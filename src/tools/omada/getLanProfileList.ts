import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { OmadaClient } from '../../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetLanProfileListTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getLanProfileList',
        {
            description: 'Get LAN profile configuration list',
            inputSchema: siteInputSchema.shape,
        },
        wrapToolHandler('omada_getLanProfileList', async ({ siteId }) => toToolResult(await client.getLanProfileList(siteId)), Permission.QUERY)
    );
}
