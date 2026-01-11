/**
 * History and logbook types for Home Assistant
 */

export interface LogbookEntry {
  when: string;
  name: string;
  message?: string;
  entity_id?: string;
  state?: string;
  domain?: string;
  context_user_id?: string;
}
