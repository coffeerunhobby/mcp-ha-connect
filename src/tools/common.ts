/**
 * Common tool utilities
 * Shared helpers for all MCP tools
 */

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

/**
 * Extra context passed to tool handlers
 */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Convert any value to a CallToolResult
 */
export function toToolResult(value: unknown, isError = false): CallToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: text ? [{ type: 'text' as const, text }] : [],
    isError,
  };
}

/**
 * Safely serialize a value for logging
 */
export function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/**
 * Wrap a tool handler with logging and error handling
 */
export function wrapToolHandler<T>(
  name: string,
  handler: (args: T, extra: ToolExtra) => Promise<CallToolResult>
): (args: T, extra: ToolExtra) => Promise<CallToolResult> {
  return async (args: T, extra: ToolExtra): Promise<CallToolResult> => {
    const sessionId = extra.sessionId ?? 'unknown-session';
    logger.info('Tool invoked', { tool: name, sessionId });

    try {
      const result = await handler(args, extra);
      logger.info('Tool completed', { tool: name, sessionId });
      return result;
    } catch (error) {
      logger.error('Tool failed', {
        tool: name,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return toToolResult({
        error: `Failed to execute ${name}`,
        message: error instanceof Error ? error.message : String(error),
      }, true);
    }
  };
}

/**
 * Common Zod schemas for tool inputs
 */

// Empty schema for tools with no inputs
export const emptySchema = z.object({});

// Entity ID schema
export const entityIdSchema = z.object({
  entity_id: z.string().describe('The entity ID (e.g., "light.living_room", "sensor.temperature")'),
});

// Domain schema
export const domainSchema = z.object({
  domain: z.string().describe('Domain name (e.g., "light", "sensor", "switch", "climate")'),
});

// Search query schema
export const searchSchema = z.object({
  query: z.string().describe('Search query (searches in entity_id and friendly_name)'),
});

// History schema
export const historySchema = z.object({
  entity_id: z.string().describe('The entity ID to get history for'),
  hours: z.number().optional().describe('Number of hours of history to retrieve (default: 24)'),
});

// Entity action schema
export const entityActionSchema = z.object({
  entity_id: z.string().describe('The entity ID to perform the action on'),
  action: z.enum(['turn_on', 'turn_off', 'toggle']).describe('The action to perform'),
});

// List entities filter schema
export const listEntitiesSchema = z.object({
  domain: z.string().optional().describe('Filter by domain (e.g., "light", "switch", "sensor")'),
  search: z.string().optional().describe('Search query to filter by entity_id or friendly_name'),
  state: z.string().optional().describe('Filter by state (e.g., "on", "off", "unavailable")'),
  limit: z.number().optional().describe('Maximum number of entities to return'),
});

// Automation state filter schema
export const automationFilterSchema = z.object({
  state: z.enum(['on', 'off']).optional().describe('Filter by automation state (enabled/disabled)'),
});

// System log schema
export const systemLogSchema = z.object({
  hours: z.number().optional().describe('Number of hours of history to retrieve (default: 24)'),
  entity_id: z.string().optional().describe('Optional entity ID to filter logs for a specific entity'),
});

// Automation ID schema
export const automationIdSchema = z.object({
  automation_id: z.string().describe('The unique ID of the automation'),
});

// Service call schema
export const serviceCallSchema = z.object({
  domain: z.string().describe('Service domain (e.g., "light", "switch", "climate", "notify")'),
  service: z.string().describe('Service name (e.g., "turn_on", "turn_off", "set_temperature")'),
  service_data: z.record(z.unknown()).optional().describe('Optional service data'),
  target: z.object({
    entity_id: z.union([z.string(), z.array(z.string())]).optional(),
    device_id: z.union([z.string(), z.array(z.string())]).optional(),
    area_id: z.union([z.string(), z.array(z.string())]).optional(),
  }).optional().describe('Optional target'),
});

// Analyze sensors schema
export const analyzeSensorsSchema = z.object({
  sensors: z.record(z.unknown()).describe('Sensor data to analyze. Object with entity_id keys and {state, unit, attributes} values.'),
});

// Trigger automation schema
export const triggerAutomationSchema = z.object({
  entity_id: z.string().describe('The automation entity ID (e.g., "automation.turn_on_lights")'),
  variables: z.record(z.unknown()).optional().describe('Optional variables to pass to the automation'),
});

// Create automation schema
export const createAutomationSchema = z.object({
  alias: z.string().describe('Friendly name for the automation'),
  description: z.string().optional().describe('Optional description of what the automation does'),
  mode: z.enum(['single', 'restart', 'queued', 'parallel']).optional().describe('Execution mode (default: single)'),
  trigger: z.unknown().describe('Trigger(s) that start the automation. Each trigger needs a "platform" property.'),
  condition: z.unknown().optional().describe('Optional condition(s) that must be true for actions to run.'),
  action: z.unknown().describe('Action(s) to perform when triggered. Each action typically has "service" and "target" properties.'),
});

// Control light schema
export const controlLightSchema = z.object({
  entity_id: z.string().describe('The light entity ID (e.g., "light.living_room")'),
  action: z.enum(['turn_on', 'turn_off', 'toggle']).describe('The action to perform'),
  brightness_pct: z.number().optional().describe('Brightness percentage (0-100)'),
  color_temp_kelvin: z.number().optional().describe('Color temperature in Kelvin (e.g., 2700 for warm, 6500 for cool)'),
  rgb_color: z.tuple([z.number(), z.number(), z.number()]).optional().describe('RGB color as [red, green, blue] (0-255 each)'),
  transition: z.number().optional().describe('Transition time in seconds'),
});

// Control climate schema
export const controlClimateSchema = z.object({
  entity_id: z.string().describe('The climate entity ID (e.g., "climate.living_room")'),
  temperature: z.number().optional().describe('Target temperature'),
  hvac_mode: z.enum(['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only']).optional().describe('HVAC mode'),
  fan_mode: z.string().optional().describe('Fan mode (device-specific)'),
  preset_mode: z.string().optional().describe('Preset mode (e.g., "home", "away", "eco")'),
});

// Control media player schema
export const controlMediaPlayerSchema = z.object({
  entity_id: z.string().describe('The media player entity ID'),
  action: z.enum(['play', 'pause', 'stop', 'next', 'previous', 'volume_set', 'volume_mute']).describe('The action to perform'),
  volume_level: z.number().optional().describe('Volume level (0.0 to 1.0)'),
  is_volume_muted: z.boolean().optional().describe('Mute state'),
});

// Control cover schema
export const controlCoverSchema = z.object({
  entity_id: z.string().describe('The cover entity ID (e.g., "cover.living_room_blinds")'),
  action: z.enum(['open', 'close', 'stop', 'set_position', 'set_tilt']).describe('The action to perform'),
  position: z.number().optional().describe('Cover position (0 = closed, 100 = open)'),
  tilt_position: z.number().optional().describe('Tilt position (0-100)'),
});

// Control fan schema
export const controlFanSchema = z.object({
  entity_id: z.string().describe('The fan entity ID'),
  action: z.enum(['turn_on', 'turn_off', 'toggle', 'set_speed', 'oscillate', 'set_direction']).describe('The action to perform'),
  percentage: z.number().optional().describe('Speed percentage (0-100)'),
  oscillating: z.boolean().optional().describe('Oscillation state'),
  direction: z.enum(['forward', 'reverse']).optional().describe('Fan direction'),
});

// Run script schema
export const runScriptSchema = z.object({
  entity_id: z.string().describe('The script entity ID (e.g., "script.morning_routine")'),
  variables: z.record(z.unknown()).optional().describe('Optional variables to pass to the script'),
});

// Notification action schema for actionable notifications
export const notificationActionSchema = z.object({
  action: z.string().describe('Action identifier returned when tapped'),
  title: z.string().describe('Button text shown to user'),
  uri: z.string().optional().describe('URI to open when tapped (e.g., "https://example.com" or "app://settings")'),
});

// Send notification schema with mobile app support
export const sendNotificationSchema = z.object({
  message: z.string().describe('The notification message. Use "clear_notification" to clear a notification by tag.'),
  title: z.string().optional().describe('Optional notification title'),
  target: z.string().optional().describe('Notification service target (e.g., "mobile_app_iphone", "mobile_app_pixel"). Defaults to "persistent_notification".'),
  // Mobile app specific options
  tag: z.string().optional().describe('Notification tag for grouping/replacing. Use same tag to update existing notification.'),
  group: z.string().optional().describe('Group notifications together (Android: group key, iOS: thread-id)'),
  priority: z.enum(['high', 'normal', 'low', 'min']).optional().describe('Notification priority (Android). "high" wakes device.'),
  importance: z.enum(['high', 'default', 'low', 'min']).optional().describe('Notification importance (Android channel importance)'),
  ttl: z.number().optional().describe('Time to live in seconds. Notification expires after this time.'),
  // Actions
  actions: z.array(notificationActionSchema).max(3).optional().describe('Up to 3 action buttons for actionable notifications'),
  // Media
  image: z.string().optional().describe('URL to image to display in notification'),
  video: z.string().optional().describe('URL to video (iOS only)'),
  icon_url: z.string().optional().describe('URL to custom notification icon (Android only)'),
  // Behavior
  sticky: z.boolean().optional().describe('If true, notification cannot be dismissed by swiping (Android)'),
  persistent: z.boolean().optional().describe('If true, notification persists across reboots (Android)'),
  clickAction: z.string().optional().describe('URI to open when notification is tapped'),
  // Sound
  channel: z.string().optional().describe('Android notification channel ID'),
  vibrationPattern: z.array(z.number()).optional().describe('Custom vibration pattern (Android) e.g., [100, 200, 100]'),
  ledColor: z.string().optional().describe('LED color as hex (Android) e.g., "#FF0000"'),
  // iOS specific
  sound: z.string().optional().describe('Sound file name (iOS) or "default"'),
  badge: z.number().optional().describe('App badge count (iOS)'),
  interruptionLevel: z.enum(['passive', 'active', 'time-sensitive', 'critical']).optional().describe('iOS interruption level'),
  // Raw data passthrough for advanced use
  data: z.record(z.unknown()).optional().describe('Additional raw data to pass to notification service'),
});

// List notification targets schema (empty - no params needed)
export const listNotificationTargetsSchema = z.object({});

// List calendars schema (empty - no params needed)
export const listCalendarsSchema = z.object({});

// Get calendar events schema
export const getCalendarEventsSchema = z.object({
  entity_id: z.string().optional().describe('Calendar entity ID (e.g., "calendar.my_calendar"). If not provided, gets events from all calendars.'),
  start_date: z.string().optional().describe('Start date in ISO format (e.g., "2026-01-01"). Defaults to today.'),
  end_date: z.string().optional().describe('End date in ISO format (e.g., "2026-12-31"). Defaults to 30 days from start.'),
  days: z.number().optional().describe('Alternative: number of days from start_date (overrides end_date if provided)'),
});
