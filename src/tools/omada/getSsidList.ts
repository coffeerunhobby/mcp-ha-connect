import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';

const ssidListSchema = z.object({
    wlanId: z.string().min(1, 'wlanId is required. Use getWlanGroupList to get available WLAN group IDs.'),
    siteId: z.string().min(1).optional(),
});

export function registerGetSsidListTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getSsidList',
        {
            description: 'Get SSID list for a WLAN group',
            inputSchema: ssidListSchema.shape,
        },
        wrapToolHandler('omada_getSsidList', async ({ wlanId, siteId }) => toToolResult(await client.getSsidList(wlanId, siteId)), Permission.QUERY)
    );
}
