/**
 * HistoryOperations tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HistoryOperations } from '../../src/haClient/history.js';
import type { RequestHandler } from '../../src/haClient/request.js';
import type { Entity, LogbookEntry } from '../../src/types/index.js';

describe('HistoryOperations', () => {
  let mockRequest: RequestHandler;
  let historyOps: HistoryOperations;

  beforeEach(() => {
    mockRequest = {
      get: vi.fn(),
    } as unknown as RequestHandler;

    historyOps = new HistoryOperations(mockRequest);
  });

  describe('getHistory', () => {
    it('should fetch history for entity', async () => {
      const mockHistory: Entity[][] = [
        [
          {
            entity_id: 'sensor.temperature',
            state: '20.0',
            attributes: { unit_of_measurement: '°C' },
            last_changed: '2026-01-08T08:00:00.000Z',
            last_updated: '2026-01-08T08:00:00.000Z',
            context: { id: 'ctx-1', parent_id: null, user_id: null },
          },
          {
            entity_id: 'sensor.temperature',
            state: '21.5',
            attributes: { unit_of_measurement: '°C' },
            last_changed: '2026-01-08T09:00:00.000Z',
            last_updated: '2026-01-08T09:00:00.000Z',
            context: { id: 'ctx-2', parent_id: null, user_id: null },
          },
          {
            entity_id: 'sensor.temperature',
            state: '22.5',
            attributes: { unit_of_measurement: '°C' },
            last_changed: '2026-01-08T10:00:00.000Z',
            last_updated: '2026-01-08T10:00:00.000Z',
            context: { id: 'ctx-3', parent_id: null, user_id: null },
          },
        ],
      ];

      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockHistory);

      const history = await historyOps.getHistory('sensor.temperature', 24);

      expect(history).toEqual(mockHistory);
      expect(mockRequest.get).toHaveBeenCalledWith(
        expect.stringContaining('/history/period/'),
        expect.objectContaining({
          filter_entity_id: 'sensor.temperature',
          end_time: expect.any(String),
        })
      );
    });

    it('should use default 24 hours', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue([[]]);

      await historyOps.getHistory('sensor.test');

      expect(mockRequest.get).toHaveBeenCalled();
    });

    it('should handle custom hours parameter', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue([[]]);

      await historyOps.getHistory('sensor.test', 48);

      expect(mockRequest.get).toHaveBeenCalled();
    });

    it('should return empty history', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue([[]]);

      const history = await historyOps.getHistory('sensor.nonexistent');

      expect(history).toEqual([[]]);
    });
  });

  describe('getSystemLog', () => {
    it('should fetch logbook entries', async () => {
      const mockEntries: LogbookEntry[] = [
        {
          when: '2026-01-08T10:00:00.000Z',
          name: 'Living Room Light',
          entity_id: 'light.living_room',
          state: 'on',
          domain: 'light',
        },
        {
          when: '2026-01-08T09:30:00.000Z',
          name: 'Motion detected',
          entity_id: 'binary_sensor.motion',
          state: 'on',
          domain: 'binary_sensor',
        },
      ];

      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntries);

      const entries = await historyOps.getSystemLog();

      expect(entries).toEqual(mockEntries);
      expect(mockRequest.get).toHaveBeenCalledWith(
        expect.stringContaining('/logbook/'),
        expect.objectContaining({
          end_time: expect.any(String),
        })
      );
    });

    it('should filter by entity_id', async () => {
      const mockEntries: LogbookEntry[] = [
        {
          when: '2026-01-08T10:00:00.000Z',
          name: 'Living Room Light',
          entity_id: 'light.living_room',
          state: 'on',
        },
      ];

      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntries);

      await historyOps.getSystemLog({ entity_id: 'light.living_room' });

      expect(mockRequest.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          entity: 'light.living_room',
        })
      );
    });

    it('should use custom hours parameter', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await historyOps.getSystemLog({ hours: 48 });

      expect(mockRequest.get).toHaveBeenCalled();
    });

    it('should use default 24 hours', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await historyOps.getSystemLog();

      expect(mockRequest.get).toHaveBeenCalled();
    });

    it('should return empty array when no logs', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const entries = await historyOps.getSystemLog();

      expect(entries).toEqual([]);
    });
  });
});
