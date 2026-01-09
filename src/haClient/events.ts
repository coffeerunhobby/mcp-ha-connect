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

export interface EventSubscription {
  id: string;
  subscriptionId: number;
  eventType?: string;
  domain?: string;
  entityId?: string;
  callback: (event: HaEvent) => void;
}

export interface EventSubscriberConfig {
  baseUrl: string;
  token: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
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
  private pendingSubscriptions: Array<{ resolve: (id: number) => void; reject: (error: Error) => void }> = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting = false;
  private shouldReconnect = true;

  private readonly config: EventSubscriberConfig;
  private readonly reconnectInterval: number;
  private readonly maxReconnectAttempts: number;

  constructor(config: EventSubscriberConfig) {
    super();
    this.config = config;
    this.reconnectInterval = config.reconnectInterval ?? 5000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
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

        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
          logger.info('WebSocket connection established');
          this.reconnectAttempts = 0;
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message, resolve, reject);
          } catch (error) {
            logger.error('Failed to parse WebSocket message', { error });
          }
        });

        this.ws.on('close', (code, reason) => {
          logger.info('WebSocket connection closed', { code, reason: reason.toString() });
          this.authenticated = false;
          this.isConnecting = false;
          this.handleDisconnect();
        });

        this.ws.on('error', (error) => {
          logger.error('WebSocket error', { error: error.message });
          this.isConnecting = false;
          reject(error);
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

      case 'auth_ok':
        logger.info('WebSocket authentication successful');
        this.authenticated = true;
        this.isConnecting = false;
        this.emit('connected');
        resolveConnect();
        break;

      case 'auth_invalid':
        logger.error('WebSocket authentication failed', { message: message.message });
        this.isConnecting = false;
        rejectConnect(new Error(`Authentication failed: ${message.message}`));
        break;

      case 'result':
        this.handleResult(message);
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
    const success = message.success as boolean;

    if (this.pendingSubscriptions.length > 0) {
      const pending = this.pendingSubscriptions.shift()!;
      if (success) {
        pending.resolve(id);
      } else {
        const error = message.error as { message?: string } | undefined;
        pending.reject(new Error(error?.message ?? 'Subscription failed'));
      }
    }
  }

  /**
   * Handle event messages
   */
  private handleEvent(message: Record<string, unknown>): void {
    const event = message.event as HaEvent;
    if (!event) return;

    // Emit to all matching subscriptions
    for (const sub of this.subscriptions.values()) {
      if (this.eventMatchesSubscription(event, sub)) {
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
    const delay = this.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1);

    logger.info('Scheduling reconnect', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
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
  async subscribeEventType(eventType: string, callback: (event: HaEvent) => void): Promise<string> {
    return this.subscribe({
      eventType,
      callback,
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
   * Internal subscribe method
   */
  private async subscribe(options: {
    eventType?: string;
    domain?: string;
    entityId?: string;
    callback: (event: HaEvent) => void;
  }): Promise<string> {
    if (!this.authenticated) {
      await this.connect();
    }

    const subscriptionId = await this.sendSubscribeEvents(options.eventType);
    const id = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    this.subscriptions.set(id, {
      id,
      subscriptionId,
      eventType: options.eventType,
      domain: options.domain,
      entityId: options.entityId,
      callback: options.callback,
    });

    logger.info('Created event subscription', {
      id,
      eventType: options.eventType,
      domain: options.domain,
      entityId: options.entityId,
    });

    return id;
  }

  /**
   * Send subscribe_events command
   */
  private sendSubscribeEvents(eventType?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.pendingSubscriptions.push({ resolve, reject });

      const message: Record<string, unknown> = {
        id: this.messageId++,
        type: 'subscribe_events',
      };

      if (eventType) {
        message.event_type = eventType;
      }

      this.sendMessage(message);
    });
  }

  /**
   * Unsubscribe from events
   */
  async unsubscribe(subscriptionId: string): Promise<void> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) {
      return;
    }

    // Send unsubscribe command
    this.sendMessage({
      id: this.messageId++,
      type: 'unsubscribe_events',
      subscription: sub.subscriptionId,
    });

    this.subscriptions.delete(subscriptionId);
    logger.info('Removed event subscription', { id: subscriptionId });
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

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.authenticated = false;
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
