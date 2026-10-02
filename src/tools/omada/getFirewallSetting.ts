import type { McpServer } from '@modelcontextprotocol/server';
import type { OmadaClient } from '../../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetFirewallSettingTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getFirewallSetting',
        {
            description: 'Get firewall configuration for a site',
            inputSchema: siteInputSchema,
        },
        wrapToolHandler('omada_getFirewallSetting', async ({ siteId }) => toToolResult(await client.getFirewallSetting(siteId)), Permission.QUERY)
    );
}
