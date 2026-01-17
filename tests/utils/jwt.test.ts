/**
 * JWT utility tests
 */

import { describe, it, expect } from 'vitest';
import { createJwt, verifyJwt } from '../../src/utils/jwt.js';

const SECRET = 'test-secret-key-32chars-minimum!';

describe('JWT', () => {
  describe('createJwt', () => {
    it('should create valid JWT with payload', () => {
      const token = createJwt({ sub: 'user1', role: 'admin' }, SECRET);

      expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      const parts = token.split('.');
      expect(parts).toHaveLength(3);
    });

    it('should create JWT that can be verified', () => {
      const payload = { sub: 'user1', custom: 'data' };
      const token = createJwt(payload, SECRET);
      const result = verifyJwt(token, SECRET);

      expect(result.valid).toBe(true);
      expect(result.payload?.sub).toBe('user1');
      expect(result.payload?.custom).toBe('data');
    });
  });

  describe('verifyJwt', () => {
    it('should verify valid token', () => {
      const token = createJwt({ sub: 'test' }, SECRET);
      const result = verifyJwt(token, SECRET);

      expect(result.valid).toBe(true);
      expect(result.payload?.sub).toBe('test');
      expect(result.error).toBeUndefined();
    });

    it('should reject token with wrong secret', () => {
      const token = createJwt({ sub: 'test' }, SECRET);
      const result = verifyJwt(token, 'wrong-secret');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('bad signature');
    });

    it('should reject malformed token', () => {
      expect(verifyJwt('not.a.valid.token', SECRET)).toEqual({
        valid: false,
        error: 'bad format',
      });

      expect(verifyJwt('onlyonepart', SECRET)).toEqual({
        valid: false,
        error: 'bad format',
      });

      expect(verifyJwt('two.parts', SECRET)).toEqual({
        valid: false,
        error: 'bad format',
      });
    });

    it('should reject expired token', () => {
      const expiredPayload = { sub: 'test', exp: Math.floor(Date.now() / 1000) - 100 };
      const token = createJwt(expiredPayload, SECRET);
      const result = verifyJwt(token, SECRET);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('expired');
    });

    it('should accept token without exp', () => {
      const token = createJwt({ sub: 'service' }, SECRET);
      const result = verifyJwt(token, SECRET);

      expect(result.valid).toBe(true);
    });

    it('should accept token with future exp', () => {
      const futurePayload = { sub: 'test', exp: Math.floor(Date.now() / 1000) + 3600 };
      const token = createJwt(futurePayload, SECRET);
      const result = verifyJwt(token, SECRET);

      expect(result.valid).toBe(true);
    });

    it('should handle token with iat claim', () => {
      const payload = { sub: 'test', iat: Math.floor(Date.now() / 1000) };
      const token = createJwt(payload, SECRET);
      const result = verifyJwt(token, SECRET);

      expect(result.valid).toBe(true);
      expect(result.payload?.iat).toBeDefined();
    });

    it('should preserve all custom claims', () => {
      const payload = {
        sub: 'user1',
        role: 'admin',
        permissions: ['read', 'write'],
        metadata: { key: 'value' },
      };
      const token = createJwt(payload, SECRET);
      const result = verifyJwt(token, SECRET);

      expect(result.valid).toBe(true);
      expect(result.payload?.role).toBe('admin');
      expect(result.payload?.permissions).toEqual(['read', 'write']);
      expect(result.payload?.metadata).toEqual({ key: 'value' });
    });
  });
});
