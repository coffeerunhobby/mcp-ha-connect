/**
 * callService tool - Call a Home Assistant service
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import type { ServiceCallData } from '../types/index.js';
import { serviceCallSchema, toToolResult, wrapToolHandler } from './common.js';

export function registerCallServiceTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'callService',
    {
      description: 'Call a Home Assistant service (e.g., turn on a light, set temperature).',
      inputSchema: serviceCallSchema.shape,
    },
    wrapToolHandler('callService', async (args: ServiceCallData) => {
      if (!args.domain || !args.service) {
        return toToolResult({ error: 'domain and service are required' }, true);
      }
      const result = await client.callService(args);
      return toToolResult({ success: true, context: result.context });
    })
  );
}
