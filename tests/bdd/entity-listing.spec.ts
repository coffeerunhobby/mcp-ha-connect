/**
 * BDD tests for Entity Listing
 * Uses vitest-cucumber for Gherkin syntax
 */

import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect, vi } from 'vitest';
import { EntityOperations } from '../../src/haClient/entities.js';
import type { StateOperations } from '../../src/haClient/states.js';
import type { Entity, DomainSummary } from '../../src/types/index.js';

const feature = await loadFeature('tests/features/entity-listing.feature');

describeFeature(feature, ({ Scenario }) => {
  // Shared test state
  let mockStateOps: StateOperations;
  let entityOps: EntityOperations;
  let listResults: Entity[];
  let summary: DomainSummary;

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
      entity_id: 'light.bedroom',
      state: 'off',
      attributes: { friendly_name: 'Bedroom Light' },
      last_changed: '2026-01-08T09:00:00.000Z',
      last_updated: '2026-01-08T10:00:00.000Z',
      context: { id: 'ctx-2', parent_id: null, user_id: null },
    },
    {
      entity_id: 'sensor.temperature',
      state: '22.5',
      attributes: { friendly_name: 'Temperature', unit_of_measurement: '°C' },
      last_changed: '2026-01-08T10:00:00.000Z',
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

  function setupMocks() {
    mockStateOps = {
      getStates: vi.fn().mockResolvedValue(mockEntities),
    } as unknown as StateOperations;
    entityOps = new EntityOperations(mockStateOps);
    listResults = [];
  }

  Scenario('List all entities without filters', ({ Given, When, Then }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I list all entities', async () => {
      listResults = await entityOps.listEntities();
    });

    Then('I should get all 4 entities', () => {
      expect(listResults).toHaveLength(4);
    });
  });

  Scenario('Filter entities by domain', ({ Given, When, Then, And }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I list entities filtered by domain "light"', async () => {
      listResults = await entityOps.listEntities({ domain: 'light' });
    });

    Then('I should only get light entities', () => {
      expect(listResults.every(e => e.entity_id.startsWith('light.'))).toBe(true);
    });

    And('the count should be 2', () => {
      expect(listResults).toHaveLength(2);
    });
  });

  Scenario('Filter entities by state', ({ Given, When, Then, And }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I list entities filtered by state "on"', async () => {
      listResults = await entityOps.listEntities({ state: 'on' });
    });

    Then('I should only get entities that are "on"', () => {
      expect(listResults.every(e => e.state === 'on')).toBe(true);
    });

    And('the count should be 2', () => {
      expect(listResults).toHaveLength(2);
    });
  });

  Scenario('Filter entities by search query', ({ Given, When, Then, And }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I list entities filtered by search "room"', async () => {
      listResults = await entityOps.listEntities({ search: 'room' });
    });

    Then('I should only get entities matching "room"', () => {
      expect(listResults.every(e =>
        e.entity_id.includes('room') ||
        (e.attributes.friendly_name as string)?.toLowerCase().includes('room')
      )).toBe(true);
    });

    And('the count should be 2', () => {
      expect(listResults).toHaveLength(2);
    });
  });

  Scenario('Apply limit to entity list', ({ Given, When, Then }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I list entities with limit 2', async () => {
      listResults = await entityOps.listEntities({ limit: 2 });
    });

    Then('I should get at most 2 entities', () => {
      expect(listResults.length).toBeLessThanOrEqual(2);
    });
  });

  Scenario('Combine multiple filters', ({ Given, When, Then, And }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I list entities filtered by domain "light" and state "on"', async () => {
      listResults = await entityOps.listEntities({ domain: 'light', state: 'on' });
    });

    Then('I should only get lights that are on', () => {
      expect(listResults.every(e =>
        e.entity_id.startsWith('light.') && e.state === 'on'
      )).toBe(true);
    });

    And('the count should be 1', () => {
      expect(listResults).toHaveLength(1);
    });
  });

  Scenario('Get domain summary', ({ Given, When, Then, And }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I get the summary for domain "light"', async () => {
      summary = await entityOps.getDomainSummary('light');
    });

    Then('the summary should show domain "light"', () => {
      expect(summary.domain).toBe('light');
    });

    And('the total count should be 2', () => {
      expect(summary.count).toBe(2);
    });

    And('the state breakdown should show 1 "on" and 1 "off"', () => {
      expect(summary.states).toEqual({ on: 1, off: 1 });
    });
  });

  Scenario('Get domain summary for non-existent domain', ({ Given, When, Then, And }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I get the summary for domain "vacuum"', async () => {
      summary = await entityOps.getDomainSummary('vacuum');
    });

    Then('the summary should show domain "vacuum"', () => {
      expect(summary.domain).toBe('vacuum');
    });

    And('the total count should be 0', () => {
      expect(summary.count).toBe(0);
    });
  });
});
