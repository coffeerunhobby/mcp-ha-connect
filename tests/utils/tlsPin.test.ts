/**
 * Certificate pinning (2.5.2): a dispatcher that trusts exactly one certificate by its SHA-256
 * fingerprint, against a real local HTTPS server with a self-signed certificate made for the
 * test (openssl, in a temp directory; no key is kept). Another certificate ends the connection
 * before the request is sent.
 */

import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPinnedDispatcher, normalizeFingerprint, PIN_MISMATCH, tlsAwareFetch } from '../../src/utils/tlsDispatcher.js';

let server: Server;
let base = '';
let fingerprint = '';
let requests = 0;

beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pin-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/O=pin test', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
    const key = readFileSync(join(dir, 'k.pem'));
    const cert = readFileSync(join(dir, 'c.pem'));
    rmSync(dir, { recursive: true, force: true });
    fingerprint = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
    server = createServer({ key, cert }, (_req, res) => {
        requests++;
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('certificate pinning', () => {
    it('reads a fingerprint with or without colons, in any case, and nothing else', () => {
        const hex = 'ab'.repeat(32);
        expect(normalizeFingerprint(hex)).toBe(hex);
        expect(normalizeFingerprint(hex.toUpperCase().match(/../g)!.join(':'))).toBe(hex);
        expect(normalizeFingerprint(` ${hex} `)).toBe(hex);
        expect(normalizeFingerprint('ab'.repeat(31))).toBeUndefined();
        expect(normalizeFingerprint('zz'.repeat(32))).toBeUndefined();
        expect(() => createPinnedDispatcher('nope')).toThrow('64 hex digits');
    });

    it('talks to the server whose certificate matches the pin, self-signed or not', async () => {
        const before = requests;
        const res = await tlsAwareFetch(`${base}/`, { dispatcher: createPinnedDispatcher(fingerprint.toUpperCase().match(/../g)!.join(':')) });
        expect(await res.json()).toEqual({ ok: true });
        expect(requests).toBe(before + 1);
    });

    it('ends the connection before sending anything when the certificate differs, every time', async () => {
        const before = requests;
        const wrong = createPinnedDispatcher('00'.repeat(32));
        for (let i = 0; i < 2; i++) {
            const error = await tlsAwareFetch(`${base}/`, { dispatcher: wrong, method: 'POST', body: 'secret' }).then(
                () => undefined,
                (e: unknown) => e
            );
            expect((error as Error & { cause?: { code?: string } }).cause?.code).toBe(PIN_MISMATCH);
        }
        expect(requests).toBe(before);
    });
});
