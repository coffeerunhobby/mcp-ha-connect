/**
 * getHistory tool - Get historical data for an entity
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { historySchema, toToolResult, wrapToolHandler, Permission } from '../common.js';
import type { z } from 'zod';

type HistoryArgs = z.infer<typeof historySchema>;

export function registerGetHistoryTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getHistory',
    {
      description: 'Get historical data for an entity.',
      inputSchema: historySchema.shape,
    },
    wrapToolHandler('getHistory', async ({ entity_id, hours = 24 }: HistoryArgs) => {
      const history = await client.getHistory(entity_id, hours);
      return toToolResult(history);
    }, Permission.QUERY)
  );
}
