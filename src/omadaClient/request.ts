import type { Dispatcher } from 'undici';
import type { OmadaApiResponse, PaginatedResult } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { createTlsDispatcher, tlsAwareFetch, type FetchInitWithDispatcher } from '../utils/tlsDispatcher.js';

import type { AuthManager } from './auth.js';

const DEFAULT_PAGE_SIZE = 200;

export interface RequestOptions {
    method?: string;
    url: string;
    params?: Record<string, unknown>;
    data?: unknown;
    headers?: Record<string, string>;
}

export interface RequestHandlerConfig {
    baseUrl: string;
    timeout?: number;
    strictSsl?: boolean;
}

/**
 * HTTP request handler for Omada API calls with authentication and retry logic.
 */
export class RequestHandler {
    private readonly baseUrl: string;
    private readonly timeout: number;
    /** Per-client undici dispatcher; set only when strictSsl is disabled (H2). */
    private readonly dispatcher?: Dispatcher;

    constructor(
        config: RequestHandlerConfig,
        private readonly auth: AuthManager
    ) {
        this.baseUrl = config.baseUrl;
        this.timeout = config.timeout ?? 30000;
        this.dispatcher = createTlsDispatcher(config.strictSsl, config.baseUrl);
    }

    /**
     * Make a GET request to the Omada API.
     */
    public async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
        return await this.request<T>({ method: 'GET', url: path, params });
    }

    /**
     * Make a PATCH request to the Omada API.
     */
    public async patch<T>(path: string, data?: unknown): Promise<T> {
        return await this.request<T>({ method: 'PATCH', url: path, data });
    }

    /**
     * Make a POST request to the Omada API.
     */
    public async post<T>(path: string, data?: unknown): Promise<T> {
        return await this.request<T>({ method: 'POST', url: path, data });
    }

    /**
     * Make an arbitrary HTTP request to the Omada API.
     */
    public async request<T>(config: RequestOptions, retry = true): Promise<T> {
        const accessToken = await this.auth.getAccessToken();

        const method = (config.method ?? 'GET').toUpperCase();
        const url = new URL(config.url, this.baseUrl);

        // Add query parameters
        if (config.params) {
            for (const [key, value] of Object.entries(config.params)) {
                if (value !== undefined && value !== null) {
                    url.searchParams.set(key, String(value));
                }
            }
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `AccessToken=${accessToken}`,
            ...(config.headers ?? {}),
        };

        logger.info('Omada request', {
            method,
            url: config.url,
            params: config.params,
            siteId: config.params?.siteId ?? undefined,
        });

        logger.debug('Omada request details', {
            method,
            url: config.url,
            headers: this.sanitizeHeaders(headers),
            params: config.params ?? null,
            data: this.sanitizePayload(config.data),
        });

        try {
            // For self-signed certificates we relax TLS validation for THIS client
            // only, via a per-instance undici dispatcher (H2). Node's global fetch
            // ignores the legacy `agent` option, and toggling the process-global
            // NODE_TLS_REJECT_UNAUTHORIZED env var would disable validation for every
            // concurrent outbound request in the process.
            const init: FetchInitWithDispatcher = {
                method,
                headers,
                body: config.data ? JSON.stringify(config.data) : undefined,
                signal: AbortSignal.timeout(this.timeout),
            };
            if (this.dispatcher) {
                init.dispatcher = this.dispatcher;
            }

            // tlsAwareFetch: dispatcher requests use undici's own fetch (pairing rule).
            const response = await tlsAwareFetch(url.toString(), init);

            logger.info('Omada response', {
                method,
                url: config.url,
                status: response.status,
            });

            // Parse response body
            const responseData = (await response.json()) as T;

            logger.debug('Omada response payload', {
                method,
                url: config.url,
                status: response.status,
                data: this.sanitizePayload(responseData),
            });

            // Check if the response data indicates an authentication error
            const errorCode = (responseData as { errorCode?: number } | undefined)?.errorCode;
            const errorMsg = (responseData as { msg?: string } | undefined)?.msg;

            if (retry && (this.isAuthErrorCode(errorCode) || this.isTokenExpiredMessage(errorMsg))) {
                logger.warn('Omada authentication error in response, retrying with fresh token', {
                    method,
                    url: config.url,
                    errorCode,
                    message: errorMsg,
                });
                this.auth.clearToken();
                return this.request<T>(config, false);
            }

            // Handle HTTP errors after checking for auth errors in body
            if (!response.ok && !this.isAuthErrorCode(errorCode)) {
                logger.error('Omada request failed', {
                    method,
                    url: config.url,
                    status: response.status,
                    statusText: response.statusText,
                    errorCode,
                    message: errorMsg,
                });
                // Surface the controller's own structured errorCode/msg when present
                // (safe diagnostic data — the controller's description, not an internal
                // hostname/header) so a rejected request explains itself instead of
                // collapsing to a bare HTTP status like "400 ".
                const parts = [`${response.status} ${response.statusText}`.trim()];
                if (errorMsg) {
                    parts.push(`- ${errorMsg}`);
                }
                if (errorCode !== undefined && errorCode !== 0) {
                    parts.push(`(errorCode ${errorCode})`);
                }
                throw new Error(`Omada API request failed: ${parts.join(' ')}`);
            }

            return responseData;
        } catch (error) {
            logger.error('Omada request failed', {
                method,
                url: config.url,
                message: error instanceof Error ? error.message : String(error),
            });

            if (!retry) {
                throw error;
            }

            // Check if it's a network/timeout error that might be auth-related
            const isNetworkError = error instanceof TypeError ||
                (error instanceof Error && error.name === 'AbortError');

            if (isNetworkError) {
                throw error;
            }

            throw error;
        }
    }

    /**
     * Fetch all pages of a paginated API endpoint.
     */
    public async fetchPaginated<T>(path: string, params: Record<string, unknown> = {}): Promise<T[]> {
        const records: T[] = [];
        let page = 1;
        let totalRows: number | undefined;

        // Fetch sequential pages because OpenAPI requires explicit pagination parameters.
        do {
            const response = await this.get<OmadaApiResponse<PaginatedResult<T>>>(path, {
                ...params,
                page,
                pageSize: DEFAULT_PAGE_SIZE,
            });

            const result = this.ensureSuccess(response);
            const pageData = result.data ?? [];
            totalRows = result.totalRows ?? totalRows;

            records.push(...pageData);
            page += 1;

            if (pageData.length === 0) {
                break;
            }
        } while (!totalRows || records.length < totalRows);

        return records;
    }

    /**
     * Ensure an Omada API response indicates success.
     * @throws {Error} If the response contains an error code
     */
    public ensureSuccess<T>(response: OmadaApiResponse<T>): T {
        if (response.errorCode !== 0) {
            logger.error('Omada API error', {
                errorCode: response.errorCode,
                message: response.msg,
            });
            throw new Error(response.msg ?? 'Omada API request failed');
        }

        return (response.result ?? ({} as T)) as T;
    }

    /**
     * Check if an error code indicates an authentication error.
     */
    private isAuthErrorCode(errorCode?: number): boolean {
        if (errorCode === undefined) {
            return false;
        }

        return [-44106, -44111, -44112, -44113, -44114, -44116].includes(errorCode);
    }

    /**
     * Check if an error message indicates token expiration.
     */
    private isTokenExpiredMessage(message?: string): boolean {
        if (!message) {
            return false;
        }

        const lowerMsg = message.toLowerCase();
        return (
            lowerMsg.includes('access token has expired') ||
            lowerMsg.includes('token has expired') ||
            lowerMsg.includes('token expired') ||
            lowerMsg.includes('re-initiate the refreshtoken')
        );
    }

    /**
     * Sanitize HTTP headers for logging, masking sensitive values.
     */
    private sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, unknown> | undefined {
        if (!headers) {
            return undefined;
        }

        const sanitized: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(headers)) {
            sanitized[key] = this.isSensitiveKey(key) ? this.maskValue(value) : value;
        }

        return sanitized;
    }

    /**
     * Sanitize a payload for logging, masking sensitive values.
     */
    private sanitizePayload(payload: unknown): unknown {
        if (!payload || typeof payload !== 'object') {
            return payload;
        }

        if (Array.isArray(payload)) {
            return payload.map((item) => this.sanitizePayload(item));
        }

        const sanitized: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(payload)) {
            sanitized[key] = this.isSensitiveKey(key) ? this.maskValue(value) : this.sanitizePayload(value);
        }

        return sanitized;
    }

    /**
     * Check if a key name indicates sensitive data.
     */
    private isSensitiveKey(key: string): boolean {
        const normalized = key.toLowerCase();
        return (
            normalized.includes('authorization') ||
            normalized.includes('token') ||
            normalized.includes('secret') ||
            normalized.includes('password') ||
            normalized.includes('client_id')
        );
    }

    /**
     * Mask a sensitive value for logging.
     */
    private maskValue(value: unknown): unknown {
        if (typeof value === 'string') {
            if (value.length <= 8) {
                return '********';
            }
            return `${value.slice(0, 4)}…${value.slice(-4)}`;
        }

        if (Array.isArray(value)) {
            return value.map(() => '********');
        }

        if (typeof value === 'object' && value !== null) {
            return '[masked-object]';
        }

        return '********';
    }
}
