/**
 * AI tools index - registers all AI-powered MCP tools
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocalAIClient } from '../../localAI/index.js';
import { logger } from '../../utils/logger.js';

import { registerAnalyzeSensorsTool } from './analyzeSensors.js';

export function registerAITools(server: McpServer, aiClient?: LocalAIClient): number {
  logger.debug('Registering AI tools');
  let toolCount = 0;

  registerAnalyzeSensorsTool(server, aiClient);
  toolCount += 1;

  logger.info('AI tools registered', { toolCount, aiEnabled: !!aiClient });
  return toolCount;
}
