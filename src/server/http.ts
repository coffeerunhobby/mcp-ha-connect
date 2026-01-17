/**
 * HTTP server for MCP with Streamable HTTP transport
 * Includes health check, CORS support, rate limiting, and real-time event subscriptions
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { EnvironmentConfig } from '../config.js';
import type { HaClient } from '../haClient/index.js';
import { EventSubscriber } from '../haClient/events.js';
import type { LocalAIClient } from '../localAI/index.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { logger } from '../utils/logger.js';
import { handleStreamRequest, type StreamTransportState, type StreamTransportOptions } from './stream.js';
import { handleEventSubscription, getClientCount } from './eventSubscription.js';
import { RateLimiter } from './rateLimiter.js';
import { createAuthMiddleware } from './auth.js';
import { VERSION } from '../version.js';

// Session storage for stateful mode
const sessions = new Map<string, StreamTransportState>();

/**
 * Wrap response to add Server-Timing header with request duration
 * The timing is calculated and header set just before res.end() is called
 */
function wrapResponseWithTiming(res: ServerResponse): { res: ServerResponse; startTime: number } {
  const startTime = performance.now();
  const originalEnd = res.end.bind(res);

  // Override res.end to set timing header before sending
  res.end = function (
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void
  ): ServerResponse {
    // Set Server-Timing header if headers haven't been sent
    if (!res.headersSent) {
      const durationMs = Math.round(performance.now() - startTime);
      res.setHeader('Server-Timing', `total;dur=${durationMs}`);
    }

    // Call original end with proper overload handling
    if (typeof encodingOrCallback === 'function') {
      return originalEnd(chunk, encodingOrCallback);
    }
    if (encodingOrCallback !== undefined) {
      return originalEnd(chunk, encodingOrCallback, callback);
    }
    return originalEnd(chunk, callback);
  } as typeof res.end;

  return { res, startTime };
}

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
 * Send JSON response with proper Content-Length header
 */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(payload).toString());
  res.end(payload);
}

/**
 * Handle health check endpoint
 */
function handleHealthCheck(res: ServerResponse, config: EnvironmentConfig, aiEnabled: boolean, eventsEnabled: boolean): void {
  sendJson(res, 200, {
    status: 'healthy',
    version: VERSION,
    transport: 'stream',
    stateful: config.stateful,
    authMethod: config.authMethod,
    aiEnabled,
    aiProvider: aiEnabled ? config.aiProvider : undefined,
    aiUrl: aiEnabled ? config.aiUrl : undefined,
    aiModel: aiEnabled ? config.aiModel : undefined,
    eventsEnabled,
    eventsPath: eventsEnabled ? config.sseEventsPath : undefined,
    eventsConnectedClients: eventsEnabled ? getClientCount() : undefined,
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

    // GET /api/version - Get HA and MCP version
    if (req.method === 'GET' && pathname === '/api/version') {
      const haConfig = await client.getVersion();
      sendJson(res, 200, {
        ha_version: haConfig.version,
        mcp_version: VERSION,
      });
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
      version: VERSION,
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
      '/api/version': {
        get: {
          operationId: 'getVersion',
          summary: 'Get Home Assistant version information',
          responses: {
            '200': {
              description: 'Version information',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ha_version: { type: 'string', description: 'Home Assistant version' },
                      mcp_version: { type: 'string', description: 'MCP server version' },
                    },
                  },
                },
              },
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

/**
 * Start HTTP server
 */
export interface HttpServerOptions {
  haClient?: HaClient;
  omadaClient?: OmadaClient;
  config: EnvironmentConfig;
  aiClient?: LocalAIClient;
}

export async function startHttpServer(options: HttpServerOptions): Promise<void> {
  const { haClient: client, omadaClient, config, aiClient } = options;
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

  // Initialize auth middleware
  const authMiddleware = createAuthMiddleware({
    method: config.authMethod,
    secret: config.authSecret,
    permissions: config.permissions,
    skipPaths: [healthPath, '/openapi.json'],
  });

  // Initialize event subscriber if SSE events are enabled and HA is configured
  let eventSubscriber: EventSubscriber | null = null;
  if (config.sseEventsEnabled && config.baseUrl && config.token) {
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
    transport: 'stream',
    mcpPath,
    healthPath,
    eventsPath: config.sseEventsEnabled ? sseEventsPath : undefined,
    stateful: config.stateful,
    aiEnabled: !!aiClient,
    rateLimitEnabled: config.rateLimitEnabled,
    eventsEnabled: config.sseEventsEnabled && !!eventSubscriber,
  });

  const server = createHttpServer(async (req: IncomingMessage, originalRes: ServerResponse) => {
    // Wrap response to add Server-Timing header
    const { res } = wrapResponseWithTiming(originalRes);

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

    // Apply authentication (skip health checks and openapi.json)
    if (!authMiddleware(req, res)) {
      return; // Response already sent by auth middleware
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

      // REST API endpoints for Open WebUI compatibility (requires HA client)
      if (url.startsWith('/api/')) {
        if (!client) {
          sendJson(res, 503, { error: 'Home Assistant not configured' });
          return;
        }
        await handleRestApi(req, res, url, client);
        return;
      }

      // Streamable HTTP Transport (MCP endpoint)
      if (urlPath === mcpPath) {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const existingState = sessionId ? sessions.get(sessionId) : undefined;

        const body = req.method !== 'GET' ? await parseBody(req) : undefined;
        const streamOptions: StreamTransportOptions = { haClient: client, omadaClient, aiClient, config };
        const state = await handleStreamRequest(streamOptions, req, res, body, existingState);

        if (state && config.stateful && sessionId) {
          sessions.set(sessionId, state);
        }
        return;
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

  // Graceful shutdown handler
  let isShuttingDown = false;

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.warn('Received shutdown signal, closing gracefully', { signal });

    // Close all MCP sessions
    for (const [sessionId, state] of sessions) {
      try {
        if ('server' in state) {
          await state.server.close();
        }
        if ('transport' in state && typeof state.transport.close === 'function') {
          await state.transport.close();
        }
        logger.info('Closed MCP session', { sessionId });
      } catch (error) {
        logger.error('Error closing MCP session', { sessionId, error });
      }
    }
    sessions.clear();

    // Close event subscriber
    if (eventSubscriber) {
      eventSubscriber.disconnect();
    }

    // Stop rate limiter
    if (rateLimiter) {
      rateLimiter.stop();
    }

    // Close HTTP server
    await new Promise<void>((resolve) => {
      server.close(() => {
        logger.info('HTTP server closed');
        resolve();
      });
    });

    process.exit(0);
  };

  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

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
