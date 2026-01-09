/**
 * Call Service Tool
 * Calls a Home Assistant service
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { HaClient } from '../haClient/index.js';
import type { ServiceCallData } from '../types/index.js';
import { logger } from '../utils/logger.js';

export function registerCallServiceTool(server: Server, client: HaClient): void {
  logger.debug('Registering callService tool');

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'callService',
          description: 'Call a Home Assistant service (e.g., turn on a light, set temperature).',
          inputSchema: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                description: 'Service domain (e.g., "light", "switch", "climate", "notify")',
              },
              service: {
                type: 'string',
                description: 'Service name (e.g., "turn_on", "turn_off", "set_temperature")',
              },
              service_data: {
                type: 'object',
                description: 'Optional service data (e.g., {"brightness": 255})',
              },
              target: {
                type: 'object',
                description: 'Optional target (entity_id, device_id, or area_id)',
                properties: {
                  entity_id: {
                    type: ['string', 'array'],
                    description: 'Entity ID or array of entity IDs',
                  },
                },
              },
            },
            required: ['domain', 'service'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'callService') {
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
      const args = request.params.arguments as unknown as ServiceCallData;

      if (!args.domain || !args.service) {
        throw new Error('domain and service are required');
      }

      logger.info('Executing callService tool', {
        domain: args.domain,
        service: args.service,
      });

      const result = await client.callService(args);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              context: result.context,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Failed to call service', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Failed to call service',
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
        isError: true,
      };
    }
  });
}
