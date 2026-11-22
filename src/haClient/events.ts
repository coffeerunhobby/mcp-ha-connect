/**
 * Home Assistant WebSocket Event Subscription
 * Connects to Home Assistant WebSocket API to receive real-time events
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { logger } from '../utils/logger.js';

export interface HaEvent {
  event_type: string;
  data: {
    entity_id?: string;
    old_state?: {
      entity_id: string;
      state: string;
      attributes: Record<string, unknown>;
      last_changed: string;
      last_updated: string;
    } | null;
    new_state?: {
      entity_id: string;
      state: string;
      attributes: Record<string, unknown>;
      last_changed: string;
      last_updated: string;
    } | null;
    domain?: string;
    service?: string;
    service_data?: Record<string, unknown>;
    [key: string]: unknown;
  };
  origin: string;
  time_fired: string;
  context: {
    id: string;
    parent_id: string | null;
    user_id: string | null;
  };
}

/** Home Assistant answered a command with `success: false` (a refusal, not a connection problem). */
export class HaCommandError extends Error {
  constructor(
    readonly commandType: string,
    readonly code: string
  ) {
    super(`Home Assistant rejected '${commandType}' (${code})`);
    this.name = 'HaCommandError';
  }
}

export interface EventSubscription {
  id: string;
  subscriptionId: number;
  /** The socket this subscription was sent on (HA forgets it when that socket closes). */
  connection?: WebSocket | null;
  /** The subscribe_events command in flight on that socket. */
  sending?: Promise<number>;
  eventType?: string;
  domain?: string;
  entityId?: string;
  callback: (event: HaEvent) => void;
  /** Called if Home Assistant refuses the subscription (e.g. a non-admin token); it is then dropped. */
  onRejected?: (error: HaCommandError) => void;
}

export interface EventSubscriberConfig {
  baseUrl: string;
  token: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  /** Upper bound for the exponential reconnect delay (ms). Default 60 s. */
  maxReconnectDelay?: number;
  /** Deadline for connecting and authenticating (ms). Default 30 s. */
  connectTimeout?: number;
  /** Verify the TLS certificate of a wss:// Home Assistant (HA_STRICT_SSL). Default true. */
  strictSsl?: boolean;
  /** How long a command waits for its result (ms). Default 30 s. */
  commandTimeout?: number;
  /** Delay before re-sending subscriptions that failed for a transient reason (ms). Default 30 s. */
  resubscribeRetryDelay?: number;
  /**
   * Interval of Home Assistant `ping`s on an authenticated connection (ms); 0 turns them off.
   * Default 30 s. Without them a peer that vanishes without closing the TCP connection
   * (a Home Assistant restart) leaves the socket looking open forever, and events stop.
   */
  pingInterval?: number;
  /** How long a ping waits for its `pong` before the connection is dropped and reopened (ms). Default 10 s. */
  pongTimeout?: number;
}

/**
 * Home Assistant Event Subscriber
 * Subscribes to real-time events via WebSocket
 */
export class EventSubscriber extends EventEmitter {
  private ws: WebSocket | null = null;
  private messageId = 1;
  private authenticated = false;
  private subscriptions = new Map<string, EventSubscription>();
  /** Commands awaiting their `result`, keyed by message id (HA answers by id). */
  private pendingCommands = new Map<
    number,
    { type: string; resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Deadline of the connect attempt in progress (cleared on auth_ok or close). */
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending retry of subscriptions that failed for a transient reason. */
  private resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting = false;
  private shouldReconnect = true;
  /** Heartbeat of the authenticated connection: the ping timer, the unanswered ping and its deadline. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPingId: number | null = null;

  private readonly config: EventSubscriberConfig;
  private readonly reconnectInterval: number;
  private readonly maxReconnectAttempts: number;
  private readonly maxReconnectDelay: number;
  private readonly pingInterval: number;
  private readonly pongTimeout: number;

  constructor(config: EventSubscriberConfig) {
    super();
    this.config = config;
    this.reconnectInterval = config.reconnectInterval ?? 5000;
    // Keep retrying by default: a long Home Assistant outage must not leave the
    // server permanently deaf to events (the delay is capped, see handleDisconnect).
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
    this.maxReconnectDelay = config.maxReconnectDelay ?? 60000;
    this.pingInterval = config.pingInterval ?? 30000;
    this.pongTimeout = config.pongTimeout ?? 10000;
  }

  /**
   * Connect to Home Assistant WebSocket API
   */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      logger.debug('WebSocket already connected');
      return;
    }

    if (this.isConnecting) {
      logger.debug('WebSocket connection already in progress');
      return;
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      try {
        // Convert HTTP URL to WebSocket URL
        const wsUrl = this.config.baseUrl
          .replace(/^http/, 'ws')
          .replace(/\/$/, '') + '/api/websocket';

        logger.info('Connecting to Home Assistant WebSocket', { url: wsUrl });

        // Same TLS policy as the REST client: only HA_STRICT_SSL=false skips verification.
        this.ws = new WebSocket(wsUrl, { rejectUnauthorized: this.config.strictSsl !== false });
        const ws = this.ws;
        // A connection that never authenticates must not hang its caller.
        this.clearConnectTimer();
        this.stopHeartbeat();
        if (this.resubscribeTimer) {
          clearTimeout(this.resubscribeTimer);
          this.resubscribeTimer = null;
        }
        this.connectTimer = setTimeout(() => {
          this.connectTimer = null;
          reject(new Error('Timed out connecting to the Home Assistant WebSocket'));
          ws.terminate();
        }, this.config.connectTimeout ?? 30000);

        this.ws.on('open', () => {
          logger.info('WebSocket connection established');
          this.reconnectAttempts = 0;
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          if (this.ws !== ws) {
            return; // a replaced socket: only the current one speaks for this subscriber
          }
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message, resolve, reject);
          } catch (error) {
            logger.error('Failed to parse WebSocket message', { error });
          }
        });

        this.ws.on('close', (code, reason) => {
          logger.info('WebSocket connection closed', { code, reason: reason.toString() });
          // Closed before authenticating: fail the connect attempt (no-op once resolved).
          const closedEarly = new Error('Home Assistant closed the WebSocket before authentication');
          if (this.ws !== ws) {
            // A socket already replaced (or disconnected): the current one's state is not its to reset.
            reject(closedEarly);
            return;
          }
          this.clearConnectTimer();
          this.stopHeartbeat();
          this.authenticated = false;
          this.isConnecting = false;
          this.rejectPendingCommands(new Error('WebSocket connection closed'));
          reject(closedEarly);
          this.handleDisconnect();
        });

        this.ws.on('error', (error) => {
          // The detail (often the internal address) stays in the server log.
          logger.error('WebSocket error', { error: error.message });
          if (this.ws === ws) this.isConnecting = false;
          reject(new Error('Could not connect to the Home Assistant WebSocket'));
        });
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(
    message: Record<string, unknown>,
    resolveConnect: (value: void) => void,
    rejectConnect: (error: Error) => void
  ): void {
    const type = message.type as string;

    switch (type) {
      case 'auth_required':
        // Send authentication
        this.sendMessage({
          type: 'auth',
          access_token: this.config.token,
        });
        break;

      case 'auth_ok': {
        logger.info('WebSocket authentication successful');
        this.clearConnectTimer();
        this.authenticated = true;
        this.isConnecting = false;
        this.startHeartbeat();
        this.emit('connected');
        resolveConnect();
        // HA forgets subscriptions with the connection: (re)send every registered
        // one, including those queued while Home Assistant was unreachable.
        void this.resubscribeAll();
        break;
      }

      case 'auth_invalid':
        logger.error('WebSocket authentication failed', { message: message.message });
        this.isConnecting = false;
        rejectConnect(new Error(`Authentication failed: ${message.message}`));
        break;

      case 'result':
        this.handleResult(message);
        break;

      case 'pong':
        if (this.pendingPingId !== null && message.id === this.pendingPingId) {
          this.clearPongTimer();
        }
        break;

      case 'event':
        this.handleEvent(message);
        break;

      default:
        logger.debug('Unhandled WebSocket message type', { type, message });
    }
  }

  /**
   * Handle result messages (responses to commands)
   */
  private handleResult(message: Record<string, unknown>): void {
    const id = message.id as number;
    const pending = this.pendingCommands.get(id);
    if (!pending) {
      return;
    }
    this.pendingCommands.delete(id);
    if (message.success) {
      pending.resolve(message.result);
    } else {
      // Callers and logs get only HA's error code (a fixed vocabulary such as
      // "unauthorized" or "not_found"); HA's free-text message can carry URLs or
      // other detail and is never passed on or logged.
      const error = message.error as { code?: string; message?: string } | undefined;
      const code = typeof error?.code === 'string' && /^[a-z_]{1,40}$/.test(error.code) ? error.code : 'unknown_error';
      logger.warn('Home Assistant command failed', { type: pending.type, code });
      pending.reject(new HaCommandError(pending.type, code));
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private rejectPendingCommands(error: Error): void {
    for (const pending of this.pendingCommands.values()) {
      pending.reject(error);
    }
    this.pendingCommands.clear();
  }

  /**
   * Send a WebSocket command and resolve with its `result` (rejects on
   * `success: false`, on disconnect, or after `timeoutMs`).
   */
  async sendCommand<T = unknown>(
    command: { type: string; [key: string]: unknown },
    timeoutMs = this.config.commandTimeout ?? 30000
  ): Promise<T> {
    return (await this.dispatchCommand<T>(command, timeoutMs)).result;
  }

  /** Like sendCommand, but also reports the message id the command was sent with. */
  private async dispatchCommand<T>(
    command: { type: string; [key: string]: unknown },
    timeoutMs = this.config.commandTimeout ?? 30000
  ): Promise<{ id: number; result: T }> {
    if (!this.authenticated) {
      await this.connect();
    }
    const { id, result } = this.beginCommand<T>(command, timeoutMs);
    return { id, result: await result };
  }

  /**
   * Send a command now and return its message id synchronously, with a promise
   * for its result. Callers that must act on the id before the result arrives
   * (subscriptions) use this directly.
   */
  private beginCommand<T>(
    command: { type: string; [key: string]: unknown },
    timeoutMs = this.config.commandTimeout ?? 30000
  ): { id: number; result: Promise<T> } {
    const id = this.messageId++;
    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`Home Assistant command '${command.type}' timed out`));
      }, timeoutMs);
      this.pendingCommands.set(id, {
        type: command.type,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.sendMessage({ ...command, id });
      } catch (error) {
        clearTimeout(timer);
        this.pendingCommands.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return { id, result };
  }

  /** Send subscribe_events for every registered subscription on a new connection. */
  private async resubscribeAll(): Promise<void> {
    for (const sub of this.subscriptions.values()) {
      if (sub.connection === this.ws) {
        continue; // already subscribed (or in flight) on this connection
      }
      const connection = this.ws;
      sub.connection = connection;
      // HA identifies the subscription by this message's id and may send events
      // right after its confirmation (even in the same read): accept them from
      // the moment the command is sent, not when the confirmation is processed.
      const { id, result } = this.beginCommand(
        sub.eventType ? { type: 'subscribe_events', event_type: sub.eventType } : { type: 'subscribe_events' }
      );
      sub.subscriptionId = id;
      sub.sending = result.then(() => id);
      try {
        await sub.sending;
        logger.info('Event subscription active on new connection', { id: sub.id, eventType: sub.eventType });
      } catch (error) {
        if (this.subscriptions.get(sub.id) !== sub) {
          continue; // unsubscribed meanwhile; unsubscribe() already cancelled it on HA's side
        }
        sub.subscriptionId = -1;
        sub.connection = null;
        if (error instanceof HaCommandError) {
          // A refusal (e.g. a non-admin token for a non-allowlisted event) is
          // permanent: drop it and tell the owner of the subscription.
          this.subscriptions.delete(sub.id);
          logger.error('Home Assistant refused an event subscription', { id: sub.id, eventType: sub.eventType, code: error.code });
          sub.onRejected?.(error);
        } else {
          // Unconfirmed (e.g. timed out): HA may still have registered it. HA
          // handles a connection's messages in order, so cancelling now is safe
          // either way and keeps a retry from adding a duplicate.
          if (this.authenticated && this.ws === connection) {
            this.sendUnsubscribe(id);
          }
          logger.warn('Event subscription not confirmed; will retry', {
            id: sub.id,
            eventType: sub.eventType,
            error: error instanceof Error ? error.message : String(error),
          });
          this.scheduleResubscribe();
        }
      }
    }
  }

  /** Retry failed subscriptions later on the same connection (a reconnect also retries them). */
  private scheduleResubscribe(): void {
    if (this.resubscribeTimer) {
      return;
    }
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null;
      if (this.authenticated) {
        void this.resubscribeAll();
      }
    }, this.config.resubscribeRetryDelay ?? 30000);
    this.resubscribeTimer.unref?.();
  }

  /**
   * Handle event messages
   */
  private handleEvent(message: Record<string, unknown>): void {
    const event = message.event as HaEvent;
    if (!event) return;

    // HA sends one copy of the event per subscription, tagged with that
    // subscription's id: deliver each copy only to its own subscription, or two
    // subscriptions to the same event type would each get every event twice.
    const subscriptionId = message.id as number;
    for (const sub of this.subscriptions.values()) {
      if (sub.subscriptionId === subscriptionId && this.eventMatchesSubscription(event, sub)) {
        try {
          sub.callback(event);
        } catch (error) {
          logger.error('Error in event callback', { error, subscriptionId: sub.id });
        }
      }
    }

    // Also emit on the EventEmitter for generic listeners
    this.emit('event', event);
    this.emit(`event:${event.event_type}`, event);

    if (event.data.entity_id) {
      this.emit(`entity:${event.data.entity_id}`, event);
    }

    if (event.data.domain) {
      this.emit(`domain:${event.data.domain}`, event);
    }
  }

  /**
   * Check if an event matches a subscription's filters
   */
  private eventMatchesSubscription(event: HaEvent, sub: EventSubscription): boolean {
    // Check event type filter
    if (sub.eventType && event.event_type !== sub.eventType) {
      return false;
    }

    // Check domain filter (for state_changed events)
    if (sub.domain && event.event_type === 'state_changed') {
      const entityDomain = event.data.entity_id?.split('.')[0];
      if (entityDomain !== sub.domain) {
        return false;
      }
    }

    // Check entity filter
    if (sub.entityId && event.data.entity_id !== sub.entityId) {
      return false;
    }

    return true;
  }

  /**
   * Ping Home Assistant regularly on the current authenticated connection. A ping
   * left unanswered past its deadline drops the connection, so the close handler
   * reconnects and resubscribes: a peer that vanished without a FIN or RST would
   * otherwise leave the socket open forever, with no events and no reconnect.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const ws = this.ws;
    if (!ws || this.pingInterval <= 0) {
      return;
    }
    this.heartbeatTimer = setInterval(() => this.sendPing(ws), this.pingInterval);
    this.heartbeatTimer.unref?.();
  }

  private sendPing(ws: WebSocket): void {
    if (this.ws !== ws || this.pendingPingId !== null) {
      return; // an old connection, or the last ping is still waiting for its pong
    }
    const id = this.messageId++;
    try {
      this.sendMessage({ id, type: 'ping' });
    } catch {
      return; // not open: its close handler reconnects
    }
    this.pendingPingId = id;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.pendingPingId = null;
      if (this.ws !== ws) {
        return;
      }
      logger.warn('No pong from Home Assistant in time; dropping the WebSocket to reconnect', {
        timeoutMs: this.pongTimeout,
      });
      ws.terminate();
    }, this.pongTimeout);
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    this.pendingPingId = null;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearPongTimer();
  }

  /**
   * Handle disconnection and attempt reconnect
   */
  private handleDisconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached, giving up');
      this.emit('disconnected', new Error('Max reconnect attempts reached'));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);

    logger.info('Scheduling reconnect', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        logger.error('Reconnect failed', { error: error.message });
      });
    }, delay);
  }

  /**
   * Subscribe to all events
   */
  async subscribeEvents(callback: (event: HaEvent) => void): Promise<string> {
    return this.subscribe({
      callback,
    });
  }

  /**
   * Subscribe to specific event type
   */
  async subscribeEventType(
    eventType: string,
    callback: (event: HaEvent) => void,
    onRejected?: (error: HaCommandError) => void
  ): Promise<string> {
    return this.subscribe({
      eventType,
      callback,
      onRejected,
    });
  }

  /**
   * Subscribe to state changes for a specific domain
   */
  async subscribeDomain(domain: string, callback: (event: HaEvent) => void): Promise<string> {
    return this.subscribe({
      eventType: 'state_changed',
      domain,
      callback,
    });
  }

  /**
   * Subscribe to state changes for a specific entity
   */
  async subscribeEntity(entityId: string, callback: (event: HaEvent) => void): Promise<string> {
    return this.subscribe({
      eventType: 'state_changed',
      entityId,
      callback,
    });
  }

  /**
   * Internal subscribe method.
   *
   * The subscription is registered first and then sent on every authenticated
   * connection: right away when connected, otherwise as soon as Home Assistant
   * is reachable, and again after any reconnect (HA forgets subscriptions with
   * the connection). It never fails because Home Assistant is down.
   */
  private async subscribe(options: {
    eventType?: string;
    domain?: string;
    entityId?: string;
    callback: (event: HaEvent) => void;
    onRejected?: (error: HaCommandError) => void;
  }): Promise<string> {
    const id = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const entry: EventSubscription = {
      id,
      subscriptionId: -1,
      connection: null,
      eventType: options.eventType,
      domain: options.domain,
      entityId: options.entityId,
      callback: options.callback,
      // Refusals that arrive later (after HA becomes reachable, or after a
      // reconnect) are reported here.
      onRejected: options.onRejected,
    };
    this.subscriptions.set(id, entry);
    logger.info('Created event subscription', {
      id,
      eventType: options.eventType,
      domain: options.domain,
      entityId: options.entityId,
    });

    if (!this.authenticated && !this.reconnectTimer) {
      try {
        await this.connect();
      } catch (error) {
        logger.warn('Home Assistant WebSocket not reachable; the subscription will be sent once it is', {
          error: error instanceof Error ? error.message : String(error),
        });
        return id;
      }
    }
    if (this.authenticated) {
      // Return once Home Assistant has confirmed it. A refusal now is thrown to
      // the caller (and the subscription dropped) rather than reported to
      // onRejected; a transient failure leaves it queued.
      entry.onRejected = undefined;
      try {
        await this.resubscribeAll();
        await entry.sending;
      } catch (error) {
        if (error instanceof HaCommandError) {
          throw error;
        }
      } finally {
        entry.onRejected = options.onRejected;
      }
    }
    return id;
  }

  /**
   * Unsubscribe from events
   */
  async unsubscribe(subscriptionId: string): Promise<void> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) {
      return;
    }

    // Forget it locally first, whatever the connection state, so it is never
    // restored on a later reconnect.
    this.subscriptions.delete(subscriptionId);
    logger.info('Removed event subscription', { id: subscriptionId });

    // Tell HA if it was sent on the current connection, confirmed or not: HA
    // handles a connection's messages in order, so the cancel follows the subscribe.
    if (this.authenticated && sub.connection === this.ws && sub.subscriptionId >= 0) {
      this.sendUnsubscribe(sub.subscriptionId);
    }
  }

  private sendUnsubscribe(haSubscriptionId: number): void {
    try {
      this.sendMessage({ id: this.messageId++, type: 'unsubscribe_events', subscription: haSubscriptionId });
    } catch (error) {
      logger.debug('Could not send unsubscribe_events', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Send a message over WebSocket
   */
  private sendMessage(message: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Disconnect from Home Assistant
   */
  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearConnectTimer();
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // The old socket's close event no longer touches this subscriber's state (see connect).
    this.authenticated = false;
    this.isConnecting = false;
    this.rejectPendingCommands(new Error('WebSocket connection closed'));
    this.subscriptions.clear();
    logger.info('Disconnected from Home Assistant WebSocket');
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.authenticated;
  }

  /**
   * Get active subscription count
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }
}
