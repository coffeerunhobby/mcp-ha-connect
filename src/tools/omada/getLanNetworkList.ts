import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { OmadaClient } from '../../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetLanNetworkListTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getLanNetworkList',
        {
            description: 'Get LAN network configuration list',
            inputSchema: siteInputSchema.shape,
        },
        wrapToolHandler('omada_getLanNetworkList', async ({ siteId }) => toToolResult(await client.getLanNetworkList(siteId)), Permission.QUERY)
    );
}
