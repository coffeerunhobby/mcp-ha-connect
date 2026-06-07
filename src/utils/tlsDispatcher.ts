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
 */

import { Agent, type Dispatcher } from 'undici';

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
 */
export function createTlsDispatcher(strictSsl: boolean | undefined): Dispatcher | undefined {
  if (strictSsl === false) {
    return new Agent({ connect: { rejectUnauthorized: false } });
  }
  return undefined;
}
