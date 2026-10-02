/**
 * Regression: tools/list over the REAL HTTP path is filtered by the caller's token.
 *
 * Drives the production pieces end to end — bearer auth middleware (real HS256
 * JWTs) -> parseBody -> handleStreamRequest -> per-request McpServer — so that
 * removing the request-to-createServer permission forwarding in stream.ts fails
 * here, not just the createServer-level unit tests.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAuthMiddleware } from '../../src/server/auth.js';
import { parseBody } from '../../src/server/http.js';
import { handleStreamRequest } from '../../src/server/stream.js';
import { createJwt } from '../../src/utils/jwt.js';
import { parsePermissionsConfig } from '../../src/permissions/index.js';
import type { EnvironmentConfig } from '../../src/config.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SECRET = 'test-secret-for-tool-visibility-0123456789';
const permissions = parsePermissionsConfig(
  JSON.stringify({
    users: [
      { sub: 'admin', role: 'admin' },
      { sub: 'operator', role: 'operator' },
      { sub: 'reader', role: 'readonly' },
    ],
    defaultRole: 'NONE',
  })
);

// Only the fields the stream path reads; HA client is a registration-only stub.
const config = { stateful: false, httpAllowedHosts: [] } as unknown as EnvironmentConfig;
const options = { haClient: {} as never, config };

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const auth = createAuthMiddleware({ method: 'bearer', secret: SECRET, permissions });
  server = createHttpServer(async (req, res) => {
    if (!auth(req, res)) return;
    const body = await parseBody(req);
    await handleStreamRequest(options, req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function listTools(sub: string): Promise<string[]> {
  const token = createJwt({ sub, exp: Math.floor(Date.now() / 1000) + 300 }, SECRET);
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const json = text.includes('data:')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))!.slice(5))
    : JSON.parse(text);
  return (json.result.tools as { name: string }[]).map((t) => t.name);
}

describe('tools/list over HTTP is filtered by the bearer token', () => {
  it('admin sees admin and control tools', async () => {
    const tools = await listTools('admin');
    expect(tools).toContain('restartHomeAssistant');
    expect(tools).toContain('controlLight');
  });

  it('a READONLY token is not offered control or admin tools', async () => {
    const tools = await listTools('reader');
    expect(tools).toContain('getState');
    expect(tools).not.toContain('controlLight');
    expect(tools).not.toContain('restartHomeAssistant');
    expect(tools).not.toContain('deleteAutomation');
  });

  it('an unmapped sub (defaultRole NONE) is offered no permission-gated tools', async () => {
    const tools = await listTools('nobody');
    expect(tools).not.toContain('getState');
    expect(tools).not.toContain('controlLight');
  });

  it('interleaved callers each get their own filtered list (no shared server instance)', async () => {
    const [reader1, admin, reader2, operator] = await Promise.all([
      listTools('reader'),
      listTools('admin'),
      listTools('reader'),
      listTools('operator'),
    ]);
    expect(reader1).toEqual(reader2);
    expect(reader1).not.toContain('controlLight');
    expect(admin).toContain('restartHomeAssistant');
    expect(operator).toContain('controlLight');
    expect(operator).not.toContain('restartHomeAssistant');
  });
});
