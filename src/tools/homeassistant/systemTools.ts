/**
 * System tools - Restart, logs, updates
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { emptySchema, systemLogSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';
import type { z } from 'zod';

type SystemLogArgs = z.infer<typeof systemLogSchema>;

export function registerRestartHomeAssistantTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'restartHomeAssistant',
    {
      description: 'Restart the Home Assistant server. Use with caution.',
      inputSchema: emptySchema.shape,
    },
    wrapToolHandler('restartHomeAssistant', async () => {
      await client.restartServer();
      return toToolResult({ success: true, message: 'Home Assistant restart initiated' });
    }, Permission.ADMIN)
  );
}

export function registerGetSystemLogTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getSystemLog',
    {
      description: 'Get system log entries from the Home Assistant logbook. Shows recent events and state changes. Default: last 24h, 100 entries.',
      inputSchema: systemLogSchema.shape,
    },
    wrapToolHandler('getSystemLog', async ({ hours = 24, entity_id, limit = 100 }: SystemLogArgs) => {
      const log = await client.getSystemLog({ hours, entity_id, limit });
      return toToolResult({ hours, limit, entity_id: entity_id || null, entries: log });
    }, Permission.ADMIN)
  );
}

export function registerCheckUpdatesTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'checkUpdates',
    {
      description: 'Check for available updates for Home Assistant Core, Supervisor, and OS. Requires Home Assistant OS or Supervised installation.',
      inputSchema: emptySchema.shape,
    },
    wrapToolHandler('checkUpdates', async () => {
      const updates = await client.getAvailableUpdates();
      return toToolResult(updates);
    }, Permission.ADMIN)
  );
}
