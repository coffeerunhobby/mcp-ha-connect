/**
 * Entity Operations for Home Assistant API
 * Handles entity listing, searching, and domain operations
 */

import type { Entity, DomainSummary } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { StateOperations } from './states.js';

/**
 * Entity-related operations for the Home Assistant API.
 */
export class EntityOperations {
  constructor(private readonly stateOps: StateOperations) {}

  /**
   * Get entities filtered by domain
   */
  async getEntitiesByDomain(domain: string): Promise<Entity[]> {
    logger.debug('Fetching entities by domain', { domain });

    const allStates = await this.stateOps.getStates();
    const filtered = allStates.filter(entity =>
      entity.entity_id.startsWith(`${domain}.`)
    );

    logger.info('Filtered entities by domain', {
      domain,
      count: filtered.length
    });

    return filtered;
  }

  /**
   * Search entities by name or entity_id
   */
  async searchEntities(query: string): Promise<Entity[]> {
    logger.debug('Searching entities', { query });

    const allStates = await this.stateOps.getStates();
    const lowerQuery = query.toLowerCase();

    const results = allStates.filter(entity => {
      const entityIdMatch = entity.entity_id.toLowerCase().includes(lowerQuery);
      const nameMatch = entity.attributes.friendly_name &&
        String(entity.attributes.friendly_name).toLowerCase().includes(lowerQuery);

      return entityIdMatch || nameMatch;
    });

    logger.info('Search completed', { query, results: results.length });
    return results;
  }

  /**
   * Get domain summary with entity counts and state breakdown
   */
  async getDomainSummary(domain: string): Promise<DomainSummary> {
    logger.debug('Fetching domain summary', { domain });

    const entities = await this.getEntitiesByDomain(domain);

    // Count states
    const states: Record<string, number> = {};
    const entityList: DomainSummary['entities'] = [];

    for (const entity of entities) {
      states[entity.state] = (states[entity.state] || 0) + 1;
      entityList.push({
        entity_id: entity.entity_id,
        state: entity.state,
        friendly_name: entity.attributes.friendly_name as string | undefined,
      });
    }

    const summary: DomainSummary = {
      domain,
      count: entities.length,
      states,
      entities: entityList,
    };

    logger.info('Fetched domain summary', { domain, count: summary.count });
    return summary;
  }

  /**
   * List entities with optional filtering
   */
  async listEntities(options: {
    domain?: string;
    search?: string;
    limit?: number;
    state?: string;
  } = {}): Promise<Entity[]> {
    logger.debug('Listing entities', options);

    let entities = await this.stateOps.getStates();

    // Filter by domain
    if (options.domain) {
      entities = entities.filter(e => e.entity_id.startsWith(`${options.domain}.`));
    }

    // Filter by state
    if (options.state) {
      entities = entities.filter(e => e.state === options.state);
    }

    // Filter by search query
    if (options.search) {
      const query = options.search.toLowerCase();
      entities = entities.filter(e =>
        e.entity_id.toLowerCase().includes(query) ||
        String(e.attributes.friendly_name || '').toLowerCase().includes(query)
      );
    }

    // Apply limit
    if (options.limit && options.limit > 0) {
      entities = entities.slice(0, options.limit);
    }

    logger.info('Listed entities', { count: entities.length, ...options });
    return entities;
  }
}
