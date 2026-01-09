/**
 * MCP Resources Registry
 * Provides URI-based access to Home Assistant entities
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { HaClient } from '../haClient/index.js';
import { logger } from '../utils/logger.js';

/**
 * Register all Home Assistant resources with the MCP server
 */
export function registerAllResources(server: Server, client: HaClient): void {
  logger.debug('Registering MCP resources');

  // List available resource templates
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: [
        {
          uriTemplate: 'hass://entities/{entity_id}',
          name: 'Entity State',
          description: 'Get the current state of a specific Home Assistant entity',
          mimeType: 'application/json',
        },
        {
          uriTemplate: 'hass://entities/{entity_id}/detailed',
          name: 'Entity Detailed',
          description: 'Get detailed information about an entity including all attributes',
          mimeType: 'application/json',
        },
        {
          uriTemplate: 'hass://entities/domain/{domain}',
          name: 'Domain Entities',
          description: 'Get all entities for a specific domain',
          mimeType: 'application/json',
        },
        {
          uriTemplate: 'hass://search/{query}/{limit}',
          name: 'Search Entities',
          description: 'Search for entities matching a query with result limit',
          mimeType: 'application/json',
        },
      ],
    };
  });

  // List concrete resources (the static entities resource)
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: 'hass://entities',
          name: 'All Entities',
          description: 'List all Home Assistant entities grouped by domain',
          mimeType: 'application/json',
        },
      ],
    };
  });

  // Read resource content
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    logger.debug('Reading resource', { uri });

    try {
      // Parse the URI
      const url = new URL(uri);
      const path = url.pathname;

      // hass://entities - List all entities grouped by domain
      if (uri === 'hass://entities') {
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
              uri,
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

      // hass://entities/{entity_id}/detailed - Detailed entity info
      if (path.endsWith('/detailed')) {
        const entityId = path.replace('/detailed', '').replace(/^\//, '');
        const entity = await client.getState(entityId);

        if (!entity) {
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({ error: 'Entity not found', entity_id: entityId }),
              },
            ],
          };
        }

        return {
          contents: [
            {
              uri,
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

      // hass://entities/domain/{domain} - Entities by domain
      if (path.startsWith('/domain/')) {
        const domain = path.replace('/domain/', '');
        const entities = await client.getEntitiesByDomain(domain);

        return {
          contents: [
            {
              uri,
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

      // hass://search/{query}/{limit} - Search entities
      if (path.startsWith('/search/')) {
        const parts = path.replace('/search/', '').split('/');
        const query = decodeURIComponent(parts[0] || '');
        const limit = parseInt(parts[1] || '50', 10);

        let entities = await client.searchEntities(query);
        if (limit > 0) {
          entities = entities.slice(0, limit);
        }

        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({
                query,
                limit,
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

      // hass://entities/{entity_id} - Simple entity state
      const entityId = path.replace(/^\//, '');
      if (entityId && !entityId.includes('/')) {
        const entity = await client.getState(entityId);

        if (!entity) {
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify({ error: 'Entity not found', entity_id: entityId }),
              },
            ],
          };
        }

        return {
          contents: [
            {
              uri,
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

      // Unknown resource
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'Unknown resource', uri }),
          },
        ],
      };

    } catch (error) {
      logger.error('Failed to read resource', {
        uri,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              error: 'Failed to read resource',
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
      };
    }
  });

  logger.info('MCP resources registered successfully', { resourceCount: 5 });
}
