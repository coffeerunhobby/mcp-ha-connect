/**
 * controlMediaPlayer tool - Control media players
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import { controlMediaPlayerSchema, toToolResult, wrapToolHandler } from './common.js';
import type { z } from 'zod';

type ControlMediaPlayerArgs = z.infer<typeof controlMediaPlayerSchema>;

export function registerControlMediaPlayerTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'controlMediaPlayer',
    {
      description: 'Control a media player with playback, volume, and media selection.',
      inputSchema: controlMediaPlayerSchema.shape,
    },
    wrapToolHandler('controlMediaPlayer', async (args: ControlMediaPlayerArgs) => {
      const actionMap: Record<string, string> = {
        play: 'media_play',
        pause: 'media_pause',
        stop: 'media_stop',
        next: 'media_next_track',
        previous: 'media_previous_track',
        volume_set: 'volume_set',
        volume_mute: 'volume_mute',
      };

      const serviceData: Record<string, unknown> = {};
      if (args.action === 'volume_set' && args.volume_level !== undefined) {
        serviceData.volume_level = args.volume_level;
      }
      if (args.action === 'volume_mute' && args.is_volume_muted !== undefined) {
        serviceData.is_volume_muted = args.is_volume_muted;
      }

      const result = await client.callService({
        domain: 'media_player',
        service: actionMap[args.action] || args.action,
        target: { entity_id: args.entity_id },
        service_data: Object.keys(serviceData).length > 0 ? serviceData : undefined,
      });
      return toToolResult({ success: true, entity_id: args.entity_id, action: args.action, context: result.context });
    })
  );
}
