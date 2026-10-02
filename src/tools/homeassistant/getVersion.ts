/**
 * getVersion tool - Get Home Assistant version info
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { HaClient } from '../../haClient/index.js';
import { emptySchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetVersionTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getVersion',
    {
      description: 'Get Home Assistant version and configuration information.',
      inputSchema: emptySchema,
    },
    wrapToolHandler('getVersion', async () => {
      const version = await client.getVersion();
      return toToolResult(version);
    }, Permission.QUERY)
  );
}
