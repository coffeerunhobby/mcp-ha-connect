/**
 * Get States Tool
 * Gets all entity states from Home Assistant
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { HaClient } from '../haClient/index.js';
import { logger } from '../utils/logger.js';

export function registerGetStatesTool(server: Server, client: HaClient): void {
  logger.debug('Registering getStates tool');

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'getStates',
          description: 'Get all entity states from Home Assistant.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'getStates') {
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
      logger.info('Executing getStates tool');
      const states = await client.getStates();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              count: states.length,
              entities: states,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Failed to get states', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Failed to get states',
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
        isError: true,
      };
    }
  });
}
