import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerSetSsidEnabledTool(server: McpServer, client: OmadaClient): void {
    const inputSchema = z.object({
        ssid: z.string().min(1, 'ssid (SSID name or ssidId) is required'),
        enabled: z.boolean(),
        siteId: z.string().min(1).optional(),
    });

    server.registerTool(
        'omada_setSsidEnabled',
        {
            description:
                'Turn an SSID (WiFi network, e.g. the guest network) on or off by name or ssidId. ' +
                'Omada has no direct SSID switch, so disabling applies a 24/7 "radio off" WLAN schedule ' +
                '(the SSID stops broadcasting entirely) and enabling removes it — fully reversible. ' +
                'All clients on that SSID lose connectivity when disabled - confirm with the user before applying.',
            inputSchema: inputSchema.shape,
        },
        wrapToolHandler('omada_setSsidEnabled', async ({ ssid, enabled, siteId }) =>
            toToolResult(await client.setSsidEnabled(ssid, enabled, siteId)),
            Permission.CONTROL
        )
    );
}
