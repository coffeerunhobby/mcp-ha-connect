/**
 * listEntities tool - List entities with optional filtering
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { listEntitiesSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';
import type { z } from 'zod';

type ListEntitiesArgs = z.infer<typeof listEntitiesSchema>;

export function registerListEntitiesTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'listEntities',
    {
      description: 'List entities with optional filtering by domain, state, or search query.',
      inputSchema: listEntitiesSchema.shape,
    },
    wrapToolHandler('listEntities', async (args: ListEntitiesArgs) => {
      const entities = await client.listEntities(args);
      return toToolResult({ count: entities.length, filters: args, entities });
    }, Permission.QUERY)
  );
}
