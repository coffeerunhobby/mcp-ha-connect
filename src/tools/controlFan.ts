/**
 * controlFan tool - Control fans
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import { controlFanSchema, toToolResult, wrapToolHandler } from './common.js';
import type { z } from 'zod';

type ControlFanArgs = z.infer<typeof controlFanSchema>;

export function registerControlFanTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'controlFan',
    {
      description: 'Control a fan with speed, oscillation, and direction settings.',
      inputSchema: controlFanSchema.shape,
    },
    wrapToolHandler('controlFan', async (args: ControlFanArgs) => {
      let service: string = args.action;
      const serviceData: Record<string, unknown> = {};

      if (args.action === 'set_speed') {
        service = 'set_percentage';
        if (args.percentage !== undefined) serviceData.percentage = args.percentage;
      } else if (args.action === 'oscillate') {
        if (args.oscillating !== undefined) serviceData.oscillating = args.oscillating;
      } else if (args.action === 'set_direction') {
        if (args.direction !== undefined) serviceData.direction = args.direction;
      }

      const result = await client.callService({
        domain: 'fan',
        service,
        target: { entity_id: args.entity_id },
        service_data: Object.keys(serviceData).length > 0 ? serviceData : undefined,
      });
      return toToolResult({ success: true, entity_id: args.entity_id, action: args.action, context: result.context });
    })
  );
}
