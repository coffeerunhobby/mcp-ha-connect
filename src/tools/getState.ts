/**
 * getState tool - Get state of a specific entity
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import { entityIdSchema, toToolResult, wrapToolHandler } from './common.js';

export function registerGetStateTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getState',
    {
      description: 'Get the state of a specific entity by entity_id.',
      inputSchema: entityIdSchema.shape,
    },
    wrapToolHandler('getState', async ({ entity_id }: { entity_id: string }) => {
      const state = await client.getState(entity_id);
      if (!state) {
        return toToolResult({ error: 'Entity not found', entity_id }, true);
      }
      return toToolResult(state);
    })
  );
}
