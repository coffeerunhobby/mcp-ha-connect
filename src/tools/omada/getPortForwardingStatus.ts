import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';
import { createPaginationSchema } from '../utils/pagination-schema.js';

const portForwardingSchema = z.object({
    type: z.enum(['User', 'UPnP']).describe('Port forwarding type: User (manually configured) or UPnP (automatically configured)'),
    siteId: z.string().min(1).describe('Site ID (required)'),
    ...createPaginationSchema(10),
});

export function registerGetPortForwardingStatusTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getPortForwardingStatus',
        {
            description: 'Get port forwarding rules (User or UPnP)',
            inputSchema: portForwardingSchema.shape,
        },
        wrapToolHandler('omada_getPortForwardingStatus', async ({ type, siteId, page = 1, pageSize = 10 }) =>
            toToolResult(await client.getPortForwardingStatus(type, siteId, page, pageSize)),
            Permission.QUERY
        )
    );
}
