/**
 * Common MCP server creation
 * Shared across all transport types (stdio, SSE, stream)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { registerAllTools } from '../tools/index.js';
import { registerAllResources } from '../resources/index.js';
import { logger } from '../utils/logger.js';
import { VERSION } from '../version.js';

export interface CreateServerOptions {
  haClient?: HaClient;
  omadaClient?: OmadaClient;
  aiClient?: LocalAIClient;
}

export function createServer(options: CreateServerOptions): McpServer {
  const { haClient, omadaClient, aiClient } = options;
  logger.debug('Creating MCP server instance');

  const server = new McpServer({
    name: 'mcp-ha-connect',
    version: VERSION,
  });

  // Register all tools based on configured clients
  registerAllTools({
    server,
    haClient,
    omadaClient,
    aiClient,
  });

  // Register Home Assistant resources (if HA client provided)
  if (haClient) {
    registerAllResources(server, haClient);
  }

  logger.debug('MCP server instance created');

  return server;
}
