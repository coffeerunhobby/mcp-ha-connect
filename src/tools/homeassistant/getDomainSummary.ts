/**
 * getDomainSummary tool - Get summary of entities in a domain
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { domainSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

/**
 * Shared handler — used by the MCP registration below AND the chat face
 * (`POST /api/tools/getDomainSummary`) so both doors behave identically.
 */
export function createGetDomainSummaryHandler(client: HaClient) {
  return wrapToolHandler('getDomainSummary', async ({ domain }: { domain: string }) => {
    const summary = await client.getDomainSummary(domain);
    return toToolResult(summary);
  }, Permission.QUERY);
}

export function registerGetDomainSummaryTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getDomainSummary',
    {
      description: 'Get a summary of entities in a domain, including counts and state breakdown.',
      inputSchema: domainSchema.shape,
    },
    createGetDomainSummaryHandler(client)
  );
}
