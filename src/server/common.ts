/**
 * Common MCP server creation
 * Shared across all transport types (stdio, SSE, stream)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';
import { registerAllTools } from '../tools/index.js';
import { registerAllResources } from '../resources/index.js';
import { logger } from '../utils/logger.js';
import { VERSION } from '../version.js';

export function createServer(client: HaClient, aiClient?: LocalAIClient): McpServer {
  logger.debug('Creating MCP server instance');

  const server = new McpServer({
    name: 'mcp-ha-connect',
    version: VERSION,
  });

  // Register all Home Assistant tools
  registerAllTools(server, client, aiClient);

  // Register all Home Assistant resources
  registerAllResources(server, client);

  logger.debug('MCP server instance created');

  return server;
}
