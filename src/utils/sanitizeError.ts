/**
 * Error sanitization for client-facing responses (M6 / OWASP A09:2021).
 *
 * Raw `error.message` values routinely embed infrastructure detail — internal
 * hostnames, ports, filesystem paths, upstream stack fragments, occasionally
 * tokens. None of that belongs in an HTTP response body. Callers should log the
 * full error server-side (via `logger.error`) and send the return of this helper
 * to the client instead.
 *
 * The function intentionally ignores the error's own text: returning a constant
 * generic string is the whole point — there is no "safe subset" of an arbitrary
 * upstream message we can trust to forward.
 */
const GENERIC_MESSAGE = 'Internal server error';

export function sanitizeError(_error: unknown, fallback: string = GENERIC_MESSAGE): string {
  return fallback;
}
