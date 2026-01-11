/**
 * getAutomationTrace tool - Get automation execution history
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import { entityIdSchema, toToolResult, wrapToolHandler } from './common.js';
import type { z } from 'zod';

type EntityIdArgs = z.infer<typeof entityIdSchema>;

export function registerGetAutomationTraceTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getAutomationTrace',
    {
      description: 'Get the execution trace (history) of an automation. Shows when it was triggered and what actions were executed.',
      inputSchema: entityIdSchema.shape,
    },
    wrapToolHandler('getAutomationTrace', async ({ entity_id }: EntityIdArgs) => {
      const trace = await client.getAutomationTrace(entity_id);
      return toToolResult({ entity_id, trace_count: Array.isArray(trace) ? trace.length : 0, traces: trace });
    })
  );
}
