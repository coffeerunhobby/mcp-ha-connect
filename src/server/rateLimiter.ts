/**
 * Rate Limiter Middleware
 * Simple token bucket rate limiter for HTTP endpoints
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../utils/logger.js';

export interface RateLimitConfig {
  windowMs?: number;      // Time window in milliseconds (default: 60000 = 1 minute)
  maxRequests?: number;   // Maximum requests per window (default: 100)
  skipPaths?: string[];   // Paths to skip rate limiting (e.g., health checks)
  keyGenerator?: (req: IncomingMessage) => string;  // Custom key generator
  /**
   * Immediate-peer IPs whose forwarding headers (CF-Connecting-IP / X-Forwarded-For /
   * X-Real-IP) may be trusted to identify the real client (M4). Empty by default —
   * with no trusted proxy, client-supplied headers are IGNORED and the socket
   * address is used, so a forged header cannot evade limits or grow the bucket map.
   */
  trustedProxies?: string[];
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/**
 * Rate Limiter class
 */
export class RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly skipPaths: Set<string>;
  private readonly keyGenerator: (req: IncomingMessage) => string;
  private readonly trustedProxies: Set<string>;
  private readonly entries = new Map<string, RateLimitEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: RateLimitConfig = {}) {
    this.windowMs = config.windowMs ?? 60000; // 1 minute default
    this.maxRequests = config.maxRequests ?? 100; // 100 requests per minute
    this.skipPaths = new Set(config.skipPaths ?? ['/health', '/healthcheck']);
    this.trustedProxies = new Set(config.trustedProxies ?? []);
    // Bind so a custom generator OR the default both see `this`.
    this.keyGenerator = config.keyGenerator ?? ((req) => this.defaultKeyGenerator(req));

    // Start cleanup interval to prevent memory leaks
    this.startCleanup();
  }

  /** First value of a possibly-array header, trimmed; undefined if absent/empty. */
  private firstHeader(value: string | string[] | undefined): string | undefined {
    const v = Array.isArray(value) ? value[0] : value;
    const trimmed = v?.trim();
    return trimmed ? trimmed : undefined;
  }

  /**
   * Default key generator (M4 / OWASP API4:2023).
   *
   * Client-supplied forwarding headers are honored ONLY when the immediate peer
   * (`socket.remoteAddress`) is a configured trusted proxy. Otherwise we key on the
   * socket address — an attacker cannot forge that, so they can neither evade the
   * limit by rotating X-Forwarded-For nor exhaust memory with unbounded forged keys.
   */
  private defaultKeyGenerator(req: IncomingMessage): string {
    const socketAddr = req.socket?.remoteAddress ?? 'unknown';

    if (!this.trustedProxies.has(socketAddr)) {
      return socketAddr;
    }

    // Behind a trusted proxy: prefer Cloudflare's single-client CF-Connecting-IP,
    // then the left-most X-Forwarded-For hop, then X-Real-IP.
    const cf = this.firstHeader(req.headers['cf-connecting-ip']);
    if (cf) {
      return cf;
    }

    const xff = this.firstHeader(req.headers['x-forwarded-for']);
    if (xff) {
      return xff.split(',')[0].trim();
    }

    const realIp = this.firstHeader(req.headers['x-real-ip']);
    if (realIp) {
      return realIp;
    }

    return socketAddr;
  }

  /**
   * Start periodic cleanup of expired entries
   */
  private startCleanup(): void {
    // Cleanup every window period
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [key, entry] of this.entries) {
        if (now - entry.windowStart > this.windowMs * 2) {
          this.entries.delete(key);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        logger.debug('Rate limiter cleanup', { entriesRemoved: cleaned, remaining: this.entries.size });
      }
    }, this.windowMs);
  }

  /**
   * Stop cleanup interval
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Check if request should be allowed
   */
  check(req: IncomingMessage): { allowed: boolean; remaining: number; resetTime: number } {
    const url = req.url ?? '/';
    const path = url.split('?')[0];

    // Skip rate limiting for certain paths
    if (this.skipPaths.has(path)) {
      return { allowed: true, remaining: this.maxRequests, resetTime: 0 };
    }

    const key = this.keyGenerator(req);
    const now = Date.now();
    let entry = this.entries.get(key);

    // Create new entry or reset if window expired
    if (!entry || now - entry.windowStart > this.windowMs) {
      entry = { count: 0, windowStart: now };
      this.entries.set(key, entry);
    }

    // Increment count
    entry.count++;

    const remaining = Math.max(0, this.maxRequests - entry.count);
    const resetTime = entry.windowStart + this.windowMs;

    if (entry.count > this.maxRequests) {
      logger.warn('Rate limit exceeded', {
        key,
        count: entry.count,
        limit: this.maxRequests,
        path,
      });
      return { allowed: false, remaining: 0, resetTime };
    }

    return { allowed: true, remaining, resetTime };
  }

  /**
   * Middleware function for HTTP server
   */
  middleware(): (req: IncomingMessage, res: ServerResponse) => boolean {
    return (req: IncomingMessage, res: ServerResponse): boolean => {
      const result = this.check(req);

      // Add rate limit headers
      res.setHeader('X-RateLimit-Limit', this.maxRequests.toString());
      res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
      res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000).toString());

      if (!result.allowed) {
        res.setHeader('Retry-After', Math.ceil((result.resetTime - Date.now()) / 1000).toString());
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Please try again later.',
          retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000),
        }));
        return false;
      }

      return true;
    };
  }

  /**
   * Get current stats
   */
  getStats(): { totalEntries: number; config: { windowMs: number; maxRequests: number } } {
    return {
      totalEntries: this.entries.size,
      config: {
        windowMs: this.windowMs,
        maxRequests: this.maxRequests,
      },
    };
  }

  /**
   * Reset rate limit for a specific key
   */
  reset(key: string): boolean {
    return this.entries.delete(key);
  }

  /**
   * Clear all rate limit entries
   */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * Create a rate limiter instance with default config
 */
export function createRateLimiter(config?: RateLimitConfig): RateLimiter {
  return new RateLimiter(config);
}
