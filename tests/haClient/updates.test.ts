/**
 * UpdateOperations tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateOperations } from '../../src/haClient/updates.js';
import type { EntityOperations } from '../../src/haClient/entities.js';
import type { Entity } from '../../src/types/index.js';

describe('UpdateOperations', () => {
  let mockEntityOps: EntityOperations;
  let updateOps: UpdateOperations;

  const mockUpdateEntities: Entity[] = [
    {
      entity_id: 'update.home_assistant_core_update',
      state: 'on', // Update available
      attributes: {
        friendly_name: 'Home Assistant Core Update',
        title: 'Home Assistant Core',
        installed_version: '2026.1.0',
        latest_version: '2026.1.1',
      },
      last_changed: '2026-01-08T10:00:00.000Z',
      last_updated: '2026-01-08T10:00:00.000Z',
      context: { id: 'ctx-1', parent_id: null, user_id: null },
    },
    {
      entity_id: 'update.home_assistant_supervisor_update',
      state: 'off', // No update
      attributes: {
        friendly_name: 'Home Assistant Supervisor Update',
        title: 'Home Assistant Supervisor',
        installed_version: '2026.01.1',
        latest_version: '2026.01.1',
      },
      last_changed: '2026-01-08T09:00:00.000Z',
      last_updated: '2026-01-08T10:00:00.000Z',
      context: { id: 'ctx-2', parent_id: null, user_id: null },
    },
    {
      entity_id: 'update.home_assistant_operating_system_update',
      state: 'on', // Update available
      attributes: {
        friendly_name: 'Home Assistant Operating System Update',
        title: 'Home Assistant OS',
        installed_version: '11.2',
        latest_version: '11.3',
      },
      last_changed: '2026-01-08T08:00:00.000Z',
      last_updated: '2026-01-08T10:00:00.000Z',
      context: { id: 'ctx-3', parent_id: null, user_id: null },
    },
    {
      entity_id: 'update.esphome_update',
      state: 'on', // Update available
      attributes: {
        friendly_name: 'ESPHome Update',
        title: 'ESPHome',
        installed_version: '2025.12.1',
        latest_version: '2026.1.0',
      },
      last_changed: '2026-01-08T07:00:00.000Z',
      last_updated: '2026-01-08T10:00:00.000Z',
      context: { id: 'ctx-4', parent_id: null, user_id: null },
    },
  ];

  beforeEach(() => {
    mockEntityOps = {
      getEntitiesByDomain: vi.fn().mockResolvedValue(mockUpdateEntities),
    } as unknown as EntityOperations;

    updateOps = new UpdateOperations(mockEntityOps);
  });

  describe('getAvailableUpdates', () => {
    it('should fetch update entities', async () => {
      const result = await updateOps.getAvailableUpdates();

      expect(mockEntityOps.getEntitiesByDomain).toHaveBeenCalledWith('update');
      expect(result.entities).toEqual(mockUpdateEntities);
    });

    it('should filter to only available updates (state = on)', async () => {
      const result = await updateOps.getAvailableUpdates();

      expect(result.updates).toHaveLength(3);
      expect(result.updates.every(u => u.version_current !== u.version_latest)).toBe(true);
    });

    it('should categorize core updates', async () => {
      const result = await updateOps.getAvailableUpdates();

      const coreUpdate = result.updates.find(u => u.update_type === 'core');
      expect(coreUpdate).toEqual({
        update_type: 'core',
        name: 'Home Assistant Core',
        version_current: '2026.1.0',
        version_latest: '2026.1.1',
      });
    });

    it('should categorize OS updates', async () => {
      const result = await updateOps.getAvailableUpdates();

      const osUpdate = result.updates.find(u => u.update_type === 'os');
      expect(osUpdate).toEqual({
        update_type: 'os',
        name: 'Home Assistant OS',
        version_current: '11.2',
        version_latest: '11.3',
      });
    });

    it('should categorize addon updates', async () => {
      const result = await updateOps.getAvailableUpdates();

      const addonUpdate = result.updates.find(u => u.update_type === 'addon');
      expect(addonUpdate).toEqual({
        update_type: 'addon',
        name: 'ESPHome',
        version_current: '2025.12.1',
        version_latest: '2026.1.0',
      });
    });

    it('should return empty updates when all entities are up to date', async () => {
      (mockEntityOps.getEntitiesByDomain as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          entity_id: 'update.test',
          state: 'off', // No update
          attributes: {
            title: 'Test',
            installed_version: '1.0.0',
            latest_version: '1.0.0',
          },
          last_changed: '2026-01-08T10:00:00.000Z',
          last_updated: '2026-01-08T10:00:00.000Z',
          context: { id: 'ctx-1', parent_id: null, user_id: null },
        },
      ]);

      const result = await updateOps.getAvailableUpdates();

      expect(result.updates).toEqual([]);
      expect(result.entities).toHaveLength(1);
    });

    it('should handle entities without version info', async () => {
      (mockEntityOps.getEntitiesByDomain as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          entity_id: 'update.incomplete',
          state: 'on',
          attributes: {
            title: 'Incomplete',
            // Missing installed_version and latest_version
          },
          last_changed: '2026-01-08T10:00:00.000Z',
          last_updated: '2026-01-08T10:00:00.000Z',
          context: { id: 'ctx-1', parent_id: null, user_id: null },
        },
      ]);

      const result = await updateOps.getAvailableUpdates();

      // Should not include entities without version info
      expect(result.updates).toEqual([]);
    });

    it('should use title or friendly_name for name', async () => {
      (mockEntityOps.getEntitiesByDomain as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          entity_id: 'update.with_title',
          state: 'on',
          attributes: {
            title: 'Title Name',
            friendly_name: 'Friendly Name',
            installed_version: '1.0',
            latest_version: '2.0',
          },
          last_changed: '2026-01-08T10:00:00.000Z',
          last_updated: '2026-01-08T10:00:00.000Z',
          context: { id: 'ctx-1', parent_id: null, user_id: null },
        },
      ]);

      const result = await updateOps.getAvailableUpdates();

      expect(result.updates[0].name).toBe('Title Name');
    });
  });
});
