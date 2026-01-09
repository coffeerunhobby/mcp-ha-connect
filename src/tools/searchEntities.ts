/**
 * Search Entities Tool
 * Search for entities by name or entity_id
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { HaClient } from '../haClient/index.js';
import { logger } from '../utils/logger.js';

export function registerSearchEntitiesTool(server: Server, client: HaClient): void {
  logger.debug('Registering searchEntities tool');

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'searchEntities',
          description: 'Search for entities by name or entity_id. Returns all matching entities.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query (searches in entity_id and friendly_name)',
              },
            },
            required: ['query'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'searchEntities') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'Unknown tool' }),
          },
        ],
        isError: true,
      };
    }

    try {
      const { query } = request.params.arguments as { query: string };

      if (!query) {
        throw new Error('query is required');
      }

      logger.info('Executing searchEntities tool', { query });
      const entities = await client.searchEntities(query);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              query,
              count: entities.length,
              entities,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Failed to search entities', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Failed to search entities',
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
        isError: true,
      };
    }
  });
}
