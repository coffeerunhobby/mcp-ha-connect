import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { OmadaClient } from '../../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetInternetInfoTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getInternetInfo',
        {
            description: 'Get internet connection configuration for a site',
            inputSchema: siteInputSchema.shape,
        },
        wrapToolHandler('omada_getInternetInfo', async ({ siteId }) => toToolResult(await client.getInternetInfo(siteId)), Permission.QUERY)
    );
}
