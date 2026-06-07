/**
 * listEntities tool - List entities with optional filtering
 * Returns lightweight entities by default to reduce response size.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { toLightweight } from '../../types/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';

const listEntitiesSchema = z.object({
  domain: z.string().optional().describe('Filter by domain (e.g., "light", "switch", "sensor")'),
  search: z.string().optional().describe('Search query to filter by entity_id or friendly_name'),
  state: z.string().optional().describe('Filter by state (e.g., "on", "off", "unavailable")'),
  limit: z.number().int().min(1).max(200).default(50).describe('Maximum number of entities to return (1-200, default 50)'),
  includeAttributes: z.boolean().default(false).describe('Include full attributes (increases response size significantly)'),
});

type ListEntitiesArgs = z.infer<typeof listEntitiesSchema>;

export function registerListEntitiesTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'listEntities',
    {
      description: 'List entities with optional filtering by domain, state, or search query. Returns lightweight entities by default (limit 50). Use includeAttributes=true for full entity data.',
      inputSchema: listEntitiesSchema.shape,
    },
    wrapToolHandler('listEntities', async (args: ListEntitiesArgs) => {
      const { includeAttributes, ...filterArgs } = args;
      const allEntities = await client.listEntities(filterArgs);

      // Convert to lightweight entities unless full attributes requested
      const entities = includeAttributes ? allEntities : allEntities.map(toLightweight);

      return toToolResult({
        count: entities.length,
        limit: args.limit,
        filters: { domain: args.domain, search: args.search, state: args.state },
        entities,
      });
    }, Permission.QUERY)
  );
}
