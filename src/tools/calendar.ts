/**
 * Calendar tools - List calendars and get calendar events
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import { listCalendarsSchema, getCalendarEventsSchema, toToolResult, wrapToolHandler } from './common.js';
import type { z } from 'zod';

type GetCalendarEventsArgs = z.infer<typeof getCalendarEventsSchema>;

export function registerListCalendarsTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'listCalendars',
    {
      description: 'List all calendar entities in Home Assistant. Returns calendar names and their current state.',
      inputSchema: listCalendarsSchema.shape,
    },
    wrapToolHandler('listCalendars', async () => {
      const calendars = await client.getCalendars();
      return toToolResult({
        count: calendars.length,
        calendars,
      });
    })
  );
}

export function registerGetCalendarEventsTool(server: McpServer, client: HaClient): void {
  server.registerTool(
    'getCalendarEvents',
    {
      description: `Get events from one or all Home Assistant calendars.

Examples:
- All calendars, next 30 days: {}
- Specific calendar: { entity_id: "calendar.family" }
- Next 7 days: { days: 7 }
- Date range: { start_date: "2026-01-01", end_date: "2026-01-31" }
- Specific calendar + date range: { entity_id: "calendar.work", start_date: "2026-02-01", days: 14 }`,
      inputSchema: getCalendarEventsSchema.shape,
    },
    wrapToolHandler('getCalendarEvents', async (args: GetCalendarEventsArgs) => {
      // Parse dates
      const startDate = args.start_date ? new Date(args.start_date) : new Date();

      let endDate: Date;
      if (args.days) {
        endDate = new Date(startDate.getTime() + args.days * 24 * 60 * 60 * 1000);
      } else if (args.end_date) {
        endDate = new Date(args.end_date);
      } else {
        // Default: 30 days from start
        endDate = new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000);
      }

      if (args.entity_id) {
        // Get events from specific calendar
        const events = await client.getCalendarEvents(args.entity_id, startDate, endDate);
        return toToolResult({
          calendar: args.entity_id,
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          count: events.length,
          events: events.map(e => ({
            summary: e.summary,
            start: e.start.dateTime || e.start.date,
            end: e.end.dateTime || e.end.date,
            description: e.description,
            location: e.location,
          })),
        });
      } else {
        // Get events from all calendars
        const allEvents = await client.getAllCalendarEvents(startDate, endDate);
        const totalCount = allEvents.reduce((sum, cal) => sum + cal.events.length, 0);

        return toToolResult({
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          total_count: totalCount,
          calendars: allEvents.map(cal => ({
            calendar: cal.calendar,
            count: cal.events.length,
            events: cal.events.map(e => ({
              summary: e.summary,
              start: e.start.dateTime || e.start.date,
              end: e.end.dateTime || e.end.date,
              description: e.description,
              location: e.location,
            })),
          })),
        });
      }
    })
  );
}
