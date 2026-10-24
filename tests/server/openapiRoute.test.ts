/**
 * The real HTTP server's /openapi.json route (2.5.1): served on the LAN, a plain 404 for a
 * request Cloudflare forwarded (the public hostname must not hand out the version and tool map).
 */

import { createServer } from 'node:net';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { startHttpServer } from '../../src/server/http.js';
import { VERSION } from '../../src/version.js';

vi.mock('../../src/utils/logger.js');

let base = '';

beforeAll(async () => {
    const port = await new Promise<number>((resolve) => {
        const probe = createServer().listen(0, '127.0.0.1', () => {
            const { port: free } = probe.address() as { port: number };
            probe.close(() => resolve(free));
        });
    });
    const config = loadConfig({ HA_PLUGIN_ENABLED: 'false', MCP_SERVER_USE_HTTP: 'true', MCP_HTTP_PORT: String(port), MCP_HTTP_BIND_ADDR: '127.0.0.1', MCP_AUTH_METHOD: 'none' });
    await startHttpServer({ config });
    base = `http://127.0.0.1:${port}`;
});

describe('/openapi.json through the real server', () => {
    it('serves the spec on the LAN', async () => {
        const res = await fetch(`${base}/openapi.json`);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { info: { version: string } }).info.version).toBe(VERSION);
    });

    it('answers a request Cloudflare forwarded with a plain 404', async () => {
        for (const headers of [{ 'CF-Connecting-IP': '198.51.100.7' }, { 'CF-Ray': '8f0000000000-OTP' }]) {
            const res = await fetch(`${base}/openapi.json`, { headers });
            expect(res.status).toBe(404);
            expect(await res.json()).toEqual({ error: 'Not found' });
        }
    });
});
