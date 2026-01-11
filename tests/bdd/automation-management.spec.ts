/**
 * BDD tests for Automation Management
 * Uses vitest-cucumber for Gherkin syntax
 */

import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect, vi } from 'vitest';
import { AutomationOperations } from '../../src/haClient/automations.js';
import type { StateOperations } from '../../src/haClient/states.js';
import type { ServiceOperations } from '../../src/haClient/services.js';
import type { RequestHandler } from '../../src/haClient/request.js';
import type { Entity, Automation } from '../../src/types/index.js';

const feature = await loadFeature('tests/features/automation-management.feature');

describeFeature(feature, ({ Scenario }) => {
  // Shared test state
  let mockStateOps: StateOperations;
  let mockServiceOps: ServiceOperations;
  let mockRequest: RequestHandler;
  let automationOps: AutomationOperations;
  let automations: Automation[];
  let automation: Automation | null;
  let entityId: string;
  let lastServiceCall: { domain: string; service: string; target?: { entity_id: string }; service_data?: Record<string, unknown> } | null;
  let lastRequest: { method: string; path: string } | null;

  const mockAutomationEntities: Entity[] = [
    {
      entity_id: 'automation.morning_lights',
      state: 'on',
      attributes: {
        friendly_name: 'Morning Lights',
        last_triggered: '2026-01-08T06:00:00.000Z',
        description: 'Turn on lights at sunrise',
        mode: 'single',
      },
      last_changed: '2026-01-08T06:00:00.000Z',
      last_updated: '2026-01-08T06:00:00.000Z',
      context: { id: 'ctx-1', parent_id: null, user_id: null },
    },
    {
      entity_id: 'automation.night_mode',
      state: 'off',
      attributes: {
        friendly_name: 'Night Mode',
        last_triggered: null,
        mode: 'restart',
      },
      last_changed: '2026-01-07T22:00:00.000Z',
      last_updated: '2026-01-08T10:00:00.000Z',
      context: { id: 'ctx-2', parent_id: null, user_id: null },
    },
    {
      entity_id: 'automation.dynamic_scene',
      state: 'on',
      attributes: {
        friendly_name: 'Dynamic Scene',
        mode: 'queued',
      },
      last_changed: '2026-01-08T09:30:00.000Z',
      last_updated: '2026-01-08T09:30:00.000Z',
      context: { id: 'ctx-3', parent_id: null, user_id: null },
    },
  ];

  function setupMocks() {
    lastServiceCall = null;
    lastRequest = null;

    mockStateOps = {
      getStates: vi.fn().mockResolvedValue(mockAutomationEntities),
      getState: vi.fn().mockImplementation(async (id: string) => {
        return mockAutomationEntities.find(e => e.entity_id === id) || null;
      }),
    } as unknown as StateOperations;

    mockServiceOps = {
      callService: vi.fn().mockImplementation(async (data) => {
        lastServiceCall = {
          domain: data.domain,
          service: data.service,
          target: data.target,
          service_data: data.service_data,
        };
        return { context: { id: 'test-ctx' } };
      }),
    } as unknown as ServiceOperations;

    mockRequest = {
      post: vi.fn().mockResolvedValue({ result: 'ok' }),
      get: vi.fn().mockResolvedValue([]),
      request: vi.fn().mockImplementation(async (path: string, options: { method: string }) => {
        lastRequest = { method: options.method, path };
        return {};
      }),
    } as unknown as RequestHandler;

    automationOps = new AutomationOperations(mockStateOps, mockServiceOps, mockRequest);
  }

  Scenario('List all automations', ({ Given, When, Then, And }) => {
    Given('a Home Assistant with automations', () => {
      setupMocks();
    });

    When('I list all automations', async () => {
      automations = await automationOps.getAutomations();
    });

    Then('I should get all automation entities', () => {
      expect(automations).toHaveLength(3);
    });

    And('each automation should have id, alias, and state', () => {
      automations.forEach(a => {
        expect(a.id).toBeDefined();
        expect(a.alias).toBeDefined();
        expect(a.state).toMatch(/^(on|off)$/);
      });
    });
  });

  Scenario('Get automation details', ({ Given, When, Then, And }) => {
    Given('an automation "automation.morning_lights" exists', () => {
      setupMocks();
      entityId = 'automation.morning_lights';
    });

    When('I get the automation details', async () => {
      automation = await automationOps.getAutomation(entityId);
    });

    Then('I should see the automation alias "Morning Lights"', () => {
      expect(automation?.alias).toBe('Morning Lights');
    });

    And('the state should be "on"', () => {
      expect(automation?.state).toBe('on');
    });

    And('the mode should be "single"', () => {
      expect(automation?.mode).toBe('single');
    });
  });

  Scenario('Trigger an automation manually', ({ Given, When, Then, And }) => {
    Given('an automation "automation.morning_lights" exists', () => {
      setupMocks();
      entityId = 'automation.morning_lights';
    });

    When('I trigger the automation', async () => {
      await automationOps.triggerAutomation(entityId);
    });

    Then('the automation.trigger service should be called', () => {
      expect(lastServiceCall?.domain).toBe('automation');
      expect(lastServiceCall?.service).toBe('trigger');
    });

    And('the target should be "automation.morning_lights"', () => {
      expect(lastServiceCall?.target?.entity_id).toBe('automation.morning_lights');
    });
  });

  Scenario('Trigger automation with variables', ({ Given, When, Then, And }) => {
    Given('an automation "automation.dynamic_scene" exists', () => {
      setupMocks();
      entityId = 'automation.dynamic_scene';
    });

    When('I trigger the automation with variables {"brightness": 100}', async () => {
      await automationOps.triggerAutomation(entityId, { brightness: 100 });
    });

    Then('the automation.trigger service should be called', () => {
      expect(lastServiceCall?.domain).toBe('automation');
      expect(lastServiceCall?.service).toBe('trigger');
    });

    And('the variables should be passed', () => {
      expect(lastServiceCall?.service_data?.variables).toEqual({ brightness: 100 });
    });
  });

  Scenario('Enable a disabled automation', ({ Given, When, Then }) => {
    Given('a disabled automation "automation.night_mode" exists', () => {
      setupMocks();
      entityId = 'automation.night_mode';
    });

    When('I enable the automation', async () => {
      await automationOps.enableAutomation(entityId);
    });

    Then('the automation.turn_on service should be called', () => {
      expect(lastServiceCall?.domain).toBe('automation');
      expect(lastServiceCall?.service).toBe('turn_on');
      expect(lastServiceCall?.target?.entity_id).toBe(entityId);
    });
  });

  Scenario('Disable an enabled automation', ({ Given, When, Then }) => {
    Given('an enabled automation "automation.morning_lights" exists', () => {
      setupMocks();
      entityId = 'automation.morning_lights';
    });

    When('I disable the automation', async () => {
      await automationOps.disableAutomation(entityId);
    });

    Then('the automation.turn_off service should be called', () => {
      expect(lastServiceCall?.domain).toBe('automation');
      expect(lastServiceCall?.service).toBe('turn_off');
      expect(lastServiceCall?.target?.entity_id).toBe(entityId);
    });
  });

  Scenario('Toggle automation state', ({ Given, When, Then }) => {
    Given('an automation "automation.morning_lights" exists', () => {
      setupMocks();
      entityId = 'automation.morning_lights';
    });

    When('I toggle the automation', async () => {
      await automationOps.toggleAutomation(entityId);
    });

    Then('the automation.toggle service should be called', () => {
      expect(lastServiceCall?.domain).toBe('automation');
      expect(lastServiceCall?.service).toBe('toggle');
      expect(lastServiceCall?.target?.entity_id).toBe(entityId);
    });
  });

  Scenario('Reload automations from configuration', ({ Given, When, Then }) => {
    Given('a Home Assistant with automations', () => {
      setupMocks();
    });

    When('I reload automations', async () => {
      await automationOps.reloadAutomations();
    });

    Then('the automation.reload service should be called', () => {
      expect(lastServiceCall?.domain).toBe('automation');
      expect(lastServiceCall?.service).toBe('reload');
    });
  });

  Scenario('Delete an automation', ({ Given, When, Then }) => {
    Given('an automation with ID "1234567890" exists', () => {
      setupMocks();
    });

    When('I delete the automation', async () => {
      await automationOps.deleteAutomation('1234567890');
    });

    Then('a DELETE request should be made to the config API', () => {
      expect(lastRequest?.method).toBe('DELETE');
      expect(lastRequest?.path).toBe('/config/automation/config/1234567890');
    });
  });
});
