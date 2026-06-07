/**
 * getEntitiesByDomain tool - Get all entities for a specific domain
 * Returns paginated, lightweight entities by default to reduce response size.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { toLightweight } from '../../types/index.js';
import { toToolResult, wrapToolHandler, Permission, paginateArray } from '../common.js';

const getEntitiesByDomainSchema = z.object({
  domain: z.string().describe('Domain name (e.g., "light", "sensor", "switch", "climate")'),
  page: z.number().int().min(1).default(1).describe('Page number (starts at 1)'),
  pageSize: z.number().int().min(1).max(200).default(50).describe('Entities per page (1-200, default 50)'),
  includeAttributes: z.boolean().default(false).describe('Include full attributes (increases response size significantly)'),
});

export function registerGetEntitiesByDomainTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getEntitiesByDomain',
    {
      description: 'Get all entities for a specific domain (e.g., all lights, all sensors). Returns paginated lightweight entities by default (50 per page). Use includeAttributes=true for full entity data.',
      inputSchema: getEntitiesByDomainSchema.shape,
    },
    wrapToolHandler('getEntitiesByDomain', async (args) => {
      const { domain, page, pageSize, includeAttributes } = args;
      const allEntities = await client.getEntitiesByDomain(domain);

      if (includeAttributes) {
        // Return full entities with all attributes
        const result = paginateArray(allEntities, page, pageSize);
        return toToolResult({
          domain,
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
        domain,
        page: result.page,
        pageSize: result.pageSize,
        totalCount: result.totalCount,
        totalPages: result.totalPages,
        entities: result.items,
      });
    }, Permission.QUERY)
  );
}
