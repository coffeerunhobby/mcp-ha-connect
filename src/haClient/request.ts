/**
 * HTTP Request Handler for Home Assistant API
 * Handles authentication and HTTP requests
 */

import https from 'https';
import type { RequestOptions } from '../types/index.js';
import { AuthenticationError, ApiError } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface RequestHandlerConfig {
  baseUrl: string;
  token: string;
  timeout: number;
  strictSsl: boolean;
}

/**
 * HTTP request handler for Home Assistant API calls.
 */
export class RequestHandler {
  private httpsAgent?: https.Agent;
  private baseUrl: string;
  private token: string;
  private timeout: number;

  constructor(config: RequestHandlerConfig) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
    this.timeout = config.timeout;

    // Create HTTPS agent with custom SSL settings
    if (!config.strictSsl) {
      this.httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });
      logger.warn('SSL certificate validation is disabled');
    }
  }

  /**
   * Make authenticated request to Home Assistant API
   */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/api${path}`);

    // Add query parameters
    if (options.params) {
      Object.entries(options.params).forEach(([key, value]) => {
        url.searchParams.append(key, String(value));
      });
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    logger.debug('Making API request', {
      method: options.method ?? 'GET',
      path,
      params: options.params,
    });

    try {
      const response = await fetch(url.toString(), {
        method: options.method ?? 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        // @ts-expect-error - agent is valid but not in types
        agent: this.httpsAgent,
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        const errorText = await response.text();

        if (response.status === 401) {
          throw new AuthenticationError(
            'Invalid Home Assistant token',
            { status: response.status, body: errorText }
          );
        }

        throw new ApiError(
          `API request failed: ${response.statusText}`,
          response.status,
          { path, body: errorText }
        );
      }

      // Handle empty responses
      const contentType = response.headers.get('content-type');
      if (!contentType?.includes('application/json')) {
        return {} as T;
      }

      const data = await response.json();
      return data as T;
    } catch (error) {
      if (error instanceof AuthenticationError || error instanceof ApiError) {
        throw error;
      }

      throw new ApiError(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
        500,
        { path }
      );
    }
  }

  /**
   * Make a GET request
   */
  async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    return this.request<T>(path, { params });
  }

  /**
   * Make a POST request
   */
  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }
}
