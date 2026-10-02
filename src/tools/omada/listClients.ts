import type { McpServer } from '@modelcontextprotocol/server';
import type { OmadaClient } from '../../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerListClientsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_listClients',
        {
            description: 'List all connected clients (devices/users) in a site',
            inputSchema: siteInputSchema,
        },
        wrapToolHandler('omada_listClients', async ({ siteId }) => toToolResult(await client.listClients(siteId)), Permission.QUERY)
    );
}
