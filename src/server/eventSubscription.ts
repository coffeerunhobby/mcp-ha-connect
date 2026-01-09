/**
 * SSE Event Subscription Endpoint
 * Allows HTTP clients to subscribe to Home Assistant events via Server-Sent Events
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventSubscriber, HaEvent } from '../haClient/events.js';
import { logger } from '../utils/logger.js';

export interface SSEClient {
  id: string;
  res: ServerResponse;
  subscriptionIds: string[];
  domain?: string;
  entityId?: string;
  eventTypes?: string[];
  createdAt: Date;
  lastEventAt?: Date;
  eventCount: number;
}

// Store active SSE clients
const clients = new Map<string, SSEClient>();

/**
 * Parse query parameters from URL
 */
function parseQueryParams(url: string): URLSearchParams {
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) {
    return new URLSearchParams();
  }
  return new URLSearchParams(url.slice(queryIndex + 1));
}

/**
 * Send SSE event to a client
 */
function sendSSEEvent(res: ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded) {
    return;
  }

  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`event: ${event}\n`);
  res.write(`data: ${payload}\n\n`);
}

/**
 * Send SSE comment (keep-alive)
 */
function sendSSEComment(res: ServerResponse, comment: string): void {
  if (res.writableEnded) {
    return;
  }
  res.write(`: ${comment}\n\n`);
}

/**
 * Handle SSE subscription request
 */
export async function handleEventSubscription(
  req: IncomingMessage,
  res: ServerResponse,
  eventSubscriber: EventSubscriber
): Promise<void> {
  const clientId = `sse_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const params = parseQueryParams(req.url ?? '');

  // Parse filter parameters
  const domain = params.get('domain') ?? undefined;
  const entityId = params.get('entity_id') ?? undefined;
  const eventTypesParam = params.get('event_types');
  const eventTypes = eventTypesParam ? eventTypesParam.split(',').map(t => t.trim()) : undefined;
  const token = params.get('token');

  logger.info('New SSE subscription request', {
    clientId,
    domain,
    entityId,
    eventTypes,
    hasToken: !!token,
  });

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': req.headers.origin ?? '*',
    'Access-Control-Allow-Credentials': 'true',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Create client record
  const client: SSEClient = {
    id: clientId,
    res,
    subscriptionIds: [],
    domain,
    entityId,
    eventTypes,
    createdAt: new Date(),
    eventCount: 0,
  };
  clients.set(clientId, client);

  // Send initial connection event
  sendSSEEvent(res, 'connected', {
    client_id: clientId,
    message: 'Connected to Home Assistant event stream',
    filters: { domain, entityId, eventTypes },
    timestamp: new Date().toISOString(),
  });

  // Ensure event subscriber is connected
  if (!eventSubscriber.isConnected()) {
    try {
      await eventSubscriber.connect();
    } catch (error) {
      logger.error('Failed to connect event subscriber', { error });
      sendSSEEvent(res, 'error', {
        error: 'Failed to connect to Home Assistant',
        message: error instanceof Error ? error.message : String(error),
      });
      res.end();
      clients.delete(clientId);
      return;
    }
  }

  // Create event callback
  const eventCallback = (event: HaEvent) => {
    // Apply filters
    if (eventTypes && !eventTypes.includes(event.event_type)) {
      return;
    }

    if (domain && event.event_type === 'state_changed') {
      const eventDomain = event.data.entity_id?.split('.')[0];
      if (eventDomain !== domain) {
        return;
      }
    }

    if (entityId && event.data.entity_id !== entityId) {
      return;
    }

    // Update client stats
    client.lastEventAt = new Date();
    client.eventCount++;

    // Send event to client
    sendSSEEvent(res, event.event_type, {
      event_type: event.event_type,
      entity_id: event.data.entity_id,
      old_state: event.data.old_state,
      new_state: event.data.new_state,
      domain: event.data.domain,
      service: event.data.service,
      service_data: event.data.service_data,
      time_fired: event.time_fired,
      context: event.context,
    });
  };

  // Subscribe to events based on filters
  try {
    let subscriptionId: string;

    if (entityId) {
      // Subscribe to specific entity
      subscriptionId = await eventSubscriber.subscribeEntity(entityId, eventCallback);
    } else if (domain) {
      // Subscribe to domain
      subscriptionId = await eventSubscriber.subscribeDomain(domain, eventCallback);
    } else if (eventTypes && eventTypes.length === 1) {
      // Subscribe to specific event type
      subscriptionId = await eventSubscriber.subscribeEventType(eventTypes[0], eventCallback);
    } else {
      // Subscribe to all state_changed events by default
      subscriptionId = await eventSubscriber.subscribeEventType('state_changed', eventCallback);
    }

    client.subscriptionIds.push(subscriptionId);

    logger.info('SSE client subscribed to events', {
      clientId,
      subscriptionId,
    });
  } catch (error) {
    logger.error('Failed to subscribe to events', { error, clientId });
    sendSSEEvent(res, 'error', {
      error: 'Failed to subscribe to events',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // Keep-alive ping every 30 seconds
  const keepAliveInterval = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepAliveInterval);
      return;
    }
    sendSSEComment(res, `keepalive ${new Date().toISOString()}`);
  }, 30000);

  // Handle client disconnect
  req.on('close', () => {
    clearInterval(keepAliveInterval);

    // Unsubscribe from all events
    for (const subId of client.subscriptionIds) {
      eventSubscriber.unsubscribe(subId).catch(error => {
        logger.error('Failed to unsubscribe', { error, subscriptionId: subId });
      });
    }

    clients.delete(clientId);

    logger.info('SSE client disconnected', {
      clientId,
      eventCount: client.eventCount,
      duration: Date.now() - client.createdAt.getTime(),
    });
  });

  // Handle errors
  req.on('error', (error) => {
    logger.error('SSE request error', { error, clientId });
    clearInterval(keepAliveInterval);
    clients.delete(clientId);
  });
}

/**
 * Get list of active SSE clients
 */
export function getActiveClients(): Array<{
  id: string;
  domain?: string;
  entityId?: string;
  eventTypes?: string[];
  createdAt: Date;
  lastEventAt?: Date;
  eventCount: number;
}> {
  return Array.from(clients.values()).map(client => ({
    id: client.id,
    domain: client.domain,
    entityId: client.entityId,
    eventTypes: client.eventTypes,
    createdAt: client.createdAt,
    lastEventAt: client.lastEventAt,
    eventCount: client.eventCount,
  }));
}

/**
 * Get count of active SSE clients
 */
export function getClientCount(): number {
  return clients.size;
}

/**
 * Broadcast event to all matching clients
 */
export function broadcastEvent(event: string, data: unknown, filter?: {
  domain?: string;
  entityId?: string;
}): void {
  for (const client of clients.values()) {
    // Apply filter
    if (filter?.domain && client.domain !== filter.domain) {
      continue;
    }
    if (filter?.entityId && client.entityId !== filter.entityId) {
      continue;
    }

    sendSSEEvent(client.res, event, data);
    client.eventCount++;
    client.lastEventAt = new Date();
  }
}

/**
 * Disconnect a specific client
 */
export function disconnectClient(clientId: string): boolean {
  const client = clients.get(clientId);
  if (!client) {
    return false;
  }

  sendSSEEvent(client.res, 'disconnect', { reason: 'Server initiated disconnect' });
  client.res.end();
  clients.delete(clientId);

  return true;
}

/**
 * Disconnect all clients
 */
export function disconnectAllClients(): number {
  const count = clients.size;

  for (const client of clients.values()) {
    sendSSEEvent(client.res, 'disconnect', { reason: 'Server shutdown' });
    client.res.end();
  }

  clients.clear();
  return count;
}
