/**
 * listAutomations tool - List all automations
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { automationFilterSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';
import type { z } from 'zod';

type ListAutomationsArgs = z.infer<typeof automationFilterSchema>;

/**
 * Shared handler — used by the MCP registration below AND the chat face
 * (`POST /api/tools/listAutomations`) so both doors behave identically.
 */
export function createListAutomationsHandler(client: HaClient) {
  return wrapToolHandler('listAutomations', async ({ state }: ListAutomationsArgs) => {
    let automations = await client.getAutomations();
    if (state) {
      automations = automations.filter(a => a.state === state);
    }
    return toToolResult({ count: automations.length, filter: state ? { state } : null, automations });
  }, Permission.QUERY);
}

export function registerListAutomationsTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'listAutomations',
    {
      description: 'List all Home Assistant automations with their status and last triggered time.',
      inputSchema: automationFilterSchema.shape,
    },
    createListAutomationsHandler(client)
  );
}
