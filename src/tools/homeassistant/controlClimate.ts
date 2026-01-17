/**
 * controlClimate tool - Control climate/thermostat devices
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { controlClimateSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';
import type { z } from 'zod';

type ControlClimateArgs = z.infer<typeof controlClimateSchema>;

export function registerControlClimateTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'controlClimate',
    {
      description: 'Control a climate/thermostat device with temperature and mode settings.',
      inputSchema: controlClimateSchema.shape,
    },
    wrapToolHandler('controlClimate', async (args: ControlClimateArgs) => {
      const results: unknown[] = [];

      if (args.hvac_mode !== undefined) {
        const result = await client.callService({
          domain: 'climate',
          service: 'set_hvac_mode',
          target: { entity_id: args.entity_id },
          service_data: { hvac_mode: args.hvac_mode },
        });
        results.push({ action: 'set_hvac_mode', hvac_mode: args.hvac_mode, context: result.context });
      }

      if (args.temperature !== undefined) {
        const result = await client.callService({
          domain: 'climate',
          service: 'set_temperature',
          target: { entity_id: args.entity_id },
          service_data: { temperature: args.temperature },
        });
        results.push({ action: 'set_temperature', temperature: args.temperature, context: result.context });
      }

      if (args.fan_mode !== undefined) {
        const result = await client.callService({
          domain: 'climate',
          service: 'set_fan_mode',
          target: { entity_id: args.entity_id },
          service_data: { fan_mode: args.fan_mode },
        });
        results.push({ action: 'set_fan_mode', fan_mode: args.fan_mode, context: result.context });
      }

      if (args.preset_mode !== undefined) {
        const result = await client.callService({
          domain: 'climate',
          service: 'set_preset_mode',
          target: { entity_id: args.entity_id },
          service_data: { preset_mode: args.preset_mode },
        });
        results.push({ action: 'set_preset_mode', preset_mode: args.preset_mode, context: result.context });
      }

      return toToolResult({ success: true, entity_id: args.entity_id, actions: results });
    }, Permission.CONTROL)
  );
}
