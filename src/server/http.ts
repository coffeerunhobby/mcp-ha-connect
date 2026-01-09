/**
 * HTTP server for MCP with SSE or Streamable transports
 * Includes health check, CORS support, rate limiting, and real-time event subscriptions
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { EnvironmentConfig } from '../config.js';
import type { HaClient } from '../haClient/index.js';
import { EventSubscriber } from '../haClient/events.js';
import type { LocalAIClient } from '../localAI/index.js';
import { logger } from '../utils/logger.js';
import { handleSseConnection, handleSseMessage, getSseMessagePath, type SSETransportState } from './sse.js';
import { handleStreamRequest, type StreamTransportState } from './stream.js';
import { handleEventSubscription, getClientCount } from './eventSubscription.js';
import { RateLimiter } from './rateLimiter.js';

// Session storage for stateful mode
const sessions = new Map<string, SSETransportState | StreamTransportState>();

/**
 * Parse JSON body from request
 */
function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk.toString()));
    req.on('end', () => {
      if (!body) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON: ${(error as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response
 */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Handle health check endpoint
 */
function handleHealthCheck(res: ServerResponse, config: EnvironmentConfig, aiEnabled: boolean, sseEnabled: boolean): void {
  sendJson(res, 200, {
    status: 'healthy',
    version: '0.5.0',
    transport: config.httpTransport,
    stateful: config.stateful,
    aiEnabled,
    aiProvider: aiEnabled ? config.aiProvider : undefined,
    aiUrl: aiEnabled ? config.aiUrl : undefined,
    aiModel: aiEnabled ? config.aiModel : undefined,
    sseEventsEnabled: sseEnabled,
    sseEventsPath: sseEnabled ? config.sseEventsPath : undefined,
    sseConnectedClients: sseEnabled ? getClientCount() : undefined,
    rateLimitEnabled: config.rateLimitEnabled,
  });
}

/**
 * Add CORS headers for REST API endpoints (always enabled for Open WebUI compatibility)
 */
function addRestApiCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Handle REST API requests for Open WebUI compatibility
 * These endpoints translate REST calls to Home Assistant API calls
 */
async function handleRestApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  client: HaClient
): Promise<void> {
  // Always add CORS for REST API
  addRestApiCors(req, res);

  const parsedUrl = new URL(url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  try {
    // GET /api/states - Get all entity states
    if (req.method === 'GET' && pathname === '/api/states') {
      const states = await client.getStates();
      sendJson(res, 200, states);
      return;
    }

    // GET /api/states/{entity_id} - Get specific entity state
    const stateMatch = pathname.match(/^\/api\/states\/([^/]+)$/);
    if (req.method === 'GET' && stateMatch) {
      const entityId = decodeURIComponent(stateMatch[1]);
      const state = await client.getState(entityId);
      if (state) {
        sendJson(res, 200, state);
      } else {
        sendJson(res, 404, { error: `Entity ${entityId} not found` });
      }
      return;
    }

    // GET /api/sensors - Get all sensors
    if (req.method === 'GET' && pathname === '/api/sensors') {
      const states = await client.getStates();
      const sensors = states.filter(
        (s: { entity_id: string }) =>
          s.entity_id.startsWith('sensor.') || s.entity_id.startsWith('binary_sensor.')
      );
      sendJson(res, 200, sensors);
      return;
    }

    // GET /api/entities/{domain} - Get entities by domain
    const domainMatch = pathname.match(/^\/api\/entities\/([^/]+)$/);
    if (req.method === 'GET' && domainMatch) {
      const domain = decodeURIComponent(domainMatch[1]);
      const states = await client.getStates();
      const filtered = states.filter((s: { entity_id: string }) =>
        s.entity_id.startsWith(`${domain}.`)
      );
      sendJson(res, 200, filtered);
      return;
    }

    // GET /api/search?q={query} - Search entities
    if (req.method === 'GET' && pathname === '/api/search') {
      const query = parsedUrl.searchParams.get('q')?.toLowerCase() ?? '';
      const states = await client.getStates();
      const filtered = states.filter(
        (s: { entity_id: string; attributes?: { friendly_name?: string } }) =>
          s.entity_id.toLowerCase().includes(query) ||
          s.attributes?.friendly_name?.toLowerCase().includes(query)
      );
      sendJson(res, 200, filtered);
      return;
    }

    // GET /api/history/{entity_id}?hours={hours} - Get entity history
    const historyMatch = pathname.match(/^\/api\/history\/([^/]+)$/);
    if (req.method === 'GET' && historyMatch) {
      const entityId = decodeURIComponent(historyMatch[1]);
      const hours = parseInt(parsedUrl.searchParams.get('hours') ?? '24', 10);
      const history = await client.getHistory(entityId, hours);
      sendJson(res, 200, history);
      return;
    }

    // POST /api/services/{domain}/{service} - Call a service
    const serviceMatch = pathname.match(/^\/api\/services\/([^/]+)\/([^/]+)$/);
    if (req.method === 'POST' && serviceMatch) {
      const domain = decodeURIComponent(serviceMatch[1]);
      const service = decodeURIComponent(serviceMatch[2]);
      const body = (await parseBody(req)) as { entity_id?: string; data?: Record<string, unknown> } | undefined;
      const result = await client.callService({
        domain,
        service,
        target: body?.entity_id ? { entity_id: body.entity_id } : undefined,
        service_data: body?.data,
      });
      sendJson(res, 200, result);
      return;
    }

    // Not found
    sendJson(res, 404, { error: 'API endpoint not found' });
  } catch (error) {
    logger.error('REST API error', { error, url });
    sendJson(res, 500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Generate OpenAPI spec for Open WebUI compatibility
 */
function getOpenApiSpec(baseUrl: string): object {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Home Assistant MCP Tools',
      description: 'MCP server for Home Assistant - exposes entity states and service calls',
      version: '0.2.0',
    },
    servers: [{ url: baseUrl }],
    paths: {
      '/api/states': {
        get: {
          operationId: 'getStates',
          summary: 'Get all entity states from Home Assistant',
          responses: {
            '200': {
              description: 'List of all entity states',
              content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/EntityState' } } } },
            },
          },
        },
      },
      '/api/states/{entity_id}': {
        get: {
          operationId: 'getState',
          summary: 'Get state of a specific entity',
          parameters: [{ name: 'entity_id', in: 'path', required: true, schema: { type: 'string' }, description: 'Entity ID (e.g., light.living_room)' }],
          responses: {
            '200': {
              description: 'Entity state',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/EntityState' } } },
            },
          },
        },
      },
      '/api/services/{domain}/{service}': {
        post: {
          operationId: 'callService',
          summary: 'Call a Home Assistant service',
          parameters: [
            { name: 'domain', in: 'path', required: true, schema: { type: 'string' }, description: 'Service domain (e.g., light, switch)' },
            { name: 'service', in: 'path', required: true, schema: { type: 'string' }, description: 'Service name (e.g., turn_on, turn_off)' },
          ],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    entity_id: { type: 'string', description: 'Target entity ID' },
                    data: { type: 'object', description: 'Service data' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Service call result' } },
        },
      },
      '/api/sensors': {
        get: {
          operationId: 'getAllSensors',
          summary: 'Get all sensor and binary_sensor states',
          responses: {
            '200': {
              description: 'List of sensor states',
              content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/EntityState' } } } },
            },
          },
        },
      },
      '/api/entities/{domain}': {
        get: {
          operationId: 'getEntitiesByDomain',
          summary: 'Get all entities for a specific domain',
          parameters: [{ name: 'domain', in: 'path', required: true, schema: { type: 'string' }, description: 'Domain name (e.g., light, sensor)' }],
          responses: {
            '200': {
              description: 'List of entities in domain',
              content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/EntityState' } } } },
            },
          },
        },
      },
      '/api/search': {
        get: {
          operationId: 'searchEntities',
          summary: 'Search entities by name or ID',
          parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' }],
          responses: {
            '200': {
              description: 'Matching entities',
              content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/EntityState' } } } },
            },
          },
        },
      },
      '/api/history/{entity_id}': {
        get: {
          operationId: 'getHistory',
          summary: 'Get historical data for an entity',
          parameters: [
            { name: 'entity_id', in: 'path', required: true, schema: { type: 'string' }, description: 'Entity ID' },
            { name: 'hours', in: 'query', schema: { type: 'number', default: 24 }, description: 'Hours of history' },
          ],
          responses: {
            '200': {
              description: 'Historical data',
              content: { 'application/json': { schema: { type: 'array' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        EntityState: {
          type: 'object',
          properties: {
            entity_id: { type: 'string' },
            state: { type: 'string' },
            attributes: { type: 'object' },
            last_changed: { type: 'string' },
            last_updated: { type: 'string' },
          },
        },
      },
    },
  };
}

/**
 * Handle CORS preflight
 */
function handleCors(req: IncomingMessage, res: ServerResponse, config: EnvironmentConfig): void {
  if (!config.httpAllowCors) {
    return;
  }

  const origin = req.headers.origin;
  const allowedOrigins = config.httpAllowedOrigins ?? [];

  // If origins list is empty, allow all (wildcard was used)
  if (allowedOrigins.length === 0 || (origin && allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

/**
 * Start HTTP server
 */
export async function startHttpServer(client: HaClient, config: EnvironmentConfig, aiClient?: LocalAIClient): Promise<void> {
  const port = config.httpPort ?? 3000;
  const bindAddr = config.httpBindAddr ?? '127.0.0.1';
  const mcpPath = config.httpPath ?? '/mcp';
  const healthPath = config.httpHealthcheckPath ?? '/health';
  const sseEventsPath = config.sseEventsPath ?? '/subscribe_events';

  // Initialize rate limiter if enabled
  const rateLimiter = config.rateLimitEnabled
    ? new RateLimiter({
        windowMs: config.rateLimitWindowMs,
        maxRequests: config.rateLimitMaxRequests,
        skipPaths: [healthPath, '/openapi.json'],
      })
    : null;

  // Initialize event subscriber if SSE events are enabled
  let eventSubscriber: EventSubscriber | null = null;
  if (config.sseEventsEnabled) {
    eventSubscriber = new EventSubscriber({
      baseUrl: config.baseUrl,
      token: config.token,
    });

    // Connect to Home Assistant WebSocket
    try {
      await eventSubscriber.connect();
      logger.info('Event subscriber connected to Home Assistant');
    } catch (error) {
      logger.warn('Failed to connect event subscriber, SSE events will be unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      eventSubscriber = null;
    }
  }

  logger.info('Starting HTTP server', {
    port,
    bindAddr,
    transport: config.httpTransport,
    mcpPath,
    healthPath,
    sseEventsPath: config.sseEventsEnabled ? sseEventsPath : undefined,
    stateful: config.stateful,
    aiEnabled: !!aiClient,
    rateLimitEnabled: config.rateLimitEnabled,
    sseEventsEnabled: config.sseEventsEnabled && !!eventSubscriber,
  });

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const urlPath = url.split('?')[0];

    // Handle OPTIONS (CORS preflight) - add CORS headers for REST API endpoints
    if (req.method === 'OPTIONS') {
      if (url === '/openapi.json' || url.startsWith('/api/') || urlPath === sseEventsPath) {
        addRestApiCors(req, res);
      } else {
        handleCors(req, res, config);
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // Apply rate limiting (skip health checks and certain paths)
    if (rateLimiter) {
      const allowed = rateLimiter.middleware()(req, res);
      if (!allowed) {
        return; // Response already sent by rate limiter
      }
    }

    // Add CORS headers for MCP endpoints
    handleCors(req, res, config);

    try {
      // Health check endpoint
      if (config.httpEnableHealthcheck && url === healthPath) {
        handleHealthCheck(res, config, !!aiClient, !!eventSubscriber);
        return;
      }

      // SSE Event Subscription endpoint
      if (config.sseEventsEnabled && eventSubscriber && urlPath === sseEventsPath) {
        if (req.method === 'GET') {
          addRestApiCors(req, res);
          await handleEventSubscription(req, res, eventSubscriber);
          return;
        }
        sendJson(res, 405, { error: 'Method not allowed. Use GET for SSE subscription.' });
        return;
      }

      // OpenAPI spec endpoint for Open WebUI compatibility
      if (req.method === 'GET' && url === '/openapi.json') {
        addRestApiCors(req, res);
        const baseUrl = `http://${req.headers.host ?? `${bindAddr}:${port}`}`;
        sendJson(res, 200, getOpenApiSpec(baseUrl));
        return;
      }

      // REST API endpoints for Open WebUI compatibility
      if (url.startsWith('/api/')) {
        await handleRestApi(req, res, url, client);
        return;
      }

      // SSE Transport
      if (config.httpTransport === 'sse') {
        const messagePath = getSseMessagePath();

        // SSE connection (GET)
        if (req.method === 'GET' && url === mcpPath) {
          const state = await handleSseConnection(client, config, mcpPath, req, res, aiClient);
          if (config.stateful && state.transport.sessionId) {
            sessions.set(state.transport.sessionId, state);
          }
          return;
        }

        // SSE message (POST)
        if (req.method === 'POST' && url === messagePath) {
          const sessionId = req.headers['mcp-session-id'] as string | undefined;
          const state = sessionId ? sessions.get(sessionId) as SSETransportState | undefined : undefined;

          if (!state || !('sessionId' in state.transport)) {
            sendJson(res, 400, { error: 'Invalid or missing session' });
            return;
          }

          const body = await parseBody(req);
          await handleSseMessage(state.transport, req, res, body);
          return;
        }
      }

      // Streamable HTTP Transport
      if (config.httpTransport === 'stream') {
        if (url === mcpPath) {
          const sessionId = req.headers['mcp-session-id'] as string | undefined;
          const existingState = sessionId ? sessions.get(sessionId) : undefined;

          const body = req.method !== 'GET' ? await parseBody(req) : undefined;
          const state = await handleStreamRequest(client, config, req, res, body, existingState as StreamTransportState, aiClient);

          if (state && config.stateful && sessionId) {
            sessions.set(sessionId, state);
          }
          return;
        }
      }

      // Not found
      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      logger.error('HTTP request error', {
        error,
        method: req.method,
        url,
      });

      if (!res.headersSent) {
        sendJson(res, 500, {
          error: 'Internal server error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  // Handle server shutdown
  const cleanup = () => {
    if (eventSubscriber) {
      eventSubscriber.disconnect();
    }
    if (rateLimiter) {
      rateLimiter.stop();
    }
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  // Start listening
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, bindAddr, () => {
      logger.info('HTTP server listening', {
        port,
        bindAddr,
        url: `http://${bindAddr}:${port}${mcpPath}`,
        healthUrl: config.httpEnableHealthcheck ? `http://${bindAddr}:${port}${healthPath}` : undefined,
        sseEventsUrl: config.sseEventsEnabled && eventSubscriber ? `http://${bindAddr}:${port}${sseEventsPath}` : undefined,
      });
      resolve();
    });
  });
}
