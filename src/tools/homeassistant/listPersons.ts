/**
 * listPersons tool - List all person entities (household members)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { emptySchema, toToolResult, wrapToolHandler, Permission } from '../common.js';

export function registerListPersonsTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'listPersons',
    {
      description: `List all household members (person entities) in Home Assistant.

Returns each person's name, location state (home/away/unknown), and linked device trackers.

Use this tool when the user asks:
- "Who's home?"
- "Where is everyone?"
- "List family members"
- "Is anyone home?"
- "Where is Dad/Mom/etc?"`,
      inputSchema: emptySchema.shape,
    },
    wrapToolHandler('listPersons', async () => {
      const entities = await client.getEntitiesByDomain('person');

      const persons = entities.map(entity => ({
        entity_id: entity.entity_id,
        name: entity.attributes.friendly_name || entity.entity_id.replace('person.', ''),
        state: entity.state, // home, not_home, unknown
        device_trackers: entity.attributes.source ? [entity.attributes.source] : [],
      }));

      const onsiteCount = persons.filter(p => p.state === 'home').length;
      const awayCount = persons.filter(p => p.state === 'not_home').length;

      return toToolResult({
        count: persons.length,
        onsite: onsiteCount,
        away: awayCount,
        persons,
      });
    }, Permission.QUERY)
  );
}
