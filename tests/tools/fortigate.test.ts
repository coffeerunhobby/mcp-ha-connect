/**
 * fortigate_read: only the listed paths, per-path permission (sessions, SSL-VPN users and logs
 * need ADMIN) checked before any call, the row limit, redaction of encrypted FortiOS values and
 * secret-looking fields, and FortiGate errors as clean tool errors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';

import { FortiGateError, type FortiGateClient } from '../../src/fortigateClient/index.js';
import { Permission, Role } from '../../src/permissions/index.js';
import { FORTIGATE_RESOURCES, canReadAnyFortiGateResource, fortigateReadSchema, redactEncrypted, registerFortiGateTools } from '../../src/tools/fortigate/index.js';

type Handler = (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function setup(answer: (kind: string, segments: string[], query?: Record<string, unknown>) => unknown = () => [{ ok: true }]) {
    const handlers = new Map<string, Handler>();
    const server = { registerTool: vi.fn((name: string, _config: unknown, handler: Handler) => handlers.set(name, handler)) } as unknown as McpServer;
    const calls: Array<{ kind: string; segments: string[]; query?: Record<string, unknown> }> = [];
    const respond = (kind: string, segments: string[], query?: Record<string, unknown>) => {
        calls.push({ kind, segments, query });
        return { results: answer(kind, segments, query), serial: 'FGT80FTK00000001', version: 'v7.4.4', build: 2662 };
    };
    const client = {
        cmdb: async (path: string, name: string) => respond('cmdb', [path, name]),
        monitor: async (path: string, name: string, action?: string, query?: Record<string, unknown>) => respond('monitor', action ? [path, name, action] : [path, name], query),
        log: async (segments: string[], query?: Record<string, unknown>) => respond('log', segments, query),
    } as unknown as FortiGateClient;
    expect(registerFortiGateTools(server, client)).toBe(1);
    const read = (args: unknown, permissions: number) =>
        handlers.get('fortigate_read')!(args, { sessionId: 's', http: { authInfo: { token: '', clientId: 'tester', scopes: [], extra: { permissions } } } });
    return { read, calls };
}

const body = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text) as Record<string, unknown>;

describe('fortigate_read', () => {
    beforeEach(() => vi.clearAllMocks());

    it('accepts only the listed paths', () => {
        expect(fortigateReadSchema.safeParse({ path: '/firewall/policies' }).success).toBe(true);
        expect(fortigateReadSchema.safeParse({ path: '/api/v2/cmdb/system/admin' }).success).toBe(false);
        expect(fortigateReadSchema.safeParse({ path: '/log/events', limit: 201 }).success).toBe(false);
    });

    it('reads a QUERY path with a read-only role and returns the results', async () => {
        const { read, calls } = setup(() => [{ policyid: 1, name: 'LAN to internet' }]);
        const result = await read({ path: '/firewall/policies' }, Role.READONLY);
        expect(result.isError).toBeFalsy();
        expect(body(result)).toEqual({ path: '/firewall/policies', data: [{ policyid: 1, name: 'LAN to internet' }] });
        expect(calls).toEqual([{ kind: 'cmdb', segments: ['firewall', 'policy'], query: undefined }]);
    });

    it.each(['/firewall/sessions', '/vpn/ssl', '/log/events'])('%s needs ADMIN, checked before any call', async (path) => {
        const { read, calls } = setup();
        const denied = await read({ path }, Role.OPERATOR);
        expect(denied.isError).toBe(true);
        expect(body(denied).error).toBe('Permission denied');
        expect(calls).toHaveLength(0);
        expect((await read({ path }, Role.ADMIN)).isError).toBeFalsy();
    });

    it('passes the row limit (default 50) to sessions and logs', async () => {
        const { read, calls } = setup();
        await read({ path: '/log/events' }, Role.ADMIN);
        await read({ path: '/firewall/sessions', limit: 10 }, Role.ADMIN);
        expect(calls).toEqual([
            { kind: 'log', segments: ['memory', 'event', 'system'], query: { rows: 50 } },
            { kind: 'monitor', segments: ['firewall', 'sessions'], query: { count: 20, start: 0 } },
        ]);
    });

    it('adds serial and version to the system status', async () => {
        const { read } = setup(() => ({ hostname: 'FGT80F-Home' }));
        expect(body(await read({ path: '/system/status' }, Role.READONLY)).data).toEqual({ hostname: 'FGT80F-Home', serial: 'FGT80FTK00000001', version: 'v7.4.4', build: 2662 });
    });

    it('redacts encrypted FortiOS values and secret-looking fields', async () => {
        const { read } = setup(() => [{ name: 'wan2', mode: 'pppoe', username: 'isp-user', password: 'ENC AAAAbbbbCCCC', 'eap-password': 'plain', 'auth-key': 'ENC xyz', alias: 'ENC is just a word here?' }]);
        const data = body(await read({ path: '/config/interfaces' }, Role.READONLY)).data as Array<Record<string, unknown>>;
        expect(data[0].password).toBe('<redacted>');
        expect(data[0]['eap-password']).toBe('<redacted>');
        expect(data[0]['auth-key']).toBe('<redacted>');
        expect(data[0].name).toBe('wan2');
        expect(redactEncrypted({ a: ['ENC x', 'ENCORE'] })).toEqual({ a: ['<redacted>', 'ENCORE'] });
    });

    it('redacts plaintext secrets under FortiOS hyphenated names, but keeps object names', async () => {
        const { read } = setup(() => [{ name: 'vpn1', q_origin_key: 'vpn1', 'auth-key': 'plain1', 'private-key': 'plain2', 'pre-shared-key': 'plain3', psksecret: 'plain4', 'ppk-secret': 'plain5', keepalive: 10 }]);
        const [row] = body(await read({ path: '/vpn/ipsec' }, Role.READONLY)).data as Array<Record<string, unknown>>;
        expect(row).toEqual({ name: 'vpn1', q_origin_key: 'vpn1', 'auth-key': '<redacted>', 'private-key': '<redacted>', 'pre-shared-key': '<redacted>', psksecret: '<redacted>', 'ppk-secret': '<redacted>', keepalive: 10 });
    });

    it('reads sessions from firewall/sessions, falling back to firewall/session, with at least 20 rows asked and the limit kept', async () => {
        const rows = Array.from({ length: 25 }, (_, i) => ({ i }));
        const { read, calls } = setup((kind, segments) => {
            if (segments[1] === 'sessions') throw new FortiGateError('no', 'notFound');
            return rows;
        });
        const data = body(await read({ path: '/firewall/sessions', limit: 5 }, Role.ADMIN)).data as unknown[];
        expect(data).toHaveLength(5);
        expect(calls.map((c) => [c.segments.join('/'), c.query])).toEqual([
            ['firewall/sessions', { count: 20, start: 0 }],
            ['firewall/session', { count: 20, start: 0 }],
        ]);
    });

    it('turns FortiGate errors into tool errors with their kind', async () => {
        const { read } = setup(() => {
            throw new FortiGateError("The FortiGate's API admin profile doesn't allow monitor vpn/ipsec (HTTP 403)", 'forbidden');
        });
        const result = await read({ path: '/vpn/ipsec' }, Role.READONLY);
        expect(result.isError).toBe(true);
        expect(body(result)).toEqual({ error: 'forbidden', message: "The FortiGate's API admin profile doesn't allow monitor vpn/ipsec (HTTP 403)" });
    });

    it('is visible to a caller who can read at least one path', () => {
        expect(canReadAnyFortiGateResource(Permission.QUERY)).toBe(true);
        expect(canReadAnyFortiGateResource(Permission.ADMIN)).toBe(true);
        expect(canReadAnyFortiGateResource(Permission.NOTIFY)).toBe(false);
        expect(Object.values(FORTIGATE_RESOURCES).every((r) => r.permission === Permission.QUERY || r.permission === Permission.ADMIN)).toBe(true);
    });
});
