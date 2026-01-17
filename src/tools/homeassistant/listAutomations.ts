/**
 * listAutomations tool - List all automations
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { automationFilterSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';
import type { z } from 'zod';

type ListAutomationsArgs = z.infer<typeof automationFilterSchema>;

export function registerListAutomationsTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'listAutomations',
    {
      description: 'List all Home Assistant automations with their status and last triggered time.',
      inputSchema: automationFilterSchema.shape,
    },
    wrapToolHandler('listAutomations', async ({ state }: ListAutomationsArgs) => {
      let automations = await client.getAutomations();
      if (state) {
        automations = automations.filter(a => a.state === state);
      }
      return toToolResult({ count: automations.length, filter: state ? { state } : null, automations });
    }, Permission.QUERY)
  );
}
