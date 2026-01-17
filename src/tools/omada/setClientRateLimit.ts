import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerSetClientRateLimitTool(server: McpServer, client: OmadaClient): void {
    const inputSchema = z.object({
        clientMac: z.string().min(1, 'clientMac (MAC address) is required'),
        downLimit: z.number().positive('downLimit must be a positive number (in Kbps)'),
        upLimit: z.number().positive('upLimit must be a positive number (in Kbps)'),
        siteId: z.string().min(1).optional(),
    });

    server.registerTool(
        'omada_setClientRateLimit',
        {
            description: 'Set custom bandwidth limits for a client (download/upload in Kbps)',
            inputSchema: inputSchema.shape,
        },
        wrapToolHandler('omada_setClientRateLimit', async ({ clientMac, downLimit, upLimit, siteId }) =>
            toToolResult(await client.setClientRateLimit(clientMac, downLimit, upLimit, siteId)),
            Permission.CONTROL
        )
    );
}
