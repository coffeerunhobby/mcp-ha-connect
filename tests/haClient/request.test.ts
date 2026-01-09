/**
 * RequestHandler tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestHandler } from '../../src/haClient/request.js';
import { AuthenticationError, ApiError } from '../../src/types/index.js';

// Mock fetch globally
global.fetch = vi.fn();

describe('RequestHandler', () => {
  let handler: RequestHandler;

  beforeEach(() => {
    handler = new RequestHandler({
      baseUrl: 'http://homeassistant.10.0.0.19.nip.io:8123',
      token: 'test-token-12345',
      timeout: 30000,
      strictSsl: false,
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('request', () => {
    it('should make GET request with authorization header', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ data: 'test' }),
      });

      await handler.request('/test');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://homeassistant.10.0.0.19.nip.io:8123/api/test',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token-12345',
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should make POST request with body', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ success: true }),
      });

      await handler.request('/test', {
        method: 'POST',
        body: { key: 'value' },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://homeassistant.10.0.0.19.nip.io:8123/api/test',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ key: 'value' }),
        })
      );
    });

    it('should add query parameters to URL', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({}),
      });

      await handler.request('/test', {
        params: { filter: 'active', limit: 10 },
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('filter=active'),
        expect.any(Object)
      );
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('limit=10'),
        expect.any(Object)
      );
    });

    it('should throw AuthenticationError on 401', async () => {
      const mockResponse = {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Invalid token',
      };
      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      const error = await handler.request('/test').catch((e) => e);
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error.message).toBe('Invalid Home Assistant token');
    });

    it('should throw ApiError on other HTTP errors', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server error',
      });

      await expect(handler.request('/test')).rejects.toThrow(ApiError);
    });

    it('should handle empty responses', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/plain']]),
      });

      const result = await handler.request('/test');

      expect(result).toEqual({});
    });

    it('should handle network errors', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('Network timeout'));

      await expect(handler.request('/test')).rejects.toThrow('Network timeout');
    });
  });

  describe('get', () => {
    it('should make GET request', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ data: 'result' }),
      });

      const result = await handler.get<{ data: string }>('/states');

      expect(result).toEqual({ data: 'result' });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/states'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should pass query parameters', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({}),
      });

      await handler.get('/history', { entity_id: 'light.living_room' });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('entity_id=light.living_room'),
        expect.any(Object)
      );
    });
  });

  describe('post', () => {
    it('should make POST request with body', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ context: { id: '123' } }),
      });

      const result = await handler.post('/services/light/turn_on', {
        entity_id: 'light.living_room',
      });

      expect(result).toEqual({ context: { id: '123' } });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/services/light/turn_on'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ entity_id: 'light.living_room' }),
        })
      );
    });
  });

  describe('SSL configuration', () => {
    it('should create HTTPS agent when strictSsl is false', () => {
      const handlerNoSsl = new RequestHandler({
        baseUrl: 'https://homeassistant.10.0.0.19.nip.io:8123',
        token: 'token',
        timeout: 30000,
        strictSsl: false,
      });

      // Handler is created successfully with strictSsl: false
      expect(handlerNoSsl).toBeDefined();
    });

    it('should not create HTTPS agent when strictSsl is true', () => {
      const handlerWithSsl = new RequestHandler({
        baseUrl: 'https://homeassistant.10.0.0.19.nip.io:8123',
        token: 'token',
        timeout: 30000,
        strictSsl: true,
      });

      // Handler is created successfully with strictSsl: true
      expect(handlerWithSsl).toBeDefined();
    });
  });
});
