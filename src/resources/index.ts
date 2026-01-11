/**
 * MCP Resources Registry
 * Provides URI-based access to Home Assistant entities
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import type { HaClient } from '../haClient/index.js';
import { logger } from '../utils/logger.js';

/**
 * Register all Home Assistant resources with the MCP server
 */
export function registerAllResources(server: McpServer, client: HaClient): void {
  logger.debug('Registering MCP resources');

  // Static resource: List all entities grouped by domain
  server.resource(
    'All Entities',
    'hass://entities',
    {
      description: 'List all Home Assistant entities grouped by domain',
      mimeType: 'application/json',
    },
    async () => {
      const entities = await client.getStates();

      // Group by domain
      const grouped: Record<string, Array<{ entity_id: string; state: string; friendly_name?: string }>> = {};
      for (const entity of entities) {
        const domain = entity.entity_id.split('.')[0];
        if (!grouped[domain]) {
          grouped[domain] = [];
        }
        grouped[domain].push({
          entity_id: entity.entity_id,
          state: entity.state,
          friendly_name: entity.attributes.friendly_name as string | undefined,
        });
      }

      return {
        contents: [
          {
            uri: 'hass://entities',
            mimeType: 'application/json',
            text: JSON.stringify({
              total: entities.length,
              domains: Object.keys(grouped).length,
              entities: grouped,
            }, null, 2),
          },
        ],
      };
    }
  );

  // Template resource: Get specific entity state
  server.resource(
    'Entity State',
    new ResourceTemplate('hass://entities/{entity_id}', { list: undefined }),
    {
      description: 'Get the current state of a specific Home Assistant entity',
      mimeType: 'application/json',
    },
    async (uri: URL, variables: Variables) => {
      const entityId = variables.entity_id as string;
      const entity = await client.getState(entityId);

      if (!entity) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: 'Entity not found', entity_id: entityId }),
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              entity_id: entity.entity_id,
              state: entity.state,
              friendly_name: entity.attributes.friendly_name,
              last_changed: entity.last_changed,
            }, null, 2),
          },
        ],
      };
    }
  );

  // Template resource: Get detailed entity info
  server.resource(
    'Entity Detailed',
    new ResourceTemplate('hass://entities/{entity_id}/detailed', { list: undefined }),
    {
      description: 'Get detailed information about an entity including all attributes',
      mimeType: 'application/json',
    },
    async (uri: URL, variables: Variables) => {
      const entityId = variables.entity_id as string;
      const entity = await client.getState(entityId);

      if (!entity) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ error: 'Entity not found', entity_id: entityId }),
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              entity_id: entity.entity_id,
              state: entity.state,
              attributes: entity.attributes,
              last_changed: entity.last_changed,
              last_updated: entity.last_updated,
              context: entity.context,
            }, null, 2),
          },
        ],
      };
    }
  );

  // Template resource: Get entities by domain
  server.resource(
    'Domain Entities',
    new ResourceTemplate('hass://entities/domain/{domain}', { list: undefined }),
    {
      description: 'Get all entities for a specific domain',
      mimeType: 'application/json',
    },
    async (uri: URL, variables: Variables) => {
      const domain = variables.domain as string;
      const entities = await client.getEntitiesByDomain(domain);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              domain,
              count: entities.length,
              entities: entities.map(e => ({
                entity_id: e.entity_id,
                state: e.state,
                friendly_name: e.attributes.friendly_name,
              })),
            }, null, 2),
          },
        ],
      };
    }
  );

  // Template resource: Search entities
  server.resource(
    'Search Entities',
    new ResourceTemplate('hass://search/{query}/{limit}', { list: undefined }),
    {
      description: 'Search for entities matching a query with result limit',
      mimeType: 'application/json',
    },
    async (uri: URL, variables: Variables) => {
      const queryStr = decodeURIComponent(variables.query as string);
      const limitNum = parseInt(variables.limit as string || '50', 10);

      let entities = await client.searchEntities(queryStr);
      if (limitNum > 0) {
        entities = entities.slice(0, limitNum);
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
              query: queryStr,
              limit: limitNum,
              count: entities.length,
              entities: entities.map(e => ({
                entity_id: e.entity_id,
                state: e.state,
                friendly_name: e.attributes.friendly_name,
              })),
            }, null, 2),
          },
        ],
      };
    }
  );

  logger.info('MCP resources registered successfully', { resourceCount: 5 });
}
