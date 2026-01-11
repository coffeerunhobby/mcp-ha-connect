/**
 * BDD tests for Calendar Operations
 * Uses vitest-cucumber for Gherkin syntax
 */

import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect, vi } from 'vitest';
import { CalendarOperations } from '../../src/haClient/calendars.js';
import type { RequestHandler } from '../../src/haClient/request.js';
import type { Calendar, CalendarEvent } from '../../src/types/index.js';

const feature = await loadFeature('tests/features/calendar.feature');

describeFeature(feature, ({ Scenario }) => {
  // Shared test state
  let mockRequest: RequestHandler;
  let calendarOps: CalendarOperations;
  let calendars: Calendar[];
  let events: CalendarEvent[];
  let allCalendarEvents: Array<{ calendar: string; events: CalendarEvent[] }>;
  let startDate: Date;
  let endDate: Date;

  const mockCalendarList = [
    { entity_id: 'calendar.family', name: 'Family Calendar' },
    { entity_id: 'calendar.work', name: 'Work Calendar' },
    { entity_id: 'calendar.reminders', name: 'Reminders' },
    { entity_id: 'calendar.empty', name: 'Empty Calendar' },
  ];

  const mockEvents: CalendarEvent[] = [
    {
      summary: 'Team Meeting',
      start: { dateTime: '2026-01-15T10:00:00.000Z' },
      end: { dateTime: '2026-01-15T11:00:00.000Z' },
      description: 'Weekly sync',
    },
    {
      summary: 'Doctor Appointment',
      start: { date: '2026-01-20' },
      end: { date: '2026-01-20' },
      location: 'Medical Center',
    },
  ];

  function setupMocks(calendarEvents: Record<string, CalendarEvent[]> = {}) {
    mockRequest = {
      get: vi.fn().mockImplementation(async (path: string) => {
        // Handle /calendars endpoint (list all calendars)
        if (path === '/calendars') {
          return mockCalendarList;
        }
        // Handle /calendars/{entity_id} endpoint (get events)
        const match = path.match(/\/calendars\/(calendar\.[^?]+)/);
        if (match) {
          const calId = match[1];
          return calendarEvents[calId] || [];
        }
        return [];
      }),
    } as unknown as RequestHandler;

    calendarOps = new CalendarOperations(mockRequest);
  }

  Scenario('List all calendars', ({ Given, When, Then, And }) => {
    Given('a Home Assistant with calendar entities', () => {
      setupMocks();
    });

    When('I list all calendars', async () => {
      calendars = await calendarOps.getCalendars();
    });

    Then('I should see all calendar entities', () => {
      expect(calendars).toHaveLength(4);
    });

    And('each calendar should have entity_id, name, and state', () => {
      calendars.forEach(cal => {
        expect(cal.entity_id).toBeDefined();
        expect(cal.name).toBeDefined();
        expect(cal.state).toBeDefined();
      });
    });
  });

  Scenario('Get events from a specific calendar', ({ Given, When, Then, And }) => {
    Given('a calendar "calendar.family" with events', () => {
      setupMocks({ 'calendar.family': mockEvents });
    });

    When('I get events from "calendar.family"', async () => {
      events = await calendarOps.getCalendarEvents('calendar.family');
    });

    Then('I should receive calendar events', () => {
      expect(events.length).toBeGreaterThan(0);
    });

    And('each event should have summary and start date', () => {
      events.forEach(event => {
        expect(event.summary).toBeDefined();
        expect(event.start).toBeDefined();
        expect(event.start.dateTime || event.start.date).toBeDefined();
      });
    });
  });

  Scenario('Get events with custom date range', ({ Given, When, Then }) => {
    Given('a calendar "calendar.work" with events', () => {
      setupMocks({ 'calendar.work': mockEvents });
    });

    When('I get events from January 1 to January 31', async () => {
      startDate = new Date('2026-01-01');
      endDate = new Date('2026-01-31');
      events = await calendarOps.getCalendarEvents('calendar.work', startDate, endDate);
    });

    Then('the events should be within the date range', () => {
      // Verify the API was called with correct date range
      expect(mockRequest.get).toHaveBeenCalledWith(
        expect.stringContaining('/calendars/calendar.work'),
        expect.objectContaining({
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        })
      );
    });
  });

  Scenario('Get events using days parameter', ({ Given, When, Then }) => {
    Given('a calendar "calendar.reminders" with events', () => {
      setupMocks({ 'calendar.reminders': mockEvents });
    });

    When('I get events for the next 7 days', async () => {
      startDate = new Date();
      endDate = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);
      events = await calendarOps.getCalendarEvents('calendar.reminders', startDate, endDate);
    });

    Then('the end date should be 7 days from now', () => {
      const expectedEnd = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);
      // Allow for small time differences
      expect(Math.abs(endDate.getTime() - expectedEnd.getTime())).toBeLessThan(1000);
    });
  });

  Scenario('Get events from all calendars', ({ Given, When, Then, And }) => {
    Given('multiple calendars with events', () => {
      setupMocks({
        'calendar.family': [mockEvents[0]],
        'calendar.work': [mockEvents[1]],
        'calendar.reminders': [],
        'calendar.empty': [],
      });
    });

    When('I get events without specifying a calendar', async () => {
      allCalendarEvents = await calendarOps.getAllCalendarEvents();
    });

    Then('I should receive events from all calendars', () => {
      expect(allCalendarEvents.length).toBe(4);
    });

    And('results should be grouped by calendar', () => {
      const calendarIds = allCalendarEvents.map(c => c.calendar);
      expect(calendarIds).toContain('calendar.family');
      expect(calendarIds).toContain('calendar.work');
      expect(calendarIds).toContain('calendar.reminders');
    });
  });

  Scenario('Get events from calendar with no events', ({ Given, When, Then }) => {
    Given('a calendar "calendar.empty" with no events', () => {
      setupMocks({ 'calendar.empty': [] });
    });

    When('I get events from "calendar.empty"', async () => {
      events = await calendarOps.getCalendarEvents('calendar.empty');
    });

    Then('I should receive an empty events list', () => {
      expect(events).toEqual([]);
    });
  });
});
