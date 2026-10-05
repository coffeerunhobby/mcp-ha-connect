import type { McpServer } from '@modelcontextprotocol/server';
import type { OmadaClient } from '../../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetSiteNtpStatusTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getSiteNtpStatus',
        {
            description: 'Get the NTP (network time) server configuration and status for a site',
            inputSchema: siteInputSchema,
        },
        wrapToolHandler('omada_getSiteNtpStatus', async ({ siteId }) => toToolResult(await client.getSiteNtpStatus(siteId)), Permission.QUERY)
    );
}
