/**
 * BDD tests for Entity Search
 * Uses vitest-cucumber for Gherkin syntax
 */

import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect, vi } from 'vitest';
import { EntityOperations } from '../../src/haClient/entities.js';
import type { StateOperations } from '../../src/haClient/states.js';
import type { Entity } from '../../src/types/index.js';

const feature = await loadFeature('tests/features/entity-search.feature');

describeFeature(feature, ({ Scenario }) => {
  // Shared test state
  let mockStateOps: StateOperations;
  let entityOps: EntityOperations;
  let searchResults: Entity[];

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
    searchResults = [];
  }

  Scenario('Search entities by friendly name', ({ Given, When, Then, And }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I search for "living"', async () => {
      searchResults = await entityOps.searchEntities('living');
    });

    Then('I should find entities with "living" in their friendly name', () => {
      expect(searchResults.length).toBeGreaterThan(0);
    });

    And('the results should include "light.living_room"', () => {
      expect(searchResults.map(e => e.entity_id)).toContain('light.living_room');
    });
  });

  Scenario('Search entities by entity ID', ({ Given, When, Then, And }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I search for "kitchen"', async () => {
      searchResults = await entityOps.searchEntities('kitchen');
    });

    Then('I should find entities with "kitchen" in their entity ID', () => {
      expect(searchResults.length).toBeGreaterThan(0);
    });

    And('the results should include "switch.kitchen"', () => {
      expect(searchResults.map(e => e.entity_id)).toContain('switch.kitchen');
    });
  });

  Scenario('Search is case insensitive', ({ Given, When, Then, And }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I search for "BEDROOM"', async () => {
      searchResults = await entityOps.searchEntities('BEDROOM');
    });

    Then('I should find entities matching "bedroom"', () => {
      expect(searchResults.length).toBeGreaterThan(0);
    });

    And('the results should include "light.bedroom"', () => {
      expect(searchResults.map(e => e.entity_id)).toContain('light.bedroom');
    });
  });

  Scenario('Search returns multiple matches', ({ Given, When, Then, And }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I search for "light"', async () => {
      searchResults = await entityOps.searchEntities('light');
    });

    Then('I should find all entities containing "light"', () => {
      expect(searchResults.every(e =>
        e.entity_id.toLowerCase().includes('light') ||
        (e.attributes.friendly_name as string)?.toLowerCase().includes('light')
      )).toBe(true);
    });

    And('the result count should be 2', () => {
      expect(searchResults).toHaveLength(2);
    });
  });

  Scenario('Search returns empty for no matches', ({ Given, When, Then }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I search for "nonexistent"', async () => {
      searchResults = await entityOps.searchEntities('nonexistent');
    });

    Then('I should find no entities', () => {
      expect(searchResults).toHaveLength(0);
    });
  });

  Scenario('Get entities by domain', ({ Given, When, Then, And }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I get entities for domain "light"', async () => {
      searchResults = await entityOps.getEntitiesByDomain('light');
    });

    Then('I should only get light entities', () => {
      expect(searchResults.length).toBeGreaterThan(0);
    });

    And('all entity IDs should start with "light."', () => {
      expect(searchResults.every(e => e.entity_id.startsWith('light.'))).toBe(true);
    });
  });

  Scenario('Get entities for empty domain', ({ Given, When, Then }) => {
    Given('a Home Assistant instance with multiple entities', () => {
      setupMocks();
    });

    When('I get entities for domain "climate"', async () => {
      searchResults = await entityOps.getEntitiesByDomain('climate');
    });

    Then('I should find no entities', () => {
      expect(searchResults).toHaveLength(0);
    });
  });
});
