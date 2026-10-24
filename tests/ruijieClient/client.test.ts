/**
 * The Ruijie eWeb client against a fake router (fetch stubbed): login and session, the call
 * format and checksum headers, a new login once when the session expired, and the lockout
 * guard: a refused login is never retried. Shapes as answered by a RG-EG105G-V3 (2026-10-24).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { checksumHeaders, gibberishDecrypt, pageKey } from '../../src/ruijieClient/crypto.js';
import { RuijieClient, RuijieError } from '../../src/ruijieClient/index.js';
import { logger } from '../../src/utils/logger.js';

vi.mock('../../src/utils/logger.js');

const SID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
type Sent = { url: string; body: Record<string, unknown>; headers: Record<string, string>; raw: string };

/** A fake router: `answers` is consulted per call (login and cmd); the default logs in and echoes. */
function router(options: { login?: () => unknown; cmd?: (body: Record<string, unknown>, n: number) => unknown; cookie?: string } = {}) {
    const sent: Sent[] = [];
    let cmds = 0;
    const json = (value: unknown, cookie?: string) =>
        new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...(cookie ? { 'set-cookie': `${cookie}; path=/` } : {}) } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const raw = String(init?.body ?? '');
        const entry: Sent = { url: String(input), body: JSON.parse(raw) as Record<string, unknown>, headers: { ...(init?.headers as Record<string, string>) }, raw };
        sent.push(entry);
        if (entry.url.endsWith('/cgi-bin/luci/api/auth')) {
            const answer = options.login ? options.login() : { code: 0, data: { sid: SID, token: 't', sn: 'SN1' } };
            return json(answer, options.cookie ?? 'SN1=cookievalue');
        }
        return json(options.cmd ? options.cmd(entry.body, cmds++) : { code: 0, data: { ok: true } });
    });
    return sent;
}

const client = (over: Partial<ConstructorParameters<typeof RuijieClient>[0]> = {}) => new RuijieClient({ baseUrl: 'https://192.0.2.1', password: 'Pa55word!', ...over });
const kind = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof RuijieError ? e.kind : `not a RuijieError: ${String(e)}`));
const message = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => String((e as Error).message));

describe('RuijieClient', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.restoreAllMocks());

    it('logs in like the router page (admin, encrypted password), then calls with the session id, cookie and checksums', async () => {
        const sent = router();
        const c = client();

        expect(await c.config('network')).toEqual({ ok: true });
        await c.status('dhcp_lease', { index: 1 });

        expect(sent).toHaveLength(3);
        const login = sent[0];
        expect(login.url).toBe('https://192.0.2.1/cgi-bin/luci/api/auth');
        const params = login.body.params as Record<string, unknown>;
        expect(login.body.method).toBe('login');
        expect(params.username).toBe('admin');
        expect(params.encry).toBe(true);
        expect(params.time).toMatch(/^\d{10}$/);
        expect(gibberishDecrypt(String(params.password), pageKey())).toBe('Pa55word!');
        expect(login.headers).toMatchObject(checksumHeaders(login.raw));
        expect(login.headers.Cookie).toBeUndefined();

        expect(sent[1].url).toBe(`https://192.0.2.1/cgi-bin/luci/api/cmd?auth=${SID}`);
        expect(sent[1].body).toEqual({ method: 'devConfig.get', params: { module: 'network' } });
        expect(sent[1].headers).toMatchObject({ Cookie: 'SN1=cookievalue', 'Content-Type': 'application/json', ...checksumHeaders(sent[1].raw) });
        expect(sent[2].body).toEqual({ method: 'devSta.get', params: { module: 'dhcp_lease', data: { index: 1 } } });
    });

    it('reads data sent as a JSON string, and the second envelope some modules answer with', async () => {
        router({
            cmd: (_b, n) =>
                n === 0
                    ? { code: 0, data: '{"List":[1]}' }
                    : n === 1
                      ? { code: 0, data: { code: 0, id: null, data: { inner: 1 }, error: null } }
                      : n === 2
                        ? { code: 0, data: 'plain text' }
                        : n === 3
                          ? { code: 0, data: { code: 0, data: '{"x":2}', error: null } }
                          : n === 4
                            ? { code: 0, data: '{not json' }
                            : { code: 0, data: { rcode: '7', value: 'settings that happen to carry an rcode' } },
        });
        const c = client();

        expect(await c.status('a')).toEqual({ List: [1] });
        expect(await c.status('b')).toEqual({ inner: 1 });
        expect(await c.status('c')).toBe('plain text');
        expect(await c.status('d')).toEqual({ x: 2 });
        expect(await c.status('e')).toBe('{not json');
        // a read is returned as it is, an rcode in it is no failure (only a write's is)
        expect(await c.config('f')).toEqual({ rcode: '7', value: 'settings that happen to carry an rcode' });
    });

    it('logs in once more and repeats the call once when the session expired, but not in a loop', async () => {
        const expired = { msg: '403 Forbidden, auth is not passed', code: 2 };
        const once = router({ cmd: (_b, n) => (n === 0 ? expired : { code: 0, data: { ok: 1 } }) });
        expect(await client().status('arp')).toEqual({ ok: 1 });
        expect(once.filter((s) => s.url.endsWith('/auth'))).toHaveLength(2);

        vi.restoreAllMocks();
        const always = router({ cmd: () => expired });
        expect(await message(client().status('arp'))).toBe('The Ruijie router refused devSta.get arp (code 2)');
        expect(always).toHaveLength(4); // login, call, login, call
    });

    it('never retries a refused login: the client switches itself off and later calls send nothing', async () => {
        const sent = router({ login: () => ({ code: 0, data: { error: 'pwd error' } }) });
        const c = client();

        expect(await kind(c.config('network'))).toBe('refused');
        expect(c.disabled).toContain('refused the login');
        expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.stringContaining('refused the login'));
        expect(await kind(c.config('network'))).toBe('disabled');
        expect(await kind(c.check())).toBe('disabled');
        expect(sent).toHaveLength(1);
    });

    it('treats an empty session id as a refused login', async () => {
        router({ login: () => ({ code: 0, data: { sid: '', token: 't' } }) });
        expect(await kind(client().config('network'))).toBe('refused');
    });

    it('says so when the router has locked its login', async () => {
        router({ login: () => ({ code: 0, data: { lockTime: 60 } }) });
        expect(await message(client().config('network'))).toContain('locked its login');
    });

    it('lets parallel calls share one login', async () => {
        const sent = router();
        const c = client();
        await Promise.all([c.config('a'), c.config('b'), c.status('c')]);
        expect(sent.filter((s) => s.url.endsWith('/auth'))).toHaveLength(1);
    });

    it('reports an unreachable router without the address or session id, and tries again on the next call', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError(`fetch failed for https://192.0.2.1/cgi-bin/luci/api/cmd?auth=${SID}`));
        const c = client();
        const error = await c.config('network').catch((e: RuijieError) => e);
        expect(error).toMatchObject({ kind: 'unreachable', message: 'The Ruijie router is not reachable' });
        expect(c.disabled).toBeUndefined();

        vi.restoreAllMocks();
        router();
        expect(await c.config('network')).toEqual({ ok: true });
    });

    it('reports a timeout as such', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
        expect(await message(client().config('network'))).toBe('The Ruijie router is timed out');
    });

    it('sends system calls to /api/system with the session, and refuses a failed upgrade but not a version read', async () => {
        const sent = router({ cmd: (b) => (b.method === 'getVersion' ? { code: 0, data: { cur: 'v1', rcode: '5' } } : { code: 0, data: { rcode: '10000001' } }) });
        const c = client();

        expect(await c.system('getVersion', { deviceType: 'self' })).toEqual({ cur: 'v1', rcode: '5' });
        expect(sent[1].url).toBe(`https://192.0.2.1/cgi-bin/luci/api/system?auth=${SID}`);
        expect(sent[1].body).toEqual({ method: 'getVersion', params: { deviceType: 'self' } });
        expect(await message(c.system('upgradeConfirm', { path: 'u', isPersist: true }))).toBe('The Ruijie router refused system upgradeConfirm (rcode 10000001)');
        await c.system('getVersion');
        expect(sent.at(-1)!.body).toEqual({ method: 'getVersion', params: {} });
    });

    it('tells an unknown module apart, and refuses errors, failed writes and answers without JSON', async () => {
        router({
            cmd: (b, n) =>
                n === 0
                    ? { code: 0, data: { rcode: '1', modelNam: 'x', rmsg: 'no module' } }
                    : n === 1
                      ? { code: 5, error: 'bad things' }
                      : n === 2
                        ? { code: 0, data: { message: 'Invalid parameter', rcode: '10000009' } }
                        : n === 3
                          ? { code: 0, data: { code: 7, data: null, error: 'inner failure' } }
                          : { code: 0, data: { message: 'Configuration success', rcode: '00000000' } },
        });
        const c = client();
        expect(await kind(c.config('nope'))).toBe('unknownModule');
        expect(await message(c.config('x'))).toBe('The Ruijie router refused devConfig.get x (code 5)');
        expect(await message(c.call('devConfig.add', 'dhcp_static', { list: [] }))).toBe('The Ruijie router refused devConfig.add dhcp_static (rcode 10000009)');
        expect(await message(c.status('y'))).toBe('The Ruijie router refused devSta.get y (code 7)');
        expect(await c.call('devConfig.add', 'dhcp_static', { list: [] })).toEqual({ message: 'Configuration success', rcode: '00000000' });

        vi.restoreAllMocks();
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 502 }));
        expect(await message(client().config('network'))).toBe('The Ruijie router answered HTTP 502 without JSON');
    });

    it('never passes the router\'s own error text on (it could hold a URL, the session id or a password)', async () => {
        const leak = `failed https://192.0.2.1/cgi-bin/luci/api/cmd?auth=${SID} password=Pa55word! token=abc`;
        router({
            cmd: (_b, n) =>
                [
                    { code: 9, msg: leak, error: leak },
                    { code: 0, data: { code: 4, data: null, error: leak } },
                    { code: 0, data: { message: leak, rcode: leak } },
                    { code: 'x' as unknown as number, msg: leak },
                ][n],
        });
        const c = client();
        const messages = [
            await message(c.config('a')),
            await message(c.status('b')),
            await message(c.call('devConfig.set', 'c', {})),
            await message(c.config('d')),
        ];
        expect(messages).toEqual([
            'The Ruijie router refused devConfig.get a (code 9)',
            'The Ruijie router refused devSta.get b (code 4)',
            'The Ruijie router refused devConfig.set c (rcode unknown)',
            'The Ruijie router refused devConfig.get d (code unknown)',
        ]);
        for (const m of messages) {
            expect(m).not.toContain(SID);
            expect(m).not.toContain('192.0.2.1');
            expect(m).not.toContain('Pa55word');
        }
    });

    it('warns when the router is reached over plain http (the page key is no secret), not over https', () => {
        client({ baseUrl: 'http://192.0.2.1' });
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('plain http'));
        vi.mocked(logger.warn).mockClear();
        client();
        expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    });

    it('reports the router model and firmware as its check, and keeps the host for protection', async () => {
        router({ cmd: () => ({ code: 0, data: { product_class: 'EG105G-V3', software_version: 'ReyeeOS 2.324' } }) });
        const c = client({ baseUrl: 'https://192.0.2.1:8443/' });
        expect(c.host).toBe('192.0.2.1');
        expect(await c.check()).toEqual({ model: 'EG105G-V3', version: 'ReyeeOS 2.324' });

        vi.restoreAllMocks();
        router({ cmd: () => ({ code: 0, data: { model: 'EG105G' } }) });
        expect(await client().check()).toEqual({ model: 'EG105G', version: 'unknown' });
    });
});
