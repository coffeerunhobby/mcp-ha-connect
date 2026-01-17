import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';

const searchDevicesSchema = z.object({
    searchKey: z.string().min(1, 'searchKey is required'),
});

export function registerSearchDevicesTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_searchDevices',
        {
            description: 'Search for devices globally across all sites',
            inputSchema: searchDevicesSchema.shape,
        },
        wrapToolHandler('omada_searchDevices', async ({ searchKey }) => toToolResult(await client.searchDevices(searchKey)), Permission.QUERY)
    );
}
