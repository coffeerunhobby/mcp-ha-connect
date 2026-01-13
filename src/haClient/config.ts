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
   * Returns only safe, public information (filters out internal config details)
   */
  async getVersion(): Promise<HaVersion> {
    logger.debug('Fetching Home Assistant version');
    const config = await this.request.get<Record<string, unknown>>('/config');
    logger.info('Fetched version', { version: config.version });

    // Return only safe, public information
    // Excludes: components, allowlist_external_dirs, allowlist_external_urls,
    // config_dir, whitelist_external_dirs, safe_mode, state, external_url, internal_url,
    // currency, country, language, latitude, longitude, elevation
    return {
      version: config.version as string,
      location_name: config.location_name as string | undefined,
      time_zone: config.time_zone as string | undefined,
      unit_system: config.unit_system as Record<string, string> | undefined,
    };
  }
}
