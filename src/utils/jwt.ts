/**
 * Minimal Bearer token verification (HS256 JWT)
 * Zero dependencies - uses Node's crypto
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtPayload {
  sub?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

export interface JwtResult {
  valid: boolean;
  payload?: JwtPayload;
  error?: string;
}

function b64decode(str: string): string {
  const pad = str + '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(pad.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
}

function b64encode(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function verifyJwt(token: string, secret: string): JwtResult {
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

  // Check expiration
  if (payload.exp && payload.exp < Date.now() / 1000) {
    return { valid: false, error: 'expired' };
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
