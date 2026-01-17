import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';
import { createPaginationSchema } from '../utils/pagination-schema.js';

const listDevicesStatsSchema = z.object({
    ...createPaginationSchema(100),
    searchMacs: z.string().optional(),
    searchNames: z.string().optional(),
    searchModels: z.string().optional(),
    searchSns: z.string().optional(),
    filterTag: z.string().optional(),
    filterDeviceSeriesType: z.string().optional(),
});

export function registerListDevicesStatsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_listDevicesStats',
        {
            description: 'Get statistics for global adopted devices with filtering',
            inputSchema: listDevicesStatsSchema.shape,
        },
        wrapToolHandler('omada_listDevicesStats', async (args) =>
            toToolResult(
                await client.listDevicesStats({
                    page: args.page,
                    pageSize: args.pageSize,
                    searchMacs: args.searchMacs,
                    searchNames: args.searchNames,
                    searchModels: args.searchModels,
                    searchSns: args.searchSns,
                    filterTag: args.filterTag,
                    filterDeviceSeriesType: args.filterDeviceSeriesType,
                })
            ),
            Permission.QUERY
        )
    );
}
