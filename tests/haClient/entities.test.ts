/**
 * EntityOperations tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EntityOperations } from '../../src/haClient/entities.js';
import type { StateOperations } from '../../src/haClient/states.js';
import type { Entity } from '../../src/types/index.js';

describe('EntityOperations', () => {
  let mockStateOps: StateOperations;
  let entityOps: EntityOperations;

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

  beforeEach(() => {
    mockStateOps = {
      getStates: vi.fn().mockResolvedValue(mockEntities),
    } as unknown as StateOperations;

    entityOps = new EntityOperations(mockStateOps);
  });

  describe('getEntitiesByDomain', () => {
    it('should filter entities by domain', async () => {
      const lights = await entityOps.getEntitiesByDomain('light');

      expect(lights).toHaveLength(2);
      expect(lights.map(e => e.entity_id)).toContain('light.living_room');
      expect(lights.map(e => e.entity_id)).toContain('light.bedroom');
    });

    it('should return empty array for non-existent domain', async () => {
      const climate = await entityOps.getEntitiesByDomain('climate');

      expect(climate).toEqual([]);
    });

    it('should return single entity domain', async () => {
      const switches = await entityOps.getEntitiesByDomain('switch');

      expect(switches).toHaveLength(1);
      expect(switches[0].entity_id).toBe('switch.kitchen');
    });
  });

  describe('searchEntities', () => {
    it('should find entities by friendly name', async () => {
      const results = await entityOps.searchEntities('living');

      expect(results).toHaveLength(1);
      expect(results[0].entity_id).toBe('light.living_room');
    });

    it('should find entities by entity_id', async () => {
      const results = await entityOps.searchEntities('kitchen');

      expect(results).toHaveLength(1);
      expect(results[0].entity_id).toBe('switch.kitchen');
    });

    it('should be case insensitive', async () => {
      const results = await entityOps.searchEntities('BEDROOM');

      expect(results).toHaveLength(1);
      expect(results[0].entity_id).toBe('light.bedroom');
    });

    it('should return multiple matches', async () => {
      const results = await entityOps.searchEntities('light');

      expect(results).toHaveLength(2);
    });

    it('should return empty array for no matches', async () => {
      const results = await entityOps.searchEntities('nonexistent');

      expect(results).toEqual([]);
    });
  });

  describe('getDomainSummary', () => {
    it('should return domain summary with counts', async () => {
      const summary = await entityOps.getDomainSummary('light');

      expect(summary.domain).toBe('light');
      expect(summary.count).toBe(2);
      expect(summary.states).toEqual({ on: 1, off: 1 });
    });

    it('should include entity list with state and name', async () => {
      const summary = await entityOps.getDomainSummary('light');

      expect(summary.entities).toHaveLength(2);
      expect(summary.entities).toContainEqual({
        entity_id: 'light.living_room',
        state: 'on',
        friendly_name: 'Living Room Light',
      });
    });

    it('should return empty summary for non-existent domain', async () => {
      const summary = await entityOps.getDomainSummary('climate');

      expect(summary.domain).toBe('climate');
      expect(summary.count).toBe(0);
      expect(summary.states).toEqual({});
      expect(summary.entities).toEqual([]);
    });
  });

  describe('listEntities', () => {
    it('should list all entities without filters', async () => {
      const entities = await entityOps.listEntities();

      expect(entities).toEqual(mockEntities);
    });

    it('should filter by domain', async () => {
      const entities = await entityOps.listEntities({ domain: 'light' });

      expect(entities).toHaveLength(2);
      expect(entities.every(e => e.entity_id.startsWith('light.'))).toBe(true);
    });

    it('should filter by state', async () => {
      const entities = await entityOps.listEntities({ state: 'on' });

      expect(entities).toHaveLength(2);
      expect(entities.every(e => e.state === 'on')).toBe(true);
    });

    it('should filter by search query', async () => {
      const entities = await entityOps.listEntities({ search: 'room' });

      expect(entities).toHaveLength(2); // living_room and bedroom
    });

    it('should apply limit', async () => {
      const entities = await entityOps.listEntities({ limit: 2 });

      expect(entities).toHaveLength(2);
    });

    it('should combine multiple filters', async () => {
      const entities = await entityOps.listEntities({
        domain: 'light',
        state: 'on',
      });

      expect(entities).toHaveLength(1);
      expect(entities[0].entity_id).toBe('light.living_room');
    });
  });
});
