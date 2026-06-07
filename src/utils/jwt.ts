/**
 * Minimal Bearer token verification (HS256 JWT)
 * Zero dependencies - uses Node's crypto
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtPayload {
  sub?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  iss?: string;
  aud?: string | string[];
  [key: string]: unknown;
}

export interface JwtResult {
  valid: boolean;
  payload?: JwtPayload;
  error?: string;
}

/** Optional claim-validation policy for verifyJwt. */
export interface JwtVerifyOptions {
  /** Reject tokens that have no `exp` claim (H3). Default: false (backward-compatible). */
  requireExp?: boolean;
  /** Require `iss` to equal this value when set (L6). */
  issuer?: string;
  /** Require `aud` to include this value when set (L6). */
  audience?: string;
  /** Allowable clock skew in seconds for exp/nbf comparisons (L6). Default: 0. */
  clockSkewSec?: number;
}

function b64decode(str: string): string {
  const pad = str + '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(pad.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
}

function b64encode(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function verifyJwt(token: string, secret: string, options: JwtVerifyOptions = {}): JwtResult {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'bad format' };
  }

  const [h, p, sig] = parts;

  // Verify signature (timing-safe)
  const expected = b64encode(createHmac('sha256', secret).update(`${h}.${p}`).digest());
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, error: 'bad signature' };
  }

  // Parse payload
  let payload: JwtPayload;
  try {
    payload = JSON.parse(b64decode(p));
  } catch {
    return { valid: false, error: 'bad payload' };
  }

  const now = Date.now() / 1000;
  const skew = options.clockSkewSec ?? 0;

  // Expiration (H3): enforce when present; optionally require it.
  if (payload.exp !== undefined) {
    if (typeof payload.exp !== 'number' || payload.exp < now - skew) {
      return { valid: false, error: 'expired' };
    }
  } else if (options.requireExp) {
    return { valid: false, error: 'missing exp' };
  }

  // Not-before (L6)
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number' || payload.nbf > now + skew) {
      return { valid: false, error: 'not yet valid' };
    }
  }

  // Issuer (L6): only checked when an expected issuer is configured.
  if (options.issuer !== undefined && payload.iss !== options.issuer) {
    return { valid: false, error: 'bad issuer' };
  }

  // Audience (L6): only checked when an expected audience is configured.
  if (options.audience !== undefined) {
    const aud = payload.aud;
    const ok = Array.isArray(aud) ? aud.includes(options.audience) : aud === options.audience;
    if (!ok) {
      return { valid: false, error: 'bad audience' };
    }
  }

  return { valid: true, payload };
}

/** Create JWT (for testing/tooling) */
export function createJwt(payload: JwtPayload, secret: string): string {
  const h = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = b64encode(createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}
