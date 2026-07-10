import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerCyclePoePortTool(server: McpServer, client: OmadaClient): void {
    const inputSchema = z.object({
        switchMac: z.string().min(1, 'switchMac (MAC address of the Omada switch) is required'),
        ports: z.array(z.number().int().positive()).min(1, 'at least one port number is required'),
        siteId: z.string().min(1).optional(),
    });

    server.registerTool(
        'omada_cyclePoePort',
        {
            description:
                'Power-cycle PoE on one or more switch ports — a remote hard-reboot for whatever the ports power ' +
                '(access points, cameras, PoE sensors). The switch briefly cuts and restores power on ONLY the given ' +
                'ports; the switch itself and other ports are unaffected. Use omada_listDevices to find the switch MAC ' +
                'and identify which port powers which device first. The powered device goes down for the cycle - ' +
                'confirm with the user before applying.',
            inputSchema: inputSchema.shape,
        },
        wrapToolHandler('omada_cyclePoePort', async ({ switchMac, ports, siteId }) => {
            await client.cyclePoePorts(switchMac, ports, siteId);
            return toToolResult({ switchMac, ports, status: 'poe-recovery triggered' });
        },
            Permission.CONTROL
        )
    );
}
