/**
 * Config Operations for Home Assistant API
 * Handles configuration and version information
 */

import type { HaVersion } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { RequestHandler } from './request.js';

/**
 * Config-related operations for the Home Assistant API.
 */
export class ConfigOperations {
  constructor(private readonly request: RequestHandler) {}

  /**
   * Get config
   */
  async getConfig(): Promise<Record<string, unknown>> {
    logger.debug('Fetching config');
    return await this.request.get<Record<string, unknown>>('/config');
  }

  /**
   * Check API (health check)
   */
  async checkApi(): Promise<{ message: string }> {
    logger.debug('Checking API health');
    return await this.request.get<{ message: string }>('/');
  }

  /**
   * Get Home Assistant version and configuration info
   */
  async getVersion(): Promise<HaVersion> {
    logger.debug('Fetching Home Assistant version');
    const config = await this.request.get<HaVersion>('/config');
    logger.info('Fetched version', { version: config.version });
    return config;
  }
}
