import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { OmadaClient } from '../../omadaClient/index.js';
import { clientIdSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetClientTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getClient',
        {
            description: 'Get detailed information about a specific connected client',
            inputSchema: clientIdSchema.shape,
        },
        wrapToolHandler('omada_getClient', async ({ clientId, siteId }) => toToolResult(await client.getClient(clientId, siteId)), Permission.QUERY)
    );
}
