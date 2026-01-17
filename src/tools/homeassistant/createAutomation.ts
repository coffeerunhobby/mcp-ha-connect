/**
 * createAutomation tool - Create a new automation
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import type { AutomationTrigger, AutomationCondition, AutomationAction } from '../../types/index.js';
import { createAutomationSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';
import type { z } from 'zod';

type CreateAutomationArgs = z.infer<typeof createAutomationSchema>;

export function registerCreateAutomationTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'createAutomation',
    {
      description: 'Create a new Home Assistant automation. Requires specifying triggers, conditions (optional), and actions.',
      inputSchema: createAutomationSchema.shape,
    },
    wrapToolHandler('createAutomation', async (args: CreateAutomationArgs) => {
      if (!args.alias || !args.trigger || !args.action) {
        return toToolResult({ error: 'alias, trigger, and action are required' }, true);
      }
      const result = await client.createAutomation({
        alias: args.alias,
        description: args.description,
        mode: args.mode,
        trigger: args.trigger as AutomationTrigger | AutomationTrigger[],
        condition: args.condition as AutomationCondition | AutomationCondition[] | undefined,
        action: args.action as AutomationAction | AutomationAction[],
      });
      return toToolResult({ success: true, automation_id: result.id, alias: args.alias, message: 'Automation created successfully' });
    }, Permission.CONFIGURE)
  );
}
