/**
 * DHCP reservations on a FortiGate (2.7.0): net_setReservation / net_deleteReservation through
 * the reserved-address child table of system.dhcp/server, as the FortiGate's own GUI writes it
 * (mapped live on a FortiGate 80F with FortiOS 7.4.4, 2026-11-24). A fake FortiGate keeps the
 * DHCP servers in memory, so every change is read back.
 */

import { describe, it, expect } from 'vitest';

import { FortiGateError, type FortiGateClient } from '../../src/fortigateClient/index.js';
import { FortiGateNetworkController } from '../../src/net/adapters/fortigate.js';
import { NetError, type Change, type Plan } from '../../src/net/model.js';

import * as fx from './fixtures/fortigate.js';

type Raw = Record<string, unknown>;
type Write = { method: string; segments: string[]; body?: Raw };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A FortiGate holding fx's interfaces and DHCP servers; writes change its reserved-address tables. */
function fortigate(options: { servers?: Raw[]; interfaces?: Raw[]; arp?: Raw[]; leases?: Raw[]; readOnly?: boolean; serverHosts?: string[]; host?: string } = {}) {
    const state = {
        interfaces: clone(options.interfaces ?? fx.interfaces),
        servers: clone(options.servers ?? fx.dhcpServers),
        arp: clone(options.arp ?? fx.arp),
        leases: clone(options.leases ?? fx.dhcpLeases),
    };
    const writes: Write[] = [];
    const hooks: {
        /** Throw instead of answering this write (by index, 0 = first). */
        failWrite?: (w: Write, n: number) => Error | undefined;
        /** Called after every read of the DHCP servers (to change the box between plan and apply). */
        afterRead?: (n: number) => void;
        /** Fail the n-th DHCP server read. */
        failRead?: (n: number) => Error | undefined;
        /** Store something else than asked. */
        tamper?: (w: Write) => void;
    } = {};
    let reads = 0;
    let nextId = 100;
    const server = (id: string) => {
        const s = state.servers.find((x) => String(x.id) === id);
        if (!s) throw new FortiGateError('no such server', 'notFound');
        return s;
    };
    const client = {
        host: options.host ?? '192.168.0.126',
        serverAddresses: options.serverHosts ?? [],
        readOnly: options.readOnly ?? false,
        cmdb: async (path: string, name: string) => {
            const key = `${path}/${name}`;
            if (key === 'system/interface') return { results: clone(state.interfaces) };
            if (key === 'system.dhcp/server') {
                const n = reads++;
                const failure = hooks.failRead?.(n);
                if (failure) throw failure;
                // FortiOS re-encrypts secrets on every read: their text changes each time.
                const answer = clone(state.servers).map((s) => ({ ...s, 'ddns-key': `ENC ${Math.random().toString(36).slice(2)}` }));
                hooks.afterRead?.(n);
                return { results: answer };
            }
            throw new Error(`unexpected cmdb ${key}`);
        },
        monitor: async (path: string, name: string) => {
            const key = `${path}/${name}`;
            if (key === 'system/dhcp') return { results: clone(state.leases) };
            if (key === 'network/arp') return { results: clone(state.arp) };
            throw new Error(`unexpected monitor ${key}`);
        },
        cmdbWrite: async (method: string, segments: string[], body?: Raw) => {
            const w: Write = { method, segments, ...(body ? { body } : {}) };
            writes.push(w);
            const failure = hooks.failWrite?.(w, writes.length - 1);
            if (failure) throw failure;
            expect(segments.slice(0, 2)).toEqual(['system.dhcp', 'server']);
            expect(segments[3]).toBe('reserved-address');
            const table = server(segments[2])['reserved-address'] as Raw[];
            if (method === 'POST') {
                const id = nextId++;
                table.push({ id, ...body });
                hooks.tamper?.(w);
                return { mkey: String(id) };
            }
            const index = table.findIndex((e) => String(e.id) === segments[4]);
            if (index < 0) throw new FortiGateError('no such entry', 'notFound');
            if (method === 'PUT') table[index] = { ...table[index], ...body };
            if (method === 'DELETE') table.splice(index, 1);
            hooks.tamper?.(w);
            return { mkey: segments[4] };
        },
    } as unknown as FortiGateClient;
    const adapter = new FortiGateNetworkController(client, { serverHosts: options.serverHosts });
    const entries = (serverId: number) => (state.servers.find((s) => s.id === serverId)!['reserved-address'] as Raw[]).map((e) => ({ ...e }));
    return { adapter, writes, hooks, state, entries };
}

const set = (value: { mac: string; ip: string; network?: { id: string }; description?: string }): Change => ({ op: 'set', kind: 'reservation', value });
const del = (mac: string): Change => ({ op: 'delete', kind: 'reservation', mac });
const RES = (server: string, ...rest: string[]) => ['system.dhcp', 'server', server, 'reserved-address', ...rest];
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof NetError ? e.code : `not a NetError: ${String(e)}`));

/** Fixture servers with the IoT server switched on (192.168.20.0/24). */
const withIot = () => clone(fx.dhcpServers).map((s) => (s.id === 2 ? { ...s, status: 'enable', 'default-gateway': '192.168.20.1', netmask: '255.255.255.0' } : s));

describe('FortiGate DHCP reservations: plan', () => {
    it('reservations are native, and unsupported while FORTIGATE_READ_ONLY is set (refused without a read)', async () => {
        expect((await fortigate().adapter.capabilities()).reservations).toBe('native');
        const ro = fortigate({ readOnly: true });
        expect((await ro.adapter.capabilities()).reservations).toBe('unsupported');
        await expect(ro.adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }))).rejects.toMatchObject({ code: 'UNSUPPORTED', details: { capability: 'reservations' } });
        expect(ro.writes).toEqual([]);
    });

    it('everything else stays refused (UNSUPPORTED)', async () => {
        const { adapter, writes } = fortigate();
        await expect(adapter.plan({ op: 'delete', kind: 'network', ref: { id: 'lan' } })).rejects.toMatchObject({ code: 'UNSUPPORTED', details: { capability: 'network' } });
        await expect(adapter.plan({ op: 'set', kind: 'mdnsRepeater', enabled: true })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
        expect(writes).toEqual([]);
    });

    it('plans a new reservation: one step, what it does, a basis, nothing written', async () => {
        const { adapter, writes } = fortigate();
        const plan = await adapter.plan(set({ mac: '02-00-00-00-00-60', ip: '192.168.1.60', description: 'printer' }));
        expect(plan.vendor).toBe('fortigate');
        expect(plan.steps).toEqual([{ action: 'create', object: 'fortigate.system.dhcp/server.reserved-address', name: '02-00-00-00-00-60', detail: '192.168.1.60 on DHCP server 1 (lan)' }]);
        expect(plan.effects[0]).toBe("02-00-00-00-00-60 always gets 192.168.1.60 on 'Home LAN'.");
        expect(plan.wouldLockOut).toEqual([]);
        expect(plan.basis).toMatch(/^[0-9a-f]{16}$/);
        expect(writes).toEqual([]);
    });

    it('the basis stays the same while nothing changes, though FortiOS re-encrypts its secrets on every read', async () => {
        const { adapter } = fortigate();
        const change = set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' });
        expect((await adapter.plan(change)).basis).toBe((await adapter.plan(change)).basis);
    });

    it('refuses an address in a network without a DHCP server, or with its server off', async () => {
        const { adapter } = fortigate();
        await expect(adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '10.10.10.20' }))).rejects.toThrow("'dmz' has no DHCP server on the FortiGate");
        await expect(adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.20.20' }))).rejects.toThrow("The DHCP server on 'iot' is switched off");
    });

    it('refuses a network with several DHCP servers (which one would hand it out is not clear)', async () => {
        const servers = [...clone(fx.dhcpServers), { id: 9, status: 'enable', interface: 'lan', netmask: '255.255.255.0', 'default-gateway': '192.168.1.99', 'reserved-address': [] }];
        const { adapter } = fortigate({ servers });
        await expect(adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }))).rejects.toMatchObject({ code: 'INVALID', message: expect.stringMatching(/several DHCP servers \(1, 9\)/) });
    });

    it("refuses an address outside the subnet the DHCP server hands out (FortiOS's own check)", async () => {
        const servers = clone(fx.dhcpServers).map((s) => (s.id === 1 ? { ...s, netmask: '255.255.255.128' } : s));
        const { adapter } = fortigate({ servers });
        await expect(adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.160' }))).rejects.toMatchObject({ code: 'INVALID', message: expect.stringMatching(/serves 192\.168\.1\.0\/25/) });
        expect((await adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }))).steps).toHaveLength(1);
    });

    it("refuses a device with a FortiOS MAC access entry (assign or block): that is the FortiGate's own rule", async () => {
        const { adapter } = fortigate();
        await expect(adapter.plan(set({ mac: '02:00:00:00:00:51', ip: '192.168.1.61' }))).rejects.toMatchObject({ code: 'INVALID', message: expect.stringMatching(/MAC access entry \(block\) on DHCP server 1/) });
        await expect(adapter.plan(set({ mac: '02:00:00:00:00:52', ip: '192.168.1.61' }))).rejects.toMatchObject({ code: 'INVALID', message: expect.stringMatching(/\(assign\)/) });
    });

    it('refuses an address another entry holds, of any kind (a block entry, an option-82 reservation)', async () => {
        const servers = clone(fx.dhcpServers);
        (servers[0]['reserved-address'] as Raw[]).push({ id: 7, type: 'option82', ip: '192.168.1.70', mac: '02:00:00:00:00:70', action: 'reserved', 'circuit-id': 'port7' });
        const { adapter } = fortigate({ servers });
        await expect(code(adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.51' })))).resolves.toBe('EXISTS');
        await expect(adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.70' }))).rejects.toMatchObject({ code: 'EXISTS', message: expect.stringMatching(/192\.168\.1\.70 is already held by entry 7 on DHCP server 1/) });
        // The option-82 entry is no device reservation.
        expect((await adapter.listReservations()).map((r) => r.ip)).not.toContain('192.168.1.70');
    });

    it('refuses a device reserved on several DHCP servers already, both to change and to remove', async () => {
        const servers = withIot();
        (servers[1]['reserved-address'] as Raw[]).push({ id: 1, type: 'mac', ip: '192.168.20.50', mac: '02:00:00:00:00:50', action: 'reserved' });
        const { adapter } = fortigate({ servers });
        await expect(adapter.plan(set({ mac: '02:00:00:00:00:50', ip: '192.168.1.57' }))).rejects.toMatchObject({ code: 'INVALID', message: expect.stringMatching(/reserved on several DHCP servers/) });
        await expect(adapter.plan(del('02:00:00:00:00:50'))).rejects.toMatchObject({ code: 'INVALID', message: expect.stringMatching(/reserved on several DHCP servers/) });
    });

    it('the shared checks apply: the gateway, a reserved address, an address in use, nothing to change', async () => {
        const { adapter } = fortigate();
        await expect(code(adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.99' })))).resolves.toBe('INVALID');
        await expect(code(adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.50' })))).resolves.toBe('EXISTS');
        await expect(code(adapter.plan(set({ mac: '02:00:00:00:00:50', ip: '192.168.1.50' })))).resolves.toBe('INVALID');
        await expect(code(adapter.plan(del('02:00:00:00:00:61')))).resolves.toBe('NOT_FOUND');
        await expect(code(adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60', description: 'x'.repeat(129) })))).resolves.toBe('INVALID');
    });

    it('moving an online device to another address is a lock-out the plan names', async () => {
        const { adapter } = fortigate();
        const plan = await adapter.plan(set({ mac: '02:00:00:00:00:50', ip: '192.168.1.57' }));
        expect(plan.wouldLockOut.map((c) => c.mac)).toEqual(['02-00-00-00-00-50']);
        expect(plan.steps).toEqual([{ action: 'update', object: 'fortigate.system.dhcp/server.reserved-address', name: 'node-c6 (02-00-00-00-00-50)', detail: '192.168.1.50 → 192.168.1.57 on DHCP server 1 (lan)' }]);
    });

    it('a profile that may not read the DHCP servers is told so, not "no DHCP server"', async () => {
        const { adapter, hooks } = fortigate();
        hooks.failRead = () => new FortiGateError("The FortiGate's API admin profile doesn't allow cmdb system.dhcp/server (HTTP 403)", 'forbidden');
        await expect(adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }))).rejects.toThrow(/doesn't allow cmdb system\.dhcp\/server/);
    });
});

describe("FortiGate DHCP reservations: this server's address stays", () => {
    it("never moves or removes this server's reservation; pinning it where it is, or describing it, is fine", async () => {
        const { adapter } = fortigate({ serverHosts: ['192.168.1.50'] });
        await expect(adapter.plan(set({ mac: '02:00:00:00:00:50', ip: '192.168.1.57' }))).rejects.toMatchObject({ code: 'PROTECTED', message: expect.stringMatching(/this server/) });
        await expect(adapter.plan(del('02:00:00:00:00:50'))).rejects.toMatchObject({ code: 'PROTECTED' });
        expect((await adapter.plan(set({ mac: '02:00:00:00:00:50', ip: '192.168.1.50', description: 'mcp' }))).steps).toHaveLength(1);
    });

    it("the device at this server's address is protected even without a reservation of that address", async () => {
        // node-c6 (02:..:50) is online at .50 (ARP); its reservation says .50 too, here it says .58.
        const servers = clone(fx.dhcpServers);
        (servers[0]['reserved-address'] as Raw[])[0].ip = '192.168.1.58';
        const { adapter } = fortigate({ servers, serverHosts: ['192.168.1.50'] });
        await expect(adapter.plan(del('02:00:00:00:00:50'))).rejects.toMatchObject({ code: 'PROTECTED' });
    });

    it('this server, online without a reservation, may get one for the address it has', async () => {
        const servers = clone(fx.dhcpServers);
        (servers[0]['reserved-address'] as Raw[]).splice(0, 1); // node-c6 (.50, online) has none now
        const { adapter } = fortigate({ servers, serverHosts: ['192.168.1.50'] });
        expect((await adapter.plan(set({ mac: '02:00:00:00:00:50', ip: '192.168.1.50' }))).steps).toHaveLength(1);
    });

    it("a reservation of this server's address is protected while the server is offline too", async () => {
        // 02:..:53 holds .53 and is not online.
        const { adapter } = fortigate({ serverHosts: ['192.168.1.53'] });
        await expect(adapter.plan(del('02:00:00:00:00:53'))).rejects.toMatchObject({ code: 'PROTECTED' });
        await expect(adapter.plan(set({ mac: '02:00:00:00:00:53', ip: '192.168.1.54' }))).rejects.toMatchObject({ code: 'PROTECTED' });
        expect((await adapter.plan(set({ mac: '02:00:00:00:00:53', ip: '192.168.1.53', description: 'mcp' }))).steps).toHaveLength(1);
    });

    it("never reserves this server's address for another device", async () => {
        const { adapter } = fortigate({ serverHosts: ['192.168.1.40'] });
        await expect(adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.40' }))).rejects.toMatchObject({ code: 'PROTECTED', message: expect.stringMatching(/192\.168\.1\.40 is this server's address/) });
    });

    it('while where this server is cannot be told (no MCP_SERVER_ADDRESSES, the FortiGate reached from a LAN), no reservation is moved or removed', async () => {
        const { adapter } = fortigate({ host: '192.168.1.99' });
        await expect(adapter.plan(set({ mac: '02:00:00:00:00:53', ip: '192.168.1.54' }))).rejects.toMatchObject({ code: 'PROTECTED', message: expect.stringMatching(/MCP_SERVER_ADDRESSES/) });
        await expect(adapter.plan(del('02:00:00:00:00:53'))).rejects.toMatchObject({ code: 'PROTECTED' });
        // New ones are fine, and so is a description on one that stays.
        expect((await adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }))).steps).toHaveLength(1);
        expect((await adapter.plan(set({ mac: '02:00:00:00:00:53', ip: '192.168.1.53', description: 'tv' }))).steps).toHaveLength(1);
        // With MCP_SERVER_ADDRESSES set, other devices' reservations move as usual.
        expect((await fortigate({ host: '192.168.1.99', serverHosts: ['192.168.1.50'] }).adapter.plan(set({ mac: '02:00:00:00:00:53', ip: '192.168.1.54' }))).steps).toHaveLength(1);
        // Reached through the WAN (the default here), with no server address set: moves are allowed.
        expect((await fortigate().adapter.plan(set({ mac: '02:00:00:00:00:53', ip: '192.168.1.54' }))).steps).toHaveLength(1);
    });
});

describe('FortiGate DHCP reservations: apply', () => {
    const run = async (f: ReturnType<typeof fortigate>, change: Change, options?: { allowLockout?: boolean }) => {
        const plan = await f.adapter.plan(change);
        return await f.adapter.apply(plan, options);
    };

    it('adds a reservation with a POST to the server\'s reserved-address table and reads it back', async () => {
        const f = fortigate();
        const result = await run(f, set({ mac: 'AA-BB-CC-00-00-60', ip: '192.168.1.60', description: 'printer' }));
        expect(f.writes).toEqual([{ method: 'POST', segments: RES('1'), body: { type: 'mac', mac: 'aa:bb:cc:00:00:60', ip: '192.168.1.60', action: 'reserved', description: 'printer' } }]);
        expect(result).toEqual({ applied: true, object: { mac: 'AA-BB-CC-00-00-60', ip: '192.168.1.60', network: { id: 'lan' }, description: 'printer' }, owned: [] });
    });

    it('a new reservation without a description sends none', async () => {
        const f = fortigate();
        await run(f, set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }));
        expect(f.writes[0].body).toEqual({ type: 'mac', mac: '02:00:00:00:00:60', ip: '192.168.1.60', action: 'reserved' });
    });

    it('changes the address of an existing one in place (PUT), keeping its description', async () => {
        const f = fortigate();
        const result = await run(f, set({ mac: '02:00:00:00:00:53', ip: '192.168.1.54' }));
        expect(f.writes).toEqual([{ method: 'PUT', segments: RES('1', '4'), body: { ip: '192.168.1.54' } }]);
        expect(result.object).toEqual({ mac: '02-00-00-00-00-53', ip: '192.168.1.54', network: { id: 'lan' }, description: 'action left out: reserved' });
    });

    it('changes only the description when that is all that differs', async () => {
        const f = fortigate();
        await run(f, set({ mac: '02:00:00:00:00:53', ip: '192.168.1.53', description: 'tv' }));
        expect(f.writes).toEqual([{ method: 'PUT', segments: RES('1', '4'), body: { ip: '192.168.1.53', description: 'tv' } }]);
        expect(f.entries(1).find((e) => e.id === 4)).toMatchObject({ ip: '192.168.1.53', description: 'tv' });
    });

    it('moves a reservation to another network: adds it there first, then removes the old one', async () => {
        const f = fortigate({ servers: withIot() });
        const plan = await f.adapter.plan(set({ mac: '02:00:00:00:00:53', ip: '192.168.20.53' }));
        expect(plan.steps.map((s) => `${s.action} ${s.detail ?? ''}`)).toEqual(['create 192.168.20.53 on DHCP server 2 (iot)', 'delete 192.168.1.53 on DHCP server 1 (lan)']);
        const result = await f.adapter.apply(plan);
        expect(f.writes).toEqual([
            { method: 'POST', segments: RES('2'), body: { type: 'mac', mac: '02:00:00:00:00:53', ip: '192.168.20.53', action: 'reserved', description: 'action left out: reserved' } },
            { method: 'DELETE', segments: RES('1', '4') },
        ]);
        expect(result.object).toMatchObject({ ip: '192.168.20.53', network: { id: 'iot' } });
        expect(result.warnings).toBeUndefined();
    });

    it('a move whose old entry could not be removed is done, with a warning saying what is left', async () => {
        const f = fortigate({ servers: withIot() });
        f.hooks.failWrite = (w) => (w.method === 'DELETE' ? new FortiGateError('The FortiGate refused it (HTTP 500, error -1)') : undefined);
        const result = await run(f, set({ mac: '02:00:00:00:00:53', ip: '192.168.20.53' }));
        expect(result.applied).toBe(true);
        expect(result.object).toMatchObject({ ip: '192.168.20.53', network: { id: 'iot' } });
        expect(result.warnings).toEqual([expect.stringMatching(/old reservation of 192\.168\.1\.53 on DHCP server 1 \(lan\) is still there/)]);
    });

    it('a move whose first write fails changes nothing more', async () => {
        const f = fortigate({ servers: withIot() });
        f.hooks.failWrite = () => new FortiGateError('The FortiGate refused it (HTTP 500, error -15)');
        await expect(run(f, set({ mac: '02:00:00:00:00:53', ip: '192.168.20.53' }))).rejects.toThrow('HTTP 500, error -15');
        expect(f.writes).toHaveLength(1);
        expect(f.entries(1).find((e) => e.id === 4)).toMatchObject({ ip: '192.168.1.53' });
    });

    it('removes a reservation (DELETE) and reads back that it is gone', async () => {
        const f = fortigate();
        const result = await run(f, del('02-00-00-00-00-50'));
        expect(f.writes).toEqual([{ method: 'DELETE', segments: RES('1', '1') }]);
        expect(result).toEqual({ applied: true, owned: [] });
        expect(f.entries(1).some((e) => e.id === 1)).toBe(false);
    });

    it('moving an online device needs allowLockout; without it nothing is written', async () => {
        const f = fortigate();
        await expect(run(f, set({ mac: '02:00:00:00:00:50', ip: '192.168.1.57' }))).rejects.toMatchObject({ code: 'LOCKOUT' });
        expect(f.writes).toEqual([]);
        await run(f, set({ mac: '02:00:00:00:00:50', ip: '192.168.1.57' }), { allowLockout: true });
        expect(f.writes).toEqual([{ method: 'PUT', segments: RES('1', '1'), body: { ip: '192.168.1.57' } }]);
    });

    it('a FortiGate changed since the plan is a CONFLICT, and nothing is written', async () => {
        const f = fortigate();
        const plan = await f.adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }));
        (f.state.servers[0]['reserved-address'] as Raw[]).push({ id: 9, type: 'mac', ip: '192.168.1.90', mac: '02:00:00:00:00:90', action: 'reserved' });
        await expect(f.adapter.apply(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(f.writes).toEqual([]);
    });

    it('a write sent without an answer may or may not be stored, and says so', async () => {
        const f = fortigate();
        f.hooks.failWrite = () => new FortiGateError('The FortiGate is timed out', 'unreachable', true);
        await expect(run(f, set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }))).rejects.toThrow(/may or may not be stored; check net_listReservations/);
        const g = fortigate();
        g.hooks.failWrite = () => new FortiGateError('The FortiGate is not reachable', 'unreachable', false);
        await expect(run(g, set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }))).rejects.toThrow('The FortiGate is not reachable');
    });

    it('a second write of a move sent without an answer is a warning that it may remain', async () => {
        const f = fortigate({ servers: withIot() });
        f.hooks.failWrite = (w) => (w.method === 'DELETE' ? new FortiGateError('The FortiGate is timed out', 'unreachable', true) : undefined);
        const result = await run(f, set({ mac: '02:00:00:00:00:53', ip: '192.168.20.53' }));
        expect(result.warnings).toEqual([expect.stringMatching(/may still be there/)]);
    });

    it('something else stored than asked is a CONFLICT', async () => {
        const f = fortigate();
        f.hooks.tamper = (w) => {
            const table = f.state.servers[0]['reserved-address'] as Raw[];
            if (w.method === 'POST') table[table.length - 1].ip = '192.168.1.66';
        };
        await expect(run(f, set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }))).rejects.toMatchObject({ code: 'CONFLICT' });
        const g = fortigate();
        g.hooks.tamper = () => (g.state.servers[0]['reserved-address'] as Raw[]).push({ id: 99, type: 'mac', ip: '192.168.1.98', mac: '02:00:00:00:00:50', action: 'reserved' });
        await expect(run(g, del('02:00:00:00:00:50'))).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('a second reservation of the device showing up next to the one asked for is a CONFLICT', async () => {
        const f = fortigate();
        f.hooks.tamper = () => (f.state.servers[1]['reserved-address'] as Raw[]).push({ id: 5, type: 'mac', ip: '192.168.20.54', mac: '02:00:00:00:00:53', action: 'reserved' });
        await expect(run(f, set({ mac: '02:00:00:00:00:53', ip: '192.168.1.54' }))).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('a description FortiOS did not keep is a CONFLICT', async () => {
        const f = fortigate();
        f.hooks.tamper = () => {
            const table = f.state.servers[0]['reserved-address'] as Raw[];
            table[table.length - 1].description = '';
        };
        await expect(run(f, set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60', description: 'printer' }))).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('a read-back that fails is a warning, not a failure (the write was accepted)', async () => {
        const f = fortigate();
        let failFrom = Infinity;
        f.hooks.failRead = (n) => (n >= failFrom ? new FortiGateError('The FortiGate is not reachable', 'unreachable') : undefined);
        const plan = await f.adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }));
        failFrom = 2; // the re-plan in apply reads once (n = 1), the read-back fails
        const result = await f.adapter.apply(plan);
        expect(result).toEqual({ applied: true, owned: [], warnings: [expect.stringMatching(/reading it back failed; check it with net_listReservations/)] });
        expect(f.writes).toHaveLength(1);
    });

    it('two changes planned on the same state: the second finds the first and is a CONFLICT', async () => {
        const f = fortigate();
        const a = await f.adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }));
        const b = await f.adapter.plan(set({ mac: '02:00:00:00:00:61', ip: '192.168.1.61' }));
        const results = await Promise.allSettled([f.adapter.apply(a), f.adapter.apply(b)]);
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
        expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
        expect(f.writes).toHaveLength(1);
    });

    it('apply of a plan this adapter did not make is refused', async () => {
        const f = fortigate();
        const plan = await f.adapter.plan(set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }));
        const forged: Plan = { ...plan, change: { op: 'delete', kind: 'network', ref: { id: 'lan' } } };
        await expect(f.adapter.apply(forged)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
        expect(f.writes).toEqual([]);
    });

    it('FORTIGATE_READ_ONLY: apply refuses too, without writing', async () => {
        const f = fortigate({ readOnly: true });
        const plan = { change: set({ mac: '02:00:00:00:00:60', ip: '192.168.1.60' }), vendor: 'fortigate', steps: [], effects: [], wouldLockOut: [], basis: 'x' } as Plan;
        await expect(f.adapter.apply(plan)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
        expect(f.writes).toEqual([]);
    });
});
