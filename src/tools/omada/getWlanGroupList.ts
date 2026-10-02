import type { McpServer } from '@modelcontextprotocol/server';
import type { OmadaClient } from '../../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetWlanGroupListTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getWlanGroupList',
        {
            description: 'Get WLAN group configuration list',
            inputSchema: siteInputSchema,
        },
        wrapToolHandler('omada_getWlanGroupList', async ({ siteId }) => toToolResult(await client.getWlanGroupList(siteId)), Permission.QUERY)
    );
}
