/**
 * Service Operations for Home Assistant API
 * Handles service calls and server management
 */

import type { ServiceCallData, ServiceCallResponse } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { RequestHandler } from './request.js';

/**
 * Service-related operations for the Home Assistant API.
 */
export class ServiceOperations {
  constructor(private readonly request: RequestHandler) {}

  /**
   * Call a service
   */
  async callService(data: ServiceCallData): Promise<ServiceCallResponse> {
    logger.info('Calling service', {
      domain: data.domain,
      service: data.service,
      hasTarget: !!data.target,
    });

    const path = `/services/${data.domain}/${data.service}`;
    const body = {
      ...data.service_data,
      ...data.target,
    };

    return await this.request.post<ServiceCallResponse>(path, body);
  }

  /**
   * Restart Home Assistant
   */
  async restartServer(): Promise<void> {
    logger.warn('Restarting Home Assistant');

    await this.request.post('/services/homeassistant/restart', {});

    logger.info('Home Assistant restart initiated');
  }
}
