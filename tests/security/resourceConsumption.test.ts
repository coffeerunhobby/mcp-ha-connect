/**
 * SEC-DOS — Unrestricted Resource Consumption
 * OWASP A04 (Rate Limiting) / API4:2023 (Unrestricted Resource Consumption).
 *
 * Findings covered:
 *   M4 — the rate limiter keyed on the spoofable X-Forwarded-For / X-Real-IP
 *        headers, letting an attacker forge a new IP per request to evade limits
 *        AND grow the bucket Map without bound. Secure behavior: trust forwarding
 *        headers ONLY when the immediate peer is a configured trusted proxy;
 *        otherwise key on the socket address.
 *   M5 — request bodies had no size cap and the server set no slowloris timeouts.
 *        Secure behavior: parseBody rejects oversize bodies (413) and destroys the
 *        socket; the server is created with explicit request/headers/keep-alive
 *        timeouts.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { RateLimiter } from '../../src/server/rateLimiter.js';
import { parseBody, MAX_BODY_BYTES } from '../../src/server/http.js';

/** Build a fake request with controllable headers and socket address. */
function fakeReq(opts: {
  url?: string;
  remoteAddress?: string;
  headers?: Record<string, string | string[] | undefined>;
}): IncomingMessage {
  return {
    url: opts.url ?? '/mcp',
    method: 'POST',
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.remoteAddress ?? '203.0.113.7' },
  } as unknown as IncomingMessage;
}

describe('SEC-DOS — Unrestricted Resource Consumption', () => {
  describe('M4: rate limiter ignores spoofable forwarding headers by default', () => {
    it('keys on the socket address, not a forged X-Forwarded-For', () => {
      const rl = new RateLimiter({ maxRequests: 2, windowMs: 60000 });

      // Same socket, attacker rotates X-Forwarded-For each request to dodge limits.
      const mk = (xff: string) =>
        fakeReq({ remoteAddress: '198.51.100.5', headers: { 'x-forwarded-for': xff } });

      expect(rl.check(mk('1.1.1.1')).allowed).toBe(true);
      expect(rl.check(mk('2.2.2.2')).allowed).toBe(true);
      // Third request from the same socket must be blocked despite a fresh XFF.
      expect(rl.check(mk('3.3.3.3')).allowed).toBe(false);

      rl.stop();
    });

    it('does not create unbounded buckets from forged headers', () => {
      const rl = new RateLimiter({ maxRequests: 1000, windowMs: 60000 });
      for (let i = 0; i < 50; i++) {
        rl.check(fakeReq({ remoteAddress: '198.51.100.9', headers: { 'x-forwarded-for': `10.0.0.${i}` } }));
      }
      // All 50 requests shared ONE socket → exactly one bucket, not 50.
      expect(rl.getStats().totalEntries).toBe(1);
      rl.stop();
    });

    it('honors CF-Connecting-IP only when the peer is a trusted proxy', () => {
      const rl = new RateLimiter({
        maxRequests: 100,
        windowMs: 60000,
        trustedProxies: ['198.51.100.1'],
      });

      // Peer IS the trusted proxy → distinct client IPs get distinct buckets.
      rl.check(fakeReq({ remoteAddress: '198.51.100.1', headers: { 'cf-connecting-ip': 'a.a.a.a' } }));
      rl.check(fakeReq({ remoteAddress: '198.51.100.1', headers: { 'cf-connecting-ip': 'b.b.b.b' } }));
      expect(rl.getStats().totalEntries).toBe(2);

      rl.stop();
    });

    it('ignores forwarding headers when the peer is NOT trusted', () => {
      const rl = new RateLimiter({
        maxRequests: 100,
        windowMs: 60000,
        trustedProxies: ['198.51.100.1'],
      });

      // Peer is some random host claiming to be a proxy → headers ignored, one bucket.
      rl.check(fakeReq({ remoteAddress: '203.0.113.50', headers: { 'cf-connecting-ip': 'a.a.a.a' } }));
      rl.check(fakeReq({ remoteAddress: '203.0.113.50', headers: { 'cf-connecting-ip': 'b.b.b.b' } }));
      expect(rl.getStats().totalEntries).toBe(1);

      rl.stop();
    });
  });

  describe('M5: request body size cap', () => {
    /** Minimal EventEmitter-like request that streams the given chunks. */
    function streamingReq(chunks: Buffer[]): IncomingMessage & { destroy: ReturnType<typeof vi.fn> } {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
      const req = {
        destroy: vi.fn(),
        on(event: string, cb: (arg?: unknown) => void) {
          (handlers[event] ??= []).push(cb);
          if (event === 'end') {
            queueMicrotask(() => {
              for (const chunk of chunks) {
                for (const d of handlers['data'] ?? []) d(chunk);
              }
              for (const e of handlers['end'] ?? []) e();
            });
          }
          return req;
        },
      } as unknown as IncomingMessage & { destroy: ReturnType<typeof vi.fn> };
      return req;
    }

    it('exposes a sane default body cap (1 MB)', () => {
      expect(MAX_BODY_BYTES).toBe(1024 * 1024);
    });

    it('parses a small JSON body normally', async () => {
      const req = streamingReq([Buffer.from(JSON.stringify({ hello: 'world' }))]);
      await expect(parseBody(req)).resolves.toEqual({ hello: 'world' });
    });

    it('rejects an oversize body with a 413 error and destroys the socket', async () => {
      const big = Buffer.alloc(2048, 0x61); // 2 KB
      const req = streamingReq([big]);

      await expect(parseBody(req, 1024)).rejects.toMatchObject({ statusCode: 413 });
      expect(req.destroy).toHaveBeenCalled();
    });

    it('rejects a malformed JSON body with a client-side 400, not a 500', async () => {
      // A body the client mis-escaped (e.g. bash-style `\"` from a Windows shell)
      // arrives as invalid JSON. It is the client's fault, so parseBody tags it 400
      // and the request handler surfaces "400 Bad Request" instead of a generic 500.
      const req = streamingReq([Buffer.from('{\\"jsonrpc\\":\\"2.0\\"}')]);

      await expect(parseBody(req)).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
