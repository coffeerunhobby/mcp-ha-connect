/**
 * Common MCP server creation
 * Shared across all transport types (stdio, SSE, stream)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';
import { registerAllTools } from '../tools/registry.js';
import { registerAllResources } from '../resources/index.js';
import { logger } from '../utils/logger.js';

export function createServer(client: HaClient, aiClient?: LocalAIClient): Server {
  logger.debug('Creating MCP server instance');

  const server = new Server(
    {
      name: 'mcp-ha-connect',
      version: '0.4.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // Register all Home Assistant tools
  registerAllTools(server, client, aiClient);

  // Register all Home Assistant resources
  registerAllResources(server, client);

  logger.debug('MCP server instance created with 15 tools and 5 resources registered');

  return server;
}
