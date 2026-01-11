/**
 * BDD tests for Service Calls
 * Uses vitest-cucumber for Gherkin syntax
 */

import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect, vi } from 'vitest';
import { ServiceOperations } from '../../src/haClient/services.js';
import type { RequestHandler } from '../../src/haClient/request.js';
import type { ServiceCallResponse } from '../../src/types/index.js';

const feature = await loadFeature('tests/features/service-calls.feature');

describeFeature(feature, ({ Scenario }) => {
  // Shared test state
  let mockRequest: RequestHandler;
  let serviceOps: ServiceOperations;
  let result: ServiceCallResponse;
  let lastPostCall: { path: string; data: Record<string, unknown> } | null;

  function setupMocks() {
    lastPostCall = null;

    mockRequest = {
      post: vi.fn().mockImplementation(async (path: string, data: Record<string, unknown>) => {
        lastPostCall = { path, data };
        return { context: { id: 'ctx-123', parent_id: null, user_id: null } };
      }),
    } as unknown as RequestHandler;

    serviceOps = new ServiceOperations(mockRequest);
  }

  Scenario('Call service with domain and service name', ({ Given, When, Then, And }) => {
    Given('a Home Assistant connection', () => {
      setupMocks();
    });

    When('I call service "light.turn_on"', async () => {
      result = await serviceOps.callService({
        domain: 'light',
        service: 'turn_on',
      });
    });

    Then('the service should be called successfully', () => {
      expect(result).toBeDefined();
      expect(result.context).toBeDefined();
    });

    And('the request should go to "/services/light/turn_on"', () => {
      expect(lastPostCall?.path).toBe('/services/light/turn_on');
    });
  });

  Scenario('Call service with target entity', ({ Given, When, Then }) => {
    Given('a Home Assistant connection', () => {
      setupMocks();
    });

    When('I call service "light.turn_on" targeting "light.living_room"', async () => {
      result = await serviceOps.callService({
        domain: 'light',
        service: 'turn_on',
        target: { entity_id: 'light.living_room' },
      });
    });

    Then('the entity_id should be included in the request', () => {
      expect(lastPostCall?.data.entity_id).toBe('light.living_room');
    });
  });

  Scenario('Call service with service data', ({ Given, When, Then }) => {
    Given('a Home Assistant connection', () => {
      setupMocks();
    });

    When('I call service "light.turn_on" with brightness 255', async () => {
      result = await serviceOps.callService({
        domain: 'light',
        service: 'turn_on',
        target: { entity_id: 'light.living_room' },
        service_data: { brightness: 255 },
      });
    });

    Then('the brightness should be included in the request', () => {
      expect(lastPostCall?.data.brightness).toBe(255);
    });
  });

  Scenario('Call service targeting multiple entities', ({ Given, When, Then }) => {
    Given('a Home Assistant connection', () => {
      setupMocks();
    });

    When('I call service "light.turn_off" targeting multiple entities', async () => {
      result = await serviceOps.callService({
        domain: 'light',
        service: 'turn_off',
        target: { entity_id: ['light.living_room', 'light.bedroom'] },
      });
    });

    Then('all entity IDs should be included in the request', () => {
      expect(lastPostCall?.data.entity_id).toEqual(['light.living_room', 'light.bedroom']);
    });
  });

  Scenario('Call climate service with temperature', ({ Given, When, Then }) => {
    Given('a Home Assistant connection', () => {
      setupMocks();
    });

    When('I call service "climate.set_temperature" with temperature 22', async () => {
      result = await serviceOps.callService({
        domain: 'climate',
        service: 'set_temperature',
        target: { entity_id: 'climate.living_room' },
        service_data: { temperature: 22 },
      });
    });

    Then('the temperature should be included in the request', () => {
      expect(lastPostCall?.path).toBe('/services/climate/set_temperature');
      expect(lastPostCall?.data.temperature).toBe(22);
    });
  });

  Scenario('Restart Home Assistant server', ({ Given, When, Then }) => {
    Given('a Home Assistant connection', () => {
      setupMocks();
    });

    When('I call the restart server operation', async () => {
      await serviceOps.restartServer();
    });

    Then('the homeassistant.restart service should be called', () => {
      expect(lastPostCall?.path).toBe('/services/homeassistant/restart');
    });
  });
});
