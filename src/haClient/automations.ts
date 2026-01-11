/**
 * Automation Operations for Home Assistant API
 * Handles automation listing and management
 */

import type { Automation, AutomationConfig, ServiceCallResponse } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { StateOperations } from './states.js';
import type { ServiceOperations } from './services.js';
import type { RequestHandler } from './request.js';

/**
 * Automation-related operations for the Home Assistant API.
 */
export class AutomationOperations {
  constructor(
    private readonly stateOps: StateOperations,
    private readonly serviceOps?: ServiceOperations,
    private readonly request?: RequestHandler
  ) {}

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

  /**
   * Get a single automation by entity_id
   */
  async getAutomation(entityId: string): Promise<Automation | null> {
    logger.debug('Fetching automation', { entityId });

    const state = await this.stateOps.getState(entityId);
    if (!state || !entityId.startsWith('automation.')) {
      return null;
    }

    return {
      id: state.entity_id,
      alias: String(state.attributes.friendly_name || state.entity_id.replace('automation.', '')),
      state: state.state as 'on' | 'off',
      last_triggered: state.attributes.last_triggered as string | null,
      description: state.attributes.description as string | undefined,
      mode: state.attributes.mode as Automation['mode'],
    };
  }

  /**
   * Trigger an automation manually
   */
  async triggerAutomation(entityId: string, variables?: Record<string, unknown>): Promise<ServiceCallResponse> {
    if (!this.serviceOps) {
      throw new Error('ServiceOperations not available');
    }

    logger.info('Triggering automation', { entityId, variables });

    return this.serviceOps.callService({
      domain: 'automation',
      service: 'trigger',
      target: { entity_id: entityId },
      service_data: variables ? { variables } : undefined,
    });
  }

  /**
   * Enable an automation
   */
  async enableAutomation(entityId: string): Promise<ServiceCallResponse> {
    if (!this.serviceOps) {
      throw new Error('ServiceOperations not available');
    }

    logger.info('Enabling automation', { entityId });

    return this.serviceOps.callService({
      domain: 'automation',
      service: 'turn_on',
      target: { entity_id: entityId },
    });
  }

  /**
   * Disable an automation
   */
  async disableAutomation(entityId: string): Promise<ServiceCallResponse> {
    if (!this.serviceOps) {
      throw new Error('ServiceOperations not available');
    }

    logger.info('Disabling automation', { entityId });

    return this.serviceOps.callService({
      domain: 'automation',
      service: 'turn_off',
      target: { entity_id: entityId },
    });
  }

  /**
   * Toggle an automation (enable if disabled, disable if enabled)
   */
  async toggleAutomation(entityId: string): Promise<ServiceCallResponse> {
    if (!this.serviceOps) {
      throw new Error('ServiceOperations not available');
    }

    logger.info('Toggling automation', { entityId });

    return this.serviceOps.callService({
      domain: 'automation',
      service: 'toggle',
      target: { entity_id: entityId },
    });
  }

  /**
   * Reload all automations from configuration
   */
  async reloadAutomations(): Promise<void> {
    if (!this.serviceOps) {
      throw new Error('ServiceOperations not available');
    }

    logger.info('Reloading automations');

    await this.serviceOps.callService({
      domain: 'automation',
      service: 'reload',
    });
  }

  /**
   * Create a new automation via the config API
   * Note: Requires automation: !include automations.yaml in configuration.yaml
   */
  async createAutomation(config: AutomationConfig): Promise<{ id: string }> {
    if (!this.request) {
      throw new Error('RequestHandler not available');
    }

    // Generate a unique ID for the automation (timestamp-based like HA UI does)
    const automationId = config.id || String(Date.now());

    logger.info('Creating automation', { alias: config.alias, id: automationId });

    // POST to /config/automation/config/{id} - the ID must be in the URL path
    await this.request.post<{ result: string }>(`/config/automation/config/${automationId}`, {
      id: automationId,
      alias: config.alias,
      description: config.description || '',
      mode: config.mode ?? 'single',
      trigger: config.trigger,
      condition: config.condition || [],
      action: config.action,
    });

    // Reload automations to pick up the new one
    if (this.serviceOps) {
      await this.serviceOps.callService({
        domain: 'automation',
        service: 'reload',
      });
    }

    return { id: automationId };
  }

  /**
   * Update an existing automation
   * Note: Requires the automation's unique_id from the automation registry
   */
  async updateAutomation(automationId: string, config: Partial<AutomationConfig>): Promise<void> {
    if (!this.request) {
      throw new Error('RequestHandler not available');
    }

    logger.info('Updating automation', { automationId, alias: config.alias });

    await this.request.post(`/config/automation/config/${automationId}`, config);
  }

  /**
   * Delete an automation
   * Note: Only works for automations created via the UI/API
   */
  async deleteAutomation(automationId: string): Promise<void> {
    if (!this.request) {
      throw new Error('RequestHandler not available');
    }

    logger.info('Deleting automation', { automationId });

    await this.request.request(`/config/automation/config/${automationId}`, {
      method: 'DELETE',
    });
  }

  /**
   * Get automation trace (execution history)
   */
  async getAutomationTrace(entityId: string): Promise<unknown[]> {
    if (!this.request) {
      throw new Error('RequestHandler not available');
    }

    const automationId = entityId.replace('automation.', '');
    logger.debug('Fetching automation trace', { automationId });

    return this.request.get<unknown[]>(`/trace/automation/${automationId}`);
  }
}
