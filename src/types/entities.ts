/**
 * Entity summary types for Home Assistant
 */

export interface DomainSummary {
  domain: string;
  count: number;
  states: Record<string, number>;
  entities: Array<{
    entity_id: string;
    state: string;
    friendly_name?: string;
  }>;
}
