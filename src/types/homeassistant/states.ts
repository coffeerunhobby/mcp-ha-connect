/**
 * State-related types for Home Assistant entities
 */

export interface Entity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context: {
    id: string;
    parent_id: string | null;
    user_id: string | null;
  };
}

export interface EntityListResponse {
  entities: Entity[];
  total: number;
}
