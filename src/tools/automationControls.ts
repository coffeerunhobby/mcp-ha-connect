/**
 * Automation control tools - Enable, disable, toggle, reload automations
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import { entityIdSchema, emptySchema, toToolResult, wrapToolHandler } from './common.js';
import type { z } from 'zod';

type EntityIdArgs = z.infer<typeof entityIdSchema>;

export function registerEnableAutomationTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'enableAutomation',
    {
      description: 'Enable a disabled Home Assistant automation.',
      inputSchema: entityIdSchema.shape,
    },
    wrapToolHandler('enableAutomation', async ({ entity_id }: EntityIdArgs) => {
      const result = await client.enableAutomation(entity_id);
      return toToolResult({ success: true, entity_id, action: 'enabled', context: result.context });
    })
  );
}

export function registerDisableAutomationTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'disableAutomation',
    {
      description: 'Disable a Home Assistant automation.',
      inputSchema: entityIdSchema.shape,
    },
    wrapToolHandler('disableAutomation', async ({ entity_id }: EntityIdArgs) => {
      const result = await client.disableAutomation(entity_id);
      return toToolResult({ success: true, entity_id, action: 'disabled', context: result.context });
    })
  );
}

export function registerToggleAutomationTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'toggleAutomation',
    {
      description: 'Toggle a Home Assistant automation (enable if disabled, disable if enabled).',
      inputSchema: entityIdSchema.shape,
    },
    wrapToolHandler('toggleAutomation', async ({ entity_id }: EntityIdArgs) => {
      const result = await client.toggleAutomation(entity_id);
      return toToolResult({ success: true, entity_id, action: 'toggled', context: result.context });
    })
  );
}

export function registerReloadAutomationsTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'reloadAutomations',
    {
      description: 'Reload all automations from the Home Assistant configuration. Useful after editing automation YAML files.',
      inputSchema: emptySchema.shape,
    },
    wrapToolHandler('reloadAutomations', async () => {
      await client.reloadAutomations();
      return toToolResult({ success: true, message: 'Automations reloaded from configuration' });
    })
  );
}
