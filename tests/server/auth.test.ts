/**
 * JWT authentication middleware tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthMiddleware } from '../../src/server/auth.js';
import { createJwt } from '../../src/utils/jwt.js';

vi.mock('../../src/utils/logger.js');

const SECRET = 'test-secret-key-32chars-minimum!';

describe('Auth Middleware', () => {
  let mockReq: Partial<IncomingMessage>;
  let mockRes: Partial<ServerResponse>;
  let responseData: { statusCode?: number; headers: Record<string, string>; body?: string };

  beforeEach(() => {
    responseData = { headers: {} };

    mockReq = {
      url: '/api/states',
      method: 'GET',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' } as any,
    };

    mockRes = {
      statusCode: 200,
      setHeader: vi.fn((key: string, value: string) => {
        responseData.headers[key] = value;
        return mockRes as ServerResponse;
      }),
      end: vi.fn((body?: string) => {
        responseData.body = body;
        return mockRes as ServerResponse;
      }) as unknown as ServerResponse['end'],
    };

    Object.defineProperty(mockRes, 'statusCode', {
      get: () => responseData.statusCode,
      set: (val) => { responseData.statusCode = val; },
    });
  });

  describe('No Auth', () => {
    it('should allow all requests when method is none', () => {
      const middleware = createAuthMiddleware({ method: 'none' });
      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(true);
      expect(mockRes.end).not.toHaveBeenCalled();
    });
  });

  describe('Bearer Auth', () => {
    it('should allow request with valid token', () => {
      const token = createJwt({ sub: 'user1' }, SECRET);
      mockReq.headers = { authorization: `Bearer ${token}` };
      const middleware = createAuthMiddleware({ method: 'bearer', secret: SECRET });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(true);
      expect(mockRes.end).not.toHaveBeenCalled();
    });

    it('should attach AuthInfo to request with payload in extra', () => {
      const token = createJwt({ sub: 'admin', role: 'superuser' }, SECRET);
      mockReq.headers = { authorization: `Bearer ${token}` };
      const middleware = createAuthMiddleware({ method: 'bearer', secret: SECRET });

      middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      const authReq = mockReq as IncomingMessage & { auth?: { clientId?: string; extra?: { payload?: { sub?: string; role?: string } } } };
      // AuthInfo.clientId is set to JWT sub
      expect(authReq.auth?.clientId).toBe('admin');
      // JWT payload is in authInfo.extra.payload
      expect(authReq.auth?.extra?.payload?.sub).toBe('admin');
      expect(authReq.auth?.extra?.payload?.role).toBe('superuser');
    });

    it('should reject request without Authorization header', () => {
      mockReq.headers = {};
      const middleware = createAuthMiddleware({ method: 'bearer', secret: SECRET });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(false);
      expect(responseData.statusCode).toBe(401);
      expect(responseData.headers['WWW-Authenticate']).toBe('Bearer');
      expect(responseData.body).toContain('Missing Authorization header');
    });

    it('should reject request with invalid signature', () => {
      const token = createJwt({ sub: 'user1' }, 'wrong-secret');
      mockReq.headers = { authorization: `Bearer ${token}` };
      const middleware = createAuthMiddleware({ method: 'bearer', secret: SECRET });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(false);
      expect(responseData.statusCode).toBe(401);
      expect(responseData.body).toContain('bad signature');
    });

    it('should reject expired token', () => {
      const token = createJwt({ sub: 'user1', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
      mockReq.headers = { authorization: `Bearer ${token}` };
      const middleware = createAuthMiddleware({ method: 'bearer', secret: SECRET });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(false);
      expect(responseData.statusCode).toBe(401);
      expect(responseData.body).toContain('expired');
    });

    it('should reject malformed Authorization header', () => {
      mockReq.headers = { authorization: 'Basic dXNlcjpwYXNz' };
      const middleware = createAuthMiddleware({ method: 'bearer', secret: SECRET });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(false);
      expect(responseData.statusCode).toBe(401);
      expect(responseData.body).toContain('Expected: Bearer');
    });

    it('should return 500 if bearer auth enabled but no secret configured', () => {
      const token = createJwt({ sub: 'user1' }, SECRET);
      mockReq.headers = { authorization: `Bearer ${token}` };
      const middleware = createAuthMiddleware({ method: 'bearer', secret: undefined });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(false);
      expect(responseData.statusCode).toBe(500);
      expect(responseData.body).toContain('misconfiguration');
    });
  });

  describe('Skip Paths', () => {
    it('should skip auth for exact path match', () => {
      mockReq.url = '/health';
      mockReq.headers = {};
      const middleware = createAuthMiddleware({
        method: 'bearer',
        secret: SECRET,
        skipPaths: ['/health'],
      });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(true);
    });

    it('should skip auth for path prefix', () => {
      mockReq.url = '/health/detailed';
      mockReq.headers = {};
      const middleware = createAuthMiddleware({
        method: 'bearer',
        secret: SECRET,
        skipPaths: ['/health'],
      });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(true);
    });

    it('should require auth for non-skipped paths', () => {
      mockReq.url = '/api/states';
      mockReq.headers = {};
      const middleware = createAuthMiddleware({
        method: 'bearer',
        secret: SECRET,
        skipPaths: ['/health'],
      });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(false);
      expect(responseData.statusCode).toBe(401);
    });

    it('should handle query strings in URL', () => {
      mockReq.url = '/health?check=true';
      mockReq.headers = {};
      const middleware = createAuthMiddleware({
        method: 'bearer',
        secret: SECRET,
        skipPaths: ['/health'],
      });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(true);
    });
  });

  describe('Bearer Payload Claims', () => {
    it('should allow token with future exp', () => {
      const token = createJwt({ sub: 'user1', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
      mockReq.headers = { authorization: `Bearer ${token}` };
      const middleware = createAuthMiddleware({ method: 'bearer', secret: SECRET });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(true);
    });

    it('should allow token without exp (no expiration)', () => {
      const token = createJwt({ sub: 'service-account' }, SECRET);
      mockReq.headers = { authorization: `Bearer ${token}` };
      const middleware = createAuthMiddleware({ method: 'bearer', secret: SECRET });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(true);
    });
  });
});
