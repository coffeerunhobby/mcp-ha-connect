/**
 * getDomainSummary tool - Get summary of entities in a domain
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { domainSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerGetDomainSummaryTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getDomainSummary',
    {
      description: 'Get a summary of entities in a domain, including counts and state breakdown.',
      inputSchema: domainSchema.shape,
    },
    wrapToolHandler('getDomainSummary', async ({ domain }: { domain: string }) => {
      const summary = await client.getDomainSummary(domain);
      return toToolResult(summary);
    }, Permission.QUERY)
  );
}
