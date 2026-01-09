/**
 * SSE (Server-Sent Events) transport for MCP server
 * Implements the legacy MCP protocol version 2024-11-05
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { EnvironmentConfig } from '../config.js';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';
import { logger } from '../utils/logger.js';
import { createServer } from './common.js';

const MESSAGE_PATH = '/messages';

interface SSETransportState {
  transport: SSEServerTransport;
  server: ReturnType<typeof createServer>;
}

/**
 * Creates an SSE transport for handling HTTP+SSE connections
 */
export function createSseTransport(
  client: HaClient,
  config: EnvironmentConfig,
  endpoint: string,
  res: ServerResponse,
  aiClient?: LocalAIClient
): SSETransportState {
  const mcpServer = createServer(client, aiClient);

  const transport = new SSEServerTransport(endpoint, res, {
    allowedOrigins: config.httpAllowedOrigins,
    enableDnsRebindingProtection: true,
  });

  transport.onerror = (error: Error) => {
    logger.error('SSE transport error', {
      error,
      message: error.message,
    });
  };

  return { transport, server: mcpServer };
}

/**
 * Handles SSE connection establishment (GET request)
 */
export async function handleSseConnection(
  client: HaClient,
  config: EnvironmentConfig,
  endpoint: string,
  req: IncomingMessage,
  res: ServerResponse,
  aiClient?: LocalAIClient
): Promise<SSETransportState> {
  const originHeader = req.headers.origin;
  const hostHeader = req.headers.host;

  logger.info('SSE connection request received', {
    method: req.method,
    url: req.url,
    origin: originHeader ?? '(not set)',
    host: hostHeader ?? '(not set)',
  });

  try {
    const { transport, server } = createSseTransport(client, config, endpoint, res, aiClient);

    await server.connect(transport);
    await transport.start();

    logger.info('SSE connection established', {
      sessionId: transport.sessionId,
    });

    return { transport, server };
  } catch (error) {
    logger.error('Failed to establish SSE connection', {
      error,
      origin: originHeader ?? '(not set)',
      host: hostHeader ?? '(not set)',
      allowedOrigins: config.httpAllowedOrigins,
    });
    throw error;
  }
}

/**
 * Handles SSE message POST requests
 */
export async function handleSseMessage(
  transport: SSEServerTransport,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown
): Promise<void> {
  logger.debug('SSE message received', {
    sessionId: transport.sessionId,
    hasBody: !!parsedBody,
  });

  await transport.handlePostMessage(req, res, parsedBody);

  logger.debug('SSE message handled', {
    sessionId: transport.sessionId,
  });
}

/**
 * Returns the message endpoint path for SSE transport
 */
export function getSseMessagePath(): string {
  return MESSAGE_PATH;
}

// Export type
export type { SSETransportState };
