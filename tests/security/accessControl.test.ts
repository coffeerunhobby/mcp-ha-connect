/**
 * SEC-AC — Access Control / Authorization
 * OWASP A01:2021 (Broken Access Control), API1/API5:2023 (BOLA/BFLA)
 *
 * Findings covered:
 *   H1 — REST /api/* routes bypass RBAC (authenticated but no permission check).
 *
 * These tests assert the SECURE behavior: every REST route is gated on the same
 * Permission.* bit as its MCP-tool twin, and a token lacking that bit is rejected
 * with 403 BEFORE any Home Assistant call is made.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HaClient } from '../../src/haClient/index.js';
import { Permission } from '../../src/permissions/index.js';
import { requiredRestPermission, handleRestApi } from '../../src/server/http.js';
import { handleEventSubscription, getClientCount } from '../../src/server/eventSubscription.js';
import type { EventSubscriber } from '../../src/haClient/events.js';
import type { AuthenticatedRequest } from '../../src/server/auth.js';

/** Build a mock request carrying a permission mask in auth.extra. */
function mockReq(
  method: string,
  url: string,
  permissions: number,
  body?: unknown
): AuthenticatedRequest {
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
  const req = {
    method,
    url,
    headers: { host: 'mcp.test:3000' },
    auth: { token: 't', clientId: 'u', scopes: [], extra: { permissions } },
    on(event: string, cb: (arg?: unknown) => void) {
      (listeners[event] ??= []).push(cb);
      // Drive the body stream synchronously on the next tick for POST parseBody().
      if (event === 'end') {
        queueMicrotask(() => {
          if (body !== undefined) {
            for (const d of listeners['data'] ?? []) d(Buffer.from(JSON.stringify(body)));
          }
          for (const e of listeners['end'] ?? []) e();
        });
      }
      return req;
    },
  } as unknown as AuthenticatedRequest;
  return req;
}

/** Capture status code and JSON body written to the response. */
function mockRes(): ServerResponse & { _status?: number; _body?: unknown } {
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
  } as unknown as ServerResponse & { _status?: number; _body?: unknown };
  // mirror statusCode into _status when sendJson sets it
  Object.defineProperty(res, '_status', {
    get() {
      return res.statusCode;
    },
    configurable: true,
  });
  return res;
}

describe('SEC-AC — Access Control', () => {
  describe('H1: REST route → permission mapping (mirrors MCP-tool twins)', () => {
    it('maps read routes to QUERY', () => {
      expect(requiredRestPermission('GET', '/api/states')).toBe(Permission.QUERY);
      expect(requiredRestPermission('GET', '/api/states/light.kitchen')).toBe(Permission.QUERY);
      expect(requiredRestPermission('GET', '/api/sensors')).toBe(Permission.QUERY);
      expect(requiredRestPermission('GET', '/api/entities/light')).toBe(Permission.QUERY);
      expect(requiredRestPermission('GET', '/api/search')).toBe(Permission.QUERY);
      expect(requiredRestPermission('GET', '/api/history/sensor.temp')).toBe(Permission.QUERY);
      expect(requiredRestPermission('GET', '/api/version')).toBe(Permission.QUERY);
    });

    it('maps the service-call route to CONTROL', () => {
      expect(requiredRestPermission('POST', '/api/services/light/turn_on')).toBe(Permission.CONTROL);
    });

    it('returns null for unknown routes (fall through to 404, no auth needed)', () => {
      expect(requiredRestPermission('GET', '/api/unknown')).toBeNull();
      expect(requiredRestPermission('DELETE', '/api/states')).toBeNull();
    });
  });

  describe('H1: enforcement — insufficient permission is rejected with 403', () => {
    it('blocks GET /api/states without QUERY and never calls the client', async () => {
      const client = { getStates: vi.fn().mockResolvedValue([]) } as unknown as HaClient;
      const req = mockReq('GET', '/api/states', Permission.CONTROL); // CONTROL, not QUERY
      const res = mockRes();

      await handleRestApi(req, res, '/api/states', client);

      expect(res.statusCode).toBe(403);
      expect(client.getStates).not.toHaveBeenCalled();
    });

    it('blocks POST /api/services without CONTROL and never calls the service', async () => {
      const client = { callService: vi.fn().mockResolvedValue({ ok: true }) } as unknown as HaClient;
      const req = mockReq('POST', '/api/services/light/turn_on', Permission.QUERY, {
        entity_id: 'light.kitchen',
      });
      const res = mockRes();

      await handleRestApi(req, res, '/api/services/light/turn_on', client);

      expect(res.statusCode).toBe(403);
      expect(client.callService).not.toHaveBeenCalled();
    });
  });

  describe('H1: enforcement — sufficient permission is allowed', () => {
    it('allows GET /api/states with QUERY', async () => {
      const client = { getStates: vi.fn().mockResolvedValue([{ entity_id: 'light.x' }]) } as unknown as HaClient;
      const req = mockReq('GET', '/api/states', Permission.QUERY);
      const res = mockRes();

      await handleRestApi(req, res, '/api/states', client);

      expect(res.statusCode).toBe(200);
      expect(client.getStates).toHaveBeenCalledOnce();
    });

    it('allows POST /api/services with CONTROL', async () => {
      const client = { callService: vi.fn().mockResolvedValue({ ok: true }) } as unknown as HaClient;
      const req = mockReq('POST', '/api/services/light/turn_on', Permission.CONTROL, {
        entity_id: 'light.kitchen',
      });
      const res = mockRes();

      await handleRestApi(req, res, '/api/services/light/turn_on', client);

      expect(res.statusCode).toBe(200);
      expect(client.callService).toHaveBeenCalledOnce();
    });

    it('treats SUPERUSER (0xFF) as allowed everywhere', async () => {
      const client = { getStates: vi.fn().mockResolvedValue([]) } as unknown as HaClient;
      const req = mockReq('GET', '/api/states', 0xff);
      const res = mockRes();

      await handleRestApi(req, res, '/api/states', client);

      expect(res.statusCode).toBe(200);
    });
  });

  describe('L2: SSE /subscribe_events requires QUERY permission', () => {
    /** Minimal SSE-capable response mock. */
    function sseRes() {
      return {
        writableEnded: false,
        writeHead: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      } as unknown as ServerResponse & { writeHead: ReturnType<typeof vi.fn> };
    }

    /** Request mock that captures the 'close' handler so we can tear down timers. */
    function sseReq(permissions: number) {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      const req = {
        url: '/subscribe_events',
        headers: {},
        auth: { token: 't', clientId: 'u', scopes: [], extra: { permissions } },
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = cb;
          return req;
        },
      } as unknown as AuthenticatedRequest;
      return { req, handlers };
    }

    it('rejects a subscriber lacking QUERY with 403 and creates no client', async () => {
      const before = getClientCount();
      const { req } = sseReq(Permission.CONTROL); // CONTROL, not QUERY
      const res = sseRes();
      const subscriber = { isConnected: vi.fn() } as unknown as EventSubscriber;

      await handleEventSubscription(req, res, subscriber);

      expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
      expect(getClientCount()).toBe(before); // no leak
      expect(subscriber.isConnected).not.toHaveBeenCalled();
    });

    it('allows a subscriber with QUERY to open the stream', async () => {
      const { req, handlers } = sseReq(Permission.QUERY);
      const res = sseRes();
      const subscriber = {
        isConnected: vi.fn().mockReturnValue(true),
        subscribeEventType: vi.fn().mockResolvedValue('sub-1'),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
      } as unknown as EventSubscriber;

      await handleEventSubscription(req, res, subscriber);

      // 200 stream opened, not 403
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/event-stream',
      }));
      expect(subscriber.subscribeEventType).toHaveBeenCalled();

      // tear down the keep-alive interval the handler registered
      handlers['close']?.();
    });
  });
});
