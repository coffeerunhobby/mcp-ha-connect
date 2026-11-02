/**
 * CORS on the MCP endpoint through the real server (2.5.5), for browser MCP clients such as
 * LocalAI's chat: the SDK client sends `MCP-Protocol-Version` on every request after
 * initialize, so the preflight must allow it, and a 401 must carry the CORS headers or the
 * browser shows an opaque "NetworkError" instead of the real status.
 */

import { createServer } from 'node:net';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { startHttpServer } from '../../src/server/http.js';
import { createJwt } from '../../src/utils/jwt.js';

vi.mock('../../src/utils/logger.js');

const SECRET = 'test-secret-for-mcp-cors-0123456789abcdef';
const ALLOWED = 'http://192.168.0.8:8080';
const OTHER = 'http://evil.example';

let mcp = '';

beforeAll(async () => {
    const port = await new Promise<number>((resolve) => {
        const probe = createServer().listen(0, '127.0.0.1', () => {
            const { port: free } = probe.address() as { port: number };
            probe.close(() => resolve(free));
        });
    });
    const config = loadConfig({
        HA_PLUGIN_ENABLED: 'false',
        MCP_SERVER_USE_HTTP: 'true',
        MCP_HTTP_PORT: String(port),
        MCP_HTTP_BIND_ADDR: '127.0.0.1',
        MCP_AUTH_METHOD: 'bearer',
        MCP_AUTH_SECRET: SECRET,
        MCP_HTTP_ALLOWED_ORIGINS: `${ALLOWED},http://127.0.0.1:${port}`,
    });
    await startHttpServer({ config });
    mcp = `http://127.0.0.1:${port}/mcp`;
});

function allowedHeaders(res: Response): string[] {
    return (res.headers.get('access-control-allow-headers') ?? '').split(',').map((h) => h.trim().toLowerCase());
}

const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cors-test', version: '1' } },
});

describe('CORS on /mcp through the real server', () => {
    it('allows a preflight asking for mcp-protocol-version and last-event-id', async () => {
        const res = await fetch(mcp, {
            method: 'OPTIONS',
            headers: {
                Origin: ALLOWED,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'authorization,content-type,mcp-protocol-version,mcp-session-id,last-event-id',
            },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
        expect(res.headers.get('access-control-allow-methods')).toContain('POST');
        for (const h of ['authorization', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id']) {
            expect(allowedHeaders(res)).toContain(h);
        }
    });

    it('gives an origin that is not allowed no CORS headers', async () => {
        const res = await fetch(mcp, {
            method: 'OPTIONS',
            headers: { Origin: OTHER, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'mcp-protocol-version' },
        });
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
        expect(res.headers.get('access-control-allow-headers')).toBeNull();
    });

    it('a 401 still carries the CORS headers, so the browser sees the real status', async () => {
        const res = await fetch(mcp, {
            method: 'POST',
            headers: { Origin: ALLOWED, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: initialize,
        });
        expect(res.status).toBe(401);
        expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    });

    it('an authenticated initialize exposes the session and protocol headers to the browser', async () => {
        const token = createJwt({ sub: 'reader', exp: Math.floor(Date.now() / 1000) + 300 }, SECRET);
        const res = await fetch(mcp, {
            method: 'POST',
            headers: {
                Origin: ALLOWED,
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
            },
            body: initialize,
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
        const exposed = (res.headers.get('access-control-expose-headers') ?? '').split(',').map((h) => h.trim().toLowerCase());
        expect(exposed).toEqual(expect.arrayContaining(['mcp-session-id', 'mcp-protocol-version']));
        await res.text();
    });
});
