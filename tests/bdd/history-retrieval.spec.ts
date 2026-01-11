/**
 * BDD tests for History Retrieval
 * Uses vitest-cucumber for Gherkin syntax
 */

import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect, vi } from 'vitest';
import { HistoryOperations } from '../../src/haClient/history.js';
import type { RequestHandler } from '../../src/haClient/request.js';
import type { Entity, LogbookEntry } from '../../src/types/index.js';

const feature = await loadFeature('tests/features/history-retrieval.feature');

describeFeature(feature, ({ Scenario }) => {
  // Shared test state
  let mockRequest: RequestHandler;
  let historyOps: HistoryOperations;
  let historyResult: Entity[][];
  let logEntries: LogbookEntry[];
  let lastGetCall: { path: string; params: Record<string, unknown> } | null;

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

  const mockLogEntries: LogbookEntry[] = [
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

  function setupMocks(historyData: Entity[][] = mockHistory, logData: LogbookEntry[] = mockLogEntries) {
    lastGetCall = null;

    mockRequest = {
      get: vi.fn().mockImplementation(async (path: string, params?: Record<string, unknown>) => {
        lastGetCall = { path, params: params || {} };
        if (path.includes('/history/')) {
          return historyData;
        }
        if (path.includes('/logbook/')) {
          return logData;
        }
        return [];
      }),
    } as unknown as RequestHandler;

    historyOps = new HistoryOperations(mockRequest);
  }

  Scenario('Get entity history for last 24 hours', ({ Given, When, Then, And }) => {
    Given('an entity "sensor.temperature" with historical data', () => {
      setupMocks();
    });

    When('I get the history for the last 24 hours', async () => {
      historyResult = await historyOps.getHistory('sensor.temperature', 24);
    });

    Then('I should receive historical state changes', () => {
      expect(historyResult).toBeDefined();
      expect(historyResult[0]?.length).toBeGreaterThan(0);
    });

    And('the history API should be called with the correct time range', () => {
      expect(lastGetCall?.path).toContain('/history/period/');
      expect(lastGetCall?.params.filter_entity_id).toBe('sensor.temperature');
    });
  });

  Scenario('Get entity history with custom time range', ({ Given, When, Then, And }) => {
    Given('an entity "sensor.temperature" with historical data', () => {
      setupMocks();
    });

    When('I get the history for the last 48 hours', async () => {
      historyResult = await historyOps.getHistory('sensor.temperature', 48);
    });

    Then('I should receive historical state changes', () => {
      expect(historyResult).toBeDefined();
    });

    And('the time range should be 48 hours', () => {
      expect(mockRequest.get).toHaveBeenCalled();
      // The start time in the path should be ~48 hours ago
      expect(lastGetCall?.path).toContain('/history/period/');
    });
  });

  Scenario('Get empty history for entity', ({ Given, When, Then }) => {
    Given('an entity with no history', () => {
      setupMocks([[]]);
    });

    When('I get the history', async () => {
      historyResult = await historyOps.getHistory('sensor.nonexistent');
    });

    Then('I should receive an empty history array', () => {
      expect(historyResult).toEqual([[]]);
    });
  });

  Scenario('Get system log entries', ({ Given, When, Then, And }) => {
    Given('a Home Assistant system log', () => {
      setupMocks();
    });

    When('I get the system log', async () => {
      logEntries = await historyOps.getSystemLog();
    });

    Then('I should receive logbook entries', () => {
      expect(logEntries.length).toBeGreaterThan(0);
    });

    And('each entry should have timestamp and entity information', () => {
      logEntries.forEach(entry => {
        expect(entry.when).toBeDefined();
        expect(entry.entity_id).toBeDefined();
      });
    });
  });

  Scenario('Get system log filtered by entity', ({ Given, When, Then, And }) => {
    Given('a Home Assistant system log', () => {
      setupMocks();
    });

    When('I get the system log for entity "light.living_room"', async () => {
      logEntries = await historyOps.getSystemLog({ entity_id: 'light.living_room' });
    });

    Then('I should receive only entries for that entity', () => {
      expect(logEntries).toBeDefined();
    });

    And('the entity filter should be applied', () => {
      expect(lastGetCall?.params.entity).toBe('light.living_room');
    });
  });

  Scenario('Get system log with custom time range', ({ Given, When, Then }) => {
    Given('a Home Assistant system log', () => {
      setupMocks();
    });

    When('I get the system log for the last 48 hours', async () => {
      logEntries = await historyOps.getSystemLog({ hours: 48 });
    });

    Then('the logbook API should use the 48 hour time range', () => {
      expect(lastGetCall?.path).toContain('/logbook/');
      // The start time should be ~48 hours ago
      expect(mockRequest.get).toHaveBeenCalled();
    });
  });
});
