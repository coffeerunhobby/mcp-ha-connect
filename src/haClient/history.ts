/**
 * History Operations for Home Assistant API
 * Handles historical data and system logs
 */

import type { Entity, LogbookEntry } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { RequestHandler } from './request.js';

/**
 * History-related operations for the Home Assistant API.
 */
export class HistoryOperations {
  constructor(private readonly request: RequestHandler) {}

  /**
   * Get historical data for an entity
   */
  async getHistory(entityId: string, hours: number = 24): Promise<Entity[][]> {
    logger.debug('Fetching history', { entityId, hours });

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

    const path = `/history/period/${startTime.toISOString()}`;
    const history = await this.request.get<Entity[][]>(path, {
      filter_entity_id: entityId,
      end_time: endTime.toISOString(),
    });

    logger.info('Fetched history', {
      entityId,
      hours,
      records: history[0]?.length ?? 0
    });

    return history;
  }

  /**
   * Get system log entries from the logbook
   * Returns recent events/state changes, optionally filtered by entity
   */
  async getSystemLog(options: {
    hours?: number;
    entity_id?: string;
    limit?: number;
  } = {}): Promise<LogbookEntry[]> {
    const hours = Math.min(options.hours || 24, 168); // Cap at 1 week
    const limit = options.limit || 100;
    logger.debug('Fetching system log', { hours, entity_id: options.entity_id, limit });

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

    const path = `/logbook/${startTime.toISOString()}`;
    const params: Record<string, string> = {
      end_time: endTime.toISOString(),
    };

    if (options.entity_id) {
      params.entity = options.entity_id;
    }

    const entries = await this.request.get<LogbookEntry[]>(path, params);

    // Apply limit - return most recent entries first
    const limited = entries.slice(-limit);

    logger.info('Fetched system log', { count: entries.length, returned: limited.length, hours, limit });
    return limited;
  }
}
