/**
 * triggerAutomation tool - Manually trigger an automation
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import { triggerAutomationSchema, toToolResult, wrapToolHandler } from './common.js';
import type { z } from 'zod';

type TriggerAutomationArgs = z.infer<typeof triggerAutomationSchema>;

export function registerTriggerAutomationTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'triggerAutomation',
    {
      description: 'Manually trigger a Home Assistant automation. Can optionally pass variables to the automation.',
      inputSchema: triggerAutomationSchema.shape,
    },
    wrapToolHandler('triggerAutomation', async ({ entity_id, variables }: TriggerAutomationArgs) => {
      const result = await client.triggerAutomation(entity_id, variables as Record<string, unknown> | undefined);
      return toToolResult({ success: true, entity_id, message: 'Automation triggered successfully', context: result.context });
    })
  );
}
