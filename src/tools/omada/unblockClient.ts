import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerUnblockClientTool(server: McpServer, client: OmadaClient): void {
    const inputSchema = z.object({
        clientMac: z.string().min(1, 'clientMac (MAC address) is required'),
        siteId: z.string().min(1).optional(),
    });

    server.registerTool(
        'omada_unblockClient',
        {
            description:
                'Unblock a previously blocked client by MAC address, restoring its network access. ' +
                'Use omada_listClients first to find the exact MAC.',
            inputSchema: inputSchema.shape,
        },
        wrapToolHandler('omada_unblockClient', async ({ clientMac, siteId }) =>
            toToolResult(await client.unblockClient(clientMac, siteId)),
            Permission.CONTROL
        )
    );
}
