/**
 * AI tools index - registers all AI-powered MCP tools
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { LocalAIClient } from '../../localAI/index.js';
import { logger } from '../../utils/logger.js';

import { registerAnalyzeSensorsTool } from './analyzeSensors.js';

/** Registers nothing without an AI client (AI_PLUGIN_ENABLED=false or AI_PROVIDER=none). */
export function registerAITools(server: McpServer, aiClient?: LocalAIClient): number {
  if (!aiClient) {
    logger.debug('AI plugin off - no AI tools registered');
    return 0;
  }
  logger.debug('Registering AI tools');
  let toolCount = 0;

  registerAnalyzeSensorsTool(server, aiClient);
  toolCount += 1;

  logger.info('AI tools registered', { toolCount });
  return toolCount;
}
