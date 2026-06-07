/**
 * SEC-LOG — Logging & Information Disclosure
 * OWASP A09:2021 (Security Logging and Monitoring Failures) / sensitive data exposure.
 *
 * Findings covered:
 *   M6 — error responses leak the raw internal `error.message` to clients
 *        (may contain internal hostnames, file paths, tokens, stack detail).
 *   M7 — the unauthenticated `/health` endpoint discloses version, auth method,
 *        and internal AI provider URLs.
 *
 * These tests assert the SECURE behavior: clients receive a generic error message
 * (the detail is logged server-side only), and `/health` returns liveness only.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HaClient } from '../../src/haClient/index.js';
import { sanitizeError } from '../../src/utils/sanitizeError.js';
import { handleRestApi, handleHealthCheck } from '../../src/server/http.js';
import type { AuthenticatedRequest } from '../../src/server/auth.js';

/** An error whose message embeds infrastructure detail we must never echo. */
const LEAKY = new Error('connect ECONNREFUSED 10.0.0.19:8123 (/volume1/docker/secret)');

/** Build a mock request carrying a full permission mask. */
function mockReq(method: string, url: string): AuthenticatedRequest {
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
  const req = {
    method,
    url,
    headers: { host: 'mcp.test:3000' },
    auth: { token: 't', clientId: 'u', scopes: [], extra: { permissions: 0xff } },
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ??= []).push(cb);
      if (event === 'end') {
        queueMicrotask(() => {
          for (const e of listeners['end'] ?? []) e();
        });
      }
      return req;
    },
  } as unknown as AuthenticatedRequest;
  return req;
}

/** Capture status code and JSON body written to the response. */
function mockRes(): ServerResponse & { _body?: unknown } {
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn(),
    end: vi.fn(function (this: { _body?: unknown }, payload?: unknown) {
      if (typeof payload === 'string') {
        try {
          this._body = JSON.parse(payload);
        } catch {
          this._body = payload;
        }
      }
      return this;
    }),
  } as unknown as ServerResponse & { _body?: unknown };
  return res;
}

describe('SEC-LOG — Logging & Information Disclosure', () => {
  describe('M6: sanitizeError never echoes internal detail', () => {
    it('returns a non-empty generic string', () => {
      const out = sanitizeError(LEAKY);
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
    });

    it('strips internal hostnames, ports and file paths from Error messages', () => {
      const out = sanitizeError(LEAKY);
      expect(out).not.toContain('10.0.0.19');
      expect(out).not.toContain('8123');
      expect(out).not.toContain('/volume1');
      expect(out).not.toContain('ECONNREFUSED');
    });

    it('does not echo raw non-Error values', () => {
      const out = sanitizeError('raw secret /volume1/docker/.env token=abc123');
      expect(out).not.toContain('/volume1');
      expect(out).not.toContain('abc123');
    });

    it('supports a caller-supplied generic fallback', () => {
      expect(sanitizeError(LEAKY, 'Upstream request failed')).toBe('Upstream request failed');
    });
  });

  describe('M6: handleRestApi 500 path returns a generic message', () => {
    it('does not leak the upstream error detail to the client', async () => {
      const client = { getStates: vi.fn().mockRejectedValue(LEAKY) } as unknown as HaClient;
      const req = mockReq('GET', '/api/states');
      const res = mockRes();

      await handleRestApi(req, res, '/api/states', client);

      expect(res.statusCode).toBe(500);
      const body = JSON.stringify(res._body);
      expect(body).not.toContain('10.0.0.19');
      expect(body).not.toContain('/volume1');
      expect(body).not.toContain('ECONNREFUSED');
    });
  });

  describe('M7: /health discloses liveness only', () => {
    it('returns status only — no version, auth method, or internal AI URLs', () => {
      const res = mockRes();

      handleHealthCheck(res);

      const body = res._body as Record<string, unknown>;
      expect(body).toEqual({ status: 'healthy' });

      // Defense in depth: the serialized body carries none of the old internals.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('version');
      expect(serialized).not.toContain('authMethod');
      expect(serialized).not.toContain('aiUrl');
      expect(serialized).not.toContain('aiProvider');
      expect(body).not.toHaveProperty('rateLimitEnabled');
      expect(body).not.toHaveProperty('eventsConnectedClients');
    });
  });
});

// Avoid unused-type lint on the IncomingMessage import in some configs.
export type _LogTestReq = IncomingMessage;
