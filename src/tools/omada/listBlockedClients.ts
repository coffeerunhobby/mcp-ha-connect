import type { McpServer } from '@modelcontextprotocol/server';

import type { OmadaClient } from '../../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerListBlockedClientsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_listBlockedClients',
        {
            description:
                'List clients that are currently blocked, including offline ones (from the known-clients list). ' +
                'Use it to check block state before or after omada_blockClient / omada_unblockClient.',
            inputSchema: siteInputSchema,
        },
        wrapToolHandler('omada_listBlockedClients', async ({ siteId }) => toToolResult(await client.listBlockedClients(siteId)), Permission.QUERY)
    );
}
