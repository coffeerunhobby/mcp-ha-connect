/**
 * sendNotification tool - Send notifications through Home Assistant
 * Supports HA Mobile App notifications with actions, images, sounds, and more
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import { sendNotificationSchema, listNotificationTargetsSchema, toToolResult, wrapToolHandler } from './common.js';
import type { z } from 'zod';

type SendNotificationArgs = z.infer<typeof sendNotificationSchema>;

/**
 * Build notification data object for mobile app
 */
function buildNotificationData(args: SendNotificationArgs): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  // Tag and grouping
  if (args.tag) data.tag = args.tag;
  if (args.group) data.group = args.group;

  // Priority and importance (Android)
  if (args.priority) data.priority = args.priority;
  if (args.importance) data.importance = args.importance;
  if (args.ttl) data.ttl = args.ttl;

  // Actions - format for mobile app
  if (args.actions && args.actions.length > 0) {
    data.actions = args.actions.map(action => ({
      action: action.action,
      title: action.title,
      ...(action.uri && { uri: action.uri }),
    }));
  }

  // Media
  if (args.image) data.image = args.image;
  if (args.video) data.video = args.video;
  if (args.icon_url) data.icon_url = args.icon_url;

  // Behavior
  if (args.sticky !== undefined) data.sticky = args.sticky;
  if (args.persistent !== undefined) data.persistent = args.persistent;
  if (args.clickAction) data.clickAction = args.clickAction;

  // Sound and vibration (Android)
  if (args.channel) data.channel = args.channel;
  if (args.vibrationPattern) data.vibrationPattern = args.vibrationPattern;
  if (args.ledColor) data.ledColor = args.ledColor;

  // iOS specific
  if (args.sound) data.sound = args.sound;
  if (args.badge !== undefined) data.badge = args.badge;
  if (args.interruptionLevel) data['push'] = { 'interruption-level': args.interruptionLevel };

  // Merge any raw data passed through
  if (args.data) {
    Object.assign(data, args.data);
  }

  return data;
}

export function registerSendNotificationTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'sendNotification',
    {
      description: `Send a notification through Home Assistant Mobile App or persistent notifications.

Features for mobile app notifications:
- Actionable notifications with up to 3 buttons
- Images and videos
- Custom sounds and vibration patterns
- Notification grouping and replacement (via tag)
- Priority and importance settings
- Sticky/persistent notifications
- iOS interruption levels (passive, active, time-sensitive, critical)

To clear a notification, send message "clear_notification" with the same tag.

Examples:
- Simple: { message: "Hello!", target: "mobile_app_phone" }
- With actions: { message: "Doorbell", target: "mobile_app_phone", actions: [{ action: "OPEN", title: "Open Door" }] }
- With image: { message: "Camera alert", target: "mobile_app_phone", image: "/api/camera_proxy/camera.front" }`,
      inputSchema: sendNotificationSchema.shape,
    },
    wrapToolHandler('sendNotification', async (args: SendNotificationArgs) => {
      const serviceData: Record<string, unknown> = { message: args.message };

      if (args.title) serviceData.title = args.title;

      // Build mobile app data if any mobile-specific options provided
      const notificationData = buildNotificationData(args);
      if (Object.keys(notificationData).length > 0) {
        serviceData.data = notificationData;
      }

      const service = args.target || 'persistent_notification';
      const result = await client.callService({
        domain: 'notify',
        service,
        service_data: serviceData,
      });

      return toToolResult({
        success: true,
        service: `notify.${service}`,
        message: args.message,
        title: args.title,
        tag: args.tag,
        hasActions: args.actions && args.actions.length > 0,
        context: result.context,
      });
    })
  );
}

export function registerListNotificationTargetsTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'listNotificationTargets',
    {
      description: 'List available notification targets (mobile apps and other notify services). Use this to discover which devices can receive notifications.',
      inputSchema: listNotificationTargetsSchema.shape,
    },
    wrapToolHandler('listNotificationTargets', async () => {
      // Get all entities and find mobile_app device trackers to infer notify services
      const states = await client.getStates();

      // Find mobile app related entities
      const mobileApps: Array<{ target: string; friendly_name?: string; type: string }> = [];

      for (const entity of states) {
        // Look for device_tracker.mobile_app_* entities which indicate mobile app presence
        if (entity.entity_id.startsWith('device_tracker.') &&
            entity.attributes.source_type === 'gps') {
          // This might be a mobile app - extract the device name
          const match = entity.entity_id.match(/device_tracker\.(.+)/);
          if (match) {
            const deviceName = match[1];
            // Mobile app notify services are typically notify.mobile_app_<device>
            mobileApps.push({
              target: `mobile_app_${deviceName}`,
              friendly_name: entity.attributes.friendly_name as string,
              type: 'mobile_app',
            });
          }
        }

        // Also check for notify.* entities directly if available
        if (entity.entity_id.startsWith('notify.')) {
          const serviceName = entity.entity_id.replace('notify.', '');
          mobileApps.push({
            target: serviceName,
            friendly_name: entity.attributes.friendly_name as string,
            type: 'notify_service',
          });
        }
      }

      // Always include persistent_notification as it's always available
      const targets = [
        { target: 'persistent_notification', friendly_name: 'Persistent Notification (Web UI)', type: 'built_in' },
        ...mobileApps,
      ];

      // Remove duplicates
      const uniqueTargets = targets.filter((t, i, arr) =>
        arr.findIndex(x => x.target === t.target) === i
      );

      return toToolResult({
        count: uniqueTargets.length,
        targets: uniqueTargets,
        note: 'Mobile app targets are typically named "mobile_app_<device_name>". Use the target value in sendNotification.',
      });
    })
  );
}
