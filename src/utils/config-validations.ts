/**
 * Configuration validation utilities
 */

/**
 * Validates if a string is a valid IPv4 or IPv6 address
 */
export function isValidBindAddress(addr: string): boolean {
  // IPv4 regex
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  // IPv6 regex (simplified)
  const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

  if (ipv4Regex.test(addr)) {
    // Validate each octet is 0-255
    const octets = addr.split('.');
    return octets.every((octet) => {
      const num = Number.parseInt(octet, 10);
      return num >= 0 && num <= 255;
    });
  }

  return ipv6Regex.test(addr) || addr === '::' || addr === '::1';
}

/**
 * Validates if a string is a valid origin (for CORS)
 */
export function isValidOrigin(origin: string): boolean {
  // Allow wildcard
  if (origin === '*') return true;

  // Allow localhost and specific hostnames
  if (origin === 'localhost' || origin === '127.0.0.1' || origin === '::1') {
    return true;
  }

  // Validate URL format
  try {
    new URL(origin);
    return true;
  } catch {
    // If not a valid URL, check if it's just a hostname/IP
    return /^[\w.-]+$/.test(origin) || isValidBindAddress(origin);
  }
}
