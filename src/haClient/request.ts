/**
 * HTTP Request Handler for Home Assistant API
 * Handles authentication and HTTP requests
 */

import type { Dispatcher } from 'undici';
import type { RequestOptions } from '../types/index.js';
import { AuthenticationError, ApiError } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { createTlsDispatcher, type FetchInitWithDispatcher } from '../utils/tlsDispatcher.js';

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
  /** Per-client undici dispatcher; set only when strictSsl is disabled (H2). */
  private dispatcher?: Dispatcher;
  private baseUrl: string;
  private token: string;
  private timeout: number;

  constructor(config: RequestHandlerConfig) {
    this.baseUrl = config.baseUrl;
    this.token = config.token;
    this.timeout = config.timeout;

    // Relax TLS validation for THIS client only, via a per-instance undici
    // dispatcher. Node's global fetch ignores the legacy `agent` option, so the
    // previous https.Agent was silently a no-op for self-signed HA instances.
    this.dispatcher = createTlsDispatcher(config.strictSsl);
    if (this.dispatcher) {
      logger.warn('SSL certificate validation is disabled');
    }
  }

  /**
   * Make authenticated request to Home Assistant API
   */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/api${path}`);

    // H4 defense-in-depth: refuse any path that resolves outside /api/.
    // Call sites encode user-controlled segments, but this guard catches any
    // raw "../" traversal that would otherwise escape the API namespace.
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      throw new ApiError('Invalid API path', 400, { path });
    }

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
      const init: FetchInitWithDispatcher = {
        method: options.method ?? 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(this.timeout),
      };
      if (this.dispatcher) {
        init.dispatcher = this.dispatcher;
      }

      const response = await fetch(url.toString(), init);

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
