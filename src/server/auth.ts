/**
 * Bearer token authentication middleware for HTTP server
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { verifyJwt, type JwtPayload } from '../utils/jwt.js';
import { getUserPermissions, Role, type PermissionsConfig } from '../permissions/index.js';
import { logger } from '../utils/logger.js';

export type AuthMethod = 'none' | 'bearer';

export interface AuthConfig {
  method: AuthMethod;
  secret?: string;
  permissions?: PermissionsConfig;
  skipPaths?: string[];
  /** Reject tokens without an exp claim (H3). */
  requireExp?: boolean;
  /** Expected JWT issuer, if any (L6). */
  issuer?: string;
  /** Expected JWT audience, if any (L6). */
  audience?: string;
}

/** Emit the "no exp" advisory at most once per process. */
let warnedNoExp = false;

export interface AuthResult {
  authenticated: boolean;
  payload?: JwtPayload;
  permissions?: number;
  error?: string;
}

/** Extended request with MCP SDK compatible auth info */
export interface AuthenticatedRequest extends IncomingMessage {
  auth?: AuthInfo;
}

/**
 * Validate JWT from Authorization header
 */
interface ClaimPolicy {
  requireExp?: boolean;
  issuer?: string;
  audience?: string;
}

function validateJwt(
  req: IncomingMessage,
  secret: string,
  permConfig?: PermissionsConfig,
  policy: ClaimPolicy = {}
): AuthResult {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return { authenticated: false, error: 'Missing Authorization header' };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { authenticated: false, error: 'Expected: Bearer <token>' };
  }

  const token = authHeader.slice(7);
  const result = verifyJwt(token, secret, {
    requireExp: policy.requireExp,
    issuer: policy.issuer,
    audience: policy.audience,
    clockSkewSec: 60,
  });

  if (!result.valid) {
    return { authenticated: false, error: result.error };
  }

  // H3: warn (once) when accepting a token that can never expire.
  if (!policy.requireExp && result.payload?.exp === undefined && !warnedNoExp) {
    warnedNoExp = true;
    logger.warn('Accepting a JWT without an exp claim; set MCP_AUTH_REQUIRE_EXP=true to enforce token expiry');
  }

  // Get user permissions from config.
  // L3: fail closed when no permission map is configured — an authenticated token
  // with no RBAC mapping gets NONE, never full access. (In the real server path
  // `permConfig` is always supplied by loadConfig, so this is defense in depth.)
  const permissions = permConfig
    ? getUserPermissions(result.payload?.sub, permConfig)
    : Role.NONE;

  return { authenticated: true, payload: result.payload, permissions };
}

/**
 * Authentication middleware
 * Returns true if request should proceed, false if blocked
 */
export function createAuthMiddleware(config: AuthConfig): (req: IncomingMessage, res: ServerResponse) => boolean {
  const { method, secret, permissions: permConfig, skipPaths = [], requireExp, issuer, audience } = config;

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (method === 'none') {
      // No auth = full permissions via AuthInfo.extra
      (req as AuthenticatedRequest).auth = {
        token: '',
        clientId: 'anonymous',
        scopes: [],
        extra: { permissions: 0xFF },
      };
      return true;
    }

    // Check skip paths
    const url = req.url ?? '/';
    const path = url.split('?')[0];

    if (skipPaths.some((p) => path === p || path.startsWith(p + '/'))) {
      return true;
    }

    // Bearer auth (JWT)
    if (method === 'bearer') {
      if (!secret) {
        logger.error('Bearer auth enabled but no secret configured');
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server misconfiguration' }));
        return false;
      }

      const result = validateJwt(req, secret, permConfig, { requireExp, issuer, audience });

      if (!result.authenticated) {
        logger.warn('Auth failed', { path, error: result.error, ip: req.socket.remoteAddress });
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('WWW-Authenticate', 'Bearer');
        res.end(JSON.stringify({ error: 'Unauthorized', message: result.error }));
        return false;
      }

      // Attach AuthInfo to request (MCP SDK compatible format)
      const authReq = req as AuthenticatedRequest;
      const token = req.headers.authorization?.slice(7) ?? '';
      authReq.auth = {
        token,
        clientId: result.payload?.sub ?? 'unknown',
        scopes: [],
        extra: {
          permissions: result.permissions,
          payload: result.payload,
        },
      };

      logger.debug('Auth OK', { path, sub: result.payload?.sub, permissions: result.permissions });
      return true;
    }

    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Unknown auth method' }));
    return false;
  };
}
