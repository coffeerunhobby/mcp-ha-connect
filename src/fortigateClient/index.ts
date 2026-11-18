/**
 * Client for a FortiGate's REST API (FortiOS 7.x), read-only:
 *
 * - Auth: a REST API admin's token (System > Administrators > REST API Admin), sent as
 *   `Authorization: Bearer <token>` on every call. Never as the `access_token` query parameter:
 *   URLs end up in logs and errors. The admin's trusted hosts should be this server only.
 * - Calls: GET /api/v2/cmdb/<path>/<name> (settings) and GET /api/v2/monitor/<path>/<name>
 *   (live state), plus GET /api/v2/log/... Every answer is an envelope
 *   {http_method, results, vdom, path, name, status: "success", http_status, serial, version, build}.
 * - A refused token (HTTP 401: wrong token, or this host isn't one of the admin's trusted hosts)
 *   switches the client off for good: FortiOS counts failed admin logins and can lock the source
 *   address out, so a refused token is never sent again until the setting is fixed and the
 *   server restarted. 403 (the admin's profile lacks the permission) only fails that call. Some
 *   builds answer 401 for 403: once the token has worked, a 401 is checked with one identity call
 *   (system/status); only if that is refused too is the token refused.
 *
 * The token is never logged or put in an error message; only the HTTP status and FortiOS's
 * numeric error code reach errors.
 */

import type { Dispatcher } from 'undici';

import { logger } from '../utils/logger.js';
import { createPinnedDispatcher, createTlsDispatcher, PIN_MISMATCH, tlsAwareFetch, type FetchInitWithDispatcher } from '../utils/tlsDispatcher.js';

export interface FortiGateClientConfig {
    /** e.g. https://192.0.2.99 (the FortiGate's HTTPS admin address, any port). https only. */
    baseUrl: string;
    /** The REST API admin's token (FORTIGATE_TOKEN). */
    token: string;
    /** false: accept the FortiGate's self-signed certificate (this client only). */
    strictSsl?: boolean;
    /** The certificate's SHA-256 fingerprint: exactly that certificate is trusted (replaces strictSsl). */
    certSha256?: string;
    /** VDOM to read (FORTIGATE_VDOM); default: the token's own (root). */
    vdom?: string;
    /** LAN addresses of the machine this server runs on (MCP_SERVER_ADDRESSES). */
    serverAddresses?: string[];
    /** Milliseconds per request (default 15000). */
    timeout?: number;
}

/** A FortiGate call that failed: `refused` = the token was refused (the client is off now), `forbidden` = the profile lacks it. */
export class FortiGateError extends Error {
    constructor(
        message: string,
        readonly kind: 'refused' | 'forbidden' | 'notFound' | 'unreachable' | 'device' | 'disabled' = 'device'
    ) {
        super(message);
        this.name = 'FortiGateError';
    }
}

/** What every FortiOS REST answer carries around its results. */
export interface FortiEnvelope<T> {
    results: T;
    serial?: string;
    version?: string;
    build?: number;
    vdom?: string;
}

/** One path segment: letters, digits and . _ - (FortiOS table and object names like "system.dhcp"). */
const SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;

export class FortiGateClient {
    /** Host of the base URL (the FortiGate's own address, as this server reaches it). */
    readonly host: string;
    /** Where this server runs, so nothing cuts it off; empty when not configured. */
    readonly serverAddresses: string[];
    private readonly baseUrl: string;
    private readonly token: string;
    private readonly vdom?: string;
    private readonly timeout: number;
    private readonly dispatcher?: Dispatcher;
    private disabledMessage?: string;
    /** A call has succeeded with this token. */
    private tokenWorked = false;

    constructor(config: FortiGateClientConfig) {
        const url = new URL(config.baseUrl);
        // The token is a full credential: over plain http anyone on the path could read it.
        if (url.protocol !== 'https:') throw new Error('FORTIGATE_BASE_URL must be https:// (the token would travel in clear text)');
        if (config.vdom !== undefined && !SEGMENT.test(config.vdom)) throw new Error('FORTIGATE_VDOM must be a VDOM name (letters, digits, . _ -)');
        this.baseUrl = url.origin;
        this.host = url.hostname;
        this.token = config.token;
        this.vdom = config.vdom;
        this.timeout = config.timeout ?? 15_000;
        this.serverAddresses = config.serverAddresses ?? [];
        this.dispatcher = config.certSha256 !== undefined ? createPinnedDispatcher(config.certSha256) : createTlsDispatcher(config.strictSsl, config.baseUrl);
    }

    /** Settings: GET /api/v2/cmdb/<path>/<name>. */
    async cmdb<T = Record<string, unknown>[]>(path: string, name: string, query?: Record<string, string | number | boolean>): Promise<FortiEnvelope<T>> {
        return await this.get<T>('cmdb', [path, name], query);
    }

    /** Live state: GET /api/v2/monitor/<path>/<name>[/<action>]. */
    async monitor<T = unknown>(path: string, name: string, action?: string, query?: Record<string, string | number | boolean>): Promise<FortiEnvelope<T>> {
        return await this.get<T>('monitor', action === undefined ? [path, name] : [path, name, action], query);
    }

    /** Logs: GET /api/v2/log/<source>/<type>[/<subtype>]. */
    async log<T = unknown>(segments: string[], query?: Record<string, string | number | boolean>): Promise<FortiEnvelope<T>> {
        return await this.get<T>('log', segments, query);
    }

    /** The FortiGate's identity (model, hostname, FortiOS version). Used as the reachability check. */
    async check(): Promise<{ model: string; hostname: string; version: string }> {
        const status = await this.monitor<Record<string, unknown>>('system', 'status');
        const r = status.results ?? {};
        const model = [r.model_name, r.model_number].filter((v) => typeof v === 'string' && v).join(' ') || (typeof r.model === 'string' ? r.model : 'FortiGate');
        return { model, hostname: typeof r.hostname === 'string' ? r.hostname : 'unknown', version: status.version ?? 'unknown' };
    }

    /** Turns every call into a refusal with this message (after a refused token). */
    disable(message: string): void {
        this.disabledMessage = message;
    }

    get disabled(): string | undefined {
        return this.disabledMessage;
    }

    private async get<T>(api: 'cmdb' | 'monitor' | 'log', segments: string[], query?: Record<string, string | number | boolean>): Promise<FortiEnvelope<T>> {
        if (this.disabledMessage) throw new FortiGateError(this.disabledMessage, 'disabled');
        for (const segment of segments) {
            if (!SEGMENT.test(segment)) throw new FortiGateError('Not a FortiOS API path', 'notFound');
        }
        const params = new URLSearchParams();
        if (this.vdom) params.set('vdom', this.vdom);
        for (const [key, value] of Object.entries(query ?? {})) {
            // The VDOM is this server's setting: a call never reads another one.
            if (key.toLowerCase() === 'vdom') throw new FortiGateError('A FortiGate call may not choose the VDOM', 'notFound');
            params.set(key, String(value));
        }
        const path = `/api/v2/${api}/${segments.map(encodeURIComponent).join('/')}`;
        const label = `${api} ${segments.join('/')}`;
        const search = params.size ? `?${params.toString()}` : '';

        const init: FetchInitWithDispatcher = {
            method: 'GET',
            headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(this.timeout),
            // A redirect would carry the token elsewhere (or downgrade to a login page): never followed.
            redirect: 'manual',
        };
        if (this.dispatcher) init.dispatcher = this.dispatcher;
        let response: Response;
        try {
            response = await tlsAwareFetch(this.baseUrl + path + search, init);
        } catch (error) {
            if ((error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined) === PIN_MISMATCH) {
                throw new FortiGateError("The FortiGate's certificate doesn't match FORTIGATE_CERT_SHA256; nothing was sent to it", 'unreachable');
            }
            const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'not reachable';
            throw new FortiGateError(`The FortiGate is ${reason}`, 'unreachable');
        }
        let raw: string;
        try {
            raw = await response.text();
        } catch (error) {
            const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'not reachable';
            throw new FortiGateError(`The FortiGate is ${reason}`, 'unreachable');
        }

        if (response.status === 401 && this.tokenWorked && !(api === 'monitor' && segments.join('/') === 'system/status')) {
            // Some FortiOS builds answer 401 instead of 403 when a valid token's profile lacks the
            // permission (FortiOS 7.0.1 known issue). The token has worked before: ask once for the
            // identity (any admin may read it). It answers: a missing permission, only this call fails.
            // It is refused too: the token is, and that call has switched the client off.
            try {
                await this.get('monitor', ['system', 'status']);
            } catch (error) {
                if (error instanceof FortiGateError && (error.kind === 'refused' || error.kind === 'disabled')) throw error;
                throw new FortiGateError(`The FortiGate refused ${label} (HTTP 401), and whether the token still works couldn't be checked`, 'forbidden');
            }
            throw new FortiGateError(`The FortiGate refused ${label} (HTTP 401 while the token works: the API admin's profile probably doesn't allow it)`, 'forbidden');
        }
        if (response.status === 401) {
            const message =
                'The FortiGate refused the API token (wrong FORTIGATE_TOKEN, or this server is not one of the REST API admin\'s trusted hosts). The FortiGate tools stay off until the setting is fixed and the server restarted; a refused token is never sent again, because failed logins can lock this address out.';
            this.disable(message);
            logger.error(message);
            throw new FortiGateError(message, 'refused');
        }
        if (response.status === 403) throw new FortiGateError(`The FortiGate's API admin profile doesn't allow ${label} (HTTP 403)`, 'forbidden');
        if (response.status === 404) throw new FortiGateError(`This FortiGate has no ${label} (HTTP 404; another FortiOS version?)`, 'notFound');
        if (response.status >= 300 && response.status < 400) throw new FortiGateError(`The FortiGate redirected ${label} (HTTP ${response.status}); not followed`);

        let body: Record<string, unknown>;
        try {
            body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            if (response.ok) throw new FortiGateError("The FortiGate's answer was cut off", 'unreachable');
            throw new FortiGateError(`The FortiGate answered ${label} with HTTP ${response.status}`);
        }
        if (!response.ok || (body.status !== undefined && body.status !== 'success')) {
            throw new FortiGateError(`The FortiGate refused ${label} (HTTP ${response.status}${errorCode(body.error)})`);
        }
        this.tokenWorked = true;
        logger.debug('FortiGate call', { call: label });
        return {
            results: body.results as T,
            ...(typeof body.serial === 'string' ? { serial: body.serial } : {}),
            ...(typeof body.version === 'string' ? { version: body.version } : {}),
            ...(typeof body.build === 'number' ? { build: body.build } : {}),
            ...(typeof body.vdom === 'string' ? { vdom: body.vdom } : {}),
        };
    }
}

/** Only FortiOS's numeric error code goes into an error, never its own text. */
function errorCode(code: unknown): string {
    return typeof code === 'number' && Number.isInteger(code) ? `, error ${code}` : '';
}
