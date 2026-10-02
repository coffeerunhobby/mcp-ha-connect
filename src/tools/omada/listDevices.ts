import type { McpServer } from '@modelcontextprotocol/server';
import type { OmadaClient } from '../../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerListDevicesTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_listDevices',
        {
            description: 'List all network devices (APs, switches, gateways) in a site',
            inputSchema: siteInputSchema,
        },
        wrapToolHandler('omada_listDevices', async ({ siteId }) => toToolResult(await client.listDevices(siteId)), Permission.QUERY)
    );
}
