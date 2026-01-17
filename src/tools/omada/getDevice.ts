import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { OmadaClient } from '../../omadaClient/index.js';
import { deviceIdSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetDeviceTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_getDevice',
        {
            description: 'Get detailed information about a specific network device',
            inputSchema: deviceIdSchema.shape,
        },
        wrapToolHandler('omada_getDevice', async ({ deviceId, siteId }) => toToolResult(await client.getDevice(deviceId, siteId)), Permission.QUERY)
    );
}
