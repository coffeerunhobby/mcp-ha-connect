/**
 * Automation Operations for Home Assistant API
 * Handles automation listing and management
 */

import type { Automation } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { StateOperations } from './states.js';

/**
 * Automation-related operations for the Home Assistant API.
 */
export class AutomationOperations {
  constructor(private readonly stateOps: StateOperations) {}

  /**
   * Get all automations
   */
  async getAutomations(): Promise<Automation[]> {
    logger.debug('Fetching automations');

    const allStates = await this.stateOps.getStates();
    const automations = allStates
      .filter(entity => entity.entity_id.startsWith('automation.'))
      .map(entity => ({
        id: entity.entity_id,
        alias: String(entity.attributes.friendly_name || entity.entity_id.replace('automation.', '')),
        state: entity.state as 'on' | 'off',
        last_triggered: entity.attributes.last_triggered as string | null,
        description: entity.attributes.description as string | undefined,
        mode: entity.attributes.mode as Automation['mode'],
      }));

    logger.info('Fetched automations', { count: automations.length });
    return automations;
  }
}
