import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';
import { createPaginationSchema } from '../utils/pagination-schema.js';

const getThreatListSchema = z.object({
    siteList: z.string().optional().describe('Comma-separated site IDs. If not provided, all sites are selected by default.'),
    archived: z.boolean().describe('Whether to include archived threats'),
    ...createPaginationSchema(10),
    startTime: z.number().int().describe('Start timestamp in seconds (e.g., 1682000000)'),
    endTime: z.number().int().describe('End timestamp in seconds (e.g., 1682000000)'),
    severity: z.number().int().min(0).max(3).optional().describe('Threat severity: 0=Critical, 1=Major, 2=Concerning, 3=Minor'),
    sortTime: z.enum(['asc', 'desc']).optional().describe('Sort by time: asc or desc'),
    searchKey: z.string().optional().describe('Fuzzy search for Threat Description/Classification/Classification Description'),
});

export function registerGetThreatListTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getThreatList',
        {
            description: 'Get security threat management list',
            inputSchema: getThreatListSchema.shape,
        },
        wrapToolHandler('omada_getThreatList', async (args) => {
            const options = {
                siteList: args.siteList,
                archived: args.archived,
                page: args.page,
                pageSize: args.pageSize,
                startTime: args.startTime,
                endTime: args.endTime,
                severity: args.severity,
                sortTime: args.sortTime,
                searchKey: args.searchKey,
            };

            return toToolResult(await client.getThreatList(options));
        }, Permission.ADMIN)
    );
}
