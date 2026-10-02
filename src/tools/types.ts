/**
 * Tool type definitions
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';

export interface ToolRegistration {
  register(server: McpServer, client: HaClient, aiClient?: LocalAIClient): void;
}
