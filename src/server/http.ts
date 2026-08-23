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
import { handleEventSubscription } from './eventSubscription.js';
import { RateLimiter } from './rateLimiter.js';
import { createAuthMiddleware } from './auth.js';
import { sanitizeError } from '../utils/sanitizeError.js';
import {
  LEGACY_BINDINGS,
  resolveChatBindings,
  buildOpenApiSpec,
  dispatchChatRequest,
  requiredPermissionFor,
  type ChatBinding,
} from './chatFace.js';

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
 * Maximum accepted request body size, in bytes (M5 / OWASP API4:2023).
 * 1 MB is comfortably above any legitimate MCP/JSON-RPC or REST payload.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Error carrying an HTTP status for the request handler to surface. */
interface HttpError extends Error {
  statusCode?: number;
}

/**
 * Parse a JSON request body, enforcing a hard size cap (M5).
 *
 * If the streamed body exceeds `maxBytes` the promise rejects with a 413-tagged
 * error and the socket is destroyed, so an attacker cannot exhaust memory by
 * streaming an unbounded payload. Buffering stops the moment the cap is crossed.
 */
export function parseBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer | string) => {
      if (aborted) {
        return;
      }
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) {
        aborted = true;
        const err: HttpError = new Error('Request body too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (aborted) {
        return;
      }
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        // A malformed body is a client mistake, not a server fault: tag it 400 so
        // the request handler surfaces "400 Bad Request" instead of a generic 500.
        const err: HttpError = new Error(`Invalid JSON: ${(error as Error).message}`);
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

/** Extract a numeric HTTP status from a thrown value, if present. */
function errorStatusCode(error: unknown): number | undefined {
  const code = (error as HttpError | undefined)?.statusCode;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Apply baseline security response headers (L4 / OWASP A05:2021).
 *
 * Cheap, static defenses applied to every response: block MIME sniffing,
 * forbid framing (clickjacking), and avoid leaking full URLs in the Referer.
 */
export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
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
 * Handle health check endpoint (M7 / OWASP A09:2021).
 *
 * `/health` is unauthenticated (it is on the auth skip-list so container/orchestrator
 * probes can reach it). It therefore returns liveness ONLY — never version, auth
 * method, AI provider URLs, client counts, or any other internal configuration that
 * would aid an unauthenticated attacker fingerprinting the deployment. Operators who
 * need that detail can query the authenticated MCP tools (e.g. `getVersion`).
 */
export function handleHealthCheck(res: ServerResponse): void {
  sendJson(res, 200, { status: 'healthy' });
}

/**
 * Add CORS headers for REST API endpoints (always enabled for Open WebUI compatibility)
 */
export function addRestApiCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // `x-session-id` is sent by Open WebUI on every tool call. A browser blocks the
  // request entirely (CORS preflight failure -> "NetworkError when attempting to
  // fetch resource") if a requested header is not listed here, so it must be allowed.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-session-id');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Whether a request path is served by the browser-facing REST surface
 * (`/openapi.json`, the `/api/*` bridge, or the SSE events stream) and therefore
 * must always carry CORS headers — INCLUDING on responses produced before the
 * route handler runs (rate-limit 429, auth 401). If those rejections go back
 * without `Access-Control-Allow-Origin`, the browser discards the response and
 * surfaces it as an opaque "NetworkError when attempting to fetch resource",
 * masking the real status (this is why an Open WebUI 401 looked like a network
 * failure). `url` is the raw request URL (query string included); `urlPath` is
 * the path-only form used to match the configurable SSE events path.
 */
export function isRestApiCorsPath(url: string, urlPath: string, sseEventsPath: string): boolean {
  return url === '/openapi.json' || url.startsWith('/api/') || urlPath === sseEventsPath;
}

/**
 * Resolve the permission a REST `/api/*` route requires (legacy surface).
 *
 * v1.7: derived from the chat-face binding registry — each binding carries the
 * `Permission.*` bit of its MCP-tool twin so the REST bridge cannot be used to
 * bypass RBAC (finding H1 / OWASP A01:2021, BFLA). Unknown routes return
 * `null` — the handler falls through to a 404, which needs no permission.
 */
export function requiredRestPermission(method: string, pathname: string): number | null {
  return requiredPermissionFor(LEGACY_BINDINGS, method, pathname);
}

/**
 * Handle REST API requests for Open WebUI compatibility (legacy entry point).
 *
 * v1.7: thin delegate to the chat-face dispatcher over the legacy bindings —
 * kept so existing callers/tests exercise the exact same code path the server
 * uses. New code should call `dispatchChatRequest` with resolved bindings.
 */
export async function handleRestApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  client: HaClient
): Promise<void> {
  // Always add CORS for REST API
  addRestApiCors(req, res);
  await dispatchChatRequest(req, res, url, {
    bindings: LEGACY_BINDINGS,
    deps: { haClient: client },
    parseBody,
    sendJson,
  });
}

/**
 * Resolve the public URL scheme, honoring `X-Forwarded-Proto` (set by Cloudflare /
 * reverse proxies that TLS-terminate upstream). The header is validated against an
 * allowlist so a spoofed value can't inject an arbitrary scheme; anything other than
 * a literal `https` falls back to `http`. Comma-separated values (proxy chains) take
 * the first hop.
 */
export function resolveForwardedProto(headerValue: string | string[] | undefined): 'http' | 'https' {
  const first = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const proto = String(first ?? '')
    .split(',')[0]
    ?.trim()
    .toLowerCase();
  return proto === 'https' ? 'https' : 'http';
}

/**
 * Generate OpenAPI spec for Open WebUI compatibility (legacy entry point).
 *
 * v1.7: generated from the chat-face binding registry. With no MCP_CHAT_TOOLS
 * slice this renders the legacy 8-tool spec byte-for-byte (golden-file test:
 * tests/fixtures/openapi-default-slice.json).
 */
export function getOpenApiSpec(baseUrl: string): object {
  return buildOpenApiSpec(baseUrl, LEGACY_BINDINGS);
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

  // v1.7: resolve the ACTIVE chat-face bindings once at startup — the operator's
  // MCP_CHAT_TOOLS slice ∩ code-side chat-eligible bindings (unset = legacy 8).
  const chatBindings: ChatBinding[] = resolveChatBindings(config.chatTools, {
    haClient: client,
    omadaClient,
  });
  logger.info('Chat face resolved', {
    tools: chatBindings.map((b) => b.operationId),
    sliceConfigured: config.chatTools !== undefined,
  });

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
        // M4: only trust forwarding headers from configured proxies.
        trustedProxies: config.rateLimitTrustedProxies,
      })
    : null;

  // Initialize auth middleware
  const authMiddleware = createAuthMiddleware({
    method: config.authMethod,
    secret: config.authSecret,
    permissions: config.permissions,
    skipPaths: [healthPath, '/openapi.json'],
    requireExp: config.authRequireExp,
    issuer: config.authIssuer,
    audience: config.authAudience,
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

    // L4: baseline security headers on every response.
    applySecurityHeaders(res);

    const url = req.url ?? '/';
    const urlPath = url.split('?')[0];

    // Handle OPTIONS (CORS preflight) - add CORS headers for REST API endpoints
    if (req.method === 'OPTIONS') {
      if (isRestApiCorsPath(url, urlPath, sseEventsPath)) {
        addRestApiCors(req, res);
      } else {
        handleCors(req, res, config);
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // Apply CORS headers for the browser-facing REST surface BEFORE rate limiting
    // and auth, so a 429 or 401 rejection still carries `Access-Control-Allow-Origin`.
    // Otherwise the browser masks the real status as an opaque "NetworkError when
    // attempting to fetch resource" (Open WebUI auth failures looked like this).
    if (isRestApiCorsPath(url, urlPath, sseEventsPath)) {
      addRestApiCors(req, res);
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
        handleHealthCheck(res);
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
        // Honor X-Forwarded-Proto (set by Cloudflare / reverse proxies) so the advertised
        // server URL is https when the public endpoint is TLS-terminated upstream. Without
        // this, an https Open WebUI page is handed an http:// server URL and the browser
        // blocks tool calls as mixed content ("NetworkError when attempting to fetch resource").
        const scheme = resolveForwardedProto(req.headers['x-forwarded-proto']);
        const baseUrl = `${scheme}://${req.headers.host ?? `${bindAddr}:${port}`}`;
        sendJson(res, 200, buildOpenApiSpec(baseUrl, chatBindings));
        return;
      }

      // REST API endpoints for Open WebUI compatibility (chat face). Per-binding
      // client requirements (HA vs Omada) are enforced inside the dispatcher.
      if (url.startsWith('/api/')) {
        await dispatchChatRequest(req, res, url, {
          bindings: chatBindings,
          deps: { haClient: client, omadaClient },
          parseBody,
          sendJson,
        });
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
      // M5: oversize body → 413 rather than a generic 500.
      if (errorStatusCode(error) === 413) {
        if (!res.headersSent) {
          sendJson(res, 413, { error: 'Payload Too Large', message: 'Request body exceeds the size limit' });
        }
        return;
      }

      // A malformed request body is the client's fault, not ours: return 400 with the
      // parse detail (which is safe — it describes the client's own JSON, not our
      // internals) rather than masking it as a 500 Internal Server Error.
      if (errorStatusCode(error) === 400) {
        if (!res.headersSent) {
          sendJson(res, 400, { error: 'Bad Request', message: (error as Error).message });
        }
        return;
      }

      logger.error('HTTP request error', {
        error,
        method: req.method,
        url,
      });

      if (!res.headersSent) {
        // M6: detail is logged above; the client gets only a generic message.
        sendJson(res, 500, {
          error: 'Internal server error',
          message: sanitizeError(error),
        });
      }
    }
  });

  // M5: bound how long a client may take to deliver headers/body so a slow-loris
  // connection cannot tie up a socket indefinitely. These cap request *intake*
  // time, not response duration, so long-lived SSE streams are unaffected.
  server.headersTimeout = 30_000;   // 30s to send all request headers
  server.requestTimeout = 60_000;   // 60s to deliver the complete request
  server.keepAliveTimeout = 5_000;  // 5s idle on a keep-alive connection
  server.maxRequestsPerSocket = 0;  // unlimited (default); explicit for clarity

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
