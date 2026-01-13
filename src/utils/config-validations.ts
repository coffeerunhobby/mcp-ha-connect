/**
 * Configuration validation utilities
 * Uses Node's built-in net module for reliable IP validation
 */

import { isIPv4, isIPv6 } from 'node:net';

/**
 * Validates if a string is a valid IPv4 or IPv6 address for binding
 */
export function isValidBindAddress(addr: string): boolean {
  return isIPv4(addr) || isIPv6(addr);
}

/**
 * Validates if a string is a valid hostname
 * Allows alphanumeric characters, hyphens, and dots
 * Must not start or end with hyphen or dot
 */
export function isValidHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;

  // Check each label (part between dots)
  const labels = hostname.split('.');
  return labels.every((label) => {
    if (!label || label.length > 63) return false;
    // Must start with alphanumeric, can contain hyphens, must end with alphanumeric
    return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label) || label.length === 1;
  });
}

/**
 * Validates if a string is a valid origin (for CORS)
 * Accepts: wildcard (*), valid URLs, hostnames, or IP addresses
 */
export function isValidOrigin(origin: string): boolean {
  // Allow wildcard
  if (origin === '*') return true;

  // Check if it's a valid IP address
  if (isValidBindAddress(origin)) return true;

  // Check if it's a valid hostname (like 'localhost')
  if (isValidHostname(origin)) return true;

  // Validate URL format (like 'http://example.com')
  try {
    new URL(origin);
    return true;
  } catch {
    return false;
  }
}
