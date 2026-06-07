import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerBlockClientTool(server: McpServer, client: OmadaClient): void {
    const inputSchema = z.object({
        clientMac: z.string().min(1, 'clientMac (MAC address) is required'),
        siteId: z.string().min(1).optional(),
    });

    server.registerTool(
        'omada_blockClient',
        {
            description:
                'Block a client from the network by MAC address. The client is denied all network access until unblocked. ' +
                'Use omada_listClients first to find the exact MAC. This affects real network connectivity - confirm with the user before applying.',
            inputSchema: inputSchema.shape,
        },
        wrapToolHandler('omada_blockClient', async ({ clientMac, siteId }) =>
            toToolResult(await client.blockClient(clientMac, siteId)),
            Permission.CONTROL
        )
    );
}
