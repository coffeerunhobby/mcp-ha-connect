/**
 * searchEntities tool - Search for entities by name or entity_id
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { searchSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerSearchEntitiesTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'searchEntities',
    {
      description: `Search for entities by name or entity_id. Returns all matching entities.

Note: For queries about people, family members, or "who's home?", use the listPersons tool instead.`,
      inputSchema: searchSchema.shape,
    },
    wrapToolHandler('searchEntities', async ({ query }: { query: string }) => {
      const entities = await client.searchEntities(query);
      return toToolResult({ query, count: entities.length, entities });
    }, Permission.QUERY)
  );
}
