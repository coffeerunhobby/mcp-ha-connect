/**
 * Per-client TLS dispatcher helper (SEC-CRYPTO / H2).
 *
 * When a client must talk to a host with a self-signed certificate, the ONLY
 * acceptable way to relax certificate validation is to scope it to that single
 * client. The previous implementation toggled the process-global
 * `NODE_TLS_REJECT_UNAUTHORIZED` env var around each `fetch` call, which
 * disables TLS verification for EVERY concurrent outbound request in the
 * process for the duration of the call — a TOCTOU race that silently strips
 * certificate validation from unrelated Home Assistant / AI traffic.
 *
 * Node's global `fetch` (undici) ignores the legacy `agent` option; the
 * supported mechanism is a per-call `dispatcher`. We build one undici Agent per
 * client instance and pass it on every request, leaving the process-global TLS
 * policy untouched.
 *
 * THE PAIRING RULE (v1.7.0, root cause of the 2026-07-10 v1.5.5 incident):
 * a dispatcher built from the npm `undici` package must ONLY be passed to
 * `undici`'s own `fetch` — never to Node's BUILT-IN fetch. The built-in fetch
 * is powered by whatever undici Node bundles, and its dispatch-handler
 * interface drifts across majors: on Node 26 an npm-undici-6 Agent fails with
 * "invalid onError method", surfacing as `fetch failed` on every request (the
 * NAS crash-loop). `tlsAwareFetch` enforces the rule at one choke point.
 */

import { TLSSocket } from 'node:tls';

import { Agent, buildConnector, fetch as undiciFetch, type Dispatcher } from 'undici';

/**
 * `fetch` init augmented with undici's per-request dispatcher option, which is
 * not present in the lib.dom / @types/node `RequestInit` typings.
 */
export type FetchInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

/**
 * Build an undici dispatcher that disables TLS certificate validation, scoped
 * to a single client instance. Returns `undefined` when `strictSsl` is not
 * explicitly disabled, so strict clients carry no dispatcher and use Node's
 * default (validating) global agent.
 *
 * @param strictSsl - When `false`, certificate validation is disabled for this
 *   client only. Any other value (including `undefined`) keeps validation on.
 * @param baseUrl - The client's base URL. For plain-`http:` targets no
 *   dispatcher is created even when `strictSsl` is false: TLS relaxation is
 *   meaningless without TLS, and carrying a dispatcher there only risks the
 *   version-mixing failure described above for zero benefit (this was exactly
 *   the NAS production config that crashed v1.5.5 — http HA + strictSsl=false).
 */
export function createTlsDispatcher(strictSsl: boolean | undefined, baseUrl?: string): Dispatcher | undefined {
  if (strictSsl === false) {
    if (baseUrl !== undefined && baseUrl.trim().toLowerCase().startsWith('http:')) {
      return undefined;
    }
    return new Agent({ connect: { rejectUnauthorized: false } });
  }
  return undefined;
}

/** A SHA-256 certificate fingerprint as 64 lowercase hex digits (colons, spaces and case ignored), or undefined if it isn't one. */
export function normalizeFingerprint(value: string): string | undefined {
  const hex = value.replace(/[:\s]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

/** The error a pinned connection fails with when the server shows another certificate (the request is never sent). */
export const PIN_MISMATCH = 'ERR_TLS_CERT_PIN_MISMATCH';

/**
 * A dispatcher that trusts exactly one certificate, by its SHA-256 fingerprint, for a device
 * with a self-signed certificate and no usable host name (e.g. a router's own HTTPS): the chain
 * and host checks are replaced by an exact match, and any other certificate ends the connection
 * right after the handshake, before a byte of the request is sent. TLS sessions are not reused,
 * so every connection shows its certificate.
 */
export function createPinnedDispatcher(sha256: string): Dispatcher {
  const pin = normalizeFingerprint(sha256);
  if (!pin) throw new Error('A certificate pin must be a SHA-256 fingerprint (64 hex digits)');
  const connect = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
  return new Agent({
    connect: (options, callback) =>
      connect(options, (error, socket) => {
        if (error) return callback(error, null);
        const shown = socket instanceof TLSSocket ? normalizeFingerprint(socket.getPeerCertificate().fingerprint256 ?? '') : undefined;
        if (shown !== pin) {
          socket.destroy();
          return callback(Object.assign(new Error("The server's certificate doesn't match the pinned fingerprint"), { code: PIN_MISMATCH }), null);
        }
        return callback(null, socket);
      }),
  });
}

/**
 * Fetch enforcing the pairing rule: requests carrying a dispatcher go through
 * undici's own `fetch` (Agent and fetch from the SAME library — compatible on
 * every Node version); requests without one use Node's built-in fetch
 * (unchanged behavior, and unit tests stubbing `global.fetch` keep working).
 */
export function tlsAwareFetch(url: string, init: FetchInitWithDispatcher): Promise<Response> {
  if (init.dispatcher) {
    return undiciFetch(url, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  }
  return fetch(url, init);
}
