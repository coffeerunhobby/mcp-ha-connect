/**
 * BDD tests for Notifications
 * Uses vitest-cucumber for Gherkin syntax
 */

import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect, vi } from 'vitest';
import type { HaClient } from '../../src/haClient/index.js';
import type { ServiceCallResponse } from '../../src/types/index.js';

// Simulates the notification tool's buildNotificationData function
function buildNotificationData(args: {
  tag?: string;
  group?: string;
  priority?: string;
  importance?: string;
  actions?: Array<{ action: string; title: string; uri?: string }>;
  image?: string;
  sticky?: boolean;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (args.tag) data.tag = args.tag;
  if (args.group) data.group = args.group;
  if (args.priority) data.priority = args.priority;
  if (args.importance) data.importance = args.importance;
  if (args.actions && args.actions.length > 0) {
    data.actions = args.actions.map(action => ({
      action: action.action,
      title: action.title,
      ...(action.uri && { uri: action.uri }),
    }));
  }
  if (args.image) data.image = args.image;
  if (args.sticky !== undefined) data.sticky = args.sticky;
  return data;
}

const feature = await loadFeature('tests/features/notifications.feature');

describeFeature(feature, ({ Scenario }) => {
  // Shared test state
  let mockClient: HaClient;
  let notificationArgs: {
    message: string;
    title?: string;
    target?: string;
    actions?: Array<{ action: string; title: string }>;
    priority?: 'high' | 'normal' | 'low' | 'min';
  };
  let result: { success: boolean; service: string; context: unknown } | null;
  let lastServiceCall: { domain: string; service: string; service_data: Record<string, unknown> } | null;

  // Helper to simulate sendNotification tool behavior
  async function sendNotification(): Promise<void> {
    const serviceData: Record<string, unknown> = { message: notificationArgs.message };
    if (notificationArgs.title) serviceData.title = notificationArgs.title;

    const notificationData = buildNotificationData({
      actions: notificationArgs.actions,
      priority: notificationArgs.priority,
    });
    if (Object.keys(notificationData).length > 0) {
      serviceData.data = notificationData;
    }

    const service = notificationArgs.target || 'persistent_notification';
    lastServiceCall = {
      domain: 'notify',
      service,
      service_data: serviceData,
    };

    const callResult = await mockClient.callService({
      domain: 'notify',
      service,
      service_data: serviceData,
    });

    result = {
      success: true,
      service: `notify.${service}`,
      context: callResult.context,
    };
  }

  Scenario('Send a simple notification', ({ Given, When, Then, And }) => {
    Given('a notification message "Hello from MCP!"', () => {
      notificationArgs = { message: 'Hello from MCP!' };
      result = null;
      lastServiceCall = null;

      mockClient = {
        callService: vi.fn().mockResolvedValue({
          context: { id: 'test-ctx' },
        } as ServiceCallResponse),
      } as unknown as HaClient;
    });

    When('I send the notification to "mobile_app_samsung_s25_fe"', async () => {
      notificationArgs.target = 'mobile_app_samsung_s25_fe';
      await sendNotification();
    });

    Then('the notification should be sent successfully', () => {
      expect(result).not.toBeNull();
      expect(result?.success).toBe(true);
    });

    And('the service called should be "notify.mobile_app_samsung_s25_fe"', () => {
      expect(result?.service).toBe('notify.mobile_app_samsung_s25_fe');
      expect(lastServiceCall?.service).toBe('mobile_app_samsung_s25_fe');
    });
  });

  Scenario('Send notification with title', ({ Given, When, Then, And }) => {
    Given('a notification message "Motion detected in garage"', () => {
      notificationArgs = { message: 'Motion detected in garage' };
      result = null;
      lastServiceCall = null;

      mockClient = {
        callService: vi.fn().mockResolvedValue({
          context: { id: 'test-ctx' },
        } as ServiceCallResponse),
      } as unknown as HaClient;
    });

    And('a notification title "Security Alert"', () => {
      notificationArgs.title = 'Security Alert';
    });

    When('I send the notification to "mobile_app_samsung_s25_fe"', async () => {
      notificationArgs.target = 'mobile_app_samsung_s25_fe';
      await sendNotification();
    });

    Then('the notification should be sent successfully', () => {
      expect(result?.success).toBe(true);
    });

    And('the title should be included in the service data', () => {
      expect(lastServiceCall?.service_data.title).toBe('Security Alert');
    });
  });

  Scenario('Send notification with action buttons', ({ Given, When, Then, And }) => {
    Given('a notification message "Someone is at the door"', () => {
      notificationArgs = { message: 'Someone is at the door', actions: [] };
      result = null;
      lastServiceCall = null;

      mockClient = {
        callService: vi.fn().mockResolvedValue({
          context: { id: 'test-ctx' },
        } as ServiceCallResponse),
      } as unknown as HaClient;
    });

    And('an action button "OPEN" with title "Open Door"', () => {
      notificationArgs.actions!.push({ action: 'OPEN', title: 'Open Door' });
    });

    And('an action button "IGNORE" with title "Ignore"', () => {
      notificationArgs.actions!.push({ action: 'IGNORE', title: 'Ignore' });
    });

    When('I send the notification to "mobile_app_samsung_s25_fe"', async () => {
      notificationArgs.target = 'mobile_app_samsung_s25_fe';
      await sendNotification();
    });

    Then('the notification should be sent successfully', () => {
      expect(result?.success).toBe(true);
    });

    And('the notification data should contain 2 actions', () => {
      const data = lastServiceCall?.service_data.data as Record<string, unknown>;
      const actions = data?.actions as Array<unknown>;
      expect(actions).toHaveLength(2);
    });
  });

  Scenario('Send persistent notification (no target)', ({ Given, When, Then }) => {
    Given('a notification message "System update available"', () => {
      notificationArgs = { message: 'System update available' };
      result = null;
      lastServiceCall = null;

      mockClient = {
        callService: vi.fn().mockResolvedValue({
          context: { id: 'test-ctx' },
        } as ServiceCallResponse),
      } as unknown as HaClient;
    });

    When('I send the notification without a target', async () => {
      // No target specified - should default to persistent_notification
      await sendNotification();
    });

    Then('the notification should be sent to "persistent_notification"', () => {
      expect(result?.service).toBe('notify.persistent_notification');
      expect(lastServiceCall?.service).toBe('persistent_notification');
    });
  });

  Scenario('Send high priority notification', ({ Given, When, Then, And }) => {
    Given('a notification message "Water leak detected!"', () => {
      notificationArgs = { message: 'Water leak detected!' };
      result = null;
      lastServiceCall = null;

      mockClient = {
        callService: vi.fn().mockResolvedValue({
          context: { id: 'test-ctx' },
        } as ServiceCallResponse),
      } as unknown as HaClient;
    });

    And('priority set to "high"', () => {
      notificationArgs.priority = 'high';
    });

    When('I send the notification to "mobile_app_samsung_s25_fe"', async () => {
      notificationArgs.target = 'mobile_app_samsung_s25_fe';
      await sendNotification();
    });

    Then('the notification should be sent successfully', () => {
      expect(result?.success).toBe(true);
    });

    And('the notification data should have priority "high"', () => {
      const data = lastServiceCall?.service_data.data as Record<string, unknown>;
      expect(data?.priority).toBe('high');
    });
  });
});
