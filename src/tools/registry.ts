/**
 * Centralized tool registry
 * Handles all tool registration and execution in one place
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient, SensorData } from '../localAI/index.js';
import type { ServiceCallData } from '../types.js';
import { logger } from '../utils/logger.js';

export function registerAllTools(server: Server, client: HaClient, aiClient?: LocalAIClient): void {
  logger.debug('Registering all tools');

  // List all available tools
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
        {
          name: 'getAllSensors',
          description: 'Get all sensor states from Home Assistant (sensor.* and binary_sensor.* entities).',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'analyzeSensors',
          description: 'Analyze sensor data using AI (Ollama) to detect issues and provide recommendations.',
          inputSchema: {
            type: 'object',
            properties: {
              sensors: {
                type: 'object',
                description: 'Sensor data to analyze. Object with entity_id keys and {state, unit, attributes} values.',
              },
            },
            required: ['sensors'],
          },
        },
        {
          name: 'getHistory',
          description: 'Get historical data for an entity.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The entity ID to get history for',
              },
              hours: {
                type: 'number',
                description: 'Number of hours of history to retrieve (default: 24)',
              },
            },
            required: ['entity_id'],
          },
        },
        {
          name: 'getVersion',
          description: 'Get Home Assistant version and configuration information.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'entityAction',
          description: 'Perform a simple action on an entity (turn_on, turn_off, toggle). Automatically detects the domain.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The entity ID to perform the action on (e.g., "light.living_room", "switch.fan")',
              },
              action: {
                type: 'string',
                enum: ['turn_on', 'turn_off', 'toggle'],
                description: 'The action to perform',
              },
            },
            required: ['entity_id', 'action'],
          },
        },
        {
          name: 'listEntities',
          description: 'List entities with optional filtering by domain, state, or search query.',
          inputSchema: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                description: 'Filter by domain (e.g., "light", "switch", "sensor")',
              },
              search: {
                type: 'string',
                description: 'Search query to filter by entity_id or friendly_name',
              },
              state: {
                type: 'string',
                description: 'Filter by state (e.g., "on", "off", "unavailable")',
              },
              limit: {
                type: 'number',
                description: 'Maximum number of entities to return',
              },
            },
            required: [],
          },
        },
        {
          name: 'getDomainSummary',
          description: 'Get a summary of entities in a domain, including counts and state breakdown.',
          inputSchema: {
            type: 'object',
            properties: {
              domain: {
                type: 'string',
                description: 'Domain name (e.g., "light", "sensor", "switch", "automation")',
              },
            },
            required: ['domain'],
          },
        },
        {
          name: 'listAutomations',
          description: 'List all Home Assistant automations with their status and last triggered time.',
          inputSchema: {
            type: 'object',
            properties: {
              state: {
                type: 'string',
                enum: ['on', 'off'],
                description: 'Filter by automation state (enabled/disabled)',
              },
            },
            required: [],
          },
        },
        {
          name: 'restartHomeAssistant',
          description: 'Restart the Home Assistant server. Use with caution.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'getSystemLog',
          description: 'Get system log entries from the Home Assistant logbook. Shows recent events and state changes.',
          inputSchema: {
            type: 'object',
            properties: {
              hours: {
                type: 'number',
                description: 'Number of hours of history to retrieve (default: 24)',
              },
              entity_id: {
                type: 'string',
                description: 'Optional entity ID to filter logs for a specific entity',
              },
            },
            required: [],
          },
        },
        {
          name: 'checkUpdates',
          description: 'Check for available updates for Home Assistant Core, Supervisor, and OS. Requires Home Assistant OS or Supervised installation.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    logger.info('Executing tool', { toolName });

    try {
      switch (toolName) {
        case 'getStates': {
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
        }

        case 'getState': {
          const { entity_id } = request.params.arguments as { entity_id: string };
          if (!entity_id) {
            throw new Error('entity_id is required');
          }

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
        }

        case 'callService': {
          const args = request.params.arguments as unknown as ServiceCallData;
          if (!args.domain || !args.service) {
            throw new Error('domain and service are required');
          }

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
        }

        case 'getEntitiesByDomain': {
          const { domain } = request.params.arguments as { domain: string };
          if (!domain) {
            throw new Error('domain is required');
          }

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
        }

        case 'searchEntities': {
          const { query } = request.params.arguments as { query: string };
          if (!query) {
            throw new Error('query is required');
          }

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
        }

        case 'getAllSensors': {
          const sensors = await client.getAllSensors();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(sensors, null, 2),
              },
            ],
          };
        }

        case 'analyzeSensors': {
          if (!aiClient) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: 'AI client not configured',
                    message: 'AI analysis requires AI_URL to be set (or legacy OLLAMA_URL)',
                  }),
                },
              ],
              isError: true,
            };
          }

          const { sensors } = request.params.arguments as { sensors: SensorData };
          if (!sensors || typeof sensors !== 'object') {
            throw new Error('sensors object is required');
          }

          const analysis = await aiClient.analyzeSensors(sensors);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(analysis, null, 2),
              },
            ],
          };
        }

        case 'getHistory': {
          const { entity_id, hours = 24 } = request.params.arguments as { entity_id: string; hours?: number };
          if (!entity_id) {
            throw new Error('entity_id is required');
          }

          const history = await client.getHistory(entity_id, hours);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(history, null, 2),
              },
            ],
          };
        }

        case 'getVersion': {
          const version = await client.getVersion();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(version, null, 2),
              },
            ],
          };
        }

        case 'entityAction': {
          const { entity_id, action } = request.params.arguments as { entity_id: string; action: 'turn_on' | 'turn_off' | 'toggle' };
          if (!entity_id || !action) {
            throw new Error('entity_id and action are required');
          }

          // Extract domain from entity_id
          const domain = entity_id.split('.')[0];
          if (!domain) {
            throw new Error('Invalid entity_id format');
          }

          const result = await client.callService({
            domain,
            service: action,
            target: { entity_id },
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  entity_id,
                  action,
                  context: result.context,
                }, null, 2),
              },
            ],
          };
        }

        case 'listEntities': {
          const options = request.params.arguments as {
            domain?: string;
            search?: string;
            state?: string;
            limit?: number;
          };

          const entities = await client.listEntities(options);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  count: entities.length,
                  filters: options,
                  entities,
                }, null, 2),
              },
            ],
          };
        }

        case 'getDomainSummary': {
          const { domain } = request.params.arguments as { domain: string };
          if (!domain) {
            throw new Error('domain is required');
          }

          const summary = await client.getDomainSummary(domain);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(summary, null, 2),
              },
            ],
          };
        }

        case 'listAutomations': {
          const { state } = request.params.arguments as { state?: 'on' | 'off' };

          let automations = await client.getAutomations();

          if (state) {
            automations = automations.filter(a => a.state === state);
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  count: automations.length,
                  filter: state ? { state } : null,
                  automations,
                }, null, 2),
              },
            ],
          };
        }

        case 'restartHomeAssistant': {
          await client.restartServer();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Home Assistant restart initiated. The server will be unavailable for a short period.',
                }, null, 2),
              },
            ],
          };
        }

        case 'getSystemLog': {
          const { hours, entity_id } = request.params.arguments as { hours?: number; entity_id?: string };

          const entries = await client.getSystemLog({ hours, entity_id });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  count: entries.length,
                  hours: hours || 24,
                  entity_id: entity_id || null,
                  entries,
                }, null, 2),
              },
            ],
          };
        }

        case 'checkUpdates': {
          const updateInfo = await client.getAvailableUpdates();

          // Extract summary info for key components
          const coreEntity = updateInfo.entities.find(e => e.entity_id === 'update.home_assistant_core_update');
          const supervisorEntity = updateInfo.entities.find(e => e.entity_id === 'update.home_assistant_supervisor_update');
          const osEntity = updateInfo.entities.find(e => e.entity_id === 'update.home_assistant_operating_system_update');

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  updates_available: updateInfo.updates.length,
                  updates: updateInfo.updates,
                  core: coreEntity ? {
                    version: coreEntity.attributes.installed_version,
                    version_latest: coreEntity.attributes.latest_version,
                    update_available: coreEntity.state === 'on',
                  } : null,
                  supervisor: supervisorEntity ? {
                    version: supervisorEntity.attributes.installed_version,
                    version_latest: supervisorEntity.attributes.latest_version,
                    update_available: supervisorEntity.state === 'on',
                  } : null,
                  os: osEntity ? {
                    version: osEntity.attributes.installed_version,
                    version_latest: osEntity.attributes.latest_version,
                    update_available: osEntity.state === 'on',
                  } : null,
                  total_update_entities: updateInfo.entities.length,
                }, null, 2),
              },
            ],
          };
        }

        default:
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: 'Unknown tool', toolName }),
              },
            ],
            isError: true,
          };
      }
    } catch (error) {
      logger.error('Tool execution failed', {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Failed to execute ${toolName}`,
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
        isError: true,
      };
    }
  });

  logger.info('All tools registered successfully', {
    toolCount: 16,
    aiEnabled: !!aiClient,
  });
}
