/**
 * The Ruijie client with a pinned certificate (RUIJIE_CERT_SHA256, 2.5.2) against a fake router
 * over real HTTPS (a certificate made for the test with openssl, in a temp directory): the right
 * pin logs in and reads; another certificate is refused before anything (the password included)
 * is sent, and is never mistaken for a refused login.
 */

import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RuijieClient, RuijieError } from '../../src/ruijieClient/index.js';

vi.mock('../../src/utils/logger.js');

let server: Server;
let base = '';
let fingerprint = '';
const seen: string[] = [];

beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pin-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/O=Internet Widgits Pty Ltd', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
    const key = readFileSync(join(dir, 'k.pem'));
    const cert = readFileSync(join(dir, 'c.pem'));
    rmSync(dir, { recursive: true, force: true });
    fingerprint = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
    server = createServer({ key, cert }, (req, res) => {
        seen.push(req.url ?? '');
        res.setHeader('content-type', 'application/json');
        if (req.url === '/cgi-bin/luci/api/auth') {
            res.setHeader('set-cookie', 'SN1=c; path=/');
            res.end(JSON.stringify({ code: 0, data: { sid: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', sn: 'SN1' } }));
        } else {
            res.end(JSON.stringify({ code: 0, data: { model: 'EG105G-V3' } }));
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('RuijieClient with a pinned certificate', () => {
    it('logs in and reads when the router shows the pinned certificate', async () => {
        seen.length = 0;
        const c = new RuijieClient({ baseUrl: base, password: 'x', certSha256: fingerprint, strictSsl: true });
        expect(await c.status('sysinfo')).toEqual({ model: 'EG105G-V3' });
        expect(seen).toEqual(['/cgi-bin/luci/api/auth', '/cgi-bin/luci/api/cmd?auth=a1b2c3d4e5f60718293a4b5c6d7e8f90']);
    });

    it('sends nothing, not even the login, to a router with another certificate, and says why', async () => {
        seen.length = 0;
        const c = new RuijieClient({ baseUrl: base, password: 'x', certSha256: 'ab'.repeat(32) });
        const error = await c.status('sysinfo').then(() => undefined, (e: unknown) => e);
        expect(error).toBeInstanceOf(RuijieError);
        expect(error).toMatchObject({ kind: 'unreachable', notSent: true, message: "The Ruijie router's certificate doesn't match RUIJIE_CERT_SHA256; nothing was sent to it" });
        expect(seen).toEqual([]);
        // not a refused login: the client stays on and tries again next time
        await expect(c.status('sysinfo')).rejects.toMatchObject({ kind: 'unreachable' });
    });

    it('refuses a pin with a plain http address, and carries the switches', () => {
        expect(() => new RuijieClient({ baseUrl: 'http://192.0.2.1', password: 'x', certSha256: 'ab'.repeat(32) })).toThrow('needs an https://');
        expect(new RuijieClient({ baseUrl: base, password: 'x' })).toMatchObject({ readOnly: false, firmwareUpgrade: true });
        expect(new RuijieClient({ baseUrl: base, password: 'x', readOnly: true, firmwareUpgrade: false })).toMatchObject({ readOnly: true, firmwareUpgrade: false });
    });
});
