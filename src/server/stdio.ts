/**
 * Stdio transport for MCP server
 * Used for Claude Desktop and other stdio-based clients
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { logger } from '../utils/logger.js';
import { createServer } from './common.js';

export interface StdioServerOptions {
  haClient?: HaClient;
  omadaClient?: OmadaClient;
  aiClient?: LocalAIClient;
}

export async function startStdioServer(options: StdioServerOptions): Promise<void> {
  logger.info('Starting stdio server');

  const server = createServer(options);
  const transport = new StdioServerTransport();

  logger.info('Connecting stdio server');
  await server.connect(transport);

  logger.info('Stdio server connected and ready');
}
