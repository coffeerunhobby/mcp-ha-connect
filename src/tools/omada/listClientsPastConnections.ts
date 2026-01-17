import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';
import { createPaginationSchema } from '../utils/pagination-schema.js';

const clientsPastConnectionsInputSchema = z.object({
    siteId: z.string().optional().describe('Optional site ID. If not provided, uses the default site from configuration.'),
    ...createPaginationSchema(50),
    sortLastSeen: z
        .enum(['asc', 'desc'])
        .optional()
        .describe('Sort by last seen time. Values: asc or desc. When multiple sorts exist, first one takes effect.'),
    timeStart: z.number().int().optional().describe('Filter by time range start timestamp (milliseconds).'),
    timeEnd: z.number().int().optional().describe('Filter by time range end timestamp (milliseconds).'),
    guest: z.boolean().optional().describe('Filter by guest status (true/false).'),
    searchKey: z.string().optional().describe('Fuzzy search by name, MAC address, or SSID.'),
});

export function registerListClientsPastConnectionsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_listClientsPastConnections',
        {
            description: 'Get historical client connection data',
            inputSchema: clientsPastConnectionsInputSchema.shape,
        },
        wrapToolHandler('omada_listClientsPastConnections', async (args) =>
            toToolResult(
                await client.listClientsPastConnections({
                    siteId: args.siteId,
                    page: args.page,
                    pageSize: args.pageSize,
                    sortLastSeen: args.sortLastSeen,
                    timeStart: args.timeStart,
                    timeEnd: args.timeEnd,
                    guest: args.guest,
                    searchKey: args.searchKey,
                })
            ),
            Permission.QUERY
        )
    );
}
