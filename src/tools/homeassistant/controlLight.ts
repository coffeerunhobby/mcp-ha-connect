/**
 * controlLight tool - Control lights with advanced options
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { HaClient } from '../../haClient/index.js';
import { controlLightSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';
import { entityNotFoundResult } from './entityGuard.js';
import type { z } from 'zod';

type ControlLightArgs = z.infer<typeof controlLightSchema>;

export function registerControlLightTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'controlLight',
    {
      description: 'Control a light with advanced options like brightness, color, and color temperature.',
      inputSchema: controlLightSchema,
    },
    wrapToolHandler('controlLight', async (args: ControlLightArgs) => {
      const missing = await entityNotFoundResult(client, args.entity_id);
      if (missing) return missing;
      const serviceData: Record<string, unknown> = {};
      if (args.brightness_pct !== undefined) serviceData.brightness_pct = args.brightness_pct;
      if (args.color_temp_kelvin !== undefined) serviceData.color_temp_kelvin = args.color_temp_kelvin;
      if (args.rgb_color !== undefined) serviceData.rgb_color = args.rgb_color;
      if (args.transition !== undefined) serviceData.transition = args.transition;

      const result = await client.callService({
        domain: 'light',
        service: args.action,
        target: { entity_id: args.entity_id },
        service_data: Object.keys(serviceData).length > 0 ? serviceData : undefined,
      });
      return toToolResult({ success: true, entity_id: args.entity_id, action: args.action, settings: serviceData, context: result.context });
    }, Permission.CONTROL)
  );
}
