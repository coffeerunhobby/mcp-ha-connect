/**
 * getAutomationTrace tool - Get automation execution history
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { HaClient } from '../../haClient/index.js';
import { entityIdSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export const getAutomationTraceSchema = entityIdSchema.extend({
  limit: z.number().int().min(1).max(20).optional().describe('How many of the most recent runs to return (default 5, max 20)'),
});

type GetAutomationTraceArgs = z.infer<typeof getAutomationTraceSchema>;

export function registerGetAutomationTraceTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getAutomationTrace',
    {
      description:
        'Get the most recent runs of an automation, newest first: when it ran, what triggered it, how it ended (state, last step, error). ' +
        'Only automations with an id (created in the UI, or YAML with an id) have traces.',
      inputSchema: getAutomationTraceSchema,
    },
    wrapToolHandler('getAutomationTrace', async ({ entity_id, limit }: GetAutomationTraceArgs) => {
      const traces = await client.getAutomationTrace(entity_id, limit);
      return toToolResult({ entity_id, trace_count: traces.length, traces });
    }, Permission.QUERY)
  );
}
