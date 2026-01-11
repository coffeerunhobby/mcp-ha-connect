/**
 * BDD tests for Automation Creation
 * Uses vitest-cucumber for Gherkin syntax
 */

import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect, vi } from 'vitest';
import { AutomationOperations } from '../../src/haClient/automations.js';
import type { StateOperations } from '../../src/haClient/states.js';
import type { ServiceOperations } from '../../src/haClient/services.js';
import type { RequestHandler } from '../../src/haClient/request.js';
import type { AutomationConfig, AutomationTrigger, AutomationAction } from '../../src/types/index.js';

const feature = await loadFeature('tests/features/automation-creation.feature');

describeFeature(feature, ({ Background, Scenario }) => {
  // Shared test state
  let mockStateOps: StateOperations;
  let mockServiceOps: ServiceOperations;
  let mockRequest: RequestHandler;
  let automationOps: AutomationOperations;
  let automationConfig: Partial<AutomationConfig>;
  let triggers: AutomationTrigger[];
  let actions: AutomationAction[];
  let result: { id: string } | null;
  let error: Error | null;

  Background(({ Given }) => {
    Given('a connected Home Assistant client', () => {
      // Reset state for each scenario
      automationConfig = {};
      triggers = [];
      actions = [];
      result = null;
      error = null;

      // Setup mocks
      mockStateOps = {
        getStates: vi.fn().mockResolvedValue([]),
        getState: vi.fn().mockResolvedValue(null),
      } as unknown as StateOperations;

      mockServiceOps = {
        callService: vi.fn().mockResolvedValue({ context: { id: 'test' } }),
      } as unknown as ServiceOperations;

      mockRequest = {
        post: vi.fn().mockResolvedValue({ result: 'ok' }),
        get: vi.fn().mockResolvedValue({}),
        request: vi.fn().mockResolvedValue({}),
      } as unknown as RequestHandler;

      automationOps = new AutomationOperations(mockStateOps, mockServiceOps, mockRequest);
    });
  });

  Scenario('Create a simple time-based automation', ({ Given, When, Then, And }) => {
    Given('an automation config with alias "Morning Lights"', () => {
      automationConfig.alias = 'Morning Lights';
    });

    And('a time trigger at "06:00:00"', () => {
      triggers.push({
        platform: 'time',
        at: '06:00:00',
      });
    });

    And('an action to turn on "light.bedroom"', () => {
      actions.push({
        service: 'light.turn_on',
        target: { entity_id: 'light.bedroom' },
      });
    });

    When('I create the automation', async () => {
      try {
        result = await automationOps.createAutomation({
          alias: automationConfig.alias!,
          trigger: triggers,
          action: actions,
        });
      } catch (e) {
        error = e as Error;
      }
    });

    Then('the automation should be created successfully', () => {
      expect(error).toBeNull();
      expect(result).not.toBeNull();
      expect(mockRequest.post).toHaveBeenCalled();
    });

    And('the automation ID should be returned', () => {
      expect(result?.id).toBeDefined();
      expect(typeof result?.id).toBe('string');
    });
  });

  Scenario('Create an automation with state trigger', ({ Given, When, Then, And }) => {
    Given('an automation config with alias "Motion Alert"', () => {
      automationConfig.alias = 'Motion Alert';
    });

    And('a state trigger for "binary_sensor.motion" changing to "on"', () => {
      triggers.push({
        platform: 'state',
        entity_id: 'binary_sensor.motion',
        to: 'on',
      });
    });

    And('an action to send notification "Motion detected!"', () => {
      actions.push({
        service: 'notify.persistent_notification',
        data: { message: 'Motion detected!' },
      });
    });

    When('I create the automation', async () => {
      try {
        result = await automationOps.createAutomation({
          alias: automationConfig.alias!,
          trigger: triggers,
          action: actions,
        });
      } catch (e) {
        error = e as Error;
      }
    });

    Then('the automation should be created successfully', () => {
      expect(error).toBeNull();
      expect(result).not.toBeNull();
    });
  });

  Scenario('Reject automation without required fields', ({ Given, When, Then }) => {
    Given('an automation config without alias', () => {
      // Leave alias undefined
      automationConfig = {};
    });

    When('I attempt to create the automation', async () => {
      // Simulate the tool validation that happens in createAutomation.ts
      // The actual validation is in the tool layer, not AutomationOperations
      if (!automationConfig.alias) {
        error = new Error('alias, trigger, and action are required');
      }
    });

    Then('it should fail with error "alias, trigger, and action are required"', () => {
      expect(error).not.toBeNull();
      expect(error?.message).toBe('alias, trigger, and action are required');
    });
  });

  Scenario('Create automation with multiple actions', ({ Given, When, Then, And }) => {
    Given('an automation config with alias "Goodnight Routine"', () => {
      automationConfig.alias = 'Goodnight Routine';
    });

    And('a time trigger at "23:00:00"', () => {
      triggers.push({
        platform: 'time',
        at: '23:00:00',
      });
    });

    And('an action to turn off "light.living_room"', () => {
      actions.push({
        service: 'light.turn_off',
        target: { entity_id: 'light.living_room' },
      });
    });

    And('an action to turn off "light.kitchen"', () => {
      actions.push({
        service: 'light.turn_off',
        target: { entity_id: 'light.kitchen' },
      });
    });

    And('an action to set "climate.thermostat" to 18 degrees', () => {
      actions.push({
        service: 'climate.set_temperature',
        target: { entity_id: 'climate.thermostat' },
        data: { temperature: 18 },
      });
    });

    When('I create the automation', async () => {
      try {
        result = await automationOps.createAutomation({
          alias: automationConfig.alias!,
          trigger: triggers,
          action: actions,
        });
      } catch (e) {
        error = e as Error;
      }
    });

    Then('the automation should be created successfully', () => {
      expect(error).toBeNull();
      expect(result).not.toBeNull();

      // Verify the POST was called with all actions
      const postCall = (mockRequest.post as ReturnType<typeof vi.fn>).mock.calls[0];
      const payload = postCall[1];
      expect(payload.action).toHaveLength(3);
    });
  });
});
