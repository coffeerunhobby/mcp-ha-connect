/**
 * getStates tool - Get all entity states from Home Assistant
 * Returns paginated, lightweight entities by default to reduce response size.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { toLightweight } from '../../types/index.js';
import { haPaginationSchema, toToolResult, wrapToolHandler, Permission, paginateArray } from '../common.js';

export function registerGetStatesTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getStates',
    {
      description: 'Get all entity states from Home Assistant. Returns paginated lightweight entities by default (50 per page). Use includeAttributes=true for full entity data.',
      inputSchema: haPaginationSchema.shape,
    },
    wrapToolHandler('getStates', async (args) => {
      const { page, pageSize, includeAttributes } = args;
      const states = await client.getStates();

      if (includeAttributes) {
        // Return full entities with all attributes
        const result = paginateArray(states, page, pageSize);
        return toToolResult({
          page: result.page,
          pageSize: result.pageSize,
          totalCount: result.totalCount,
          totalPages: result.totalPages,
          entities: result.items,
        });
      }

      // Default: return lightweight entities
      const lightweight = states.map(toLightweight);
      const result = paginateArray(lightweight, page, pageSize);
      return toToolResult({
        page: result.page,
        pageSize: result.pageSize,
        totalCount: result.totalCount,
        totalPages: result.totalPages,
        entities: result.items,
      });
    }, Permission.QUERY)
  );
}
