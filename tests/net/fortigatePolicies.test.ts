/**
 * Firewall policies on a FortiGate (net_createRule / net_updateRule / net_deleteRule / net_moveRule),
 * as mapped live on a FortiGate 80F with FortiOS 7.4.13 (2026-11-26): POST cmdb firewall/policy adds
 * one at the bottom, PUT firewall/policy/<id>?action=move&before|after=<id> moves it, PUT changes it,
 * DELETE removes it; a name is refused twice (-651) and an address object in use can't be removed
 * (-23). A fake FortiGate keeps the policies, address objects and groups in memory, so every change is
 * read back.
 */

import { describe, it, expect } from 'vitest';

import { FortiGateError, type FortiGateClient } from '../../src/fortigateClient/index.js';
import { FortiGateNetworkController } from '../../src/net/adapters/fortigate.js';
import { OWNED_ADDRESS_COMMENT, mayMatchServer, type PolicyWorld } from '../../src/net/adapters/fortigateRules.js';
import { NetError, type Change, type Plan, type Rule } from '../../src/net/model.js';

import * as fx from './fixtures/fortigate.js';

type Raw = Record<string, unknown>;
type Write = { method: string; segments: string[]; body?: Raw; query?: Record<string, string | number> };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const intf = (...n: string[]) => n.map((name) => ({ name }));
const names = (v: unknown) => (v as Array<{ name: string }>).map((x) => x.name);

/** A FortiGate holding fx's interfaces, policies, address objects and groups; writes change them. */
function fortigate(options: { policies?: Raw[]; addresses?: Raw[]; groups?: Raw[]; serverHosts?: string[]; host?: string; readOnly?: boolean } = {}) {
    const state = {
        interfaces: clone(fx.interfaces),
        servers: clone(fx.dhcpServers),
        policies: clone(options.policies ?? fx.policies),
        addresses: clone(options.addresses ?? fx.addresses),
        groups: clone(options.groups ?? fx.addressGroups),
    };
    const writes: Write[] = [];
    const hooks: {
        /** Throw instead of answering this write (n = its index among all writes). */
        failWrite?: (w: Write, n: number) => Error | undefined;
        /** Throw after storing this write (an answer that never came back). */
        loseAnswer?: (w: Write, n: number) => Error | undefined;
        /** Called after every read of the policies (to change the box between plan and apply). */
        afterPolicyRead?: (n: number) => void;
        /** Store something else than asked. */
        tamper?: (w: Write) => void;
    } = {};
    let policyReads = 0;
    const fail = (message: string) => new FortiGateError(message);
    const client = {
        host: options.host ?? '192.168.0.126',
        serverAddresses: options.serverHosts ?? ['192.168.0.8'],
        readOnly: options.readOnly ?? false,
        cmdb: async (path: string, name: string) => {
            const key = `${path}/${name}`;
            if (key === 'system/interface') return { results: clone(state.interfaces) };
            if (key === 'system.dhcp/server') return { results: clone(state.servers) };
            if (key === 'firewall/policy') {
                const answer = { results: clone(state.policies) };
                const n = policyReads++;
                hooks.afterPolicyRead?.(n);
                return answer;
            }
            if (key === 'firewall/address') return { results: clone(state.addresses) };
            if (key === 'firewall/addrgrp') return { results: clone(state.groups) };
            throw new Error(`unexpected cmdb ${key}`);
        },
        monitor: async (path: string, name: string) => {
            const key = `${path}/${name}`;
            if (key === 'system/dhcp') return { results: clone(fx.dhcpLeases) };
            if (key === 'network/arp') return { results: clone(fx.arp) };
            throw new Error(`unexpected monitor ${key}`);
        },
        cmdbWrite: async (method: string, segments: string[], body?: Raw, query?: Record<string, string | number>) => {
            const w: Write = { method, segments, ...(body ? { body } : {}), ...(query ? { query } : {}) };
            writes.push(w);
            const n = writes.length - 1;
            const failure = hooks.failWrite?.(w, n);
            if (failure) throw failure;
            const [path, name, key] = segments;
            let mkey: string | undefined;
            if (`${path}/${name}` === 'firewall/address') {
                if (method === 'POST') {
                    if (state.addresses.some((a) => a.name === body!.name)) throw fail('exists (-5)');
                    state.addresses.push(clone(body!));
                    mkey = String(body!.name);
                } else if (method === 'DELETE') {
                    const used = state.policies.some((p) => [...names(p.srcaddr), ...names(p.dstaddr)].includes(key)) || state.groups.some((g) => names(g.member).includes(key));
                    if (used) throw fail('The entry is used by other entries (-23)');
                    const before = state.addresses.length;
                    state.addresses = state.addresses.filter((a) => a.name !== key);
                    if (state.addresses.length === before) throw new FortiGateError('no such address', 'notFound');
                } else throw new Error(`unexpected ${method} address`);
            } else if (`${path}/${name}` === 'firewall/policy') {
                if (method === 'POST') {
                    if (body!.name && state.policies.some((p) => p.name === body!.name)) throw fail('name already used (-651)');
                    const id = Math.max(0, ...state.policies.map((p) => Number(p.policyid))) + 1;
                    state.policies.push({ ...clone(body!), policyid: id });
                    mkey = String(id);
                } else {
                    const index = state.policies.findIndex((p) => String(p.policyid) === key);
                    if (index < 0) throw new FortiGateError('no such policy', 'notFound');
                    if (method === 'DELETE') state.policies.splice(index, 1);
                    else if (query?.action === 'move') {
                        const ref = String(query.before ?? query.after);
                        const [moved] = state.policies.splice(index, 1);
                        const at = state.policies.findIndex((p) => String(p.policyid) === ref);
                        if (at < 0) {
                            state.policies.splice(index, 0, moved);
                            throw fail('Command fail. Return code 1');
                        }
                        state.policies.splice(query.before !== undefined ? at : at + 1, 0, moved);
                    } else state.policies[index] = { ...state.policies[index], ...clone(body!) };
                }
            } else throw new Error(`unexpected write ${segments.join('/')}`);
            hooks.tamper?.(w);
            const lost = hooks.loseAnswer?.(w, n);
            if (lost) throw lost;
            return mkey === undefined ? {} : { mkey };
        },
    };
    const adapter = new FortiGateNetworkController(client as unknown as FortiGateClient, { serverHosts: options.serverHosts ?? ['192.168.0.8'] });
    return { adapter, state, writes, hooks };
}

const value = (over: Partial<Omit<Rule, 'id' | 'foreign' | 'position'>> & { position?: number } = {}) => ({
    name: 'block iot out',
    action: 'block' as const,
    from: [{ network: { name: 'iot' } }],
    to: [{ internet: true as const }],
    protocol: 'any' as const,
    replies: 'allow' as const,
    schedule: { kind: 'always' as const },
    enabled: true,
    ...over,
});
const create = (over: Parameters<typeof value>[0] = {}): Change => ({ op: 'create', kind: 'rule', value: value(over) });
const update = (rule: string, set: Extract<Change, { op: 'update'; kind: 'rule' }>['value']['set']): Change => ({ op: 'update', kind: 'rule', value: { ref: { name: rule }, set } });
const remove = (rule: string): Change => ({ op: 'delete', kind: 'rule', ref: { name: rule } });
const move = (rule: string, position: number): Change => ({ op: 'move', kind: 'rule', ref: { name: rule }, position });

/** Plans and applies a change. */
async function run(f: ReturnType<typeof fortigate>, change: Change) {
    return await f.adapter.apply(await f.adapter.plan(change));
}

const order = (f: ReturnType<typeof fortigate>) => f.state.policies.map((p) => p.name || `#${String(p.policyid)}`);

describe('FortiGate policies: create', () => {
    it('plans a new block: the steps, what it does, a basis, nothing written', async () => {
        const f = fortigate();
        const plan = await f.adapter.plan(create());
        expect(plan.vendor).toBe('fortigate');
        expect(plan.steps).toEqual([{ action: 'create', object: 'fortigate.firewall/policy', name: 'block iot out', detail: 'block iot to wan1, wan2, position 7' }]);
        expect(plan.effects).toEqual([
            'block iot to wan1, wan2.',
            'New connections are stopped; replies to connections started from the other side still pass.',
            'It is policy 7 of 7. Policies are checked from the top and the first match decides; traffic no policy allows is dropped.',
        ]);
        expect(plan.basis).toMatch(/^[0-9a-f]{16}$/);
        expect(plan.wouldLockOut).toEqual([]);
        expect(f.writes).toEqual([]);
    });

    it('writes it switched off at the bottom, switches it on, and reads it back', async () => {
        const f = fortigate();
        const result = await run(f, create());
        expect(f.writes.map((w) => [w.method, w.segments.join('/'), w.query ?? null])).toEqual([
            ['POST', 'firewall/policy', null],
            ['PUT', 'firewall/policy/8', null],
        ]);
        expect(f.writes[0].body).toEqual({
            name: 'block iot out',
            srcintf: intf('iot'),
            dstintf: intf('wan1', 'wan2'),
            srcaddr: intf('all'),
            dstaddr: intf('all'),
            service: intf('ALL'),
            schedule: 'always',
            action: 'deny',
            status: 'disable',
            nat: 'disable',
            'match-vip': 'enable',
        });
        expect(f.writes[1].body).toEqual({ status: 'enable' });
        expect(result.object).toMatchObject({ id: '8', name: 'block iot out', action: 'block', from: [{ network: { id: 'iot' } }], to: [{ internet: true }], enabled: true, position: 7 });
        expect((result.object as Rule).foreign).toBeUndefined();
        expect(result.warnings).toBeUndefined();
    });

    it('an allow to the internet gets NAT; one switched off is never switched on', async () => {
        const f = fortigate();
        await run(f, create({ name: 'iot out', action: 'allow', enabled: false }));
        expect(f.writes).toHaveLength(1);
        expect(f.writes[0].body).toMatchObject({ action: 'accept', nat: 'enable', status: 'disable' });
        expect(f.writes[0].body).not.toHaveProperty('match-vip');
        const plan = await f.adapter.plan(create({ name: 'iot out 2', action: 'allow' }));
        expect(plan.effects).toContain("NAT is on: the devices reach the internet through the FortiGate's WAN address.");
    });

    it('moves a new one into place before it is switched on', async () => {
        const f = fortigate();
        const result = await run(f, create({ position: 2 }));
        expect(f.writes.map((w) => [w.method, w.query ?? null, w.body ?? null])).toEqual([
            ['POST', null, expect.objectContaining({ status: 'disable' })],
            ['PUT', { action: 'move', before: '5' }, null],
            ['PUT', null, { status: 'enable' }],
        ]);
        expect(order(f)).toEqual(['LAN to internet', 'block iot out', 'block IoT to LAN', 'laptop web', 'servers to printers', 'night', '#7']);
        expect(result.object).toMatchObject({ position: 2, enabled: true });
    });

    it('addresses: an address object saying exactly that is used, else one is made and owned', async () => {
        const f = fortigate();
        const plan = await f.adapter.plan(create({ name: 'cam to dns', from: [{ addresses: ['192.168.20.5'] }], to: [{ addresses: ['9.9.9.9'] }], protocol: 'udp' }));
        expect(plan.steps[0]).toEqual({ action: 'create', object: 'fortigate.firewall/address', name: 'net-192.168.20.5', detail: '192.168.20.5 mask 255.255.255.255' });
        expect(plan.effects).toContain("Address object(s) net-192.168.20.5 are created for the addresses; they stay when the rule goes (reused by later rules; remove them in the FortiGate's UI if no longer wanted).");
        const result = await f.adapter.apply(plan);
        expect(f.writes[0]).toEqual({ method: 'POST', segments: ['firewall', 'address'], body: { name: 'net-192.168.20.5', type: 'ipmask', subnet: '192.168.20.5 255.255.255.255', comment: OWNED_ADDRESS_COMMENT } });
        expect(f.writes[1].body).toMatchObject({ srcintf: intf('iot'), srcaddr: intf('net-192.168.20.5'), dstintf: intf('wan1', 'wan2'), dstaddr: intf('dns'), service: intf('ALL_UDP') });
        expect(result.object).toMatchObject({ from: [{ addresses: ['192.168.20.5'] }], to: [{ addresses: ['9.9.9.9'] }], protocol: 'udp' });
    });

    it('a network address range becomes one object named after it; several LAN addresses take their interfaces', async () => {
        const f = fortigate();
        await run(f, create({ name: 'two nets', from: [{ addresses: ['192.168.20.0/25', '192.168.1.70'] }], to: [{ network: { name: 'dmz' } }] }));
        expect(f.writes.filter((w) => w.segments[1] === 'address').map((w) => w.body)).toEqual([
            { name: 'net-192.168.20.0_25', type: 'ipmask', subnet: '192.168.20.0 255.255.255.128', comment: OWNED_ADDRESS_COMMENT },
            { name: 'net-192.168.1.70', type: 'ipmask', subnet: '192.168.1.70 255.255.255.255', comment: OWNED_ADDRESS_COMMENT },
        ]);
        expect(f.state.policies.at(-1)).toMatchObject({ srcintf: intf('iot', 'lan'), dstintf: intf('dmz'), dstaddr: intf('all') });
    });

    it('an address object tied to an interface, or holding a wider network, is not used for an address', async () => {
        const f = fortigate({ addresses: [...fx.addresses, { name: 'cam-tied', type: 'ipmask', subnet: '192.168.20.5 255.255.255.255', 'associated-interface': 'iot' }] });
        await run(f, create({ name: 'cam', from: [{ addresses: ['192.168.20.5'] }] }));
        expect(f.writes[0].body).toMatchObject({ name: 'net-192.168.20.5' });
        const g = fortigate();
        await run(g, create({ name: 'printer', from: [{ addresses: ['192.168.1.32'] }] }));
        expect(g.writes[0].body).toMatchObject({ name: 'net-192.168.1.32', subnet: '192.168.1.32 255.255.255.255' });
    });

    it('a secondary subnet is refused as a network: a policy names the whole interface', async () => {
        const f = fortigate();
        f.state.interfaces = f.state.interfaces.map((i) => (i.name === 'iot' ? { ...i, secondaryip: [{ id: 1, ip: '192.168.21.1 255.255.255.0' }] } : i));
        await expect(f.adapter.plan(create({ from: [{ network: { id: 'iot:secondary:1' } }] }))).rejects.toThrow('secondary subnet of an interface');
    });

    it('a complete address group is used by name', async () => {
        const f = fortigate({ groups: [...fx.addressGroups, { name: 'cams', member: [{ name: 'printers' }, { name: 'node-c6' }] }] });
        const result = await run(f, create({ name: 'cams out', from: [{ group: { name: 'cams' } }] }));
        expect(f.writes[0].body).toMatchObject({ srcintf: intf('lan'), srcaddr: intf('cams') });
        expect(result.object).toMatchObject({ from: [{ group: { name: 'cams' } }] });
    });

    it.each([
        ['a device', { from: [{ device: '02:00:00:00:00:50' }] }, 'UNSUPPORTED', 'rules.deviceMatch'],
        ['a Wi-Fi network', { from: [{ wifi: { name: 'x' } }] }, 'UNSUPPORTED', 'rules.wifiMatch'],
        ['the FortiGate itself', { to: [{ gateway: true as const }] }, 'UNSUPPORTED', 'rules.toGateway'],
        ['ports', { protocol: { tcpUdpPorts: '443' } }, 'UNSUPPORTED', 'rules.ports'],
        ['a schedule', { schedule: { kind: 'during' as const, windows: [{ days: ['mon' as const], from: '22:00', to: '24:00' }] } }, 'UNSUPPORTED', 'rules.schedule'],
        ['replies matched', { replies: 'match' as const }, 'UNSUPPORTED', 'rules.stateful'],
    ])('refuses %s (UNSUPPORTED)', async (_label, over, code, capability) => {
        const f = fortigate();
        await expect(f.adapter.plan(create(over as never))).rejects.toMatchObject({ code, details: { capability } });
        expect(f.writes).toEqual([]);
    });

    it.each([
        ['the internet as a source', { from: [{ internet: true as const }] }, /not from the internet/],
        ['outside addresses as a source', { from: [{ addresses: ['8.8.8.8'] }] }, /outside them/],
        ['mixed kinds on one side', { from: [{ network: { name: 'iot' } }, { addresses: ['192.168.1.5'] }] }, /one kind of source/],
        ['inside and outside addresses together', { to: [{ addresses: ['192.168.1.5', '8.8.8.8'] }] }, /mixes addresses inside/],
        ['a range across a network edge', { to: [{ addresses: ['192.168.0.0/16'] }] }, /partly inside/],
        ['everything as an address', { to: [{ addresses: ['0.0.0.0/0'] }] }, /internet: true/],
        ['a bad address', { to: [{ addresses: ['300.1.1.1'] }] }, /300\.1\.1\.1/],
        ['the same network on both sides', { to: [{ network: { name: 'iot' } }] }, /inside 'iot'/],
        ['a name too long', { name: 'x'.repeat(36) }, /1 to 35/],
        ['a name with a quote', { name: 'a"b' }, /quotes/],
        ['a name like an unnamed policy', { name: 'Policy 9' }, /unnamed policy/],
        ['a secondary subnet', { from: [{ network: { id: 'lan:secondary:1' } }] }, /not found|secondary/i],
        ['an incomplete group', { from: [{ group: { name: 'servers' } }] }, /can't say/],
        ['a MAC group', { from: [{ group: { name: 'kids' } }] }, /can't say/],
    ])('refuses %s (INVALID / NOT_FOUND)', async (_label, over, message) => {
        const f = fortigate();
        await expect(f.adapter.plan(create(over as never))).rejects.toThrow(message);
        expect(f.writes).toEqual([]);
    });

    it('refuses a name already used (any case), and an address object name holding something else', async () => {
        const f = fortigate({ addresses: [...fx.addresses, { name: 'net-192.168.20.5', type: 'ipmask', subnet: '192.168.20.6 255.255.255.255' }] });
        await expect(f.adapter.plan(create({ name: 'lan TO internet' }))).rejects.toMatchObject({ code: 'EXISTS' });
        await expect(f.adapter.plan(create({ from: [{ addresses: ['192.168.20.5'] }] }))).rejects.toMatchObject({ code: 'EXISTS', message: expect.stringContaining('net-192.168.20.5') });
    });

    it('refuses an interface with secondary subnets', async () => {
        const f = fortigate();
        f.state.interfaces = f.state.interfaces.map((i) => (i.name === 'iot' ? { ...i, 'secondary-IP': 'enable', secondaryip: [{ id: 1, ip: '192.168.21.1 255.255.255.0' }] } : i));
        await expect(f.adapter.plan(create())).rejects.toThrow(/secondary subnets/);
    });

    it('refuses a position outside the list', async () => {
        const f = fortigate();
        await expect(f.adapter.plan(create({ position: 8 }))).rejects.toThrow('Position 8 must be from 1 to 7');
        await expect(f.adapter.plan(create({ position: 0 }))).rejects.toMatchObject({ code: 'INVALID' });
    });
});

describe('FortiGate policies: this server stays reachable', () => {
    it('no change at all without MCP_SERVER_ADDRESSES', async () => {
        const f = fortigate({ serverHosts: [] });
        await expect(f.adapter.plan(create({ action: 'allow' }))).rejects.toMatchObject({ code: 'PROTECTED', message: expect.stringContaining('MCP_SERVER_ADDRESSES') });
        await expect(f.adapter.plan(remove('block IoT to LAN'))).rejects.toMatchObject({ code: 'PROTECTED' });
    });

    describe('this server on a LAN network (192.168.1.50 on lan)', () => {
        const inside = () => fortigate({ serverHosts: ['192.168.1.50'] });

        it('refuses a block from its network, or to its address', async () => {
            await expect(inside().adapter.plan(create({ from: [{ network: { name: 'Home LAN' } }] }))).rejects.toMatchObject({ code: 'PROTECTED' });
            await expect(inside().adapter.plan(create({ from: [{ addresses: ['192.168.1.0/26'] }] }))).rejects.toMatchObject({ code: 'PROTECTED' });
            await expect(inside().adapter.plan(create({ to: [{ addresses: ['192.168.1.50'] }] }))).rejects.toMatchObject({ code: 'PROTECTED' });
        });

        it('allows a block that can\'t match its traffic, a block towards its whole network, any allow, and a block switched off', async () => {
            const f = inside();
            await f.adapter.plan(create({ from: [{ addresses: ['192.168.1.100'] }] }));
            await f.adapter.plan(create({ to: [{ network: { name: 'Home LAN' } }] }));
            await f.adapter.plan(create({ action: 'allow', from: [{ network: { name: 'Home LAN' } }] }));
            await f.adapter.plan(create({ from: [{ network: { name: 'Home LAN' } }], enabled: false }));
        });

        it('refuses removing, changing or moving down an allow that carries its traffic; a rename is fine', async () => {
            const f = inside();
            await expect(f.adapter.plan(remove('LAN to internet'))).rejects.toMatchObject({ code: 'PROTECTED' });
            await expect(f.adapter.plan(update('LAN to internet', { enabled: false }))).rejects.toMatchObject({ code: 'PROTECTED' });
            await expect(f.adapter.plan(update('LAN to internet', { protocol: 'tcp' }))).rejects.toMatchObject({ code: 'PROTECTED' });
            await expect(f.adapter.plan(move('LAN to internet', 2))).rejects.toMatchObject({ code: 'PROTECTED' });
            await expect(f.adapter.plan(update('LAN to internet', { position: 2 }))).rejects.toMatchObject({ code: 'PROTECTED' });
            await f.adapter.plan(update('LAN to internet', { name: 'home out' }));
        });

        it('a block that could match its traffic may move down or be removed, not move up', async () => {
            const f = inside();
            f.state.policies.push({ policyid: 9, name: 'lan block', status: 'enable', srcintf: intf('lan'), dstintf: intf('wan1'), srcaddr: intf('all'), dstaddr: intf('dns'), action: 'deny', service: intf('ALL'), schedule: 'always', 'match-vip': 'enable' });
            await expect(f.adapter.plan(move('lan block', 1))).rejects.toMatchObject({ code: 'PROTECTED' });
            await f.adapter.plan(remove('lan block'));
            await f.adapter.plan(update('lan block', { action: 'allow' }));
            await expect(f.adapter.plan(update('block IoT to LAN', { from: [{ network: { name: 'Home LAN' } }], to: [{ internet: true }] }))).rejects.toMatchObject({ code: 'PROTECTED' });
        });
    });

    it('this server outside (on the WAN side): a block to its own address is refused, one to the internet is not', async () => {
        const f = fortigate();
        await expect(f.adapter.plan(create({ to: [{ addresses: ['192.168.0.0/24'] }] }))).rejects.toMatchObject({ code: 'PROTECTED' });
        await f.adapter.plan(create());
        await f.adapter.plan(remove('LAN to internet'));
    });

    it('where this server is can\'t be told (outside every network, the FortiGate reached on a LAN address): every interface counts', async () => {
        const f = fortigate({ host: '192.168.1.99' });
        await expect(f.adapter.plan(create())).rejects.toMatchObject({ code: 'PROTECTED' });
        await f.adapter.plan(create({ from: [{ addresses: ['192.168.20.7'] }] }));
    });

    it('mayMatchServer: what it can\'t read counts as a match', () => {
        const world: PolicyWorld = {
            networks: [],
            lans: new Map([
                ['lan', { id: 'lan', name: 'lan', purpose: 'normal', vlan: 1, gateway: '192.168.1.99/24', ipv6: false, isolated: false, protected: true }],
                ['iot', { id: 'iot', name: 'iot', purpose: 'normal', vlan: 20, gateway: '192.168.20.1/24', ipv6: false, isolated: false, protected: false }],
            ]),
            wan: ['wan1'],
            secondary: new Set(),
            addresses: new Map(fx.addresses.map((a) => [String(a.name), a])),
            groups: new Map(),
            serverAddresses: [0xc0a80132], // 192.168.1.50
            serverInterfaces: new Set(['lan']),
        };
        const policy = (over: Raw): Raw => ({ status: 'enable', srcintf: intf('iot'), dstintf: intf('wan1'), srcaddr: intf('all'), dstaddr: intf('all'), ...over });
        expect(mayMatchServer(policy({}), world)).toBe(false);
        expect(mayMatchServer(policy({ srcintf: intf('lan') }), world)).toBe(true);
        expect(mayMatchServer(policy({ srcintf: intf('lan'), srcaddr: intf('dns') }), world)).toBe(false);
        expect(mayMatchServer(policy({ srcintf: intf('lan'), srcaddr: intf('node-c6') }), world)).toBe(true);
        expect(mayMatchServer(policy({ srcintf: intf('lan'), srcaddr: intf('dns'), 'srcaddr-negate': 'enable' }), world)).toBe(true);
        expect(mayMatchServer(policy({ srcintf: intf('lan'), srcaddr: intf('example.com') }), world)).toBe(true);
        expect(mayMatchServer(policy({ srcintf: intf('a-zone') }), world)).toBe(true);
        expect(mayMatchServer(policy({ srcintf: [] }), world)).toBe(true);
        expect(mayMatchServer(policy({ srcintf: intf('lan'), status: 'disable' }), world)).toBe(false);
        expect(mayMatchServer(policy({ dstaddr: intf('node-c6') }), world)).toBe(true);
        expect(mayMatchServer(policy({ dstaddr: intf('dns') }), world)).toBe(false);
        expect(mayMatchServer(policy({ dstaddr: intf('dns'), 'dstaddr-negate': 'enable' }), world)).toBe(true);
        expect(mayMatchServer(policy({ dstaddr: [], 'internet-service': 'enable' }), world)).toBe(true);
        expect(mayMatchServer(policy({ dstaddr: intf('dns'), 'internet-service': 'enable' }), world)).toBe(true);
        world.groups.set('half', { complete: false, addresses: ['10.0.0.1'], macs: false });
        world.groups.set('whole', { complete: true, addresses: ['10.0.0.1'], macs: false });
        expect(mayMatchServer(policy({ srcintf: intf('lan'), srcaddr: intf('whole') }), world)).toBe(false);
        expect(mayMatchServer(policy({ srcintf: intf('lan'), srcaddr: intf('half') }), world)).toBe(true);
        expect(mayMatchServer(policy({ srcaddr: [] }), world)).toBe(false);
        expect(mayMatchServer(policy({ srcintf: intf('lan'), srcaddr: [] }), world)).toBe(true);
    });
});

describe('FortiGate policies: delete, move, update', () => {
    it('deletes one and reads it back gone', async () => {
        const f = fortigate();
        const plan = await f.adapter.plan(remove('block IoT to LAN'));
        expect(plan.steps).toEqual([{ action: 'delete', object: 'fortigate.firewall/policy', name: 'block IoT to LAN' }]);
        expect(plan.effects).toEqual(["Policy 'block IoT to LAN' is removed; the traffic it matched follows the policies below it."]);
        expect((await f.adapter.plan(remove('LAN to internet'))).effects[0]).toContain('and is dropped if none allows it');
        const result = await f.adapter.apply(plan);
        expect(f.writes).toEqual([{ method: 'DELETE', segments: ['firewall', 'policy', '5'] }]);
        expect(result).toEqual({ applied: true, owned: [] });
    });

    it('address objects stay when their rules go (a comment proves nothing), and the next rule reuses them (Codex)', async () => {
        const f = fortigate();
        await run(f, create({ name: 'a', from: [{ addresses: ['192.168.20.5'] }] }));
        const plan = await f.adapter.plan(remove('a'));
        expect(plan.steps).toEqual([{ action: 'delete', object: 'fortigate.firewall/policy', name: 'a' }]);
        f.writes.length = 0;
        await f.adapter.apply(plan);
        expect(f.writes).toEqual([{ method: 'DELETE', segments: ['firewall', 'policy', '8'] }]);
        expect(f.state.addresses.some((a) => a.name === 'net-192.168.20.5')).toBe(true);
        f.writes.length = 0;
        await run(f, create({ name: 'b', from: [{ addresses: ['192.168.20.5'] }] }));
        expect(f.writes.filter((w) => w.segments[1] === 'address')).toEqual([]);
        expect(f.state.policies.at(-1)).toMatchObject({ srcaddr: intf('net-192.168.20.5') });
    });

    it("an address object it didn't make stays, even when no rule uses it any more", async () => {
        const f = fortigate();
        await run(f, create({ name: 'to dns', to: [{ addresses: ['9.9.9.9'] }] }));
        expect(f.writes.filter((w) => w.segments[1] === 'address')).toEqual([]);
        const plan = await f.adapter.plan(remove('to dns'));
        expect(plan.steps).toHaveLength(1);
        await f.adapter.apply(plan);
        expect(f.state.addresses.some((a) => a.name === 'dns')).toBe(true);
    });

    it('moves one in one call: before the policy at that place, or after the last', async () => {
        const f = fortigate();
        const result = await run(f, move('block IoT to LAN', 1));
        expect(f.writes).toEqual([{ method: 'PUT', segments: ['firewall', 'policy', '5'], query: { action: 'move', before: '1' } }]);
        expect(result.object).toMatchObject({ name: 'block IoT to LAN', position: 1 });
        await run(f, move('block IoT to LAN', 6));
        expect(f.writes[1].query).toEqual({ action: 'move', after: '7' });
        expect(order(f).at(-1)).toBe('block IoT to LAN');
        await run(f, move('block IoT to LAN', 3));
        expect(f.writes[2].query).toEqual({ action: 'move', before: '4' });
        expect(order(f)[2]).toBe('block IoT to LAN');
        await run(f, move('block IoT to LAN', 5));
        expect(f.writes[3].query).toEqual({ action: 'move', before: '7' });
        expect(order(f)[4]).toBe('block IoT to LAN');
    });

    it('refuses a move to where it is, out of the list, or of a foreign policy', async () => {
        const f = fortigate();
        await expect(f.adapter.plan(move('block IoT to LAN', 2))).rejects.toThrow('already at position 2');
        await expect(f.adapter.plan(move('block IoT to LAN', 7))).rejects.toThrow('Position 7 must be from 1 to 6');
        await expect(f.adapter.plan(move('night', 1))).rejects.toMatchObject({ code: 'UNSUPPORTED', message: expect.stringContaining('school-nights') });
        await expect(f.adapter.plan(remove('policy 7'))).rejects.toMatchObject({ code: 'UNSUPPORTED' });
        await expect(f.adapter.plan(update('laptop web', { enabled: true }))).rejects.toMatchObject({ code: 'UNSUPPORTED' });
        await expect(f.adapter.plan(remove('nope'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a rename writes only the name; nothing to change is refused', async () => {
        const f = fortigate();
        const result = await run(f, update('block IoT to LAN', { name: 'iot stays out' }));
        expect(f.writes).toEqual([{ method: 'PUT', segments: ['firewall', 'policy', '5'], body: { name: 'iot stays out' } }]);
        expect(result.object).toMatchObject({ name: 'iot stays out', position: 2 });
        await expect(f.adapter.plan(update('iot stays out', { name: 'iot stays out', action: 'block', enabled: true, protocol: 'any' }))).rejects.toThrow('Nothing to change');
        await expect(f.adapter.plan(update('iot stays out', { name: 'LAN to internet' }))).rejects.toMatchObject({ code: 'EXISTS' });
    });

    it.each([
        ['a schedule', { schedule: { kind: 'during' as const, windows: [{ days: ['mon' as const], from: '22:00', to: '24:00' }] } }, 'rules.schedule'],
        ['replies matched', { replies: 'match' as const }, 'rules.stateful'],
        ['ports', { protocol: { tcpUdpPorts: '443' } }, 'rules.ports'],
    ])('a change to %s is refused (UNSUPPORTED)', async (_label, set, capability) => {
        const f = fortigate();
        await expect(f.adapter.plan(update('block IoT to LAN', set))).rejects.toMatchObject({ code: 'UNSUPPORTED', details: { capability } });
    });

    it('a change that puts one interface on both sides is refused', async () => {
        const f = fortigate();
        await expect(f.adapter.plan(update('block IoT to LAN', { to: [{ network: { name: 'iot' } }] }))).rejects.toThrow("inside 'iot'");
    });

    it('allow becomes block: NAT off, VIP traffic matched too', async () => {
        const f = fortigate();
        const plan = await f.adapter.plan(update('LAN to internet', { action: 'block' }));
        expect(plan.effects).toContain('NAT is switched off.');
        await f.adapter.apply(plan);
        expect(f.writes[0].body).toEqual({ action: 'deny', nat: 'disable', 'match-vip': 'enable' });
    });

    it('new addresses on one side make an object; the old one stays', async () => {
        const f = fortigate();
        await run(f, create({ name: 'a', from: [{ addresses: ['192.168.20.5'] }] }));
        f.writes.length = 0;
        const result = await run(f, update('a', { from: [{ addresses: ['192.168.20.6'] }], to: [{ network: { name: 'dmz' } }] }));
        expect(f.writes.map((w) => `${w.method} ${w.segments.join('/')}`)).toEqual(['POST firewall/address', 'PUT firewall/policy/8']);
        expect(f.state.addresses.some((a) => a.name === 'net-192.168.20.5')).toBe(true);
        expect(f.writes[1].body).toEqual({ srcaddr: intf('net-192.168.20.6'), dstintf: intf('dmz') });
        expect(result.object).toMatchObject({ from: [{ addresses: ['192.168.20.6'] }], to: [{ network: { id: 'dmz' } }] });
    });

    it('a change and a move: it moves first, then changes', async () => {
        const f = fortigate();
        const result = await run(f, update('block IoT to LAN', { protocol: 'tcp', position: 1 }));
        expect(f.writes.map((w) => [w.query ?? null, w.body ?? null])).toEqual([
            [{ action: 'move', before: '1' }, null],
            [null, { service: intf('ALL_TCP') }],
        ]);
        expect(result.object).toMatchObject({ protocol: 'tcp', position: 1 });
    });
});

describe('FortiGate policies: when something goes wrong', () => {
    it('the box changed after the plan: CONFLICT, nothing written', async () => {
        const f = fortigate();
        const plan = await f.adapter.plan(create());
        f.state.policies[0].status = 'disable';
        await expect(f.adapter.apply(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(f.writes).toEqual([]);
    });

    it('the policy refused: the address objects made for it are removed again', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => (w.segments[1] === 'policy' ? new FortiGateError('The FortiGate refused cmdb firewall/policy (HTTP 500, error -651)') : undefined);
        await expect(run(f, create({ from: [{ addresses: ['192.168.20.5'] }] }))).rejects.toThrow('-651');
        expect(f.writes.map((w) => `${w.method} ${w.segments.join('/')}`)).toEqual(['POST firewall/address', 'POST firewall/policy', 'DELETE firewall/address/net-192.168.20.5']);
        expect(f.state.addresses).toEqual(fx.addresses);
    });

    it('the answer to a new address object got lost and it was stored: it is removed again, nothing changed (Codex)', async () => {
        const f = fortigate();
        f.hooks.loseAnswer = (w) => (w.method === 'POST' && w.segments[1] === 'address' ? new FortiGateError('The FortiGate is not reachable', 'unreachable', true) : undefined);
        await expect(run(f, create({ from: [{ addresses: ['192.168.20.5'] }] }))).rejects.toThrow('nothing of this change was kept');
        expect(f.state.addresses).toEqual(fx.addresses);
        expect(f.state.policies).toEqual(fx.policies);
        const g = fortigate();
        g.hooks.loseAnswer = f.hooks.loseAnswer;
        await expect(run(g, update('block IoT to LAN', { to: [{ addresses: ['192.168.1.70'] }] }))).rejects.toThrow('nothing of this change was kept');
        expect(g.state.addresses).toEqual(fx.addresses);
        expect(g.state.policies).toEqual(fx.policies);
    });

    it('the answer to a new address object got lost and nothing was stored: nothing is removed, an object of that name saying something else stays', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => {
            if (w.method !== 'POST' || w.segments[1] !== 'address') return undefined;
            f.state.addresses.push({ name: 'net-192.168.20.5', type: 'ipmask', subnet: '192.168.20.5 255.255.255.255', comment: 'mine' });
            return new FortiGateError('The FortiGate is not reachable', 'unreachable', true);
        };
        await expect(run(f, create({ from: [{ addresses: ['192.168.20.5'] }] }))).rejects.toThrow('nothing of this change was kept');
        expect(f.writes.filter((w) => w.method === 'DELETE')).toEqual([]);
        expect(f.state.addresses.at(-1)).toMatchObject({ comment: 'mine' });
    });

    it('the answer to a new address object got lost: one of that name with our comment but another subnet stays', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => {
            if (w.method !== 'POST' || w.segments[1] !== 'address') return undefined;
            f.state.addresses.push({ name: 'net-192.168.20.5', type: 'ipmask', subnet: '192.168.20.6 255.255.255.255', comment: OWNED_ADDRESS_COMMENT });
            return new FortiGateError('The FortiGate is not reachable', 'unreachable', true);
        };
        await expect(run(f, create({ from: [{ addresses: ['192.168.20.5'] }] }))).rejects.toThrow('nothing of this change was kept');
        expect(f.writes.filter((w) => w.method === 'DELETE')).toEqual([]);
    });

    it('the answer to a new address object got lost and the check fails: CONFLICT', async () => {
        const f = fortigate();
        f.hooks.loseAnswer = (w) => (w.method === 'POST' && w.segments[1] === 'address' ? new FortiGateError('The FortiGate is not reachable', 'unreachable', true) : undefined);
        const read = f.adapter['client'].cmdb.bind(f.adapter['client']);
        let reads = 0;
        (f.adapter['client'] as { cmdb: typeof read }).cmdb = async (...args: Parameters<typeof read>) => {
            if (args.join('/') === 'firewall/address' && ++reads > 2) throw new FortiGateError('gone', 'unreachable');
            return await read(...args);
        };
        await expect(run(f, create({ from: [{ addresses: ['192.168.20.5'] }] }))).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('an address object refused: nothing else is written', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => (w.segments[1] === 'address' ? new FortiGateError('refused') : undefined);
        await expect(run(f, create({ from: [{ addresses: ['192.168.20.5'] }] }))).rejects.toThrow('refused');
        expect(f.writes).toHaveLength(1);
    });

    it('the answer to the new policy got lost: it is found by name and removed', async () => {
        const f = fortigate();
        f.hooks.loseAnswer = (w) => (w.method === 'POST' && w.segments[1] === 'policy' ? new FortiGateError('The FortiGate is not reachable', 'unreachable', true) : undefined);
        await expect(run(f, create())).rejects.toThrow('may or may not be stored; check net_listRules');
        expect(f.state.policies).toEqual(fx.policies);
    });

    it("the name was taken meanwhile and the new policy refused: the other admin's policy is left alone (Codex)", async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => {
            if (w.method !== 'POST' || w.segments[1] !== 'policy') return undefined;
            f.state.policies.push({ policyid: 40, name: 'block iot out', status: 'enable', srcintf: intf('iot'), dstintf: intf('wan1', 'wan2'), srcaddr: intf('all'), dstaddr: intf('all'), action: 'deny', service: intf('ALL'), schedule: 'always' });
            return new FortiGateError('The FortiGate refused cmdb firewall/policy (HTTP 500, error -651)');
        };
        await expect(run(f, create())).rejects.toThrow('-651');
        expect(f.state.policies.map((p) => p.policyid)).toContain(40);
        expect(f.writes.filter((w) => w.method === 'DELETE')).toEqual([]);
    });

    it('the answer got lost and nothing was stored: a same-named policy saying something else is left alone (Codex)', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => {
            if (w.method !== 'POST' || w.segments[1] !== 'policy') return undefined;
            f.state.policies.push({ policyid: 40, name: 'block iot out', status: 'disable', srcintf: intf('lan'), dstintf: intf('dmz'), srcaddr: intf('all'), dstaddr: intf('all'), action: 'deny', service: intf('ALL'), schedule: 'always' });
            return new FortiGateError('The FortiGate is not reachable', 'unreachable', true);
        };
        await expect(run(f, create())).rejects.toThrow('may or may not be stored');
        expect(f.state.policies.map((p) => p.policyid)).toContain(40);
        expect(f.writes.filter((w) => w.method === 'DELETE')).toEqual([]);
    });

    it('the answer got lost: a policy that was there before, renamed to this name meanwhile, is left alone', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => {
            if (w.method !== 'POST' || w.segments[1] !== 'policy') return undefined;
            f.state.policies[1] = { ...f.state.policies[1], name: 'x', status: 'disable' };
            return new FortiGateError('The FortiGate is not reachable', 'unreachable', true);
        };
        await expect(run(f, create({ name: 'x', to: [{ network: { name: 'Home LAN' } }] }))).rejects.toThrow('may or may not be stored');
        expect(f.state.policies.map((p) => p.policyid)).toContain(5);
        expect(f.writes.filter((w) => w.method === 'DELETE')).toEqual([]);
    });

    it('the answer got lost and two new policies say exactly what was written: CONFLICT, neither removed', async () => {
        const f = fortigate();
        f.hooks.loseAnswer = (w) => {
            if (w.method !== 'POST' || w.segments[1] !== 'policy') return undefined;
            f.state.policies.push({ ...f.state.policies.at(-1)!, policyid: 41 });
            return new FortiGateError('The FortiGate is not reachable', 'unreachable', true);
        };
        await expect(run(f, create())).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(f.state.policies).toHaveLength(fx.policies.length + 2);
        expect(f.writes.filter((w) => w.method === 'DELETE')).toEqual([]);
    });

    it('the new policy is said removed but is still there: CONFLICT', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => (w.query ? new FortiGateError('Command fail. Return code 1') : undefined);
        f.hooks.tamper = (w) => {
            if (w.method === 'DELETE' && w.segments[1] === 'policy') f.state.policies.push({ ...fx.policies[0], policyid: 8, name: 'block iot out' });
        };
        await expect(run(f, create({ position: 1 }))).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('may still be stored') });
    });

    it('no id in the answer and the policy found is not exactly the one written: CONFLICT, nothing removed', async () => {
        const f = fortigate();
        f.hooks.tamper = (w) => {
            if (w.method === 'POST' && w.segments[1] === 'policy') f.state.policies.at(-1)!.service = intf('ALL_UDP');
        };
        const write = f.adapter['client'].cmdbWrite.bind(f.adapter['client']);
        (f.adapter['client'] as { cmdbWrite: typeof write }).cmdbWrite = async (...args: Parameters<typeof write>) => {
            await write(...args);
            return {};
        };
        await expect(run(f, create())).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(f.writes.filter((w) => w.method === 'DELETE')).toEqual([]);
    });

    it('no id in the answer: it is looked up by name', async () => {
        const f = fortigate();
        const write = f.adapter['client'].cmdbWrite.bind(f.adapter['client']);
        (f.adapter['client'] as { cmdbWrite: typeof write }).cmdbWrite = async (...args: Parameters<typeof write>) => {
            await write(...args);
            return {};
        };
        const result = await run(f, create());
        expect(result.object).toMatchObject({ id: '8', enabled: true });
    });

    it('the move fails: the new policy is removed again and the failure passed on', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => (w.query ? new FortiGateError('Command fail. Return code 1') : undefined);
        await expect(run(f, create({ position: 1 }))).rejects.toThrow('Return code 1');
        expect(f.state.policies).toEqual(fx.policies);
    });

    it('switching on fails and it can\'t be removed: CONFLICT that says what may be left', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => (w.method !== 'POST' ? new FortiGateError('refused') : undefined);
        await expect(run(f, create({ from: [{ addresses: ['192.168.20.5'] }] }))).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('may still be stored') });
    });

    it('it reads back as something else: CONFLICT', async () => {
        const f = fortigate();
        f.hooks.tamper = (w) => {
            if (w.body?.status === 'enable') f.state.policies.at(-1)!.service = intf('ALL_UDP');
        };
        await expect(run(f, create())).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('shows something else') });
    });

    it('it reads back at another position, or as a policy the model cannot say: CONFLICT', async () => {
        const moved = fortigate();
        moved.hooks.tamper = (w) => {
            if (w.body?.status === 'enable') moved.state.policies.unshift(moved.state.policies.pop()!);
        };
        await expect(run(moved, create())).rejects.toMatchObject({ code: 'CONFLICT' });
        const foreign = fortigate();
        foreign.hooks.tamper = (w) => {
            if (w.body?.status === 'enable') foreign.state.policies.at(-1)!.schedule = 'school-nights';
        };
        await expect(run(foreign, create())).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('the move fails and an address object made for it won\'t go: CONFLICT that says what may be left', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => (w.query || (w.method === 'DELETE' && w.segments[1] === 'address') ? new FortiGateError('refused') : undefined);
        await expect(run(f, create({ position: 1, from: [{ addresses: ['192.168.20.5'] }] }))).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('address objects may be left') });
        expect(f.state.policies).toEqual(fx.policies);
    });

    it('reading back fails: applied, with a warning', async () => {
        const f = fortigate();
        const plan = await f.adapter.plan(remove('block IoT to LAN'));
        f.hooks.afterPolicyRead = (n) => {
            if (n === 2) throw new FortiGateError('gone', 'unreachable');
        };
        const result = await f.adapter.apply(plan);
        expect(result.warnings).toEqual(['The FortiGate accepted the policy change, but reading it back failed; check it with net_listRules.']);
    });

    it('a change after a move fails: it is moved back', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => (w.body ? new FortiGateError('refused') : undefined);
        await expect(run(f, update('block IoT to LAN', { protocol: 'tcp', position: 1 }))).rejects.toThrow('refused');
        expect(f.writes.map((w) => w.query ?? w.body)).toEqual([{ action: 'move', before: '1' }, { service: intf('ALL_TCP') }, { action: 'move', before: '3' }]);
        expect(f.state.policies).toEqual(fx.policies);
    });

    it('a change with a new address object is refused: the object made for it is removed again', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => (w.method === 'PUT' ? new FortiGateError('refused') : undefined);
        await expect(run(f, update('block IoT to LAN', { to: [{ addresses: ['192.168.1.70'] }] }))).rejects.toThrow('refused');
        expect(f.writes.map((w) => `${w.method} ${w.segments.join('/')}`)).toEqual(['POST firewall/address', 'PUT firewall/policy/5', 'DELETE firewall/address/net-192.168.1.70']);
        expect(f.state.addresses).toEqual(fx.addresses);
    });

    it('a change with a new address object gets no answer: the object stays (the change may use it), and said so', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => (w.method === 'PUT' ? new FortiGateError('The FortiGate is not reachable', 'unreachable', true) : undefined);
        await expect(run(f, update('block IoT to LAN', { to: [{ addresses: ['192.168.1.70'] }] }))).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('address objects made for it may be left') });
        expect(f.writes.filter((w) => w.method === 'DELETE')).toEqual([]);
    });

    it('a change after a move gets no answer: left where it is, and said so', async () => {
        const f = fortigate();
        f.hooks.failWrite = (w) => (w.body ? new FortiGateError('The FortiGate is not reachable', 'unreachable', true) : undefined);
        await expect(run(f, update('block IoT to LAN', { protocol: 'tcp', position: 1 }))).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('it is at position 1 (it was at 2)') });
        expect(f.writes).toHaveLength(2);
    });

    it('FORTIGATE_READ_ONLY refuses rules without reading', async () => {
        const f = fortigate({ readOnly: true });
        await expect(f.adapter.plan(create())).rejects.toMatchObject({ code: 'UNSUPPORTED', details: { capability: 'rules' } });
        expect((await f.adapter.capabilities()).rules.between).toBe('unsupported');
    });

    it('a plan this adapter did not make is planned again before anything is written', async () => {
        const f = fortigate();
        const forged = { change: create(), vendor: 'fortigate', steps: [], effects: [], wouldLockOut: [], basis: 'x' } as Plan;
        await expect(f.adapter.apply(forged)).rejects.toBeInstanceOf(NetError);
        expect(f.writes).toEqual([]);
    });
});
