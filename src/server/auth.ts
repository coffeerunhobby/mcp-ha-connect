/**
 * Authentication middleware for HTTP server
 * Supports bearer token authentication with multi-token support
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../utils/logger.js';

export type AuthMethod = 'none' | 'bearer';

export interface AuthConfig {
  method: AuthMethod;
  tokens?: Set<string>;
  skipPaths?: string[];
}

export interface AuthResult {
  authenticated: boolean;
  error?: string;
}

/**
 * Validate bearer token from Authorization header
 */
function validateBearerToken(req: IncomingMessage, validTokens: Set<string>): AuthResult {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return { authenticated: false, error: 'Missing Authorization header' };
  }

  if (!authHeader.startsWith('Bearer ')) {
    return { authenticated: false, error: 'Invalid Authorization header format. Expected: Bearer <token>' };
  }

  const token = authHeader.slice(7);
  if (!validTokens.has(token)) {
    return { authenticated: false, error: 'Invalid token' };
  }

  return { authenticated: true };
}

/**
 * Authentication middleware
 * Returns true if request should proceed, false if blocked
 */
export function createAuthMiddleware(config: AuthConfig): (req: IncomingMessage, res: ServerResponse) => boolean {
  const { method, tokens, skipPaths = [] } = config;

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    // No auth required
    if (method === 'none') {
      return true;
    }

    // Check if path should skip auth
    const url = req.url ?? '/';
    const urlPath = url.split('?')[0];

    if (skipPaths.some((path) => urlPath === path || urlPath.startsWith(path + '/'))) {
      return true;
    }

    // Bearer auth
    if (method === 'bearer') {
      if (!tokens?.size) {
        logger.error('Bearer auth enabled but no token configured');
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Server misconfiguration: auth token not set' }));
        return false;
      }

      const result = validateBearerToken(req, tokens);

      if (!result.authenticated) {
        logger.warn('Authentication failed', {
          method: req.method,
          url: urlPath,
          error: result.error,
          ip: req.socket.remoteAddress,
        });

        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('WWW-Authenticate', result.error === 'Invalid token' ? 'Bearer error="invalid_token"' : 'Bearer');
        res.end(JSON.stringify({ error: 'Unauthorized', message: result.error }));
        return false;
      }

      logger.debug('Authentication successful', { method: req.method, url: urlPath });
      return true;
    }

    // Unknown auth method
    logger.error('Unknown auth method', { method });
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Server misconfiguration: unknown auth method' }));
    return false;
  };
}
