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
        {
          name: 'triggerAutomation',
          description: 'Manually trigger a Home Assistant automation. Can optionally pass variables to the automation.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The automation entity ID (e.g., "automation.turn_on_lights")',
              },
              variables: {
                type: 'object',
                description: 'Optional variables to pass to the automation',
              },
            },
            required: ['entity_id'],
          },
        },
        {
          name: 'enableAutomation',
          description: 'Enable a disabled Home Assistant automation.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The automation entity ID to enable',
              },
            },
            required: ['entity_id'],
          },
        },
        {
          name: 'disableAutomation',
          description: 'Disable a Home Assistant automation.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The automation entity ID to disable',
              },
            },
            required: ['entity_id'],
          },
        },
        {
          name: 'toggleAutomation',
          description: 'Toggle a Home Assistant automation (enable if disabled, disable if enabled).',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The automation entity ID to toggle',
              },
            },
            required: ['entity_id'],
          },
        },
        {
          name: 'reloadAutomations',
          description: 'Reload all automations from the Home Assistant configuration. Useful after editing automation YAML files.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'createAutomation',
          description: 'Create a new Home Assistant automation. Requires specifying triggers, conditions (optional), and actions.',
          inputSchema: {
            type: 'object',
            properties: {
              alias: {
                type: 'string',
                description: 'Friendly name for the automation',
              },
              description: {
                type: 'string',
                description: 'Optional description of what the automation does',
              },
              mode: {
                type: 'string',
                enum: ['single', 'restart', 'queued', 'parallel'],
                description: 'Execution mode (default: single)',
              },
              trigger: {
                type: ['object', 'array'],
                description: 'Trigger(s) that start the automation. Each trigger needs a "platform" property.',
              },
              condition: {
                type: ['object', 'array'],
                description: 'Optional condition(s) that must be true for actions to run.',
              },
              action: {
                type: ['object', 'array'],
                description: 'Action(s) to perform when triggered. Each action typically has "service" and "target" properties.',
              },
            },
            required: ['alias', 'trigger', 'action'],
          },
        },
        {
          name: 'deleteAutomation',
          description: 'Delete a Home Assistant automation. Only works for automations created via the UI/API.',
          inputSchema: {
            type: 'object',
            properties: {
              automation_id: {
                type: 'string',
                description: 'The unique ID of the automation to delete',
              },
            },
            required: ['automation_id'],
          },
        },
        {
          name: 'getAutomationTrace',
          description: 'Get the execution trace (history) of an automation. Shows when it was triggered and what actions were executed.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The automation entity ID to get trace for',
              },
            },
            required: ['entity_id'],
          },
        },
        {
          name: 'controlLight',
          description: 'Control a light with advanced options like brightness, color, and color temperature.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The light entity ID (e.g., "light.living_room")',
              },
              action: {
                type: 'string',
                enum: ['turn_on', 'turn_off', 'toggle'],
                description: 'The action to perform',
              },
              brightness_pct: {
                type: 'number',
                description: 'Brightness percentage (0-100)',
              },
              color_temp_kelvin: {
                type: 'number',
                description: 'Color temperature in Kelvin (e.g., 2700 for warm, 6500 for cool)',
              },
              rgb_color: {
                type: 'array',
                items: { type: 'number' },
                description: 'RGB color as [red, green, blue] (0-255 each)',
              },
              transition: {
                type: 'number',
                description: 'Transition time in seconds',
              },
            },
            required: ['entity_id', 'action'],
          },
        },
        {
          name: 'controlClimate',
          description: 'Control a climate/thermostat device with temperature and mode settings.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The climate entity ID (e.g., "climate.living_room")',
              },
              temperature: {
                type: 'number',
                description: 'Target temperature',
              },
              hvac_mode: {
                type: 'string',
                enum: ['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'],
                description: 'HVAC mode',
              },
              fan_mode: {
                type: 'string',
                description: 'Fan mode (device-specific)',
              },
              preset_mode: {
                type: 'string',
                description: 'Preset mode (e.g., "home", "away", "eco")',
              },
            },
            required: ['entity_id'],
          },
        },
        {
          name: 'controlMediaPlayer',
          description: 'Control a media player with playback, volume, and media selection.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The media player entity ID',
              },
              action: {
                type: 'string',
                enum: ['play', 'pause', 'stop', 'next', 'previous', 'volume_set', 'volume_mute'],
                description: 'The action to perform',
              },
              volume_level: {
                type: 'number',
                description: 'Volume level (0.0 to 1.0)',
              },
              is_volume_muted: {
                type: 'boolean',
                description: 'Mute state',
              },
            },
            required: ['entity_id', 'action'],
          },
        },
        {
          name: 'controlCover',
          description: 'Control a cover/blind with position and tilt settings.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The cover entity ID (e.g., "cover.living_room_blinds")',
              },
              action: {
                type: 'string',
                enum: ['open', 'close', 'stop', 'set_position', 'set_tilt'],
                description: 'The action to perform',
              },
              position: {
                type: 'number',
                description: 'Cover position (0 = closed, 100 = open)',
              },
              tilt_position: {
                type: 'number',
                description: 'Tilt position (0-100)',
              },
            },
            required: ['entity_id', 'action'],
          },
        },
        {
          name: 'controlFan',
          description: 'Control a fan with speed, oscillation, and direction settings.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The fan entity ID',
              },
              action: {
                type: 'string',
                enum: ['turn_on', 'turn_off', 'toggle', 'set_speed', 'oscillate', 'set_direction'],
                description: 'The action to perform',
              },
              percentage: {
                type: 'number',
                description: 'Speed percentage (0-100)',
              },
              oscillating: {
                type: 'boolean',
                description: 'Oscillation state',
              },
              direction: {
                type: 'string',
                enum: ['forward', 'reverse'],
                description: 'Fan direction',
              },
            },
            required: ['entity_id', 'action'],
          },
        },
        {
          name: 'activateScene',
          description: 'Activate a Home Assistant scene.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The scene entity ID (e.g., "scene.movie_night")',
              },
            },
            required: ['entity_id'],
          },
        },
        {
          name: 'runScript',
          description: 'Run a Home Assistant script with optional variables.',
          inputSchema: {
            type: 'object',
            properties: {
              entity_id: {
                type: 'string',
                description: 'The script entity ID (e.g., "script.morning_routine")',
              },
              variables: {
                type: 'object',
                description: 'Optional variables to pass to the script',
              },
            },
            required: ['entity_id'],
          },
        },
        {
          name: 'sendNotification',
          description: 'Send a notification through Home Assistant.',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'The notification message',
              },
              title: {
                type: 'string',
                description: 'Optional notification title',
              },
              target: {
                type: 'string',
                description: 'Notification service target (e.g., "mobile_app_phone")',
              },
              data: {
                type: 'object',
                description: 'Additional notification data (device-specific)',
              },
            },
            required: ['message'],
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

        case 'triggerAutomation': {
          const { entity_id, variables } = request.params.arguments as {
            entity_id: string;
            variables?: Record<string, unknown>;
          };
          if (!entity_id) {
            throw new Error('entity_id is required');
          }

          const result = await client.triggerAutomation(entity_id, variables);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  entity_id,
                  message: 'Automation triggered successfully',
                  context: result.context,
                }, null, 2),
              },
            ],
          };
        }

        case 'enableAutomation': {
          const { entity_id } = request.params.arguments as { entity_id: string };
          if (!entity_id) {
            throw new Error('entity_id is required');
          }

          const result = await client.enableAutomation(entity_id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  entity_id,
                  action: 'enabled',
                  context: result.context,
                }, null, 2),
              },
            ],
          };
        }

        case 'disableAutomation': {
          const { entity_id } = request.params.arguments as { entity_id: string };
          if (!entity_id) {
            throw new Error('entity_id is required');
          }

          const result = await client.disableAutomation(entity_id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  entity_id,
                  action: 'disabled',
                  context: result.context,
                }, null, 2),
              },
            ],
          };
        }

        case 'toggleAutomation': {
          const { entity_id } = request.params.arguments as { entity_id: string };
          if (!entity_id) {
            throw new Error('entity_id is required');
          }

          const result = await client.toggleAutomation(entity_id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  entity_id,
                  action: 'toggled',
                  context: result.context,
                }, null, 2),
              },
            ],
          };
        }

        case 'reloadAutomations': {
          await client.reloadAutomations();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Automations reloaded from configuration',
                }, null, 2),
              },
            ],
          };
        }

        case 'createAutomation': {
          const config = request.params.arguments as {
            alias: string;
            description?: string;
            mode?: 'single' | 'restart' | 'queued' | 'parallel';
            trigger: unknown;
            condition?: unknown;
            action: unknown;
          };
          if (!config.alias || !config.trigger || !config.action) {
            throw new Error('alias, trigger, and action are required');
          }

          const result = await client.createAutomation({
            alias: config.alias,
            description: config.description,
            mode: config.mode,
            trigger: config.trigger as import('../types/index.js').AutomationTrigger | import('../types/index.js').AutomationTrigger[],
            condition: config.condition as import('../types/index.js').AutomationCondition | import('../types/index.js').AutomationCondition[] | undefined,
            action: config.action as import('../types/index.js').AutomationAction | import('../types/index.js').AutomationAction[],
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  automation_id: result.id,
                  alias: config.alias,
                  message: 'Automation created successfully',
                }, null, 2),
              },
            ],
          };
        }

        case 'deleteAutomation': {
          const { automation_id } = request.params.arguments as { automation_id: string };
          if (!automation_id) {
            throw new Error('automation_id is required');
          }

          await client.deleteAutomation(automation_id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  automation_id,
                  message: 'Automation deleted successfully',
                }, null, 2),
              },
            ],
          };
        }

        case 'getAutomationTrace': {
          const { entity_id } = request.params.arguments as { entity_id: string };
          if (!entity_id) {
            throw new Error('entity_id is required');
          }

          const trace = await client.getAutomationTrace(entity_id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  entity_id,
                  trace_count: Array.isArray(trace) ? trace.length : 0,
                  traces: trace,
                }, null, 2),
              },
            ],
          };
        }

        case 'controlLight': {
          const args = request.params.arguments as {
            entity_id: string;
            action: 'turn_on' | 'turn_off' | 'toggle';
            brightness_pct?: number;
            color_temp_kelvin?: number;
            rgb_color?: [number, number, number];
            transition?: number;
          };
          if (!args.entity_id || !args.action) {
            throw new Error('entity_id and action are required');
          }

          let result;
          if (args.action === 'turn_off') {
            result = await client.devices.turnOffLight(args.entity_id, args.transition);
          } else if (args.action === 'toggle') {
            result = await client.devices.toggleLight(args.entity_id);
          } else {
            result = await client.devices.turnOnLight(args.entity_id, {
              brightness_pct: args.brightness_pct,
              color_temp_kelvin: args.color_temp_kelvin,
              rgb_color: args.rgb_color,
              transition: args.transition,
            });
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  entity_id: args.entity_id,
                  action: args.action,
                  context: result.context,
                }, null, 2),
              },
            ],
          };
        }

        case 'controlClimate': {
          const args = request.params.arguments as {
            entity_id: string;
            temperature?: number;
            hvac_mode?: 'off' | 'heat' | 'cool' | 'heat_cool' | 'auto' | 'dry' | 'fan_only';
            fan_mode?: string;
            preset_mode?: string;
          };
          if (!args.entity_id) {
            throw new Error('entity_id is required');
          }

          const results: Array<{ action: string; success: boolean }> = [];

          if (args.hvac_mode) {
            await client.devices.setClimateMode(args.entity_id, args.hvac_mode);
            results.push({ action: 'set_hvac_mode', success: true });
          }

          if (args.temperature !== undefined) {
            await client.devices.setClimateTemperature(args.entity_id, args.temperature);
            results.push({ action: 'set_temperature', success: true });
          }

          if (args.fan_mode) {
            await client.devices.setClimateFanMode(args.entity_id, args.fan_mode);
            results.push({ action: 'set_fan_mode', success: true });
          }

          if (args.preset_mode) {
            await client.devices.setClimatePreset(args.entity_id, args.preset_mode);
            results.push({ action: 'set_preset_mode', success: true });
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  entity_id: args.entity_id,
                  actions: results,
                }, null, 2),
              },
            ],
          };
        }

        case 'controlMediaPlayer': {
          const args = request.params.arguments as {
            entity_id: string;
            action: 'play' | 'pause' | 'stop' | 'next' | 'previous' | 'volume_set' | 'volume_mute';
            volume_level?: number;
            is_volume_muted?: boolean;
          };
          if (!args.entity_id || !args.action) {
            throw new Error('entity_id and action are required');
          }

          let result;
          switch (args.action) {
            case 'play':
              result = await client.devices.mediaPlay(args.entity_id);
              break;
            case 'pause':
              result = await client.devices.mediaPause(args.entity_id);
              break;
            case 'stop':
              result = await client.devices.mediaStop(args.entity_id);
              break;
            case 'next':
              result = await client.devices.mediaNext(args.entity_id);
              break;
            case 'previous':
              result = await client.devices.mediaPrevious(args.entity_id);
              break;
            case 'volume_set':
              if (args.volume_level === undefined) {
                throw new Error('volume_level is required for volume_set action');
              }
              result = await client.devices.setMediaVolume(args.entity_id, args.volume_level);
              break;
            case 'volume_mute':
              if (args.is_volume_muted === undefined) {
                throw new Error('is_volume_muted is required for volume_mute action');
              }
              result = await client.devices.setMediaMute(args.entity_id, args.is_volume_muted);
              break;
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  entity_id: args.entity_id,
                  action: args.action,
                  context: result?.context,
                }, null, 2),
              },
            ],
          };
        }

        case 'controlCover': {
          const args = request.params.arguments as {
            entity_id: string;
            action: 'open' | 'close' | 'stop' | 'set_position' | 'set_tilt';
            position?: number;
            tilt_position?: number;
          };
          if (!args.entity_id || !args.action) {
            throw new Error('entity_id and action are required');
          }

          let result;
          switch (args.action) {
            case 'open':
              result = await client.devices.openCover(args.entity_id);
              break;
            case 'close':
              result = await client.devices.closeCover(args.entity_id);
              break;
            case 'stop':
              result = await client.devices.stopCover(args.entity_id);
              break;
            case 'set_position':
              if (args.position === undefined) {
                throw new Error('position is required for set_position action');
              }
              result = await client.devices.setCoverPosition(args.entity_id, args.position);
              break;
            case 'set_tilt':
              if (args.tilt_position === undefined) {
                throw new Error('tilt_position is required for set_tilt action');
              }
              result = await client.devices.setCoverTilt(args.entity_id, args.tilt_position);
              break;
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  entity_id: args.entity_id,
                  action: args.action,
                  context: result?.context,
                }, null, 2),
              },
            ],
          };
        }

        case 'controlFan': {
          const args = request.params.arguments as {
            entity_id: string;
            action: 'turn_on' | 'turn_off' | 'toggle' | 'set_speed' | 'oscillate' | 'set_direction';
            percentage?: number;
            oscillating?: boolean;
            direction?: 'forward' | 'reverse';
          };
          if (!args.entity_id || !args.action) {
            throw new Error('entity_id and action are required');
          }

          let result;
          switch (args.action) {
            case 'turn_on':
              result = await client.devices.turnOnFan(args.entity_id, { percentage: args.percentage });
              break;
            case 'turn_off':
              result = await client.devices.turnOffFan(args.entity_id);
              break;
            case 'toggle':
              result = await client.callService({ domain: 'fan', service: 'toggle', target: { entity_id: args.entity_id } });
              break;
            case 'set_speed':
              if (args.percentage === undefined) {
                throw new Error('percentage is required for set_speed action');
              }
              result = await client.devices.setFanSpeed(args.entity_id, args.percentage);
              break;
            case 'oscillate':
              if (args.oscillating === undefined) {
                throw new Error('oscillating is required for oscillate action');
              }
              result = await client.devices.setFanOscillation(args.entity_id, args.oscillating);
              break;
            case 'set_direction':
              if (!args.direction) {
                throw new Error('direction is required for set_direction action');
              }
              result = await client.devices.setFanDirection(args.entity_id, args.direction);
              break;
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  entity_id: args.entity_id,
                  action: args.action,
                  context: result?.context,
                }, null, 2),
              },
            ],
          };
        }

        case 'activateScene': {
          const { entity_id } = request.params.arguments as { entity_id: string };
          if (!entity_id) {
            throw new Error('entity_id is required');
          }

          const result = await client.devices.activateScene(entity_id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  entity_id,
                  message: 'Scene activated',
                  context: result.context,
                }, null, 2),
              },
            ],
          };
        }

        case 'runScript': {
          const { entity_id, variables } = request.params.arguments as {
            entity_id: string;
            variables?: Record<string, unknown>;
          };
          if (!entity_id) {
            throw new Error('entity_id is required');
          }

          const result = await client.devices.runScript(entity_id, variables);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  entity_id,
                  message: 'Script started',
                  context: result.context,
                }, null, 2),
              },
            ],
          };
        }

        case 'sendNotification': {
          const { message, title, target, data } = request.params.arguments as {
            message: string;
            title?: string;
            target?: string;
            data?: Record<string, unknown>;
          };
          if (!message) {
            throw new Error('message is required');
          }

          const result = await client.devices.sendNotification(message, title, target, data);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Notification sent',
                  target: target ?? 'notify',
                  context: result.context,
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
    toolCount: 33,
    aiEnabled: !!aiClient,
  });
}
