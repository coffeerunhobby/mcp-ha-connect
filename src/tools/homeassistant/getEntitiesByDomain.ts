/**
 * getEntitiesByDomain tool - Get all entities for a specific domain
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { domainSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetEntitiesByDomainTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getEntitiesByDomain',
    {
      description: 'Get all entities for a specific domain (e.g., all lights, all sensors).',
      inputSchema: domainSchema.shape,
    },
    wrapToolHandler('getEntitiesByDomain', async ({ domain }: { domain: string }) => {
      const entities = await client.getEntitiesByDomain(domain);
      return toToolResult({ domain, count: entities.length, entities });
    }, Permission.QUERY)
  );
}
