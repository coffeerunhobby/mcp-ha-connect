import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { OmadaClient } from '../../omadaClient/index.js';
import { stackIdSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetSwitchStackDetailTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getSwitchStackDetail',
        {
            description: 'Get detailed information about a switch stack',
            inputSchema: stackIdSchema.shape,
        },
        wrapToolHandler('omada_getSwitchStackDetail', async ({ stackId, siteId }) => toToolResult(await client.getSwitchStackDetail(stackId, siteId)), Permission.QUERY)
    );
}
