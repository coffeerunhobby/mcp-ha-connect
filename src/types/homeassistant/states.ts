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

/**
 * Lightweight entity representation for reduced payload size.
 * Contains only essential fields needed for browsing/listing entities.
 */
export interface LightweightEntity {
  entity_id: string;
  state: string;
  friendly_name?: string;
  unit_of_measurement?: string;
  last_changed: string;
}

/**
 * Convert a full Entity to a LightweightEntity.
 * Reduces payload size by ~90% by excluding full attributes.
 */
export function toLightweight(entity: Entity): LightweightEntity {
  return {
    entity_id: entity.entity_id,
    state: entity.state,
    friendly_name: entity.attributes?.friendly_name as string | undefined,
    unit_of_measurement: entity.attributes?.unit_of_measurement as string | undefined,
    last_changed: entity.last_changed,
  };
}

/**
 * Paginated response for entity listings.
 */
export interface PaginatedEntityResponse<T = LightweightEntity> {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  entities: T[];
}

export interface EntityListResponse {
  entities: Entity[];
  total: number;
}
