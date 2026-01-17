/**
 * Tools index - registers all MCP tools organized by domain
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { logger } from '../utils/logger.js';

// Tool registration functions by domain
import { registerHomeAssistantTools } from './homeassistant/index.js';
import { registerOmadaTools } from './omada/index.js';
import { registerAITools } from './ai/index.js';

export interface RegisterToolsOptions {
  server: McpServer;
  haClient?: HaClient;
  omadaClient?: OmadaClient;
  aiClient?: LocalAIClient;
}

/**
 * Register all available tools based on configured clients
 */
export function registerAllTools(options: RegisterToolsOptions): void {
  const { server, haClient, omadaClient, aiClient } = options;
  logger.debug('Registering all tools');

  let totalTools = 0;

  // Home Assistant tools (if client provided)
  if (haClient) {
    const haToolCount = registerHomeAssistantTools(server, haClient);
    totalTools += haToolCount;
  }

  // Omada tools (if client provided)
  if (omadaClient) {
    const omadaToolCount = registerOmadaTools(server, omadaClient);
    totalTools += omadaToolCount;
  }

  // AI tools (always register, but may be disabled if no aiClient)
  const aiToolCount = registerAITools(server, aiClient);
  totalTools += aiToolCount;

  logger.info('All tools registered successfully', {
    totalTools,
    haEnabled: !!haClient,
    omadaEnabled: !!omadaClient,
    aiEnabled: !!aiClient,
  });
}

// Re-export common utilities
export { toToolResult, wrapToolHandler, Permission } from './common.js';

// Re-export domain-specific registration functions for selective use
export { registerHomeAssistantTools } from './homeassistant/index.js';
export { registerOmadaTools } from './omada/index.js';
export { registerAITools } from './ai/index.js';
