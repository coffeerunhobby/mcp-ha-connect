/**
 * Get State Tool
 * Gets the state of a specific entity
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { HaClient } from '../haClient/index.js';
import { logger } from '../utils/logger.js';

export function registerGetStateTool(server: Server, client: HaClient): void {
  logger.debug('Registering getState tool');

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'getState',
          description: 'Get the state of a specific entity by entity_id.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The entity ID (e.g., "light.living_room", "sensor.temperature")',
              },
            },
            required: ['entity_id'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'getState') {
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
      const { entity_id } = request.params.arguments as { entity_id: string };

      if (!entity_id) {
        throw new Error('entity_id is required');
      }

      logger.info('Executing getState tool', { entity_id });
      const state = await client.getState(entity_id);

      if (!state) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Entity not found',
                entity_id,
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(state, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Failed to get state', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Failed to get state',
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
        isError: true,
      };
    }
  });
}
