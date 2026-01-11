/**
 * BDD tests for State Retrieval
 * Uses vitest-cucumber for Gherkin syntax
 */

import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect, vi } from 'vitest';
import { StateOperations } from '../../src/haClient/states.js';
import type { RequestHandler } from '../../src/haClient/request.js';
import type { Entity } from '../../src/types/index.js';
import { ApiError } from '../../src/types/index.js';

const feature = await loadFeature('tests/features/state-retrieval.feature');

describeFeature(feature, ({ Scenario }) => {
  // Shared test state
  let mockRequest: RequestHandler;
  let stateOps: StateOperations;
  let stateResult: Entity | Entity[] | null;
  let error: Error | null;

  const mockEntities: Entity[] = [
    {
      entity_id: 'light.living_room',
      state: 'on',
      attributes: { friendly_name: 'Living Room Light', brightness: 255 },
      last_changed: '2026-01-08T10:00:00.000Z',
      last_updated: '2026-01-08T10:00:00.000Z',
      context: { id: 'ctx-1', parent_id: null, user_id: null },
    },
    {
      entity_id: 'sensor.temperature',
      state: '22.5',
      attributes: { friendly_name: 'Temperature', unit_of_measurement: '°C' },
      last_changed: '2026-01-08T10:00:00.000Z',
      last_updated: '2026-01-08T10:00:00.000Z',
      context: { id: 'ctx-2', parent_id: null, user_id: null },
    },
    {
      entity_id: 'binary_sensor.motion',
      state: 'off',
      attributes: { friendly_name: 'Motion Sensor', device_class: 'motion' },
      last_changed: '2026-01-08T09:00:00.000Z',
      last_updated: '2026-01-08T10:00:00.000Z',
      context: { id: 'ctx-3', parent_id: null, user_id: null },
    },
    {
      entity_id: 'switch.kitchen',
      state: 'on',
      attributes: { friendly_name: 'Kitchen Switch' },
      last_changed: '2026-01-08T08:00:00.000Z',
      last_updated: '2026-01-08T10:00:00.000Z',
      context: { id: 'ctx-4', parent_id: null, user_id: null },
    },
  ];

  function setupMocks(entities: Entity[] = mockEntities) {
    error = null;
    stateResult = null;

    mockRequest = {
      get: vi.fn().mockImplementation(async (path: string) => {
        if (path === '/states') {
          return entities;
        }
        if (path.startsWith('/states/')) {
          const entityId = path.replace('/states/', '');
          const entity = entities.find(e => e.entity_id === entityId);
          if (entity) {
            return entity;
          }
          throw new ApiError('Not found', 404, { path });
        }
        return [];
      }),
    } as unknown as RequestHandler;

    stateOps = new StateOperations(mockRequest);
  }

  Scenario('Get all entity states', ({ Given, When, Then, And }) => {
    Given('a Home Assistant with multiple entities', () => {
      setupMocks();
    });

    When('I get all states', async () => {
      stateResult = await stateOps.getStates();
    });

    Then('I should receive all entity states', () => {
      expect(Array.isArray(stateResult)).toBe(true);
      expect((stateResult as Entity[]).length).toBe(4);
    });

    And('the states API should be called', () => {
      expect(mockRequest.get).toHaveBeenCalledWith('/states');
    });
  });

  Scenario('Get state of specific entity', ({ Given, When, Then, And }) => {
    Given('an entity "light.living_room" exists', () => {
      setupMocks();
    });

    When('I get the state of "light.living_room"', async () => {
      stateResult = await stateOps.getState('light.living_room');
    });

    Then('I should receive the entity state', () => {
      expect(stateResult).not.toBeNull();
    });

    And('the state should include entity_id, state, and attributes', () => {
      const entity = stateResult as Entity;
      expect(entity.entity_id).toBe('light.living_room');
      expect(entity.state).toBe('on');
      expect(entity.attributes).toBeDefined();
      expect(entity.attributes.friendly_name).toBe('Living Room Light');
    });
  });

  Scenario('Get state of non-existent entity', ({ Given, When, Then }) => {
    Given('an entity does not exist', () => {
      setupMocks();
    });

    When('I get the state of "nonexistent.entity"', async () => {
      stateResult = await stateOps.getState('nonexistent.entity');
    });

    Then('I should receive null', () => {
      expect(stateResult).toBeNull();
    });
  });

  Scenario('Handle API error gracefully', ({ Given, When, Then }) => {
    Given('the API returns a 500 error', () => {
      mockRequest = {
        get: vi.fn().mockRejectedValue(new ApiError('Server error', 500, { path: '/states/sensor.temperature' })),
      } as unknown as RequestHandler;
      stateOps = new StateOperations(mockRequest);
      error = null;
    });

    When('I get the state of "sensor.temperature"', async () => {
      try {
        stateResult = await stateOps.getState('sensor.temperature');
      } catch (e) {
        error = e as Error;
      }
    });

    Then('it should throw an API error', () => {
      expect(error).not.toBeNull();
      expect(error).toBeInstanceOf(ApiError);
    });
  });

  Scenario('Get all sensors', ({ Given, When, Then, And }) => {
    Given('a Home Assistant with sensors and other entities', () => {
      setupMocks();
    });

    When('I get all sensors', async () => {
      stateResult = await stateOps.getAllSensors();
    });

    Then('I should only receive sensor and binary_sensor entities', () => {
      const sensors = stateResult as Entity[];
      expect(sensors.every(e =>
        e.entity_id.startsWith('sensor.') || e.entity_id.startsWith('binary_sensor.')
      )).toBe(true);
    });

    And('other entity types should be excluded', () => {
      const sensors = stateResult as Entity[];
      expect(sensors.some(e => e.entity_id.startsWith('light.'))).toBe(false);
      expect(sensors.some(e => e.entity_id.startsWith('switch.'))).toBe(false);
    });
  });

  Scenario('Get sensors when none exist', ({ Given, When, Then }) => {
    Given('a Home Assistant with no sensors', () => {
      setupMocks([
        {
          entity_id: 'light.living_room',
          state: 'on',
          attributes: { friendly_name: 'Living Room Light' },
          last_changed: '2026-01-08T10:00:00.000Z',
          last_updated: '2026-01-08T10:00:00.000Z',
          context: { id: 'ctx-1', parent_id: null, user_id: null },
        },
      ]);
    });

    When('I get all sensors', async () => {
      stateResult = await stateOps.getAllSensors();
    });

    Then('I should receive an empty array', () => {
      expect(stateResult).toEqual([]);
    });
  });
});
