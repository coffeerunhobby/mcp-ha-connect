import type { McpServer } from '@modelcontextprotocol/server';
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
                'Use omada_listClients first to find the exact MAC. This affects real network connectivity - confirm with the user before applying. ' +
                "Caution: a blocked device cannot reconnect, and once the controller stops treating it as current, Omada's API can no longer unblock it. " +
                'For recurring schedules (e.g. a curfew) prefer an Omada time-range access rule on the controller over daily block/unblock calls.',
            inputSchema: inputSchema,
        },
        wrapToolHandler('omada_blockClient', async ({ clientMac, siteId }) =>
            toToolResult(await client.blockClient(clientMac, siteId)),
            Permission.CONTROL
        )
    );
}
