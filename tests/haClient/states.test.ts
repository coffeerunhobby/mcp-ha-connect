/**
 * StateOperations tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateOperations } from '../../src/haClient/states.js';
import type { RequestHandler } from '../../src/haClient/request.js';
import type { Entity } from '../../src/types/index.js';
import { ApiError } from '../../src/types/index.js';

describe('StateOperations', () => {
  let mockRequest: RequestHandler;
  let stateOps: StateOperations;

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
  ];

  beforeEach(() => {
    mockRequest = {
      get: vi.fn(),
    } as unknown as RequestHandler;

    stateOps = new StateOperations(mockRequest);
  });

  describe('getStates', () => {
    it('should fetch all states', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntities);

      const states = await stateOps.getStates();

      expect(states).toEqual(mockEntities);
      expect(mockRequest.get).toHaveBeenCalledWith('/states');
    });

    it('should return empty array when no entities exist', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const states = await stateOps.getStates();

      expect(states).toEqual([]);
    });
  });

  describe('getState', () => {
    it('should fetch specific entity state', async () => {
      const entity = mockEntities[0];
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(entity);

      const state = await stateOps.getState('light.living_room');

      expect(state).toEqual(entity);
      expect(mockRequest.get).toHaveBeenCalledWith('/states/light.living_room');
    });

    it('should return null when entity not found', async () => {
      const error = new ApiError('Not found', 404, { path: '/states/nonexistent' });
      (mockRequest.get as ReturnType<typeof vi.fn>).mockRejectedValue(error);

      const state = await stateOps.getState('nonexistent');

      expect(state).toBeNull();
    });

    it('should throw error for non-404 errors', async () => {
      const error = new ApiError('Server error', 500, { path: '/states/test' });
      (mockRequest.get as ReturnType<typeof vi.fn>).mockRejectedValue(error);

      await expect(stateOps.getState('test')).rejects.toThrow(ApiError);
    });
  });

  describe('getAllSensors', () => {
    it('should return only sensor and binary_sensor entities', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntities);

      const sensors = await stateOps.getAllSensors();

      expect(sensors).toHaveLength(2);
      expect(sensors.map(s => s.entity_id)).toContain('sensor.temperature');
      expect(sensors.map(s => s.entity_id)).toContain('binary_sensor.motion');
      expect(sensors.map(s => s.entity_id)).not.toContain('light.living_room');
    });

    it('should return empty array when no sensors exist', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...mockEntities[0] }, // Only light entity
      ]);

      const sensors = await stateOps.getAllSensors();

      expect(sensors).toEqual([]);
    });
  });
});
