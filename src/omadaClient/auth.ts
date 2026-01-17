import type { OmadaApiResponse, TokenResult } from '../types/index.js';
import { logger } from '../utils/logger.js';

const TOKEN_EXPIRY_BUFFER_SECONDS = 30;

export interface AuthManagerConfig {
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    omadacId: string;
    timeout?: number;
    strictSsl?: boolean;
}

/**
 * Authentication state management for the Omada client.
 */
export class AuthManager {
    private accessToken?: string;

    private refreshToken?: string;

    private tokenExpiresAt?: number;

    private readonly baseUrl: string;
    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly omadacId: string;
    private readonly timeout: number;
    private readonly strictSsl: boolean;

    constructor(config: AuthManagerConfig) {
        this.baseUrl = config.baseUrl;
        this.clientId = config.clientId;
        this.clientSecret = config.clientSecret;
        this.omadacId = config.omadacId;
        this.timeout = config.timeout ?? 30000;
        this.strictSsl = config.strictSsl ?? true;
    }

    /**
     * Get the current access token, refreshing if necessary.
     */
    public async getAccessToken(): Promise<string> {
        await this.ensureAccessToken();
        return this.accessToken ?? '';
    }

    /**
     * Clear the current authentication token.
     */
    public clearToken(): void {
        this.accessToken = undefined;
        this.refreshToken = undefined;
        this.tokenExpiresAt = undefined;
    }

    /**
     * Ensure a valid access token is available, refreshing or re-authenticating if necessary.
     */
    private async ensureAccessToken(): Promise<void> {
        if (this.accessToken && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt) {
            return;
        }

        if (this.refreshToken) {
            try {
                await this.authenticate('refresh_token');
                return;
            } catch {
                this.clearToken();
            }
        }

        await this.authenticate('client_credentials');
    }

    /**
     * Authenticate with the Omada controller using the specified grant type.
     */
    private async authenticate(grantType: 'client_credentials' | 'refresh_token'): Promise<void> {
        const url = new URL('/openapi/authorize/token', this.baseUrl);

        // Add query parameters
        url.searchParams.set('grant_type', grantType);
        if (grantType === 'refresh_token') {
            if (!this.refreshToken) {
                throw new Error('No refresh token available to refresh the access token');
            }
            url.searchParams.set('refresh_token', this.refreshToken);
        }

        const body: Record<string, string> = {
            client_id: this.clientId,
            client_secret: this.clientSecret,
        };

        if (grantType === 'client_credentials') {
            body.omadacId = this.omadacId;
        }

        try {
            // For self-signed certificates, we need to temporarily disable TLS validation
            // Node.js native fetch doesn't support the `agent` option like axios/node-fetch
            const originalRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
            if (!this.strictSsl) {
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
            }

            let response: Response;
            try {
                response = await fetch(url.toString(), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(this.timeout),
                });
            } finally {
                // Restore original setting
                if (!this.strictSsl) {
                    if (originalRejectUnauthorized === undefined) {
                        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
                    } else {
                        process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalRejectUnauthorized;
                    }
                }
            }

            if (!response.ok) {
                const errorText = await response.text();
                logger.error('Omada authentication HTTP error', {
                    grantType,
                    status: response.status,
                    statusText: response.statusText,
                    body: errorText,
                });
                throw new Error(`Omada authentication failed: ${response.statusText}`);
            }

            const data = (await response.json()) as OmadaApiResponse<TokenResult>;

            if (data.errorCode !== 0) {
                logger.error('Omada authentication error', {
                    errorCode: data.errorCode,
                    message: data.msg,
                });
                throw new Error(data.msg ?? 'Omada authentication failed');
            }

            const token = data.result ?? ({} as TokenResult);
            this.setToken(token);
        } catch (error) {
            logger.error('Omada authentication failed', {
                grantType,
                baseUrl: this.baseUrl,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * Store the authentication token and calculate expiration time.
     */
    private setToken(token: TokenResult): void {
        this.accessToken = token.accessToken;
        this.refreshToken = token.refreshToken;

        const expiresInSeconds = Number.isFinite(token.expiresIn) ? token.expiresIn : 0;
        const expiresInMs = Math.max(expiresInSeconds - TOKEN_EXPIRY_BUFFER_SECONDS, 0) * 1000;
        this.tokenExpiresAt = Date.now() + expiresInMs;
    }
}
