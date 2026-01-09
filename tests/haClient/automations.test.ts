/**
 * AutomationOperations tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutomationOperations } from '../../src/haClient/automations.js';
import type { StateOperations } from '../../src/haClient/states.js';
import type { Entity } from '../../src/types/index.js';

describe('AutomationOperations', () => {
  let mockStateOps: StateOperations;
  let automationOps: AutomationOperations;

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
      entity_id: 'automation.motion_alert',
      state: 'on',
      attributes: {
        friendly_name: 'Motion Alert',
        last_triggered: '2026-01-08T09:30:00.000Z',
        mode: 'queued',
      },
      last_changed: '2026-01-08T09:30:00.000Z',
      last_updated: '2026-01-08T09:30:00.000Z',
      context: { id: 'ctx-3', parent_id: null, user_id: null },
    },
    {
      entity_id: 'light.living_room', // Non-automation entity
      state: 'on',
      attributes: { friendly_name: 'Living Room Light' },
      last_changed: '2026-01-08T10:00:00.000Z',
      last_updated: '2026-01-08T10:00:00.000Z',
      context: { id: 'ctx-4', parent_id: null, user_id: null },
    },
  ];

  beforeEach(() => {
    mockStateOps = {
      getStates: vi.fn().mockResolvedValue(mockAutomationEntities),
    } as unknown as StateOperations;

    automationOps = new AutomationOperations(mockStateOps);
  });

  describe('getAutomations', () => {
    it('should return only automation entities', async () => {
      const automations = await automationOps.getAutomations();

      expect(automations).toHaveLength(3);
      expect(automations.every(a => a.id.startsWith('automation.'))).toBe(true);
    });

    it('should map entity to Automation type', async () => {
      const automations = await automationOps.getAutomations();

      const morning = automations.find(a => a.id === 'automation.morning_lights');
      expect(morning).toEqual({
        id: 'automation.morning_lights',
        alias: 'Morning Lights',
        state: 'on',
        last_triggered: '2026-01-08T06:00:00.000Z',
        description: 'Turn on lights at sunrise',
        mode: 'single',
      });
    });

    it('should handle automations without friendly_name', async () => {
      (mockStateOps.getStates as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          entity_id: 'automation.unnamed',
          state: 'on',
          attributes: {},
          last_changed: '2026-01-08T10:00:00.000Z',
          last_updated: '2026-01-08T10:00:00.000Z',
          context: { id: 'ctx-1', parent_id: null, user_id: null },
        },
      ]);

      const automations = await automationOps.getAutomations();

      expect(automations[0].alias).toBe('unnamed');
    });

    it('should handle null last_triggered', async () => {
      const automations = await automationOps.getAutomations();

      const nightMode = automations.find(a => a.id === 'automation.night_mode');
      expect(nightMode?.last_triggered).toBeNull();
    });

    it('should return empty array when no automations exist', async () => {
      (mockStateOps.getStates as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          entity_id: 'light.test',
          state: 'on',
          attributes: {},
          last_changed: '2026-01-08T10:00:00.000Z',
          last_updated: '2026-01-08T10:00:00.000Z',
          context: { id: 'ctx-1', parent_id: null, user_id: null },
        },
      ]);

      const automations = await automationOps.getAutomations();

      expect(automations).toEqual([]);
    });
  });
});
