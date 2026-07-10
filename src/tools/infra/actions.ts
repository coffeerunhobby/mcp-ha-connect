import { z } from 'zod';

/**
 * A pre-registered REST action the `invokeAction` tool may fire.
 *
 * SECURITY MODEL: the LLM caller supplies ONE thing — an action NAME — which is
 * exact-match looked up here. Method, URL, auth, and timeout all come from this
 * operator-controlled config; no model-supplied string is ever interpolated into
 * any part of the request. A malformed/hostile name can only fail the lookup.
 */
export interface RestAction {
    /** Human hint surfaced in the tool description so the agent picks well. */
    description?: string;
    method: 'GET' | 'POST';
    url: string;
    /** Optional Authorization: Bearer <token> (e.g. watchtower's HTTP-API token). */
    bearerToken?: string;
    /** Per-action timeout; some actions (watchtower update = image pulls) run long. */
    timeoutMs?: number;
}

/**
 * Action names are deliberately boring: lowercase alnum with -/_ separators,
 * 1–64 chars, must start alphanumeric. This rejects prototype-pollution shaped
 * keys (`__proto__`), path/URL fragments, and whitespace tricks at CONFIG time,
 * so the runtime lookup only ever sees tame identifiers.
 */
const ACTION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const actionSchema = z.object({
    description: z.string().max(200).optional(),
    method: z.enum(['GET', 'POST']).default('POST'),
    url: z.string().url({ message: 'each action needs a valid http(s) url' }),
    bearerToken: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1000).max(300_000).optional(),
});

/**
 * Parse MCP_REST_ACTIONS (JSON):
 *   {"update-node-u2":{"method":"POST","url":"http://192.168.0.9:8425/v1/update","bearerToken":"…","description":"deploy latest images on node-u2"}}
 *
 * Returns an empty map when unset; throws on malformed input so a config typo
 * fails loudly at startup instead of silently disabling the tool.
 */
export function parseRestActions(raw: string | undefined): Record<string, RestAction> {
    if (!raw || raw.trim() === '') {
        return {};
    }

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        throw new Error(
            'MCP_REST_ACTIONS must be valid JSON: {"name":{"method":"POST","url":"http://host/path","bearerToken":"..."}}'
        );
    }

    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        throw new Error('MCP_REST_ACTIONS must be a JSON object keyed by action name');
    }

    // Null-prototype output: even a hostile config key can never shadow or reach
    // Object.prototype members, and runtime lookups stay own-property-only.
    const actions: Record<string, RestAction> = Object.create(null) as Record<string, RestAction>;

    for (const [name, value] of Object.entries(json)) {
        if (!ACTION_NAME_PATTERN.test(name)) {
            throw new Error(
                `Invalid MCP_REST_ACTIONS action name '${name}': must match ${ACTION_NAME_PATTERN.source}`
            );
        }
        const parsed = actionSchema.safeParse(value);
        if (!parsed.success) {
            const messages = parsed.error.issues.map((issue) => issue.message);
            throw new Error(`Invalid MCP_REST_ACTIONS entry '${name}':\n${messages.join('\n')}`);
        }
        const url = new URL(parsed.data.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error(`Invalid MCP_REST_ACTIONS entry '${name}': only http(s) urls are allowed`);
        }
        actions[name] = parsed.data;
    }

    return actions;
}
