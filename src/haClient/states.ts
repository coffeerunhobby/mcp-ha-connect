/**
 * State Operations for Home Assistant API
 * Handles entity state retrieval
 */

import type { Entity } from '../types/index.js';
import { ApiError } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { RequestHandler } from './request.js';

/**
 * State-related operations for the Home Assistant API.
 */
export class StateOperations {
  constructor(private readonly request: RequestHandler) {}

  /**
   * Get all states (entities)
   */
  async getStates(): Promise<Entity[]> {
    logger.debug('Fetching all states');
    const states = await this.request.get<Entity[]>('/states');
    logger.info('Fetched states', { count: states.length });
    return states;
  }

  /**
   * Get state of a specific entity
   */
  async getState(entityId: string): Promise<Entity | null> {
    logger.debug('Fetching state', { entityId });

    try {
      const state = await this.request.get<Entity>(`/states/${entityId}`);
      return state;
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        logger.warn('Entity not found', { entityId });
        return null;
      }
      throw error;
    }
  }

  /**
   * Get all sensors (sensor.* and binary_sensor.* entities)
   */
  async getAllSensors(): Promise<Entity[]> {
    logger.debug('Fetching all sensors');

    const allStates = await this.getStates();
    const sensors = allStates.filter(entity =>
      entity.entity_id.startsWith('sensor.') ||
      entity.entity_id.startsWith('binary_sensor.')
    );

    logger.info('Fetched sensors', { count: sensors.length });
    return sensors;
  }
}
