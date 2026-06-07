/**
 * SEC-INJ — Injection (path / parameter)
 * OWASP A03:2021 (Injection); overlaps SEC-SSRF (A10:2021).
 *
 * Finding covered:
 *   H4 — Home Assistant API paths interpolate user input without encoding, so an
 *        entity_id / domain / service containing "/", "..", "?" or "#" could escape
 *        the intended /api/<resource> path or inject query parameters.
 *
 * Secure behavior asserted:
 *   - Call sites percent-encode each user-controlled path segment.
 *   - The request layer refuses any path that resolves outside /api/ (traversal guard).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestHandler } from '../../src/haClient/request.js';
import { StateOperations } from '../../src/haClient/states.js';
import { ServiceOperations } from '../../src/haClient/services.js';

function makeHandler() {
  return new RequestHandler({
    baseUrl: 'http://ha.test:8123',
    token: 'tok',
    timeout: 30000,
    strictSsl: true,
  });
}

/** Capture the URL string passed to fetch and return an empty JSON response. */
function stubFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => ({}),
    text: async () => '',
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('SEC-INJ — Injection (H4: HA API path)', () => {
  beforeEach(() => {
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('request-layer traversal guard', () => {
    it('rejects a path that escapes /api via ".." before making any request', async () => {
      const handler = makeHandler();
      await expect(handler.get('/states/../../secret')).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('allows a normal /api path', async () => {
      const handler = makeHandler();
      await handler.get('/states');
      expect(fetch).toHaveBeenCalledOnce();
      const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(new URL(calledUrl).pathname).toBe('/api/states');
    });
  });

  describe('call-site encoding — StateOperations.getState', () => {
    it('encodes a malicious entity_id so it cannot escape /api/states', async () => {
      const states = new StateOperations(makeHandler());
      await states.getState('x/../../admin');

      const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const { pathname } = new URL(calledUrl);
      // The whole id stays a single encoded segment under /api/states/.
      expect(pathname.startsWith('/api/states/')).toBe(true);
      expect(pathname).not.toContain('/admin');
      expect(calledUrl).toContain('%2F'); // the slashes were encoded
    });

    it('encodes "?" so it cannot inject query parameters', async () => {
      const states = new StateOperations(makeHandler());
      await states.getState('light.x?evil=1');

      const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(new URL(calledUrl).searchParams.get('evil')).toBeNull();
    });

    it('passes a normal entity_id through unchanged', async () => {
      const states = new StateOperations(makeHandler());
      await states.getState('light.kitchen');

      const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(new URL(calledUrl).pathname).toBe('/api/states/light.kitchen');
    });
  });

  describe('call-site encoding — ServiceOperations.callService', () => {
    it('encodes domain and service segments', async () => {
      const services = new ServiceOperations(makeHandler());
      await services.callService({ domain: 'light', service: 'turn_on/../../admin' });

      const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      const { pathname } = new URL(calledUrl);
      expect(pathname.startsWith('/api/services/light/')).toBe(true);
      expect(pathname).not.toContain('/admin');
    });

    it('passes a normal service call through unchanged', async () => {
      const services = new ServiceOperations(makeHandler());
      await services.callService({ domain: 'light', service: 'turn_on' });

      const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(new URL(calledUrl).pathname).toBe('/api/services/light/turn_on');
    });
  });
});
