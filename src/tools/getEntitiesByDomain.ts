/**
 * Get Entities By Domain Tool
 * Gets all entities for a specific domain
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { HaClient } from '../haClient/index.js';
import { logger } from '../utils/logger.js';

export function registerGetEntitiesByDomainTool(server: Server, client: HaClient): void {
  logger.debug('Registering getEntitiesByDomain tool');

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'getEntitiesByDomain',
          description: 'Get all entities for a specific domain (e.g., all lights, all sensors).',
          inputSchema: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                description: 'Domain name (e.g., "light", "sensor", "switch", "climate")',
              },
            },
            required: ['domain'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'getEntitiesByDomain') {
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
      const { domain } = request.params.arguments as { domain: string };

      if (!domain) {
        throw new Error('domain is required');
      }

      logger.info('Executing getEntitiesByDomain tool', { domain });
      const entities = await client.getEntitiesByDomain(domain);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              domain,
              count: entities.length,
              entities,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Failed to get entities by domain', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Failed to get entities by domain',
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
        isError: true,
      };
    }
  });
}
