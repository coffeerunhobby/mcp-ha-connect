/**
 * Streamable HTTP transport for MCP server
 * Implements the MCP protocol version 2025-03-26 (current/recommended)
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { EnvironmentConfig } from '../config.js';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { logger } from '../utils/logger.js';
import { createServer } from './common.js';

interface StreamTransportState {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createServer>;
}

// Export the type for use in http.ts
export type { StreamTransportState };

export interface StreamTransportOptions {
  haClient?: HaClient;
  omadaClient?: OmadaClient;
  aiClient?: LocalAIClient;
  config: EnvironmentConfig;
}

export interface TransportSecurityOptions {
  allowedOrigins: string[];
  allowedHosts: string[];
  enableDnsRebindingProtection: boolean;
}

/**
 * Build the DNS-rebinding protection options for the Streamable HTTP transport
 * (M3 / OWASP A05:2021).
 *
 * The SDK only validates the `Host` header when `allowedHosts` is non-empty and
 * only validates `Origin` when `allowedOrigins` is non-empty, each by EXACT
 * string match. Previously only `allowedOrigins` was passed, so the Host-header
 * rebinding check never ran. Here we derive `allowedHosts` (host[:port] form,
 * no scheme) from the configured origins plus the local/bind host so that:
 *   - clients reaching the server by its configured origin host succeed,
 *   - direct loopback/bind-address access still works,
 *   - everything else is rejected with a 403.
 *
 * When origins are empty (operator configured a `*` wildcard) both lists are
 * empty and the SDK skips validation — preserving the documented opt-out.
 */
export function buildTransportSecurityOptions(config: EnvironmentConfig): TransportSecurityOptions {
  const origins = config.httpAllowedOrigins ?? [];

  if (origins.length === 0) {
    return { allowedOrigins: [], allowedHosts: [], enableDnsRebindingProtection: true };
  }

  const port = config.httpPort ?? 3000;
  const bindAddr = config.httpBindAddr ?? '127.0.0.1';
  const hosts = new Set<string>();

  for (const origin of origins) {
    try {
      // Full origin URL (e.g. https://example.com) → host header form (example.com).
      hosts.add(new URL(origin).host);
    } catch {
      // Bare hostname / IP already in host-header form.
      hosts.add(origin);
    }
  }

  // Always permit direct loopback / bind-address access on the listen port.
  for (const host of [bindAddr, 'localhost', '127.0.0.1']) {
    hosts.add(host);
    hosts.add(`${host}:${port}`);
  }

  return {
    allowedOrigins: origins,
    allowedHosts: [...hosts],
    enableDnsRebindingProtection: true,
  };
}

/**
 * Creates a Streamable HTTP transport
 * This implements the MCP protocol version 2025-03-26
 */
export function createStreamTransport(options: StreamTransportOptions): StreamTransportState {
  const { haClient, omadaClient, aiClient, config } = options;
  const mcpServer = createServer({ haClient, omadaClient, aiClient });

  const enableStatefulSessions = config.stateful;
  const sessionIdGenerator = enableStatefulSessions ? () => randomUUID() : undefined;

  if (!enableStatefulSessions) {
    logger.info('Starting Streamable HTTP transport in stateless mode; Mcp-Session-Id headers are optional');
  }

  const security = buildTransportSecurityOptions(config);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator,
    allowedOrigins: security.allowedOrigins,
    allowedHosts: security.allowedHosts,
    enableDnsRebindingProtection: security.enableDnsRebindingProtection,
    onsessioninitialized: (sessionId: string) => {
      logger.info('Session initialized', { sessionId });
    },
    onsessionclosed: (sessionId: string) => {
      logger.info('Session closed', { sessionId });
    },
  });

  transport.onerror = (error: Error) => {
    logger.error('Streamable HTTP transport error', {
      error,
      message: error.message,
    });
  };

  return { transport, server: mcpServer };
}

/**
 * Handles incoming Streamable HTTP requests (GET, POST, DELETE)
 * For stateful mode, transports should be stored and reused by the caller
 */
export async function handleStreamRequest(
  options: StreamTransportOptions,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
  existingTransport?: StreamTransportState
): Promise<StreamTransportState | void> {
  const { config } = options;
  const originHeader = req.headers.origin;
  const hostHeader = req.headers.host;

  logger.info('Streamable HTTP request received', {
    method: req.method,
    url: req.url,
    sessionId: req.headers['mcp-session-id'] ?? undefined,
    origin: originHeader ?? '(not set)',
    host: hostHeader ?? '(not set)',
  });

  // Reuse existing transport if provided, otherwise create new one
  const state = existingTransport ?? createStreamTransport(options);

  if (!existingTransport) {
    await state.server.connect(state.transport);
  }

  // Ensure Accept header includes required MIME types for SDK compatibility
  // Some MCP clients (like n8n) don't send the full Accept header
  const acceptHeader = req.headers.accept ?? '';
  if (!acceptHeader.includes('text/event-stream') || !acceptHeader.includes('application/json')) {
    req.headers.accept = 'application/json, text/event-stream';
  }

  try {
    await state.transport.handleRequest(req, res, parsedBody);

    logger.debug('Streamable HTTP request handled', {
      method: req.method,
      sessionId: req.headers['mcp-session-id'] ?? undefined,
    });
  } catch (error) {
    logger.error('Failed to handle Streamable HTTP request', {
      error,
      method: req.method,
      url: req.url,
      origin: originHeader ?? '(not set)',
      host: hostHeader ?? '(not set)',
      allowedOrigins: config.httpAllowedOrigins,
    });
    throw error;
  }

  // Return state for session management if stateful
  if (config.stateful) {
    return state;
  }
}
