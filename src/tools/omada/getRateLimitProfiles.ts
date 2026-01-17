import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { OmadaClient } from '../../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetRateLimitProfilesTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getRateLimitProfiles',
        {
            description: 'Get available rate limit profiles for a site',
            inputSchema: siteInputSchema.shape,
        },
        wrapToolHandler('omada_getRateLimitProfiles', async ({ siteId }) => toToolResult(await client.getRateLimitProfiles(siteId)), Permission.QUERY)
    );
}
