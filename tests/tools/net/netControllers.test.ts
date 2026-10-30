/**
 * net_* tools with several controllers (2.5.0): every tool takes an optional `controller`
 * (the vendor); without it Omada answers when configured, else the first one. Parallel calls
 * keep their own choice, and a value without a controller behind it never falls back.
 */

import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { registerNetTools } from '../../../src/tools/net/index.js';
import type { NetworkController, Vendor } from '../../../src/net/model.js';
import { Permission } from '../../../src/permissions/index.js';

type Handler = (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function fake(vendor: Vendor, delay = 0): NetworkController & { listNetworks: ReturnType<typeof vi.fn> } {
    return {
        vendor,
        id: `${vendor}:test`,
        capabilities: vi.fn(async () => ({ vendor })),
        listNetworks: vi.fn(async () => {
            if (delay) await new Promise((r) => setTimeout(r, delay));
            return [{ id: `${vendor}-net`, name: vendor }];
        }),
        plan: vi.fn(async (change) => ({ change, vendor, steps: [], effects: [], wouldLockOut: [], basis: `${vendor}-basis` })),
        apply: vi.fn(async () => ({ applied: true, owned: [] })),
    } as unknown as NetworkController & { listNetworks: ReturnType<typeof vi.fn> };
}

function setup(controllers: NetworkController[]) {
    const handlers = new Map<string, Handler>();
    const schemas = new Map<string, z.ZodObject<z.ZodRawShape>>();
    const server = {
        registerTool: vi.fn((name: string, c: { inputSchema: z.ZodObject<z.ZodRawShape> }, h: Handler) => {
            handlers.set(name, h);
            schemas.set(name, c.inputSchema);
        }),
    } as unknown as McpServer;
    const count = registerNetTools(server, controllers);
    return { handlers, schemas, count };
}

const as = (permissions: number) => ({ sessionId: 's', http: { authInfo: { extra: { permissions } } } });
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe('net_ tools with several controllers', () => {
    it('answers through Omada by default and through the controller named', async () => {
        const omada = fake('omada');
        const ruijie = fake('ruijie');
        const { handlers } = setup([ruijie, omada]);

        expect(parse(await handlers.get('net_listNetworks')!({}, as(Permission.QUERY)))).toEqual([{ id: 'omada-net', name: 'omada' }]);
        expect(parse(await handlers.get('net_listNetworks')!({ controller: 'ruijie' }, as(Permission.QUERY)))).toEqual([{ id: 'ruijie-net', name: 'ruijie' }]);
        expect(parse(await handlers.get('net_capabilities')!({ controller: 'ruijie' }, as(Permission.QUERY)))).toEqual({ controller: 'ruijie:test', vendor: 'ruijie' });

        await handlers.get('net_deleteRule')!({ rule: 'x', dryRun: true, controller: 'ruijie' }, as(Permission.CONFIGURE));
        expect(vi.mocked(ruijie.plan)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(omada.plan)).not.toHaveBeenCalled();
    });

    it('keeps each parallel call on its own controller', async () => {
        const omada = fake('omada', 20);
        const ruijie = fake('ruijie', 5);
        const { handlers } = setup([omada, ruijie]);

        const [a, b, c] = await Promise.all([
            handlers.get('net_listNetworks')!({}, as(Permission.QUERY)),
            handlers.get('net_listNetworks')!({ controller: 'ruijie' }, as(Permission.QUERY)),
            handlers.get('net_listNetworks')!({ controller: 'omada' }, as(Permission.QUERY)),
        ]);
        expect([parse(a)[0].name, parse(b)[0].name, parse(c)[0].name]).toEqual(['omada', 'ruijie', 'omada']);
    });

    it('lets every tool\'s schema take only the configured vendors', () => {
        const { schemas, count } = setup([fake('omada'), fake('ruijie')]);
        expect(count).toBe(26);
        for (const [name, schema] of schemas) {
            expect(schema.shape.controller, name).toBeDefined();
            expect(schema.safeParse({ ...validArgs(name), controller: 'ruijie' }).success, name).toBe(true);
            expect(schema.safeParse({ ...validArgs(name), controller: 'unifi' }).success, name).toBe(false);
        }
    });

    it('refuses a controller that is not configured, never falling back to another', async () => {
        const omada = fake('omada');
        const { handlers } = setup([omada]);

        const result = await handlers.get('net_listNetworks')!({ controller: 'ruijie' }, as(Permission.QUERY));
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("No network controller 'ruijie' is configured; configured: omada");
        expect(omada.listNetworks).not.toHaveBeenCalled();
    });

    it('defaults to the only controller when Omada is not there, keeps one per vendor, and registers nothing without one', async () => {
        const ruijie = fake('ruijie');
        const second = fake('ruijie');
        const { handlers } = setup([ruijie, second]);
        expect(parse(await handlers.get('net_listNetworks')!({}, as(Permission.QUERY)))[0].name).toBe('ruijie');
        expect(second.listNetworks).not.toHaveBeenCalled();

        expect(setup([]).count).toBe(0);
        expect(setup([]).handlers.size).toBe(0);
    });

    it('still takes a single controller', async () => {
        const handlers = new Map<string, Handler>();
        const server = { registerTool: vi.fn((name: string, _c: unknown, h: Handler) => handlers.set(name, h)) } as unknown as McpServer;
        expect(registerNetTools(server, fake('omada'))).toBe(26);
        expect(parse(await handlers.get('net_listNetworks')!({}, as(Permission.QUERY)))[0].name).toBe('omada');
    });
});

/** Minimal valid arguments per tool, to check the controller field on its own. */
function validArgs(name: string): Record<string, unknown> {
    const args: Record<string, Record<string, unknown>> = {
        net_createNetwork: { name: 'n', vlan: 5 },
        net_updateNetwork: { network: 'n' },
        net_deleteNetwork: { network: 'n' },
        net_createWifi: { name: 'w', network: 'n' },
        net_updateWifi: { wifi: 'w' },
        net_deleteWifi: { wifi: 'w' },
        net_createRule: { name: 'r', action: 'block', from: [{ network: 'a' }], to: [{ internet: true }] },
        net_updateRule: { rule: 'r' },
        net_deleteRule: { rule: 'r' },
        net_moveRule: { rule: 'r', position: 1 },
        net_assignPort: { switch: 's', port: 1, network: 'n' },
        net_setMdnsRepeater: { enabled: false },
        net_setReservation: { mac: '02-00-00-00-00-09', ip: '10.0.0.9' },
        net_deleteReservation: { mac: '02-00-00-00-00-09' },
    };
    return args[name] ?? {};
}
