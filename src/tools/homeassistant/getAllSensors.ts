/**
 * getAllSensors tool - Get all sensor entities
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { emptySchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetAllSensorsTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getAllSensors',
    {
      description: 'Get all sensor states from Home Assistant (sensor.* and binary_sensor.* entities).',
      inputSchema: emptySchema.shape,
    },
    wrapToolHandler('getAllSensors', async () => {
      const sensors = await client.getAllSensors();
      return toToolResult(sensors);
    }, Permission.QUERY)
  );
}
