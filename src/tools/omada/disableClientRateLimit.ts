import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerDisableClientRateLimitTool(server: McpServer, client: OmadaClient): void {
    const inputSchema = z.object({
        clientMac: z.string().min(1, 'clientMac (MAC address) is required'),
        siteId: z.string().min(1).optional(),
    });

    server.registerTool(
        'omada_disableClientRateLimit',
        {
            description: 'Remove bandwidth limits from a client',
            inputSchema: inputSchema.shape,
        },
        wrapToolHandler('omada_disableClientRateLimit', async ({ clientMac, siteId }) =>
            toToolResult(await client.disableClientRateLimit(clientMac, siteId)),
            Permission.CONTROL
        )
    );
}
