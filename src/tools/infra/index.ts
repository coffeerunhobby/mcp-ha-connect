/**
 * Infra tools — pre-registered REST actions ("actuator rails for HTTP").
 *
 * Design rules:
 *  - The healer lives OUTSIDE the patient (2026-07-10 v1.5.5 outage lesson):
 *    this server never holds a docker socket or update logic; it only pokes
 *    separately-running endpoints (watchtower HTTP API, webhooks) that keep
 *    their own privileges.
 *  - The model can only NAME an action, never shape a request: exact-match,
 *    own-property lookup into operator config. No model string reaches the
 *    URL, method, headers, or body. Redirects are refused; responses are
 *    truncated before they re-enter the context window.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { toToolResult, wrapToolHandler, Permission } from '../common.js';
import { logger } from '../../utils/logger.js';

import type { RestAction } from './actions.js';

export type { RestAction } from './actions.js';
export { parseRestActions } from './actions.js';

/** Default per-action timeout; watchtower update cycles pull images. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Cap on response bytes surfaced to the caller (anti context-flooding). */
const MAX_RESPONSE_CHARS = 500;
/** Default per-action cooldown (override per action via `cooldownMs`; 0 disables). */
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Last-fired timestamps per action name — the rate limiter's whole state.
 *
 * MODULE-level on purpose: the HTTP server registers tools per SESSION, so a
 * closure-scoped map would give every new session a fresh cooldown (trivially
 * bypassed by reconnecting). One process = one store. In-memory is correct for
 * this single-process server; the check-and-claim below runs synchronously
 * before any await, so two racing calls cannot both pass (no TOCTOU on the
 * event loop). Resets on restart — acceptable: a restart itself takes longer
 * than the default cooldown.
 */
const lastFired = new Map<string, number>();

/** Test hook: clear the process-wide cooldown state between test cases. */
export function resetActionCooldowns(): void {
    lastFired.clear();
}

export function registerInfraTools(server: McpServer, actions: Record<string, RestAction>): number {
    const names = Object.keys(actions);
    if (names.length === 0) {
        return 0;
    }

    const catalogue = names
        .map((n) => {
            const description = actions[n].description;
            return description ? `${n} (${description})` : n;
        })
        .join('; ');

    const inputSchema = z.object({
        action: z
            .string()
            .min(1)
            .max(64, 'action names are at most 64 chars')
            .describe(`Name of the pre-registered action to invoke — one of: ${names.join(', ')}`),
    });

    server.registerTool(
        'invokeAction',
        {
            description:
                'Invoke a pre-registered REST action by name. Actions are fixed, operator-configured HTTP calls ' +
                '(method, URL, and credentials come from server config — only the name is chosen here). ' +
                `Available actions: ${catalogue}. ` +
                'Actions have real-world effects (deploys, restarts, webhooks) - confirm with the user before applying.',
            inputSchema: inputSchema.shape,
        },
        wrapToolHandler('invokeAction', async ({ action }) => {
            // Own-property, exact-match lookup. The registry has a null prototype,
            // so names like 'constructor' or '__proto__' can never resolve to
            // anything but a genuinely configured action.
            if (!Object.hasOwn(actions, action)) {
                throw new Error(`Unknown action '${action}'. Available actions: ${names.join(', ')}`);
            }
            const spec = actions[action];

            // Rate limit: check-and-CLAIM synchronously before the fetch, so the
            // slot is consumed even when the call fails (no hammering a dying
            // endpoint), and two racing calls can't both pass.
            const cooldownMs = spec.cooldownMs ?? DEFAULT_COOLDOWN_MS;
            if (cooldownMs > 0) {
                const now = Date.now();
                const elapsed = now - (lastFired.get(action) ?? Number.NEGATIVE_INFINITY);
                if (elapsed < cooldownMs) {
                    const retryInS = Math.ceil((cooldownMs - elapsed) / 1000);
                    throw new Error(
                        `Action '${action}' is cooling down — try again in ~${String(retryInS)}s. ` +
                        'Repeated firing of infrastructure actions is rate-limited by design.'
                    );
                }
                lastFired.set(action, now);
            }

            logger.info('Invoking registered REST action', { action, method: spec.method, url: spec.url });

            const response = await fetch(spec.url, {
                method: spec.method,
                headers: spec.bearerToken ? { Authorization: `Bearer ${spec.bearerToken}` } : undefined,
                // A registered endpoint that suddenly redirects is a surprise, not
                // a convenience — fail closed rather than follow.
                redirect: 'error',
                signal: AbortSignal.timeout(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS),
            });

            const body = (await response.text().catch(() => '')).slice(0, MAX_RESPONSE_CHARS);

            if (!response.ok) {
                throw new Error(`Action '${action}' returned HTTP ${String(response.status)}${body ? `: ${body}` : ''}`);
            }

            return toToolResult({
                action,
                status: 'completed',
                httpStatus: response.status,
                response: body || undefined,
            });
        },
            Permission.ADMIN
        )
    );

    logger.info('Infra tools registered', { toolCount: 1, actions: names });
    return 1;
}
