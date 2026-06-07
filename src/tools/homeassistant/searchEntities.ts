/**
 * searchEntities tool - Search for entities by name or entity_id
 * Returns paginated, lightweight entities by default to reduce response size.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { toLightweight } from '../../types/index.js';
import { toToolResult, wrapToolHandler, Permission, paginateArray } from '../common.js';

const searchEntitiesSchema = z.object({
  query: z.string().describe('Search query (searches in entity_id and friendly_name)'),
  page: z.number().int().min(1).default(1).describe('Page number (starts at 1)'),
  pageSize: z.number().int().min(1).max(200).default(50).describe('Entities per page (1-200, default 50)'),
  includeAttributes: z.boolean().default(false).describe('Include full attributes (increases response size significantly)'),
});

export function registerSearchEntitiesTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'searchEntities',
    {
      description: `Search for entities by name or entity_id. Returns paginated lightweight entities by default (50 per page). Use includeAttributes=true for full entity data.

Note: For queries about people, family members, or "who's home?", use the listPersons tool instead.`,
      inputSchema: searchEntitiesSchema.shape,
    },
    wrapToolHandler('searchEntities', async (args) => {
      const { query, page, pageSize, includeAttributes } = args;
      const allEntities = await client.searchEntities(query);

      if (includeAttributes) {
        // Return full entities with all attributes
        const result = paginateArray(allEntities, page, pageSize);
        return toToolResult({
          query,
          page: result.page,
          pageSize: result.pageSize,
          totalCount: result.totalCount,
          totalPages: result.totalPages,
          entities: result.items,
        });
      }

      // Default: return lightweight entities
      const lightweight = allEntities.map(toLightweight);
      const result = paginateArray(lightweight, page, pageSize);
      return toToolResult({
        query,
        page: result.page,
        pageSize: result.pageSize,
        totalCount: result.totalCount,
        totalPages: result.totalPages,
        entities: result.items,
      });
    }, Permission.QUERY)
  );
}
