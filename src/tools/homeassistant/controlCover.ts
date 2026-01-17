/**
 * controlCover tool - Control covers/blinds
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { controlCoverSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';
import type { z } from 'zod';

type ControlCoverArgs = z.infer<typeof controlCoverSchema>;

export function registerControlCoverTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'controlCover',
    {
      description: 'Control a cover/blind with position and tilt settings.',
      inputSchema: controlCoverSchema.shape,
    },
    wrapToolHandler('controlCover', async (args: ControlCoverArgs) => {
      const actionMap: Record<string, string> = {
        open: 'open_cover',
        close: 'close_cover',
        stop: 'stop_cover',
        set_position: 'set_cover_position',
        set_tilt: 'set_cover_tilt_position',
      };

      const serviceData: Record<string, unknown> = {};
      if (args.action === 'set_position' && args.position !== undefined) {
        serviceData.position = args.position;
      }
      if (args.action === 'set_tilt' && args.tilt_position !== undefined) {
        serviceData.tilt_position = args.tilt_position;
      }

      const result = await client.callService({
        domain: 'cover',
        service: actionMap[args.action] || args.action,
        target: { entity_id: args.entity_id },
        service_data: Object.keys(serviceData).length > 0 ? serviceData : undefined,
      });
      return toToolResult({ success: true, entity_id: args.entity_id, action: args.action, context: result.context });
    }, Permission.CONTROL)
  );
}
