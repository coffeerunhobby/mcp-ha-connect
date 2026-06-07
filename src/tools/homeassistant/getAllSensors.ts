/**
 * getAllSensors tool - Get all sensor entities
 * Returns paginated, lightweight entities by default to reduce response size.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { toLightweight } from '../../types/index.js';
import { haPaginationSchema, toToolResult, wrapToolHandler, Permission, paginateArray } from '../common.js';

export function registerGetAllSensorsTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getAllSensors',
    {
      description: 'Get all sensor states from Home Assistant (sensor.* and binary_sensor.* entities). Returns paginated lightweight entities by default (50 per page). Use includeAttributes=true for full entity data.',
      inputSchema: haPaginationSchema.shape,
    },
    wrapToolHandler('getAllSensors', async (args) => {
      const { page, pageSize, includeAttributes } = args;
      const sensors = await client.getAllSensors();

      if (includeAttributes) {
        // Return full entities with all attributes
        const result = paginateArray(sensors, page, pageSize);
        return toToolResult({
          page: result.page,
          pageSize: result.pageSize,
          totalCount: result.totalCount,
          totalPages: result.totalPages,
          entities: result.items,
        });
      }

      // Default: return lightweight entities
      const lightweight = sensors.map(toLightweight);
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
