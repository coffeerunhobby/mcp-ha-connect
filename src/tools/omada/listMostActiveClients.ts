import type { McpServer } from '@modelcontextprotocol/server';
import type { OmadaClient } from '../../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerListMostActiveClientsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_listMostActiveClients',
        {
            description: 'Get the most active clients sorted by total traffic',
            inputSchema: siteInputSchema,
        },
        wrapToolHandler('omada_listMostActiveClients', async ({ siteId }) => toToolResult(await client.listMostActiveClients(siteId)), Permission.QUERY)
    );
}
