/**
 * Client for a Ruijie / Reyee router's local eWeb API (the JSON API its own web page uses),
 * mapped on a RG-EG105G-V3 with ReyeeOS 2.324 (2026-10-24):
 *
 * - Login: POST /cgi-bin/luci/api/auth {method: "login", params: {username: "admin",
 *   password: <GibberishAES>, time, encry: true}} answers {data: {sid, token, sn}} and sets a
 *   session cookie. The username is always "admin". The session lasts about an hour.
 * - Calls: POST /cgi-bin/luci/api/cmd?auth=<sid> {method, params: {module, data}} with the
 *   cookie and the page's checksum headers. Methods: devConfig.get (settings), devSta.get
 *   (live state), and devConfig.add / update / del / set for changes.
 * - An expired or unknown session answers {code: 2, msg: "403 Forbidden, auth is not passed"}:
 *   the client logs in again once and repeats the call once.
 *
 * Wrong passwords lock the router's login (five in a row lock it for a minute), so a refused
 * login is never retried: the client switches itself off with a clear message until the
 * setting is fixed and the server restarted. Only a network failure lets the next call try
 * again. The session id is never logged or put in an error message.
 */

import type { Dispatcher } from 'undici';

import { logger } from '../utils/logger.js';
import { createPinnedDispatcher, createTlsDispatcher, PIN_MISMATCH, tlsAwareFetch, type FetchInitWithDispatcher } from '../utils/tlsDispatcher.js';

import { checksumHeaders, encryptPassword } from './crypto.js';

export interface RuijieClientConfig {
    /** e.g. https://192.168.110.1 (the router's management address). */
    baseUrl: string;
    /** The router's admin password (RUIJIE_PASSWORD). */
    password: string;
    /** false: accept the router's self-signed certificate (this client only). */
    strictSsl?: boolean;
    /** The router certificate's SHA-256 fingerprint: exactly that certificate is trusted (https only; replaces strictSsl). */
    certSha256?: string;
    /** true: every change through the tools is refused (RUIJIE_READ_ONLY). */
    readOnly?: boolean;
    /** false: firmware upgrades are refused (RUIJIE_FIRMWARE_UPGRADE). */
    firmwareUpgrade?: boolean;
    /** Milliseconds per request (default 15000). */
    timeout?: number;
}

/** A Ruijie call that failed: `refused` = the login was refused, `unknownModule` = the router has no such module. */
export class RuijieError extends Error {
    constructor(
        message: string,
        readonly kind: 'refused' | 'unreachable' | 'router' | 'unknownModule' | 'disabled' = 'router',
        /** For an unreachable router: true when the request certainly never reached it (no connection, or no session). */
        readonly notSent = false
    ) {
        super(message);
        this.name = 'RuijieError';
    }
}

/** Connection failures that happen before a request is sent: refused, no route, no name, TLS rejected. */
const NOT_SENT = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/;

function failedBeforeSending(error: unknown): boolean {
    const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
    return typeof cause?.code === 'string' && NOT_SENT.test(cause.code);
}

interface Session {
    sid: string;
    cookie: string;
}

/** Answer of a call whose session was not accepted. */
const AUTH_NOT_PASSED = 2;

export class RuijieClient {
    /** Host of the router's base URL (the router's own address, kept out of harm's way). */
    readonly host: string;
    private readonly baseUrl: string;
    private readonly password: string;
    private readonly timeout: number;
    private readonly dispatcher?: Dispatcher;
    /** Changes through the tools switched off (RUIJIE_READ_ONLY). */
    readonly readOnly: boolean;
    /** Firmware upgrades allowed (RUIJIE_FIRMWARE_UPGRADE). */
    readonly firmwareUpgrade: boolean;
    private session?: Session;
    private loggingIn?: Promise<Session>;
    private disabledMessage?: string;

    constructor(config: RuijieClientConfig) {
        const url = new URL(config.baseUrl);
        this.baseUrl = url.origin;
        this.host = url.hostname;
        this.password = config.password;
        this.timeout = config.timeout ?? 15_000;
        this.readOnly = config.readOnly ?? false;
        this.firmwareUpgrade = config.firmwareUpgrade ?? true;
        if (config.certSha256 !== undefined) {
            if (url.protocol !== 'https:') throw new Error('A certificate pin (RUIJIE_CERT_SHA256) needs an https:// router address');
            this.dispatcher = createPinnedDispatcher(config.certSha256);
        } else {
            this.dispatcher = createTlsDispatcher(config.strictSsl, config.baseUrl);
        }
        if (url.protocol === 'http:') {
            // The login page's password encryption uses a key shipped in the page itself: over plain
            // HTTP anyone watching the traffic can read the password. Only HTTPS protects it.
            logger.warn('RUIJIE_BASE_URL uses plain http: the router password can be read by anyone watching the traffic. Use https:// with RUIJIE_CERT_SHA256 (the self-signed certificate of the router, pinned) unless the connection already runs inside an encrypted tunnel.');
        }
    }

    /** Settings: devConfig.get. */
    async config<T = Record<string, unknown>>(module: string, data?: unknown): Promise<T> {
        return await this.call<T>('devConfig.get', module, data);
    }

    /** Live state: devSta.get. */
    async status<T = Record<string, unknown>>(module: string, data?: unknown): Promise<T> {
        return await this.call<T>('devSta.get', module, data);
    }

    /** The router's identity (model and firmware); logs in when needed. Used as the reachability check. */
    async check(): Promise<{ model: string; version: string }> {
        const info = await this.status<Record<string, unknown>>('sysinfo');
        return { model: String(info.product_class ?? info.model ?? 'unknown'), version: String(info.software_version ?? 'unknown') };
    }

    /** Turns every call into a refusal with this message (e.g. after a refused login). */
    disable(message: string): void {
        this.disabledMessage = message;
    }

    get disabled(): string | undefined {
        return this.disabledMessage;
    }

    /** A module call on /api/cmd: devConfig.* (settings and changes) or devSta.* (live state). */
    async call<T>(method: string, module: string, data?: unknown): Promise<T> {
        return await this.request<T>('cmd', { method, params: data === undefined ? { module } : { module, data } }, `${method} ${module}`, !method.endsWith('.get'));
    }

    /**
     * A system call on /api/system, e.g. getVersion (the running and the offered firmware) or
     * upgradeConfirm (install a firmware and restart).
     */
    async system<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        return await this.request<T>('system', { method, params: params ?? {} }, `system ${method}`, method !== 'getVersion');
    }

    /** One call with the session; a session the router no longer accepts is renewed once. */
    private async request<T>(endpoint: 'cmd' | 'system', payload: Record<string, unknown>, label: string, isChange: boolean): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            let session: Session;
            try {
                session = await this.ensureSession();
            } catch (error) {
                // No session, so this request was never sent (after a code 2 the router refused the first try).
                if (error instanceof RuijieError && error.kind === 'unreachable') throw new RuijieError(error.message, 'unreachable', true);
                throw error;
            }
            const body = JSON.stringify(payload);
            const answer = await this.post(`/cgi-bin/luci/api/${endpoint}?auth=${encodeURIComponent(session.sid)}`, body, session.cookie);
            if (answer.code === AUTH_NOT_PASSED && attempt === 0) {
                // The session expired (or the router restarted): log in once more, repeat once.
                if (this.session === session) this.session = undefined;
                continue;
            }
            if (answer.code !== 0) throw new RuijieError(`The Ruijie router refused ${label} (${codeOf(answer.code)})`);
            let result = parseData(answer.data);
            // Some modules answer with a second envelope inside data.
            if (isEnvelope(result)) {
                if (result.code !== 0 && result.code !== '0') throw new RuijieError(`The Ruijie router refused ${label} (${codeOf(result.code)})`);
                result = parseData(result.data);
            }
            if (result && typeof result === 'object' && 'rcode' in result && 'rmsg' in result && 'modelNam' in result) {
                throw new RuijieError(`The Ruijie router has no ${label}`, 'unknownModule');
            }
            const rcode = result && typeof result === 'object' ? (result as Record<string, unknown>).rcode : undefined;
            if (isChange && rcode !== undefined && rcode !== '00000000') {
                throw new RuijieError(`The Ruijie router refused ${label} (r${codeOf(rcode)})`);
            }
            logger.debug('Ruijie call', { call: label });
            return result as T;
        }
    }

    private async ensureSession(): Promise<Session> {
        if (this.disabledMessage) throw new RuijieError(this.disabledMessage, 'disabled');
        if (this.session) return this.session;
        // One login at a time: parallel calls wait for the same one.
        this.loggingIn ??= this.login().finally(() => {
            this.loggingIn = undefined;
        });
        return await this.loggingIn;
    }

    private async login(): Promise<Session> {
        const body = JSON.stringify({
            method: 'login',
            params: { password: encryptPassword(this.password), username: 'admin', time: Math.floor(Date.now() / 1000).toString(), encry: true },
        });
        const { answer, cookies } = await this.postWithCookies('/cgi-bin/luci/api/auth', body);
        const data = parseData(answer.data);
        const sid = data && typeof data === 'object' ? (data as Record<string, unknown>).sid : undefined;
        if (typeof sid !== 'string' || sid === '') {
            const locked = data && typeof data === 'object' && (data as Record<string, unknown>).lockTime !== undefined;
            // Never retried: wrong passwords lock the router's login.
            const message = locked
                ? 'The Ruijie router has locked its login after failed attempts. The Ruijie tools stay off; check RUIJIE_PASSWORD, wait for the lock to pass and restart the server.'
                : 'The Ruijie router refused the login (wrong RUIJIE_PASSWORD?). The Ruijie tools stay off until the setting is fixed and the server restarted; they never retry, because wrong passwords lock the router.';
            this.disable(message);
            logger.error(message);
            throw new RuijieError(message, 'refused');
        }
        this.session = { sid, cookie: cookies.join('; ') };
        logger.info('Logged in to the Ruijie router');
        return this.session;
    }

    private async post(path: string, body: string, cookie: string): Promise<RuijieAnswer> {
        return (await this.postWithCookies(path, body, cookie)).answer;
    }

    private async postWithCookies(path: string, body: string, cookie?: string): Promise<{ answer: RuijieAnswer; cookies: string[] }> {
        const init: FetchInitWithDispatcher = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...checksumHeaders(body) },
            body,
            signal: AbortSignal.timeout(this.timeout),
        };
        if (this.dispatcher) init.dispatcher = this.dispatcher;
        let response: Response;
        try {
            response = await tlsAwareFetch(this.baseUrl + path, init);
        } catch (error) {
            // Never the URL: it carries the session id.
            if ((error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined) === PIN_MISMATCH) {
                throw new RuijieError("The Ruijie router's certificate doesn't match RUIJIE_CERT_SHA256; nothing was sent to it", 'unreachable', true);
            }
            const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'not reachable';
            throw new RuijieError(`The Ruijie router is ${reason}`, 'unreachable', failedBeforeSending(error));
        }
        let raw: string;
        try {
            raw = await response.text();
        } catch (error) {
            // The answer broke off (e.g. the router restarted while sending it): the request did arrive.
            const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'not reachable';
            throw new RuijieError(`The Ruijie router is ${reason}`, 'unreachable');
        }
        let answer: RuijieAnswer;
        try {
            answer = JSON.parse(raw) as RuijieAnswer;
        } catch {
            // A success status with a broken body is a cut-off answer, not a refusal.
            if (response.ok) throw new RuijieError('The Ruijie router\'s answer was cut off', 'unreachable');
            throw new RuijieError(`The Ruijie router answered HTTP ${response.status} without JSON`);
        }
        const cookies = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
        return { answer: answer ?? {}, cookies };
    }
}

interface RuijieAnswer {
    code?: number;
    msg?: string;
    error?: unknown;
    data?: unknown;
}

interface Envelope {
    code: number | string;
    id?: unknown;
    data?: unknown;
    error?: unknown;
}

function isEnvelope(value: unknown): value is Envelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort().join(',');
    return keys === 'code,data,error,id' || keys === 'code,data,error';
}

/** The router sometimes sends `data` as a JSON string. */
function parseData(data: unknown): unknown {
    if (typeof data !== 'string') return data;
    try {
        return JSON.parse(data.trim());
    } catch {
        return data;
    }
}

/**
 * Only the router's numeric code goes into an error, never its own text: that could carry a URL,
 * the session id or a password, and errors reach tool output.
 */
function codeOf(code: unknown): string {
    const value = typeof code === 'number' ? String(code) : typeof code === 'string' ? code : '';
    return `code ${/^\d{1,10}$/.test(value) ? value : 'unknown'}`;
}
