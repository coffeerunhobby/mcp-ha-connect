/**
 * Authentication middleware tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthMiddleware } from '../../src/server/auth.js';

vi.mock('../../src/utils/logger.js');

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
    const validTokens = new Set(['test-token-123', 'another-token']);

    it('should allow request with valid token', () => {
      mockReq.headers = { authorization: 'Bearer test-token-123' };
      const middleware = createAuthMiddleware({ method: 'bearer', tokens: validTokens });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(true);
      expect(mockRes.end).not.toHaveBeenCalled();
    });

    it('should allow request with any valid token from set', () => {
      mockReq.headers = { authorization: 'Bearer another-token' };
      const middleware = createAuthMiddleware({ method: 'bearer', tokens: validTokens });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(true);
    });

    it('should reject request without Authorization header', () => {
      mockReq.headers = {};
      const middleware = createAuthMiddleware({ method: 'bearer', tokens: validTokens });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(false);
      expect(responseData.statusCode).toBe(401);
      expect(responseData.headers['WWW-Authenticate']).toBe('Bearer');
      expect(responseData.body).toContain('Missing Authorization header');
    });

    it('should reject request with invalid token', () => {
      mockReq.headers = { authorization: 'Bearer wrong-token' };
      const middleware = createAuthMiddleware({ method: 'bearer', tokens: validTokens });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(false);
      expect(responseData.statusCode).toBe(401);
      expect(responseData.headers['WWW-Authenticate']).toBe('Bearer error="invalid_token"');
      expect(responseData.body).toContain('Invalid token');
    });

    it('should reject request with malformed Authorization header', () => {
      mockReq.headers = { authorization: 'Basic dXNlcjpwYXNz' };
      const middleware = createAuthMiddleware({ method: 'bearer', tokens: validTokens });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(false);
      expect(responseData.statusCode).toBe(401);
      expect(responseData.body).toContain('Invalid Authorization header format');
    });

    it('should return 500 if bearer auth enabled but no tokens configured', () => {
      mockReq.headers = { authorization: 'Bearer test-token' };
      const middleware = createAuthMiddleware({ method: 'bearer', tokens: undefined });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(false);
      expect(responseData.statusCode).toBe(500);
      expect(responseData.body).toContain('auth token not set');
    });
  });

  describe('Skip Paths', () => {
    const validTokens = new Set(['secret-token']);

    it('should skip auth for exact path match', () => {
      mockReq.url = '/health';
      mockReq.headers = {}; // No auth header
      const middleware = createAuthMiddleware({
        method: 'bearer',
        tokens: validTokens,
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
        tokens: validTokens,
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
        tokens: validTokens,
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
        tokens: validTokens,
        skipPaths: ['/health'],
      });

      const result = middleware(mockReq as IncomingMessage, mockRes as ServerResponse);

      expect(result).toBe(true);
    });
  });

  describe('Multi-token Support', () => {
    it('should support multiple tokens for different clients', () => {
      const tokens = new Set(['n8n-token', 'openwebui-token', 'cli-token']);
      const middleware = createAuthMiddleware({ method: 'bearer', tokens });

      // n8n client
      mockReq.headers = { authorization: 'Bearer n8n-token' };
      expect(middleware(mockReq as IncomingMessage, mockRes as ServerResponse)).toBe(true);

      // Open WebUI client
      mockReq.headers = { authorization: 'Bearer openwebui-token' };
      expect(middleware(mockReq as IncomingMessage, mockRes as ServerResponse)).toBe(true);

      // CLI client
      mockReq.headers = { authorization: 'Bearer cli-token' };
      expect(middleware(mockReq as IncomingMessage, mockRes as ServerResponse)).toBe(true);

      // Invalid client
      mockReq.headers = { authorization: 'Bearer unknown-token' };
      expect(middleware(mockReq as IncomingMessage, mockRes as ServerResponse)).toBe(false);
    });
  });
});
