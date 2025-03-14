import { CanceledPromiseError } from '@ulixee/commons/interfaces/IPendingWaitEvent';
import IResolvablePromise from '@ulixee/commons/interfaces/IResolvablePromise';
import EventSubscriber from '@ulixee/commons/lib/EventSubscriber';
import { TypedEventEmitter } from '@ulixee/commons/lib/eventUtils';
import Log from '@ulixee/commons/lib/Logger';
import Resolvable from '@ulixee/commons/lib/Resolvable';
import SessionClosedOrMissingError from '@ulixee/commons/lib/SessionClosedOrMissingError';
import { bindFunctions } from '@ulixee/commons/lib/utils';
import DisconnectedError from '../errors/DisconnectedError';
import IApiHandlers, { IApiSpec } from '../interfaces/IApiHandlers';
import ICoreEventPayload from '../interfaces/ICoreEventPayload';
import ICoreRequestPayload from '../interfaces/ICoreRequestPayload';
import ICoreResponsePayload from '../interfaces/ICoreResponsePayload';
import ITransport from '../interfaces/ITransport';
import IUnixTime from '../interfaces/IUnixTime';
import PendingMessages from './PendingMessages';

const { log } = Log(module);

export interface IConnectionToCoreEvents<IEventSpec> {
  disconnected: Error | null;
  connected: void;
  event: { event: ICoreEventPayload<IEventSpec, any> };
}

export interface IConnectAction {
  isCallingHook?: boolean;
  hookMessageId?: string;
  startTime: IUnixTime;
  isAutomatic: boolean;
  resolvable: IResolvablePromise<void>;
  error?: Error;
}

export default class ConnectionToCore<
  TCoreApiHandlers extends IApiHandlers,
  TEventSpec,
> extends TypedEventEmitter<IConnectionToCoreEvents<TEventSpec>> {
  public static MinimumAutoReconnectMillis = 1000;
  public connectAction: IConnectAction;
  public disconnectAction: IConnectAction;
  public autoReconnect = true;

  public hooks: {
    afterConnectFn?: (action: IConnectAction) => Promise<void>;
    beforeDisconnectFn?: (action: IConnectAction) => Promise<void>;
    afterDisconnectHook?: () => Promise<void>;
  } = {};

  protected pendingMessages = new PendingMessages<
    ICoreResponsePayload<TCoreApiHandlers, any>['data']
  >();

  protected events = new EventSubscriber();

  protected didCallConnectionTerminated = false;
  protected lastDisconnectDate?: Date;

  constructor(public transport: ITransport) {
    super();

    bindFunctions(this);

    this.events.on(transport, 'disconnected', this.onConnectionTerminated);
    this.events.on(transport, 'message', this.onMessage);
  }

  public async connect(
    options: {
      timeoutMs?: number;
      isAutoConnect?: boolean;
      shouldAutoReconnect?: boolean;
    } = {},
  ): Promise<void> {
    if (this.disconnectAction?.isCallingHook) {
      return;
    }
    if (this.connectAction) return this.connectAction.resolvable.promise;
    const { timeoutMs, isAutoConnect, shouldAutoReconnect } = options;
    if (shouldAutoReconnect !== undefined) this.autoReconnect = shouldAutoReconnect;

    const connectAction: IConnectAction = {
      isAutomatic: isAutoConnect,
      startTime: Date.now(),
      resolvable: new Resolvable(),
    };
    this.disconnectAction = null;

    try {
      this.connectAction = connectAction;
      await this.transport.connect?.(timeoutMs);
      this.didCallConnectionTerminated = false;
      await this.afterConnectHook();
      connectAction.resolvable.resolve();
      this.emit('connected');
    } catch (err) {
      delete this.connectAction;
      connectAction.resolvable.reject(err, true);
    }

    return connectAction.resolvable.promise;
  }

  public async disconnect(fatalError?: Error): Promise<void> {
    this.autoReconnect = false;
    if (this.disconnectAction) return this.disconnectAction.resolvable.promise;

    const disconnectAction: IConnectAction = {
      isAutomatic: false,
      startTime: Date.now(),
      resolvable: new Resolvable(),
      error: fatalError,
    };
    this.disconnectAction = disconnectAction;

    try {
      const logid = log.stats('ConnectionToCore.Disconnecting', {
        host: this.transport.host,
        sessionId: null,
      });
      this.pendingMessages.cancel(new DisconnectedError(this.transport.host));

      await this.beforeDisconnectHook();

      this.transport.disconnect?.();
      await this.onConnectionTerminated();
      this.connectAction = null;
      log.stats('ConnectionToCore.Disconnected', {
        parentLogId: logid,
        host: this.transport.host,
        sessionId: null,
      });
    } finally {
      disconnectAction.resolvable.resolve();
    }
    return disconnectAction.resolvable.promise;
  }

  public async sendRequest<T extends keyof TCoreApiHandlers & string>(
    payload: {
      command: T;
      args: IApiSpec<TCoreApiHandlers>[T]['args'];
      commandId?: number;
      startTime?: IUnixTime;
    },
    timeoutMs?: number,
  ): Promise<ICoreResponsePayload<TCoreApiHandlers, T>['data']> {
    const activeConnectHook = this.connectAction?.isCallingHook && this.connectAction;
    const activeDisconnectHook = this.disconnectAction?.isCallingHook && this.disconnectAction;
    // if we are not connected, try to connect (except during a disconnect)
    if (this.shouldAutoConnect()) {
      await this.connect({ timeoutMs, isAutoConnect: true });
    }

    const { promise, id } = this.pendingMessages.create(
      timeoutMs,
      !!activeConnectHook || !!activeDisconnectHook,
    );
    if (activeConnectHook) activeConnectHook.hookMessageId = id;
    if (activeDisconnectHook) activeDisconnectHook.hookMessageId = id;

    try {
      const [result] = await Promise.all([
        promise,
        this.transport.send({
          ...payload,
          messageId: id,
          sendTime: Date.now(),
        } as ICoreRequestPayload<TCoreApiHandlers, T>),
      ]);
      return result;
    } catch (error) {
      this.pendingMessages.delete(id);
      if (this.disconnectAction && error instanceof CanceledPromiseError) {
        return;
      }
      throw error;
    } finally {
      if (activeConnectHook) activeConnectHook.hookMessageId = null;
      if (activeDisconnectHook) activeDisconnectHook.hookMessageId = null;
    }
  }

  /**
   * Override fn to control active sessions
   */
  public hasActiveSessions(): boolean {
    return false;
  }

  public shouldAutoConnect(): boolean {
    if (!this.autoReconnect || !!this.connectAction) return false;
    // if we're mid-disconnect, don't auto-reconnect
    if (this.disconnectAction?.hookMessageId) return false;
    if (!this.lastDisconnectDate) return true;
    const reconnectMillis = (this.constructor as typeof ConnectionToCore)
      .MinimumAutoReconnectMillis;
    if (Number.isNaN(reconnectMillis)) return false;
    return Date.now() - this.lastDisconnectDate.getTime() >= reconnectMillis;
  }

  protected onMessage(
    payload: ICoreResponsePayload<TCoreApiHandlers, any> | ICoreEventPayload<TEventSpec, any>,
  ): void {
    if ('responseId' in payload) {
      this.onResponse(payload);
    } else if ('listenerId' in payload || 'eventType' in payload) {
      this.onEvent(payload);
    }
  }

  protected onResponse(message: ICoreResponsePayload<any, any>): void {
    const id = message.responseId;
    if (message.data instanceof Error) {
      let responseError = message.data;
      const isDisconnected =
        !!this.disconnectAction ||
        responseError.name === SessionClosedOrMissingError.name ||
        (responseError as any).isDisconnecting === true;
      delete (responseError as any).isDisconnecting;

      if (isDisconnected && !isBrowserLaunchError(responseError)) {
        responseError = new DisconnectedError(this.transport.host);
      }
      this.pendingMessages.reject(id, responseError);
    } else {
      this.pendingMessages.resolve(id, message.data);
    }
  }

  protected onEvent(event: ICoreEventPayload<TEventSpec, any>): void {
    this.emit('event', { event });
  }

  protected async onConnectionTerminated(): Promise<void> {
    if (this.didCallConnectionTerminated) return;
    this.lastDisconnectDate = new Date();
    this.didCallConnectionTerminated = true;
    this.emit('disconnected');

    // clear all pending messages
    if (this.connectAction?.hookMessageId) {
      this.onResponse({
        responseId: this.connectAction.hookMessageId,
        data: !this.connectAction.isAutomatic ? new DisconnectedError(this.transport.host) : null,
      });
    }
    this.connectAction = null;

    if (this.disconnectAction?.hookMessageId) {
      this.onResponse({
        responseId: this.disconnectAction.hookMessageId,
        data: null,
      });
    }
    this.pendingMessages.cancel(new DisconnectedError(this.transport.host));

    await this.hooks.afterDisconnectHook?.();
  }

  private async afterConnectHook(): Promise<void> {
    if (this.disconnectAction) return;

    const connectAction = this.connectAction;
    if (!connectAction) return;
    // don't run this if we're already connected
    if (connectAction.resolvable.isResolved) return;
    try {
      connectAction.isCallingHook = true;
      await this.hooks.afterConnectFn?.(connectAction);
    } finally {
      connectAction.isCallingHook = false;
    }
  }

  private async beforeDisconnectHook(): Promise<void> {
    const disconnectAction = this.disconnectAction;
    if (!disconnectAction) return;
    try {
      disconnectAction.isCallingHook = true;
      await this.hooks.beforeDisconnectFn?.(disconnectAction);
    } catch (err) {
      log.error('Error in beforeDisconnect hook', {
        sessionId: null,
        error: err,
      });
    } finally {
      disconnectAction.isCallingHook = false;
    }
  }
}

function isBrowserLaunchError(error: Error): boolean {
  return error.name === 'BrowserLaunchError' || error.name === 'DependenciesMissingError';
}
