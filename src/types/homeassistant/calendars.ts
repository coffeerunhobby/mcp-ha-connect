/**
 * Calendar types for Home Assistant
 */

export interface CalendarEvent {
  summary: string;
  start: {
    dateTime?: string;
    date?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
  };
  description?: string;
  location?: string;
  uid?: string;
  recurrence_id?: string;
  rrule?: string;
}

export interface Calendar {
  entity_id: string;
  name: string;
  state: string;
}
