import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerDeleteClientTool(server: McpServer, client: OmadaClient): void {
    const inputSchema = z.object({
        clientMac: z.string().min(1, 'clientMac (MAC address) is required'),
        siteId: z.string().min(1).optional(),
    });

    server.registerTool(
        'omada_deleteClient',
        {
            description:
                "Delete the controller's record of a client by MAC: its name, history and block state. " +
                'Use it to clear a block that omada_unblockClient can no longer reach (the device stays refused by the access points although Omada lists nothing). ' +
                'The device is treated as new when it reconnects. Irreversible for that history - confirm with the user before applying.',
            inputSchema,
        },
        wrapToolHandler('omada_deleteClient', async ({ clientMac, siteId }: z.infer<typeof inputSchema>) =>
            toToolResult(await client.deleteClient(clientMac, siteId)),
            Permission.CONFIGURE
        )
    );
}
