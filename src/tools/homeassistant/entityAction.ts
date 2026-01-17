/**
 * entityAction tool - Simple entity actions (turn_on, turn_off, toggle)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { entityActionSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';
import type { z } from 'zod';

type EntityActionArgs = z.infer<typeof entityActionSchema>;

export function registerEntityActionTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'entityAction',
    {
      description: 'Perform a simple action on an entity (turn_on, turn_off, toggle). Automatically detects the domain.',
      inputSchema: entityActionSchema.shape,
    },
    wrapToolHandler('entityAction', async ({ entity_id, action }: EntityActionArgs) => {
      const domain = entity_id.split('.')[0];
      if (!domain) {
        return toToolResult({ error: 'Invalid entity_id format' }, true);
      }
      const result = await client.callService({
        domain,
        service: action,
        target: { entity_id },
      });
      return toToolResult({ success: true, entity_id, action, context: result.context });
    }, Permission.CONTROL)
  );
}
