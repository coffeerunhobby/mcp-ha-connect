import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';

const ssidDetailSchema = z.object({
    wlanId: z.string().min(1, 'wlanId is required. Use getWlanGroupList to get available WLAN group IDs.'),
    ssidId: z.string().min(1, 'ssidId is required. Use getSsidList to get available SSID IDs.'),
    siteId: z.string().min(1).optional(),
});

export function registerGetSsidDetailTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getSsidDetail',
        {
            description: 'Get detailed SSID configuration',
            inputSchema: ssidDetailSchema.shape,
        },
        wrapToolHandler('omada_getSsidDetail', async ({ wlanId, ssidId, siteId }) => toToolResult(await client.getSsidDetail(wlanId, ssidId, siteId)), Permission.QUERY)
    );
}
