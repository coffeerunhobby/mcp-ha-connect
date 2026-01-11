/**
 * Scene and Script tools - Activate scenes and run scripts
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import { entityIdSchema, runScriptSchema, toToolResult, wrapToolHandler } from './common.js';
import type { z } from 'zod';

type EntityIdArgs = z.infer<typeof entityIdSchema>;
type RunScriptArgs = z.infer<typeof runScriptSchema>;

export function registerActivateSceneTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'activateScene',
    {
      description: 'Activate a Home Assistant scene.',
      inputSchema: entityIdSchema.shape,
    },
    wrapToolHandler('activateScene', async ({ entity_id }: EntityIdArgs) => {
      const result = await client.callService({
        domain: 'scene',
        service: 'turn_on',
        target: { entity_id },
      });
      return toToolResult({ success: true, entity_id, action: 'activated', context: result.context });
    })
  );
}

export function registerRunScriptTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'runScript',
    {
      description: 'Run a Home Assistant script with optional variables.',
      inputSchema: runScriptSchema.shape,
    },
    wrapToolHandler('runScript', async ({ entity_id, variables }: RunScriptArgs) => {
      const result = await client.callService({
        domain: 'script',
        service: 'turn_on',
        target: { entity_id },
        service_data: variables as Record<string, unknown> | undefined,
      });
      return toToolResult({ success: true, entity_id, action: 'executed', context: result.context });
    })
  );
}
