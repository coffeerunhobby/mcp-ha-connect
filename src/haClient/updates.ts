/**
 * Update Operations for Home Assistant API
 * Handles checking for available updates
 */

import type { Entity, UpdateInfo } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { EntityOperations } from './entities.js';

/**
 * Update-related operations for the Home Assistant API.
 */
export class UpdateOperations {
  constructor(private readonly entityOps: EntityOperations) {}

  /**
   * Get available updates by checking update.* entities
   * Works with regular long-lived access tokens
   */
  async getAvailableUpdates(): Promise<{
    updates: UpdateInfo[];
    entities: Entity[];
  }> {
    logger.debug('Fetching available updates from update entities');

    // Get all update entities
    const updateEntities = await this.entityOps.getEntitiesByDomain('update');

    // Filter to only those with updates available (state = 'on')
    const updates: UpdateInfo[] = [];

    for (const entity of updateEntities) {
      const attrs = entity.attributes;
      const installedVersion = attrs.installed_version as string | undefined;
      const latestVersion = attrs.latest_version as string | undefined;
      const title = attrs.title as string || attrs.friendly_name as string || entity.entity_id;

      // state 'on' means update is available
      if (entity.state === 'on' && installedVersion && latestVersion) {
        updates.push({
          update_type: entity.entity_id.includes('core') ? 'core' :
                       entity.entity_id.includes('supervisor') ? 'supervisor' :
                       entity.entity_id.includes('operating_system') ? 'os' : 'addon',
          name: title,
          version_current: installedVersion,
          version_latest: latestVersion,
        });
      }
    }

    logger.info('Fetched available updates', { updateCount: updates.length, totalEntities: updateEntities.length });

    return {
      updates,
      entities: updateEntities,
    };
  }
}
