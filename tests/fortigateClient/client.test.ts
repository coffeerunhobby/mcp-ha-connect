/**
 * The FortiGate REST client against a fake FortiGate (fetch stubbed): the token only in the
 * Authorization header, the call paths, VDOM, the envelope, and the refusals: a refused token
 * (401) switches the client off and is never sent again; 403/404 fail only that call; nothing a
 * FortiGate answers in text, and never the token, reaches an error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { FortiGateClient, FortiGateError } from '../../src/fortigateClient/index.js';
import { logger } from '../../src/utils/logger.js';

import { envelope, systemStatus } from '../net/fixtures/fortigate.js';

vi.mock('../../src/utils/logger.js');

const TOKEN = 'n8Qx3fG7hZp1kT9mW2rV5yB4cJ6dL0sA';
type Sent = { url: string; init: RequestInit };

function fortigate(answer: (url: URL, n: number) => Response | Promise<Response>) {
    const sent: Sent[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        sent.push({ url: String(input), init: init ?? {} });
        return await answer(new URL(String(input)), sent.length - 1);
    });
    return sent;
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
// strictSsl true: no dispatcher, so the stubbed global fetch is used.
const client = (over: Partial<ConstructorParameters<typeof FortiGateClient>[0]> = {}) => new FortiGateClient({ baseUrl: 'https://192.0.2.99', token: TOKEN, ...over });
const failure = async (p: Promise<unknown>) =>
    p.then(
        () => ({ kind: 'ok', message: '' }),
        (e: unknown) => ({ kind: e instanceof FortiGateError ? e.kind : 'not a FortiGateError', message: String((e as Error).message) })
    );

describe('FortiGateClient', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.restoreAllMocks());

    it('sends the token as a Bearer header only, never in the URL, and does not follow redirects', async () => {
        const sent = fortigate(() => json(envelope('system', 'status', systemStatus)));
        const result = await client().monitor('system', 'status');

        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe('https://192.0.2.99/api/v2/monitor/system/status');
        expect(sent[0].url).not.toContain(TOKEN);
        expect(sent[0].init.method).toBe('GET');
        expect(sent[0].init.redirect).toBe('manual');
        expect((sent[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
        expect(result).toEqual({ results: systemStatus, serial: 'FGT80FTK00000001', version: 'v7.4.4', build: 2662, vdom: 'root' });
    });

    it('builds cmdb, monitor and log paths, with the VDOM and query parameters', async () => {
        const sent = fortigate(() => json(envelope('x', 'y', [])));
        const c = client({ vdom: 'root' });
        await c.cmdb('system.dhcp', 'server');
        await c.monitor('system', 'resource', 'usage', { scope: 'global' });
        await c.log(['memory', 'event', 'system'], { rows: 50 });
        expect(sent.map((s) => s.url)).toEqual([
            'https://192.0.2.99/api/v2/cmdb/system.dhcp/server?vdom=root',
            'https://192.0.2.99/api/v2/monitor/system/resource/usage?vdom=root&scope=global',
            'https://192.0.2.99/api/v2/log/memory/event/system?vdom=root&rows=50',
        ]);
    });

    it('keeps the configured VDOM: a query cannot override it', async () => {
        const sent = fortigate(() => json(envelope('x', 'y', [])));
        expect((await failure(client({ vdom: 'root' }).cmdb('firewall', 'policy', { vdom: 'other' }))).kind).toBe('notFound');
        expect((await failure(client().monitor('system', 'status', undefined, { VDOM: 'other' }))).kind).toBe('notFound');
        expect(sent).toHaveLength(0);
    });

    it('refuses path segments that are not plain FortiOS names, without calling', async () => {
        const sent = fortigate(() => json(envelope('x', 'y', [])));
        expect((await failure(client().cmdb('firewall', '../../admin'))).kind).toBe('notFound');
        expect((await failure(client().monitor('system', 'status', 'x?y=1'))).kind).toBe('notFound');
        expect(sent).toHaveLength(0);
    });

    it('reads the identity for the reachability check', async () => {
        fortigate(() => json(envelope('system', 'status', systemStatus)));
        expect(await client().check()).toEqual({ model: 'FortiGate 80F', hostname: 'FGT80F-Home', version: 'v7.4.4' });
    });

    it('a refused token (401) switches the client off: logged once, never sent again', async () => {
        const sent = fortigate(() => json({ http_method: 'GET', status: 'error', http_status: 401 }, 401));
        const c = client();
        const first = await failure(c.monitor('system', 'status'));
        expect(first.kind).toBe('refused');
        expect(first.message).toContain('trusted hosts');
        expect(c.disabled).toBeDefined();
        expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1);

        const second = await failure(c.cmdb('firewall', 'policy'));
        expect(second.kind).toBe('disabled');
        expect(sent).toHaveLength(1);
    });

    it('a 401 after the token has worked is checked once against the identity call: it answers, so it was a missing permission (some FortiOS builds answer 401 for 403)', async () => {
        const sent = fortigate((url) => (url.pathname.endsWith('/status') ? json(envelope('system', 'status', systemStatus)) : json({ status: 'error', http_status: 401 }, 401)));
        const c = client();
        await c.check();
        const denied = await failure(c.cmdb('firewall', 'policy'));
        expect(denied.kind).toBe('forbidden');
        expect(denied.message).toContain('HTTP 401');
        // Two unreadable paths in a row don't switch a working token off.
        expect((await failure(c.cmdb('firewall', 'address'))).kind).toBe('forbidden');
        expect(c.disabled).toBeUndefined();
        expect(sent.map((x) => new URL(x.url).pathname.split('/').slice(-2).join('/'))).toEqual(['system/status', 'firewall/policy', 'system/status', 'firewall/address', 'system/status']);
    });

    it('a 401 after the token worked, confirmed by a refused identity call, switches the client off (the token was revoked or changed)', async () => {
        const sent = fortigate((_url, n) => (n === 0 ? json(envelope('system', 'status', systemStatus)) : json({ status: 'error', http_status: 401 }, 401)));
        const c = client();
        await c.check();
        expect((await failure(c.cmdb('firewall', 'policy'))).kind).toBe('refused');
        expect((await failure(c.monitor('system', 'status'))).kind).toBe('disabled');
        expect(sent).toHaveLength(3);
        expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1);
    });

    it('a 401 on the identity call itself after the token worked switches the client off at once', async () => {
        const sent = fortigate((_url, n) => (n === 0 ? json(envelope('system', 'status', systemStatus)) : json({ status: 'error', http_status: 401 }, 401)));
        const c = client();
        await c.check();
        expect((await failure(c.check())).kind).toBe('refused');
        expect(sent).toHaveLength(2);
    });

    it('403 (the profile lacks it) and 404 (no such path) fail only that call', async () => {
        const sent = fortigate((url) => (url.pathname.endsWith('/policy') ? json({ status: 'error', http_status: 403 }, 403) : new Response('<html>not found</html>', { status: 404 })));
        const c = client();
        expect((await failure(c.cmdb('firewall', 'policy'))).kind).toBe('forbidden');
        const missing = await failure(c.monitor('vpn', 'ssl'));
        expect(missing.kind).toBe('notFound');
        expect(missing.message).not.toContain('html');
        expect(c.disabled).toBeUndefined();
        expect(sent).toHaveLength(2);
    });

    it('passes on only the HTTP status and the numeric error code, never the answer text or the token', async () => {
        fortigate(() => json({ status: 'error', http_status: 500, error: -3, cli_error: `secret detail ${TOKEN}` }, 500));
        const { kind, message } = await failure(client().cmdb('firewall', 'policy'));
        expect(kind).toBe('device');
        expect(message).toBe('The FortiGate refused cmdb firewall/policy (HTTP 500, error -3)');
        expect(message).not.toContain(TOKEN);
    });

    it('treats status "error" in a 200 envelope as a refusal', async () => {
        fortigate(() => json({ status: 'error', http_status: 200, error: -5 }));
        expect((await failure(client().cmdb('firewall', 'policy'))).message).toContain('error -5');
    });

    it('does not follow a redirect', async () => {
        fortigate(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }));
        expect((await failure(client().monitor('system', 'status'))).message).toContain('redirected');
    });

    it('a cut-off answer and an unreachable FortiGate are "unreachable", with no URL or token in the message', async () => {
        fortigate(() => new Response('{"results": [', { status: 200 }));
        expect((await failure(client().monitor('system', 'status'))).kind).toBe('unreachable');
        vi.restoreAllMocks();
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
        const down = await failure(client().monitor('system', 'status'));
        expect(down).toEqual({ kind: 'unreachable', message: 'The FortiGate is not reachable' });
    });

    it('accepts https only, and a plain VDOM name', () => {
        expect(() => client({ baseUrl: 'http://192.0.2.99' })).toThrow(/https/);
        expect(() => client({ vdom: 'root/../x' })).toThrow(/VDOM/);
        expect(() => client({ baseUrl: 'https://user:pw@192.0.2.99' })).toThrow(/user name, password, path/);
        expect(() => client({ baseUrl: 'https://192.0.2.99/forti' })).toThrow(/path/);
        expect(() => client({ baseUrl: 'https://192.0.2.99/?x=1' })).toThrow(/path/);
        expect(client({ baseUrl: 'https://192.0.2.99:8443/' }).host).toBe('192.0.2.99');
    });
});
