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
import { fetch as undiciFetch } from 'undici';
import { RequestHandler } from '../../src/omadaClient/request.js';
import { AuthManager } from '../../src/omadaClient/auth.js';
import { createTlsDispatcher } from '../../src/utils/tlsDispatcher.js';
import { generateClientId } from '../../src/server/eventSubscription.js';

// Partial-mock undici: real Agent (createTlsDispatcher needs it), mocked fetch —
// dispatcher-carrying requests must route here (THE PAIRING RULE, see below).
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});

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
    vi.mocked(undiciFetch).mockReset();
    delete process.env[ENV_KEY];
  });

  it('Omada request with strictSsl=false never mutates global NODE_TLS_REJECT_UNAUTHORIZED', async () => {
    let envDuringFetch: string | undefined = 'SENTINEL';
    let dispatcherDuringFetch: unknown;

    // Dispatcher requests route through UNDICI's fetch (pairing rule) — mock it.
    vi.mocked(undiciFetch).mockImplementation((async (_url: unknown, init: unknown) => {
      envDuringFetch = process.env[ENV_KEY];
      dispatcherDuringFetch = (init as { dispatcher?: unknown }).dispatcher;
      return jsonResponse({ errorCode: 0, result: {} });
    }) as unknown as typeof undiciFetch);
    const globalFetchSpy = vi.fn();
    global.fetch = globalFetchSpy as unknown as typeof fetch;

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
    // THE PAIRING RULE (v1.5.5 incident regression): a dispatcher built from
    // the npm undici package must go to undici's OWN fetch — never Node's
    // built-in fetch, whose bundled undici drifts across majors (Node 26:
    // "invalid onError method" -> "fetch failed" crash-loop).
    expect(globalFetchSpy).not.toHaveBeenCalled();
  });

  it('Omada request with strictSsl=true sends no insecure dispatcher (built-in fetch)', async () => {
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
    // No dispatcher -> Node's built-in fetch, undici's stays untouched.
    expect(vi.mocked(undiciFetch)).not.toHaveBeenCalled();
  });

  it('Omada auth with strictSsl=false never mutates global NODE_TLS_REJECT_UNAUTHORIZED', async () => {
    let envDuringFetch: string | undefined = 'SENTINEL';
    let dispatcherDuringFetch: unknown;

    vi.mocked(undiciFetch).mockImplementation((async (_url: unknown, init: unknown) => {
      envDuringFetch = process.env[ENV_KEY];
      dispatcherDuringFetch = (init as { dispatcher?: unknown }).dispatcher;
      return jsonResponse({
        errorCode: 0,
        result: { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 },
      });
    }) as unknown as typeof undiciFetch);
    const globalFetchSpy = vi.fn();
    global.fetch = globalFetchSpy as unknown as typeof fetch;

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
    expect(globalFetchSpy).not.toHaveBeenCalled();
  });

  it('plain-http base with strictSsl=false carries NO dispatcher (v1.5.5 NAS config)', async () => {
    // The exact production config that crash-looped v1.5.5: http HA +
    // HA_STRICT_SSL=false. TLS relaxation is meaningless without TLS, so no
    // dispatcher is built at all -> built-in fetch -> immune to undici drift.
    expect(createTlsDispatcher(false, 'http://192.168.0.19:8123')).toBeUndefined();
    expect(createTlsDispatcher(false, 'HTTP://UPPER.example')).toBeUndefined();
    // https targets still get the relaxing dispatcher.
    expect(createTlsDispatcher(false, 'https://omada.example')).toBeDefined();
    // And with no baseUrl hint, behavior is unchanged (dispatcher created).
    expect(createTlsDispatcher(false)).toBeDefined();
    expect(createTlsDispatcher(true, 'https://omada.example')).toBeUndefined();
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
