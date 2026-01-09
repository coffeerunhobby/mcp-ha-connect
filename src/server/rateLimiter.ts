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
  private readonly entries = new Map<string, RateLimitEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: RateLimitConfig = {}) {
    this.windowMs = config.windowMs ?? 60000; // 1 minute default
    this.maxRequests = config.maxRequests ?? 100; // 100 requests per minute
    this.skipPaths = new Set(config.skipPaths ?? ['/health', '/healthcheck']);
    this.keyGenerator = config.keyGenerator ?? this.defaultKeyGenerator;

    // Start cleanup interval to prevent memory leaks
    this.startCleanup();
  }

  /**
   * Default key generator - uses IP address
   */
  private defaultKeyGenerator(req: IncomingMessage): string {
    // Try to get real IP from common proxy headers
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
      return ips.split(',')[0].trim();
    }

    const realIp = req.headers['x-real-ip'];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0] : realIp;
    }

    // Fall back to socket remote address
    return req.socket.remoteAddress ?? 'unknown';
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
