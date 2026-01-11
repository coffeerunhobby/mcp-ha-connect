/**
 * Calendar Operations for Home Assistant API
 * Handles calendar listing and event retrieval
 */

import type { CalendarEvent, Calendar } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { RequestHandler } from './request.js';

interface CalendarApiResponse {
  entity_id: string;
  name?: string;
}

/**
 * Calendar-related operations for the Home Assistant API.
 */
export class CalendarOperations {
  constructor(private readonly request: RequestHandler) {}

  /**
   * Get all calendar entities
   */
  async getCalendars(): Promise<Calendar[]> {
    logger.debug('Fetching calendars');

    // Use dedicated /api/calendars endpoint instead of filtering all states
    const response = await this.request.get<CalendarApiResponse[]>('/calendars');
    const calendars = response.map(cal => ({
      entity_id: cal.entity_id,
      name: cal.name || cal.entity_id.replace('calendar.', ''),
      state: 'on', // Calendar API doesn't return state, default to 'on'
    }));

    logger.info('Fetched calendars', { count: calendars.length });
    return calendars;
  }

  /**
   * Get events from a calendar
   * @param entityId - Calendar entity ID (e.g., 'calendar.my_calendar')
   * @param startDate - Start date for event range (defaults to now)
   * @param endDate - End date for event range (defaults to 30 days from start)
   */
  async getCalendarEvents(
    entityId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<CalendarEvent[]> {
    const start = startDate || new Date();
    const end = endDate || new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);

    logger.debug('Fetching calendar events', { entityId, start: start.toISOString(), end: end.toISOString() });

    // Calendar events use a special API endpoint, not the standard services API
    const events = await this.request.get<CalendarEvent[]>(
      `/calendars/${entityId}`,
      {
        start: start.toISOString(),
        end: end.toISOString(),
      }
    );

    logger.info('Fetched calendar events', { entityId, count: events.length });
    return events;
  }

  /**
   * Get events from all calendars
   * @param startDate - Start date for event range (defaults to now)
   * @param endDate - End date for event range (defaults to 30 days from start)
   */
  async getAllCalendarEvents(
    startDate?: Date,
    endDate?: Date
  ): Promise<Array<{ calendar: string; events: CalendarEvent[] }>> {
    const calendars = await this.getCalendars();

    // Fetch all calendar events in parallel
    const results = await Promise.all(
      calendars.map(async calendar => {
        try {
          const events = await this.getCalendarEvents(calendar.entity_id, startDate, endDate);
          return { calendar: calendar.entity_id, events };
        } catch (error) {
          logger.warn('Failed to fetch events for calendar', { calendar: calendar.entity_id, error });
          return { calendar: calendar.entity_id, events: [] };
        }
      })
    );

    return results;
  }
}
