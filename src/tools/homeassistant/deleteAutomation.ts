/**
 * deleteAutomation tool - Delete an automation
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { automationIdSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';
import type { z } from 'zod';

type DeleteAutomationArgs = z.infer<typeof automationIdSchema>;

export function registerDeleteAutomationTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'deleteAutomation',
    {
      description: 'Delete a Home Assistant automation. Only works for automations created via the UI/API.',
      inputSchema: automationIdSchema.shape,
    },
    wrapToolHandler('deleteAutomation', async ({ automation_id }: DeleteAutomationArgs) => {
      await client.deleteAutomation(automation_id);
      return toToolResult({ success: true, automation_id, message: 'Automation deleted successfully' });
    }, Permission.CONFIGURE)
  );
}
