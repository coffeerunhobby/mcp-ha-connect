import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerSetClientRateLimitProfileTool(server: McpServer, client: OmadaClient): void {
    const inputSchema = z.object({
        clientMac: z.string().min(1, 'clientMac (MAC address) is required'),
        profileId: z.string().min(1, 'profileId (rate limit profile ID) is required'),
        siteId: z.string().min(1).optional(),
    });

    server.registerTool(
        'omada_setClientRateLimitProfile',
        {
            description: 'Apply a rate limit profile to a client',
            inputSchema: inputSchema.shape,
        },
        wrapToolHandler('omada_setClientRateLimitProfile', async ({ clientMac, profileId, siteId }) =>
            toToolResult(await client.setClientRateLimitProfile(clientMac, profileId, siteId)),
            Permission.CONTROL
        )
    );
}
