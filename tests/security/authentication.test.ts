/**
 * SEC-AUTHN — Authentication & Session
 * OWASP A07:2021 (Identification & Authentication Failures), API2:2023
 *
 * Findings covered:
 *   H3 — tokens without `exp` never expire; expiry is optional and unenforceable.
 *   M8 — JWT secret strength is not enforced at startup.
 *   L6 — no `iss` / `aud` / `nbf` / clock-skew validation.
 *
 * Secure behavior asserted here:
 *   - verifyJwt can REQUIRE exp (opt-in), validate nbf, and check iss/aud when configured.
 *   - The default (no options) stays backward-compatible: a token without exp is accepted.
 *   - loadConfig refuses a bearer secret shorter than 32 chars.
 */

import { describe, it, expect } from 'vitest';
import { createJwt, verifyJwt } from '../../src/utils/jwt.js';
import { loadConfig } from '../../src/config.js';

const SECRET = 'test-secret-key-32chars-minimum!';
const now = () => Math.floor(Date.now() / 1000);

describe('SEC-AUTHN — Authentication', () => {
  describe('H3: enforce token expiry (opt-in via requireExp)', () => {
    it('rejects a token without exp when requireExp is set', () => {
      const token = createJwt({ sub: 'service' }, SECRET);
      const result = verifyJwt(token, SECRET, { requireExp: true });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/exp/i);
    });

    it('accepts a token with a future exp when requireExp is set', () => {
      const token = createJwt({ sub: 'u', exp: now() + 3600 }, SECRET);
      expect(verifyJwt(token, SECRET, { requireExp: true }).valid).toBe(true);
    });

    it('still rejects an expired token when requireExp is set', () => {
      const token = createJwt({ sub: 'u', exp: now() - 100 }, SECRET);
      expect(verifyJwt(token, SECRET, { requireExp: true }).valid).toBe(false);
    });

    it('default (no options) remains backward-compatible: accepts no-exp token', () => {
      const token = createJwt({ sub: 'service' }, SECRET);
      expect(verifyJwt(token, SECRET).valid).toBe(true);
    });
  });

  describe('L6: nbf (not-before) validation', () => {
    it('rejects a token whose nbf is in the future', () => {
      const token = createJwt({ sub: 'u', nbf: now() + 3600 }, SECRET);
      const result = verifyJwt(token, SECRET);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/not yet valid|nbf/i);
    });

    it('accepts a token whose nbf is in the past', () => {
      const token = createJwt({ sub: 'u', nbf: now() - 100 }, SECRET);
      expect(verifyJwt(token, SECRET).valid).toBe(true);
    });

    it('tolerates small clock skew on nbf', () => {
      const token = createJwt({ sub: 'u', nbf: now() + 30 }, SECRET);
      expect(verifyJwt(token, SECRET, { clockSkewSec: 60 }).valid).toBe(true);
    });
  });

  describe('L6: issuer / audience validation (only when configured)', () => {
    it('rejects a token with the wrong issuer', () => {
      const token = createJwt({ sub: 'u', iss: 'evil' }, SECRET);
      const result = verifyJwt(token, SECRET, { issuer: 'mcp-ha-connect' });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/issuer/i);
    });

    it('accepts a token with the expected issuer', () => {
      const token = createJwt({ sub: 'u', iss: 'mcp-ha-connect' }, SECRET);
      expect(verifyJwt(token, SECRET, { issuer: 'mcp-ha-connect' }).valid).toBe(true);
    });

    it('rejects a token whose audience does not match', () => {
      const token = createJwt({ sub: 'u', aud: 'other' }, SECRET);
      const result = verifyJwt(token, SECRET, { audience: 'mcp' });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/audience/i);
    });

    it('accepts a token whose audience array contains the expected value', () => {
      const token = createJwt({ sub: 'u', aud: ['mcp', 'other'] }, SECRET);
      expect(verifyJwt(token, SECRET, { audience: 'mcp' }).valid).toBe(true);
    });

    it('ignores iss/aud when not configured (backward-compatible)', () => {
      const token = createJwt({ sub: 'u', iss: 'whatever', aud: 'whatever' }, SECRET);
      expect(verifyJwt(token, SECRET).valid).toBe(true);
    });
  });

  describe('M8: bearer secret strength enforced at startup', () => {
    const base = { MCP_SERVER_USE_HTTP: 'true', MCP_AUTH_METHOD: 'bearer' };

    it('rejects a bearer secret shorter than 32 characters', () => {
      expect(() =>
        loadConfig({ ...base, MCP_AUTH_SECRET: 'too-short' } as NodeJS.ProcessEnv)
      ).toThrow(/32|secret/i);
    });

    it('accepts a bearer secret of at least 32 characters', () => {
      expect(() =>
        loadConfig({ ...base, MCP_AUTH_SECRET: 'a'.repeat(32) } as NodeJS.ProcessEnv)
      ).not.toThrow();
    });

    it('does not require a secret when auth method is none', () => {
      expect(() => loadConfig({ MCP_AUTH_METHOD: 'none' } as NodeJS.ProcessEnv)).not.toThrow();
    });
  });
});
