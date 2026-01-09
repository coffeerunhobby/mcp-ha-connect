/**
 * Stdio transport for MCP server
 * Used for Claude Desktop and other stdio-based clients
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';
import { logger } from '../utils/logger.js';
import { createServer } from './common.js';

export async function startStdioServer(client: HaClient, aiClient?: LocalAIClient): Promise<void> {
  logger.info('Starting stdio server');

  const server = createServer(client, aiClient);
  const transport = new StdioServerTransport();

  logger.info('Connecting stdio server');
  await server.connect(transport);

  logger.info('Stdio server connected and ready');
}
