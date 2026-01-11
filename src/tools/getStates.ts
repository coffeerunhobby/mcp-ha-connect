/**
 * getStates tool - Get all entity states from Home Assistant
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import { emptySchema, toToolResult, wrapToolHandler } from './common.js';

export function registerGetStatesTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getStates',
    {
      description: 'Get all entity states from Home Assistant.',
      inputSchema: emptySchema.shape,
    },
    wrapToolHandler('getStates', async () => {
      const states = await client.getStates();
      return toToolResult({ count: states.length, entities: states });
    })
  );
}
