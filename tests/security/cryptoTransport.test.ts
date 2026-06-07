/**
 * SEC-CRYPTO — Cryptographic / transport-security findings.
 *
 * OWASP API8:2023 Security Misconfiguration / A02:2021 Cryptographic Failures.
 *
 * H2  Per-client TLS scoping. The Omada and HA clients must NOT toggle the
 *     process-global `NODE_TLS_REJECT_UNAUTHORIZED` env var to talk to a
 *     self-signed controller — that disables certificate validation for EVERY
 *     concurrent outbound request in the process (a TOCTOU race that silently
 *     drops TLS verification for unrelated HA/AI traffic). The insecure mode
 *     must be scoped to the single client via a per-instance undici dispatcher.
 *
 * L5  SSE client IDs must be generated with a CSPRNG (randomUUID), not
 *     Math.random(), so they are not predictable/guessable.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { RequestHandler } from '../../src/omadaClient/request.js';
import { AuthManager } from '../../src/omadaClient/auth.js';
import { generateClientId } from '../../src/server/eventSubscription.js';

const ENV_KEY = 'NODE_TLS_REJECT_UNAUTHORIZED';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SEC-CRYPTO H2: per-client TLS scoping (no global env mutation)', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
    delete process.env[ENV_KEY];
  });

  it('Omada request with strictSsl=false never mutates global NODE_TLS_REJECT_UNAUTHORIZED', async () => {
    let envDuringFetch: string | undefined = 'SENTINEL';
    let dispatcherDuringFetch: unknown;

    global.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      envDuringFetch = process.env[ENV_KEY];
      dispatcherDuringFetch = (init as { dispatcher?: unknown }).dispatcher;
      return jsonResponse({ errorCode: 0, result: {} });
    }) as unknown as typeof fetch;

    const auth = {
      getAccessToken: async () => 'access-token',
      clearToken: () => {},
    } as unknown as AuthManager;

    const handler = new RequestHandler(
      { baseUrl: 'https://omada.example:8043', strictSsl: false },
      auth
    );

    await handler.get('/openapi/v1/anything');

    // The env var must NOT be set at any point — it stays undefined throughout.
    expect(envDuringFetch).toBeUndefined();
    expect(process.env[ENV_KEY]).toBeUndefined();
    // Insecure TLS must be carried by a per-call dispatcher instead.
    expect(dispatcherDuringFetch).toBeDefined();
  });

  it('Omada request with strictSsl=true sends no insecure dispatcher', async () => {
    let dispatcherDuringFetch: unknown = 'SENTINEL';

    global.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      dispatcherDuringFetch = (init as { dispatcher?: unknown }).dispatcher;
      return jsonResponse({ errorCode: 0, result: {} });
    }) as unknown as typeof fetch;

    const auth = {
      getAccessToken: async () => 'access-token',
      clearToken: () => {},
    } as unknown as AuthManager;

    const handler = new RequestHandler(
      { baseUrl: 'https://omada.example:8043', strictSsl: true },
      auth
    );

    await handler.get('/openapi/v1/anything');

    expect(dispatcherDuringFetch).toBeUndefined();
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it('Omada auth with strictSsl=false never mutates global NODE_TLS_REJECT_UNAUTHORIZED', async () => {
    let envDuringFetch: string | undefined = 'SENTINEL';
    let dispatcherDuringFetch: unknown;

    global.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      envDuringFetch = process.env[ENV_KEY];
      dispatcherDuringFetch = (init as { dispatcher?: unknown }).dispatcher;
      return jsonResponse({
        errorCode: 0,
        result: { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 },
      });
    }) as unknown as typeof fetch;

    const auth = new AuthManager({
      baseUrl: 'https://omada.example:8043',
      clientId: 'id',
      clientSecret: 'secret',
      omadacId: 'omadac',
      strictSsl: false,
    });

    const token = await auth.getAccessToken();

    expect(token).toBe('a');
    expect(envDuringFetch).toBeUndefined();
    expect(process.env[ENV_KEY]).toBeUndefined();
    expect(dispatcherDuringFetch).toBeDefined();
  });
});

describe('SEC-CRYPTO L5: SSE client IDs use a CSPRNG', () => {
  it('generateClientId returns an unpredictable UUID, not a Math.random/timestamp string', () => {
    const id = generateClientId();
    // RFC 4122 v4 UUID shape.
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('generateClientId returns distinct values across calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateClientId()));
    expect(ids.size).toBe(100);
  });
});
