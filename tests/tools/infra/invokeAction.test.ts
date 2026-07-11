/**
 * Unit tests for the infra plugin: MCP_REST_ACTIONS parsing and the invokeAction
 * tool ("actuator rails for HTTP").
 *
 * The security property under test throughout: the model's ONLY input is an
 * action NAME resolved by exact own-property lookup — a malformed or hostile
 * string can fail the lookup, and nothing else. It never reaches URL, method,
 * headers, or body.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerInfraTools, parseRestActions, resetActionCooldowns } from '../../../src/tools/infra/index.js';
import { Permission } from '../../../src/tools/common.js';

describe('parseRestActions', () => {
    it('returns an empty map for unset/blank input', () => {
        expect(parseRestActions(undefined)).toEqual({});
        expect(parseRestActions('')).toEqual({});
        expect(parseRestActions('   ')).toEqual({});
    });

    it('parses a valid action map (method defaults to POST)', () => {
        const parsed = parseRestActions(
            '{"update-node-u2":{"url":"http://192.168.0.9:8425/v1/update","bearerToken":"secret-1","description":"deploy latest images"}}'
        );
        expect(parsed['update-node-u2']).toMatchObject({
            method: 'POST',
            url: 'http://192.168.0.9:8425/v1/update',
            bearerToken: 'secret-1',
        });
    });

    it('returns a null-prototype map (no Object.prototype reachable through it)', () => {
        const parsed = parseRestActions('{"ok-action":{"url":"http://h:1/x"}}');
        expect(Object.getPrototypeOf(parsed)).toBeNull();
    });

    it('fails loudly on malformed JSON, arrays, and non-objects', () => {
        expect(() => parseRestActions('not-json')).toThrow(/must be valid JSON/);
        expect(() => parseRestActions('[1,2]')).toThrow(/JSON object keyed by action name/);
        expect(() => parseRestActions('"str"')).toThrow(/JSON object keyed by action name/);
    });

    it('rejects hostile or malformed action names at config time', () => {
        for (const bad of ['__proto__', 'has space', 'UPPER', 'a/../b', 'x'.repeat(65), '-startdash']) {
            expect(() => parseRestActions(`{"${bad}":{"url":"http://h:1/x"}}`)).toThrow(/Invalid MCP_REST_ACTIONS action name/);
        }
    });

    it('rejects invalid urls, non-http(s) schemes, and bad methods', () => {
        expect(() => parseRestActions('{"a":{"url":"nope"}}')).toThrow(/Invalid MCP_REST_ACTIONS entry/);
        expect(() => parseRestActions('{"a":{"url":"file:///etc/passwd"}}')).toThrow(/only http\(s\)/);
        expect(() => parseRestActions('{"a":{"url":"http://h:1/x","method":"DELETE"}}')).toThrow(/Invalid MCP_REST_ACTIONS entry/);
    });
});

// Mock server that captures registered handlers (same pattern as omada handler tests)
function createMockServer() {
    const handlers = new Map<string, { config: unknown; handler: (...args: unknown[]) => unknown }>();
    return {
        registerTool: vi.fn((name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
            handlers.set(name, { config, handler });
        }),
        handlers,
    } as unknown as McpServer & { handlers: Map<string, { config: unknown; handler: (...args: unknown[]) => unknown }> };
}

const adminExtra = {
    sessionId: 'test-session',
    authInfo: { extra: { permissions: 0xff } },
};

const ACTIONS = parseRestActions(
    JSON.stringify({
        'update-node-u2': {
            url: 'http://192.168.0.9:8425/v1/update',
            bearerToken: 'tok-u2',
            description: 'deploy latest images on node-u2',
        },
        'ping-webhook': { url: 'http://192.168.0.18:5678/webhook/ping', method: 'GET' },
    })
);

describe('invokeAction tool', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        fetchSpy = vi.spyOn(globalThis, 'fetch');
        // The cooldown store is process-wide (module-level by design — sessions
        // must share it); clear it so cases can't poison each other.
        resetActionCooldowns();
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    it('does not register at all when no actions are configured', () => {
        const server = createMockServer();
        expect(registerInfraTools(server, {})).toBe(0);
        expect(server.handlers.size).toBe(0);
    });

    it('embeds the action names + descriptions in the tool description', () => {
        const server = createMockServer();
        expect(registerInfraTools(server, ACTIONS)).toBe(1);
        const description = (server.handlers.get('invokeAction')?.config as { description: string }).description;
        expect(description).toContain('update-node-u2 (deploy latest images on node-u2)');
        expect(description).toContain('ping-webhook');
    });

    it('fires the configured request exactly — model input shapes nothing but the lookup', async () => {
        fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));
        const server = createMockServer();
        registerInfraTools(server, ACTIONS);

        const { handler } = server.handlers.get('invokeAction')!;
        const result = (await handler({ action: 'update-node-u2' }, adminExtra)) as { isError?: boolean; content: Array<{ text: string }> };

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledWith(
            'http://192.168.0.9:8425/v1/update',
            expect.objectContaining({
                method: 'POST',
                headers: { Authorization: 'Bearer tok-u2' },
                redirect: 'error',
            })
        );
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toContain('completed');
    });

    it('sends no Authorization header when the action has no token', async () => {
        fetchSpy.mockResolvedValue(new Response('pong', { status: 200 }));
        const server = createMockServer();
        registerInfraTools(server, ACTIONS);

        const { handler } = server.handlers.get('invokeAction')!;
        await handler({ action: 'ping-webhook' }, adminExtra);

        expect(fetchSpy).toHaveBeenCalledWith(
            'http://192.168.0.18:5678/webhook/ping',
            expect.objectContaining({ method: 'GET', headers: undefined })
        );
    });

    it('rejects unknown actions without touching the network', async () => {
        const server = createMockServer();
        registerInfraTools(server, ACTIONS);

        const { handler } = server.handlers.get('invokeAction')!;
        const result = (await handler({ action: 'rm-rf-everything' }, adminExtra)) as { isError?: boolean; content: Array<{ text: string }> };

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/Unknown action 'rm-rf-everything'/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('cannot be escaped via prototype-chain names — lookup is own-property only', async () => {
        const server = createMockServer();
        registerInfraTools(server, ACTIONS);
        const { handler } = server.handlers.get('invokeAction')!;

        for (const hostile of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
            const result = (await handler({ action: hostile }, adminExtra)) as { isError?: boolean; content: Array<{ text: string }> };
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('Unknown action');
        }
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('surfaces non-200 responses as errors (body truncated)', async () => {
        fetchSpy.mockResolvedValue(new Response('x'.repeat(2000), { status: 503 }));
        const server = createMockServer();
        registerInfraTools(server, ACTIONS);

        const { handler } = server.handlers.get('invokeAction')!;
        const result = (await handler({ action: 'update-node-u2' }, adminExtra)) as { isError?: boolean; content: Array<{ text: string }> };

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/HTTP 503/);
        expect(result.content[0].text.length).toBeLessThan(700); // 500-char cap + wrapper
    });

    it('rate-limits: a second firing within the cooldown is rejected without touching the network', async () => {
        fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));
        const server = createMockServer();
        registerInfraTools(server, ACTIONS);
        const { handler } = server.handlers.get('invokeAction')!;

        const first = (await handler({ action: 'update-node-u2' }, adminExtra)) as { isError?: boolean };
        expect(first.isError).toBeFalsy();

        const second = (await handler({ action: 'update-node-u2' }, adminExtra)) as { isError?: boolean; content: Array<{ text: string }> };
        expect(second.isError).toBe(true);
        expect(second.content[0].text).toMatch(/cooling down/);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('rate-limits per action: cooling one action does not block another', async () => {
        fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));
        const server = createMockServer();
        registerInfraTools(server, ACTIONS);
        const { handler } = server.handlers.get('invokeAction')!;

        await handler({ action: 'update-node-u2' }, adminExtra);
        const other = (await handler({ action: 'ping-webhook' }, adminExtra)) as { isError?: boolean };
        expect(other.isError).toBeFalsy();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('allows firing again once the cooldown has elapsed', async () => {
        vi.useFakeTimers();
        try {
            fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));
            const server = createMockServer();
            registerInfraTools(server, ACTIONS);
            const { handler } = server.handlers.get('invokeAction')!;

            await handler({ action: 'update-node-u2' }, adminExtra);
            vi.advanceTimersByTime(60_001); // default cooldown is 60s
            const again = (await handler({ action: 'update-node-u2' }, adminExtra)) as { isError?: boolean };
            expect(again.isError).toBeFalsy();
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a FAILED firing still consumes the cooldown slot (no hammering a dying endpoint)', async () => {
        fetchSpy.mockResolvedValue(new Response('boom', { status: 503 }));
        const server = createMockServer();
        registerInfraTools(server, ACTIONS);
        const { handler } = server.handlers.get('invokeAction')!;

        const first = (await handler({ action: 'update-node-u2' }, adminExtra)) as { isError?: boolean };
        expect(first.isError).toBe(true); // HTTP 503 surfaced
        const retry = (await handler({ action: 'update-node-u2' }, adminExtra)) as { isError?: boolean; content: Array<{ text: string }> };
        expect(retry.isError).toBe(true);
        expect(retry.content[0].text).toMatch(/cooling down/);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('cooldownMs: 0 disables the rate limit for that action', async () => {
        fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));
        const noCooldown = parseRestActions(
            '{"rapid":{"url":"http://192.168.0.9:1/x","cooldownMs":0}}'
        );
        const server = createMockServer();
        registerInfraTools(server, noCooldown);
        const { handler } = server.handlers.get('invokeAction')!;

        await handler({ action: 'rapid' }, adminExtra);
        const second = (await handler({ action: 'rapid' }, adminExtra)) as { isError?: boolean };
        expect(second.isError).toBeFalsy();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('rejects invalid cooldownMs at config parse', () => {
        expect(() => parseRestActions('{"a":{"url":"http://h:1/x","cooldownMs":-1}}')).toThrow(/Invalid MCP_REST_ACTIONS entry/);
        expect(() => parseRestActions('{"a":{"url":"http://h:1/x","cooldownMs":999999999}}')).toThrow(/Invalid MCP_REST_ACTIONS entry/);
        expect(parseRestActions('{"a":{"url":"http://h:1/x","cooldownMs":30000}}')['a'].cooldownMs).toBe(30000);
    });

    it('denies callers without the ADMIN permission bit', async () => {
        const server = createMockServer();
        registerInfraTools(server, ACTIONS);

        const operatorExtra = {
            sessionId: 'test-session',
            // OPERATOR mask = QUERY|CONTROL|NOTIFY — no ADMIN bit
            authInfo: { extra: { permissions: Permission.QUERY | Permission.CONTROL | Permission.NOTIFY } },
        };

        const { handler } = server.handlers.get('invokeAction')!;
        const result = (await handler({ action: 'update-node-u2' }, operatorExtra)) as { isError?: boolean };

        expect(result.isError).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
