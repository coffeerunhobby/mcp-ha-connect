/**
 * Ruijie traffic rules (2.5.6) against a fake router that keeps access_ctrl like the real one:
 * add and update take {list: [entry]}, delete {uuid: [...]}, a move {uuid, opt: "up" | "down"} (the
 * calls of the router's own page on ReyeeOS 2.430). Every change is planned, checked again right
 * before writing, and read back; no rule may cut off the router or this server.
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { RuijieNetworkController, toRule } from '../../src/net/adapters/ruijie.js';
import { NetError, type Change, type Network } from '../../src/net/model.js';
import { RuijieError, type RuijieClient } from '../../src/ruijieClient/index.js';

type Raw = Record<string, unknown>;
const fixture = (name: string): Raw => (JSON.parse(readFileSync(new URL(`./fixtures/ruijie/${name}.json`, import.meta.url), 'utf8')) as { data: Raw }).data;

const base = { enable: '1', by: 'ip', mac: '', src: 'lan', srcIP: '', srcPort: '', dest: 'wan', destIP: '', destPort: '', proto: 'all', netProto: 'ipv4', target: 'REJECT', state: '1,4', tmngtName: '所有时段', type: 'cycle' };
const OLD: Raw = { ...base, ruleName: 'old', uuid: 'U-OLD', ruleid: 'R1', enable: '0', target: 'DROP', state: '0', destIP: '10.99.99.99' };
/** The recorded LAN (192.168.110.0/24, protected) plus a second network nothing depends on. */
const twoLans = (): Raw => {
    const network = structuredClone(fixture('network'));
    (network.lan as Raw[]).push({ ipaddr: '10.20.0.1', netmask: '255.255.255.0', vlanid: '20', desc: 'IoT' });
    return network;
};

interface Over {
    readOnly?: boolean;
    entries?: Raw[];
    serverHosts?: string[];
    addAtTop?: boolean;
    write?: (method: string, data: Raw, count: number) => unknown;
    readBack?: () => Raw;
    readBackFails?: boolean;
}

function controller(over: Over = {}) {
    const state = { entries: structuredClone(over.entries ?? [OLD]) };
    const writes: Array<[string, Raw]> = [];
    let next = 0;
    const client = {
        host: '192.168.110.1',
        ...(over.readOnly !== undefined ? { readOnly: over.readOnly } : {}),
        config: async (module: string) => {
            if (module === 'network') return twoLans();
            if (module === 'access_ctrl') {
                if (writes.length && over.readBackFails) throw new RuijieError('The Ruijie router is not reachable', 'unreachable');
                if (writes.length && over.readBack) return over.readBack();
                return { list: structuredClone(state.entries) };
            }
            throw new Error(`unexpected config ${module}`);
        },
        status: async (module: string) => {
            if (module === 'sysinfo') return fixture('sysinfo');
            if (module === 'arp') return fixture('arp');
            if (module === 'dhcp_lease') return fixture('dhcp_lease');
            throw new Error(`unexpected status ${module}`);
        },
        call: async (method: string, module: string, data: Raw) => {
            if (module !== 'access_ctrl') throw new Error(`unexpected ${method} ${module}`);
            writes.push([method, structuredClone(data)]);
            if (over.write) {
                const answer = over.write(method, data, writes.length);
                if (answer !== undefined) return answer;
            }
            if (method === 'devConfig.add') {
                for (const e of data.list as Raw[]) {
                    const stored = { ...e, uuid: `U${++next}`, ruleid: `R${next}0`, type: 'cycle' };
                    if (over.addAtTop) state.entries.unshift(stored);
                    else state.entries.push(stored);
                }
            }
            if (method === 'devConfig.update' && data.list) {
                for (const e of data.list as Raw[]) state.entries = state.entries.map((r) => (r.uuid === e.uuid ? structuredClone(e) : r));
            }
            if (method === 'devConfig.update' && data.opt) {
                const at = state.entries.findIndex((r) => r.uuid === data.uuid);
                const [entry] = state.entries.splice(at, 1);
                state.entries.splice(at + (data.opt === 'down' ? 1 : -1), 0, entry);
            }
            if (method === 'devConfig.del') state.entries = state.entries.filter((r) => !(data.uuid as string[]).includes(r.uuid as string));
            return { message: 'Configuration success', rcode: '00000000' };
        },
    } as unknown as RuijieClient;
    const net = new RuijieNetworkController(client, over.serverHosts ? { serverHosts: over.serverHosts } : {});
    return { net, state, writes, apply: async (change: Change) => net.apply(await net.plan(change)) };
}

const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof NetError ? e.code : `not a NetError: ${String(e)}`));
type Value = Extract<Change, { op: 'create'; kind: 'rule' }>['value'];
const create = (over: Partial<Value> = {}): Change => ({
    op: 'create',
    kind: 'rule',
    value: { name: 'iot-out', action: 'block', from: [{ network: { name: 'IoT' } }], to: [{ internet: true }], protocol: 'any', replies: 'allow', schedule: { kind: 'always' }, enabled: true, ...over },
});
const update = (name: string, set: Extract<Change, { op: 'update'; kind: 'rule' }>['value']['set']): Change => ({ op: 'update', kind: 'rule', value: { ref: { name }, set } });
const added = (writes: Array<[string, Raw]>) => (writes.find(([m]) => m === 'devConfig.add')![1].list as Raw[])[0];

describe('Ruijie rules: reading what the page writes', () => {
    const LAN: Network[] = [{ id: 'vlan233', name: 'LAN', purpose: 'normal', vlan: 233, gateway: '192.168.110.1/24', ipv6: false, isolated: false, protected: true }];

    it('reads a block on new and invalid connections as letting replies pass, in either order', () => {
        expect(toRule({ ...base, target: 'REJECT', state: '1,4' }, 0, LAN)).toMatchObject({ action: 'block', replies: 'allow' });
        expect(toRule({ ...base, target: 'REJECT', state: '4,1' }, 0, LAN).foreign).toBeUndefined();
    });

    it('reads every state as a block on replies too, and an allow as letting them pass', () => {
        expect(toRule({ ...base, target: 'DROP', state: '0' }, 0, LAN)).toMatchObject({ action: 'block', replies: 'match' });
        expect(toRule({ ...base, target: 'ACCEPT', state: '0' }, 0, LAN)).toMatchObject({ action: 'allow', replies: 'allow' });
    });

    it('keeps a device rule the page wouldn\'t write read-only', () => {
        const device = { ...base, by: 'mac', mac: '02:aa:bb:cc:dd:ee' };
        expect(toRule(device, 0, LAN).foreign).toBeUndefined();
        for (const odd of [{ dest: 'vlan233' }, { destIP: '8.8.8.8' }, { srcIP: '192.168.110.5' }, { proto: 'tcp' }, { proto: 'tcpudp', destPort: '80' }]) {
            expect(toRule({ ...device, ...odd }, 0, LAN).foreign?.reason).toContain('a device match');
        }
    });

    it('keeps a rule matching some other way read-only', () => {
        expect(toRule({ ...base, by: 'user' }, 0, LAN).foreign?.reason).toContain("a match by 'user'");
        expect(toRule({ ...base, by: '' }, 0, LAN).foreign).toBeUndefined();
    });

    it('keeps other connection states read-only', () => {
        expect(toRule({ ...base, state: '1' }, 0, LAN).foreign?.reason).toContain('only some connection states (1)');
        expect(toRule({ ...base, target: 'ACCEPT', state: '1,4' }, 0, LAN).foreign?.reason).toContain('only some connection states');
    });
});

describe('Ruijie rules: creating', () => {
    it('says it can, unless changes are switched off', async () => {
        expect((await controller().net.capabilities()).rules).toMatchObject({ between: 'native', toInternet: 'native', deviceMatch: 'native', stateful: 'native', wifiMatch: 'unsupported', schedule: 'unsupported' });
        expect((await controller({ readOnly: true }).net.capabilities()).rules.between).toBe('unsupported');
        expect(await code(controller({ readOnly: true }).net.plan(create()))).toBe('UNSUPPORTED');
    });

    it('a dry run writes nothing and says what happens', async () => {
        const { net, writes } = controller();
        const plan = await net.plan(create());
        expect(writes).toEqual([]);
        expect(plan.steps).toEqual([{ action: 'create', object: 'ruijie.access_ctrl', name: 'iot-out', detail: 'block vlan20 to the internet (all)' }]);
        expect(plan.effects.join(' ')).toContain('It is rule 2 of 2');
        expect(plan.effects.join(' ')).toContain('connections the other side starts still work');
        expect(plan.wouldLockOut).toEqual([]);
    });

    it('adds a block like the page (REJECT on new and invalid), switched off, then switches it on, and reads it back', async () => {
        const { state, writes, apply } = controller();
        const result = await apply(create());
        expect(writes.map(([m]) => m)).toEqual(['devConfig.add', 'devConfig.update']);
        expect(added(writes)).toEqual({ ruleName: 'iot-out', enable: '0', by: 'ip', mac: '', src: 'vlan20', srcIP: '', srcPort: '', dest: 'wan', destIP: '', proto: 'all', destPort: '', netProto: 'ipv4', target: 'REJECT', state: '1,4', tmngtName: '所有时段' });
        // The switch-on is the entry exactly as stored, with its id.
        expect(writes[1][1]).toEqual({ list: [{ ...added(writes), enable: '1', uuid: 'U1', ruleid: 'R10', type: 'cycle' }] });
        expect(state.entries.map((e) => e.ruleName)).toEqual(['old', 'iot-out']);
        expect(result).toEqual({ applied: true, owned: [], object: { id: 'U1', name: 'iot-out', action: 'block', from: [{ network: { id: 'vlan20' } }], to: [{ internet: true }], protocol: 'any', replies: 'allow', schedule: { kind: 'always' }, enabled: true, position: 2 } });
    });

    it('adds an allow as ACCEPT on every state', async () => {
        const { writes, apply } = controller();
        const result = await apply(create({ action: 'allow' }));
        expect(added(writes)).toMatchObject({ target: 'ACCEPT', state: '0' });
        expect(result.object).toMatchObject({ action: 'allow', replies: 'allow' });
    });

    it('stays switched off when asked: only the add is written', async () => {
        const { writes, apply } = controller();
        const result = await apply(create({ enabled: false }));
        expect(writes.map(([m]) => m)).toEqual(['devConfig.add']);
        expect(result.object).toMatchObject({ enabled: false });
    });

    it('moves it into place one step at a time while it is off, wherever the router put it', async () => {
        const { state, writes, apply } = controller({ addAtTop: true, entries: [OLD, { ...OLD, ruleName: 'old2', uuid: 'U-OLD2' }] });
        await apply(create());
        expect(writes.map(([m, d]) => (d.opt ? `move ${String(d.opt)}` : m))).toEqual(['devConfig.add', 'move down', 'move down', 'devConfig.update']);
        expect(writes[1][1]).toEqual({ uuid: 'U1', opt: 'down' });
        expect(state.entries.map((e) => e.ruleName)).toEqual(['old', 'old2', 'iot-out']);
    });

    it('puts it at the position asked for', async () => {
        const { state, writes, apply } = controller();
        const result = await apply(create({ position: 1 }));
        expect(writes.map(([m, d]) => (d.opt ? `move ${String(d.opt)}` : m))).toEqual(['devConfig.add', 'move up', 'devConfig.update']);
        expect(state.entries.map((e) => e.ruleName)).toEqual(['iot-out', 'old']);
        expect(result.object).toMatchObject({ position: 1 });
        expect(await code(controller().net.plan(create({ position: 3 })))).toBe('INVALID');
        expect(await code(controller().net.plan(create({ position: 0 })))).toBe('INVALID');
    });

    it('maps addresses to the side they are on', async () => {
        const inside = controller();
        await inside.apply(create({ from: [{ addresses: ['192.168.110.50'] }], to: [{ addresses: ['10.20.0.0/24'] }], name: 'a' }));
        expect(added(inside.writes)).toMatchObject({ src: 'lan', srcIP: '192.168.110.50', dest: 'lan', destIP: '10.20.0.0/24' });
        const outside = controller();
        const result = await outside.apply(create({ to: [{ addresses: ['8.8.8.8'] }], name: 'b' }));
        expect(added(outside.writes)).toMatchObject({ src: 'vlan20', dest: 'wan', destIP: '8.8.8.8' });
        expect(result.object).toMatchObject({ to: [{ addresses: ['8.8.8.8'] }] });
    });

    it('maps networks, protocols and one port', async () => {
        const nets = controller();
        await nets.apply(create({ from: [{ network: { name: 'IoT' } }], to: [{ network: { name: 'LAN' } }] }));
        expect(added(nets.writes)).toMatchObject({ src: 'vlan20', dest: 'vlan233', destIP: '' });
        const tcp = controller();
        await tcp.apply(create({ protocol: 'tcp' }));
        expect(added(tcp.writes)).toMatchObject({ proto: 'tcp', destPort: '' });
        const port = controller();
        const result = await port.apply(create({ protocol: { tcpUdpPorts: ' 8123 ' }, to: [{ addresses: ['8.8.8.8'] }] }));
        expect(added(port.writes)).toMatchObject({ proto: 'tcpudp', destPort: '8123' });
        expect(result.object).toMatchObject({ protocol: { tcpUdpPorts: '8123' } });
    });

    it('takes a device by MAC, lower case with colons, towards the whole internet only', async () => {
        const { writes, apply } = controller({ serverHosts: ['192.168.110.3'] });
        const result = await apply(create({ from: [{ device: '02-AA-BB-CC-DD-EE' }] }));
        expect(added(writes)).toMatchObject({ by: 'mac', mac: '02:aa:bb:cc:dd:ee', src: 'lan', dest: 'wan', destIP: '', proto: 'all' });
        expect(result.object).toMatchObject({ from: [{ device: '02-AA-BB-CC-DD-EE' }], to: [{ internet: true }] });
        expect(await code(controller().net.plan(create({ from: [{ device: '02-AA-BB-CC-DD-EE' }], to: [{ addresses: ['8.8.8.8'] }] })))).toBe('UNSUPPORTED');
        expect(await code(controller().net.plan(create({ from: [{ device: '02-AA-BB-CC-DD-EE' }], protocol: 'tcp' })))).toBe('UNSUPPORTED');
        expect(await code(controller().net.plan(create({ from: [{ device: 'FF-FF-FF-FF-FF-FF' }] })))).toBe('INVALID');
    });

    it.each<[string, Partial<Value>, string]>([
        ['a name too long', { name: 'x'.repeat(29) }, 'INVALID'],
        ['an empty name', { name: '  ' }, 'INVALID'],
        ['a name that could reach the router\'s commands', { name: 'a;reboot' }, 'INVALID'],
        ['a name with a quote', { name: 'a"b' }, 'INVALID'],
        ['a name already used, in another case', { name: 'OLD' }, 'EXISTS'],
        ['two sources', { from: [{ network: { name: 'IoT' } }, { network: { name: 'LAN' } }] }, 'INVALID'],
        ['two destinations', { to: [{ addresses: ['8.8.8.8'] }, { addresses: ['1.1.1.1'] }] }, 'INVALID'],
        ['two addresses in one', { to: [{ addresses: ['8.8.8.8', '1.1.1.1'] }] }, 'INVALID'],
        ['a source outside the networks', { from: [{ addresses: ['8.8.8.8'] }] }, 'INVALID'],
        ['the internet as a source', { from: [{ internet: true }] }, 'INVALID'],
        ['the router as a source', { from: [{ gateway: true }] }, 'INVALID'],
        ['Wi-Fi as a source', { from: [{ wifi: { name: 'x' } }] }, 'UNSUPPORTED'],
        ['a group as a source', { from: [{ group: { name: 'x' } }] }, 'UNSUPPORTED'],
        ['a group as a destination', { to: [{ group: { name: 'x' } }] }, 'UNSUPPORTED'],
        ['the router as a destination', { to: [{ gateway: true }] }, 'UNSUPPORTED'],
        ['a device as a destination', { to: [{ device: '02-AA-BB-CC-DD-EE' }] }, 'INVALID'],
        ['an address across a network edge', { to: [{ addresses: ['10.20.0.0/16'] }] }, 'INVALID'],
        ['an address that is no address', { to: [{ addresses: ['nope'] }] }, 'INVALID'],
        ['everything as an address', { to: [{ addresses: ['0.0.0.0/0'] }] }, 'INVALID'],
        ['one network to itself', { to: [{ network: { name: 'IoT' } }] }, 'INVALID'],
        ['an unknown network', { from: [{ network: { name: 'nope' } }] }, 'NOT_FOUND'],
        ['several ports', { protocol: { tcpUdpPorts: '80,443' } }, 'UNSUPPORTED'],
        ['a port range', { protocol: { tcpUdpPorts: '80-90' } }, 'UNSUPPORTED'],
        ['no port', { protocol: { tcpUdpPorts: '99999' } }, 'INVALID'],
        ['a schedule', { schedule: { kind: 'during', windows: [{ days: ['mon'], from: '22:00', to: '24:00' }] } }, 'UNSUPPORTED'],
        ['a block that also stops replies', { replies: 'match' }, 'UNSUPPORTED'],
    ])('refuses %s, writing nothing', async (_what, over, expected) => {
        const { net, writes } = controller();
        expect(await code(net.plan(create(over)))).toBe(expected);
        expect(writes).toEqual([]);
    });
});

describe('Ruijie rules: what stays online', () => {
    const toInternet = (from: Value['from']) => create({ from });

    it('never blocks a protected network or every network from the internet', async () => {
        expect(await code(controller().net.plan(toInternet([{ network: { name: 'LAN' } }])))).toBe('PROTECTED');
        expect(await code(controller({ serverHosts: ['10.99.0.1'] }).net.plan(toInternet([{ network: { name: 'LAN' } }])))).toBe('PROTECTED');
    });

    it('blocks a whole other network, unless this server is on it', async () => {
        expect(await code(controller().net.plan(create()))).toBe('ok');
        expect(await code(controller({ serverHosts: ['10.20.0.5'] }).net.plan(create()))).toBe('PROTECTED');
    });

    it('blocks one address from the internet only when it knows that is not this server', async () => {
        const one = [{ addresses: ['192.168.110.50'] }];
        expect(await code(controller().net.plan(toInternet(one)))).toBe('PROTECTED');
        expect(await code(controller({ serverHosts: ['server.lan'] }).net.plan(toInternet(one)))).toBe('PROTECTED');
        expect(await code(controller({ serverHosts: ['192.168.110.3'] }).net.plan(toInternet(one)))).toBe('ok');
        expect(await code(controller({ serverHosts: ['192.168.110.50'] }).net.plan(toInternet(one)))).toBe('PROTECTED');
        expect(await code(controller({ serverHosts: ['192.168.110.3'] }).net.plan(toInternet([{ addresses: ['192.168.110.0/25'] }])))).toBe('PROTECTED');
    });

    it('blocks an online device only when it knows that is not this server; an offline one can\'t be it', async () => {
        const online = [{ device: '02:00:00:00:00:03' }];
        expect(await code(controller().net.plan(toInternet(online)))).toBe('PROTECTED');
        expect(await code(controller({ serverHosts: ['192.168.110.2'] }).net.plan(toInternet(online)))).toBe('PROTECTED');
        expect(await code(controller({ serverHosts: ['192.168.110.3'] }).net.plan(toInternet(online)))).toBe('ok');
        expect(await code(controller().net.plan(toInternet([{ device: '02-AA-BB-CC-DD-EE' }])))).toBe('ok');
    });

    it('treats one outside address like the internet: it may be a relay this server needs', async () => {
        const to = [{ addresses: ['8.8.8.8'] }];
        expect(await code(controller().net.plan(create({ from: [{ network: { name: 'LAN' } }], to })))).toBe('PROTECTED');
        expect(await code(controller({ serverHosts: ['192.168.110.3'] }).net.plan(create({ from: [{ addresses: ['192.168.110.3'] }], to })))).toBe('PROTECTED');
        expect(await code(controller({ serverHosts: ['192.168.110.3'] }).net.plan(create({ from: [{ addresses: ['192.168.110.99'] }], to })))).toBe('ok');
        expect(await code(controller().net.plan(create({ to })))).toBe('ok');
    });

    it('a block between its own networks is no danger to the internet path', async () => {
        const to = [{ addresses: ['10.20.0.5'] }];
        expect(await code(controller().net.plan(create({ from: [{ network: { name: 'LAN' } }], to })))).toBe('ok');
    });

    it('blocking a network from the router\'s network is the point, unless that network may hold this server', async () => {
        const lan = [{ network: { name: 'LAN' } }];
        expect(await code(controller().net.plan(create({ to: lan })))).toBe('ok');
        expect(await code(controller({ serverHosts: ['192.168.110.3'] }).net.plan(create({ to: lan })))).toBe('ok');
        expect(await code(controller({ serverHosts: ['10.20.0.5'] }).net.plan(create({ to: lan })))).toBe('PROTECTED');
        expect(await code(controller({ serverHosts: ['10.20.0.5'] }).net.plan(create({ from: [{ addresses: ['10.20.0.9'] }], to: lan })))).toBe('ok');
        expect(await code(controller({ serverHosts: ['10.20.0.5'] }).net.plan(create({ from: [{ addresses: ['10.20.0.5'] }], to: lan })))).toBe('PROTECTED');
        // The other way: towards a network holding only other devices nothing is at stake, towards this server's it is.
        expect(await code(controller({ serverHosts: ['192.168.110.3'] }).net.plan(create({ from: lan, to: [{ network: { name: 'IoT' } }] })))).toBe('ok');
        expect(await code(controller({ serverHosts: ['10.20.0.5'] }).net.plan(create({ from: lan, to: [{ network: { name: 'IoT' } }] })))).toBe('PROTECTED');
    });

    it('never blocks the router or this server as a destination', async () => {
        expect(await code(controller().net.plan(create({ from: [{ network: { name: 'IoT' } }], to: [{ addresses: ['192.168.110.1'] }] })))).toBe('PROTECTED');
        expect(await code(controller().net.plan(create({ from: [{ network: { name: 'IoT' } }], to: [{ addresses: ['192.168.110.0/24'] }] })))).toBe('PROTECTED');
        expect(await code(controller({ serverHosts: ['192.168.110.3'] }).net.plan(create({ from: [{ network: { name: 'IoT' } }], to: [{ addresses: ['192.168.110.3'] }] })))).toBe('PROTECTED');
        // Switched off it blocks nothing yet; switching it on is checked then.
        expect(await code(controller().net.plan(create({ from: [{ network: { name: 'IoT' } }], to: [{ addresses: ['192.168.110.1'] }], enabled: false })))).toBe('ok');
    });

    const allowAll: Raw = { ...base, ruleName: 'all-out', uuid: 'U-ALLOW', target: 'ACCEPT', state: '0' };
    const blockAll: Raw = { ...base, ruleName: 'stop', uuid: 'U-BLOCK' };

    it('sees a block rule below an allow for everyone as harmless, and refuses what uncovers it', async () => {
        const entries = [allowAll, blockAll];
        expect(await code(controller({ entries }).net.plan({ op: 'delete', kind: 'rule', ref: { name: 'all-out' } }))).toBe('PROTECTED');
        expect(await code(controller({ entries }).net.plan(update('all-out', { enabled: false })))).toBe('PROTECTED');
        expect(await code(controller({ entries }).net.plan(update('all-out', { action: 'block' })))).toBe('PROTECTED');
        expect(await code(controller({ entries }).net.plan({ op: 'move', kind: 'rule', ref: { name: 'stop' }, position: 1 }))).toBe('PROTECTED');
        expect(await code(controller({ entries }).net.plan({ op: 'move', kind: 'rule', ref: { name: 'all-out' }, position: 2 }))).toBe('PROTECTED');
        expect(await code(controller({ entries }).net.plan(update('stop', { name: 'stop2' })))).toBe('ok');
        expect(await code(controller({ entries }).net.plan({ op: 'delete', kind: 'rule', ref: { name: 'stop' } }))).toBe('ok');
    });

    it.each<[string, Raw]>([
        ['some connection states', { state: '1' }],
        ['a schedule', { tmngtName: 'evenings' }],
        ['source ports', { srcPort: '1234' }],
        ['destination ports', { destPort: '443', proto: 'tcpudp' }],
        ['one protocol', { proto: 'tcp' }],
        ['user groups', { userGroupList: ['kids'] }],
        ['IPv6', { netProto: 'ipv6' }],
        ['a device', { by: 'mac', mac: '02:aa:bb:cc:dd:ee' }],
    ])('an allow limited by %s shields nothing below it', async (_what, limit) => {
        const entries = [{ ...allowAll, ...limit }];
        const below = create({ from: [{ network: { name: 'LAN' } }] });
        expect(await code(controller({ entries: [allowAll] }).net.plan(below))).toBe('ok');
        expect(await code(controller({ entries }).net.plan(below))).toBe('PROTECTED');
    });

    it('checks every place a rule passes through when an update moves it', async () => {
        const between: Raw = { ...base, ruleName: 'b', uuid: 'U-B', enable: '0', destIP: '8.8.8.8' };
        const entries = [{ ...allowAll, ruleName: 'top', uuid: 'U-T' }, { ...base, ruleName: 'stop', uuid: 'U-S', enable: '1', src: 'vlan20' }, between];
        // Past the allow it is harmless at the end, but it can't go above it even for a moment.
        const stop = { ...base, ruleName: 'stop', uuid: 'U-S' };
        expect(await code(controller({ entries: [allowAll, stop, between] }).net.plan(update('stop', { position: 1 })))).toBe('PROTECTED');
        expect(await code(controller({ entries: [between, allowAll, stop] }).net.plan(update('all-out', { position: 3 })))).toBe('PROTECTED');
        expect(await code(controller({ entries }).net.plan(update('b', { position: 2 })))).toBe('ok');
    });

    it('refuses switching on or widening a rule into a cut-off', async () => {
        const off: Raw = { ...base, ruleName: 'off', uuid: 'U-OFF', enable: '0' };
        expect(await code(controller({ entries: [off] }).net.plan(update('off', { enabled: true })))).toBe('PROTECTED');
        const narrow: Raw = { ...base, ruleName: 'narrow', uuid: 'U-N', destIP: '8.8.8.8' };
        expect(await code(controller({ entries: [narrow] }).net.plan(update('narrow', { to: [{ internet: true }] })))).toBe('PROTECTED');
        const router: Raw = { ...base, ruleName: 'r', uuid: 'U-R', enable: '0', src: 'vlan20', dest: 'lan', destIP: '192.168.110.1' };
        expect(await code(controller({ entries: [router] }).net.plan(update('r', { enabled: true })))).toBe('PROTECTED');
    });

    it.each<[string, Raw, Parameters<typeof update>[1]]>([
        ['a protocol', { proto: 'tcp' }, { protocol: 'any' }],
        ['a port', { proto: 'tcpudp', destPort: '80' }, { protocol: { tcpUdpPorts: '443' } }],
        ['a destination', { destIP: '8.8.8.8' }, { to: [{ internet: true }] }],
    ])('widening %s on a rule already there is a new danger', async (_what, limit, set) => {
        const entries = [{ ...base, ruleName: 'part', uuid: 'U-P', ...limit }];
        expect(await code(controller({ entries }).net.plan(update('part', set)))).toBe('PROTECTED');
    });

    it('leaves a danger already there alone rather than blocking unrelated changes to it', async () => {
        expect(await code(controller({ entries: [blockAll] }).net.plan(update('stop', { name: 'stop2' })))).toBe('ok');
    });

    it('fails closed on a source it can\'t read', async () => {
        const odd: Raw = { ...base, ruleName: 'odd', uuid: 'U-ODD', enable: '0', src: 'wan0' };
        const list = await controller({ entries: [odd] }).net.listRules();
        expect(list[0].foreign).toBeDefined();
        const unreadable: Raw = { ...base, ruleName: 'u', uuid: 'U-U', srcIP: 'nope', enable: '1' };
        // Already on the router and foreign, but a new rule below it still plans; a new danger only counts when it is new.
        expect(await code(controller({ entries: [unreadable] }).net.plan(create()))).toBe('ok');
    });
});

describe('Ruijie rules: deleting and moving', () => {
    it('deletes by uuid and reads it back', async () => {
        const { net, state, writes, apply } = controller();
        const plan = await net.plan({ op: 'delete', kind: 'rule', ref: { name: 'old' } });
        expect(plan.steps).toEqual([{ action: 'delete', object: 'ruijie.access_ctrl', name: 'old' }]);
        expect(plan.effects[0]).toContain('it was switched off');
        expect(await apply({ op: 'delete', kind: 'rule', ref: { name: 'old' } })).toEqual({ applied: true, owned: [] });
        expect(writes).toEqual([['devConfig.del', { uuid: ['U-OLD'] }]]);
        expect(state.entries).toEqual([]);
    });

    it('finds a rule by id or name; an unknown one is NOT_FOUND', async () => {
        expect(await code(controller().net.plan({ op: 'delete', kind: 'rule', ref: { id: 'U-OLD' } }))).toBe('ok');
        expect(await code(controller().net.plan({ op: 'delete', kind: 'rule', ref: { name: 'nope' } }))).toBe('NOT_FOUND');
    });

    it('never changes a rule the model can\'t express', async () => {
        const foreign: Raw = { ...base, ruleName: 'hand', uuid: 'U-H', srcPort: '1234', enable: '0' };
        for (const change of [{ op: 'delete', kind: 'rule', ref: { name: 'hand' } }, { op: 'move', kind: 'rule', ref: { name: 'hand' }, position: 2 }, update('hand', { name: 'x' })] as Change[]) {
            const { net, writes } = controller({ entries: [foreign, OLD] });
            await expect(net.plan(change)).rejects.toMatchObject({ code: 'UNSUPPORTED', details: { capability: 'rule' } });
            expect(writes).toEqual([]);
        }
    });

    it('refuses a rule the router gives no id', async () => {
        const { uuid: _uuid, ...noId } = OLD;
        expect(await code(controller({ entries: [{ ...noId, ruleid: 'R1' }] }).net.plan({ op: 'delete', kind: 'rule', ref: { name: 'old' } }))).toBe('INVALID');
    });

    const three = [OLD, { ...OLD, ruleName: 'b', uuid: 'U-B', ruleid: 'R2' }, { ...OLD, ruleName: 'c', uuid: 'U-C', ruleid: 'R3' }];

    it('moves one place per call, up or down, and reads it back', async () => {
        const down = controller({ entries: three });
        const result = await down.apply({ op: 'move', kind: 'rule', ref: { name: 'old' }, position: 3 });
        expect(down.writes).toEqual([['devConfig.update', { uuid: 'U-OLD', opt: 'down' }], ['devConfig.update', { uuid: 'U-OLD', opt: 'down' }]]);
        expect(down.state.entries.map((e) => e.ruleName)).toEqual(['b', 'c', 'old']);
        expect(result.object).toMatchObject({ name: 'old', position: 3 });
        const up = controller({ entries: three });
        await up.apply({ op: 'move', kind: 'rule', ref: { name: 'c' }, position: 2 });
        expect(up.writes).toEqual([['devConfig.update', { uuid: 'U-C', opt: 'up' }]]);
    });

    it('refuses a move to where it is, or off the list', async () => {
        expect(await code(controller({ entries: three }).net.plan({ op: 'move', kind: 'rule', ref: { name: 'old' }, position: 1 }))).toBe('INVALID');
        expect(await code(controller({ entries: three }).net.plan({ op: 'move', kind: 'rule', ref: { name: 'old' }, position: 4 }))).toBe('INVALID');
    });
});

describe('Ruijie rules: changing', () => {
    it('keeps what wasn\'t asked for, as the router stores it', async () => {
        const old = { ...OLD, src: 'vlan20' };
        const { state, writes, apply } = controller({ entries: [old] });
        const result = await apply(update('old', { enabled: true }));
        expect(writes).toEqual([['devConfig.update', { list: [{ ...old, enable: '1' }] }]]);
        expect(state.entries[0]).toMatchObject({ target: 'DROP', state: '0', enable: '1', src: 'vlan20' });
        expect(result.object).toMatchObject({ enabled: true, replies: 'match' });
    });

    it('renames, refusing a name in use', async () => {
        const { state, apply } = controller();
        await apply(update('old', { name: 'new' }));
        expect(state.entries[0].ruleName).toBe('new');
        expect(await code(controller({ entries: [OLD, { ...OLD, ruleName: 'b', uuid: 'U-B' }] }).net.plan(update('old', { name: 'B' })))).toBe('EXISTS');
        expect(await code(controller().net.plan(update('old', { name: 'OLD' })))).toBe('ok');
        expect(await code(controller().net.plan(update('old', { name: 'a|b' })))).toBe('INVALID');
    });

    it('a new action takes what the page writes for it; the same action keeps the entry', async () => {
        const allow = controller();
        await allow.apply(update('old', { action: 'allow' }));
        expect(allow.state.entries[0]).toMatchObject({ target: 'ACCEPT', state: '0' });
        const block = controller({ entries: [{ ...OLD, target: 'ACCEPT' }] });
        await block.apply(update('old', { action: 'block' }));
        expect(block.state.entries[0]).toMatchObject({ target: 'REJECT', state: '1,4' });
        const same = controller();
        await same.apply(update('old', { action: 'block', name: 'x' }));
        expect(same.state.entries[0]).toMatchObject({ target: 'DROP', state: '0' });
    });

    it('changes a side, and only that side', async () => {
        const { state, apply } = controller();
        await apply(update('old', { to: [{ addresses: ['1.1.1.1'] }], protocol: 'udp' }));
        expect(state.entries[0]).toMatchObject({ src: 'lan', srcIP: '', dest: 'wan', destIP: '1.1.1.1', proto: 'udp', uuid: 'U-OLD', ruleid: 'R1' });
    });

    it('checks the rule as a whole: a device rule stays towards the whole internet', async () => {
        const device: Raw = { ...base, ruleName: 'kid', uuid: 'U-K', by: 'mac', mac: '02:aa:bb:cc:dd:ee', enable: '0' };
        expect(await code(controller({ entries: [device] }).net.plan(update('kid', { to: [{ addresses: ['8.8.8.8'] }] })))).toBe('UNSUPPORTED');
        expect(await code(controller({ entries: [device] }).net.plan(update('kid', { protocol: 'tcp' })))).toBe('UNSUPPORTED');
    });

    it('a changed, enabled rule that moves is switched off until it is in place', async () => {
        const entries = [{ ...OLD, enable: '1', src: 'vlan20', destIP: '8.8.8.8' }, { ...OLD, ruleName: 'b', uuid: 'U-B' }];
        const { state, writes, apply } = controller({ entries });
        await apply(update('old', { to: [{ addresses: ['1.1.1.1'] }], position: 2 }));
        expect(writes.map(([, d]) => (d.opt ? `move ${String(d.opt)}` : (d.list as Raw[])[0].enable))).toEqual(['0', 'move down', '1']);
        expect(state.entries.map((e) => e.ruleName)).toEqual(['b', 'old']);
    });

    it('only moves when only the position changes', async () => {
        const entries = [OLD, { ...OLD, ruleName: 'b', uuid: 'U-B' }];
        const { writes, apply } = controller({ entries });
        await apply(update('old', { position: 2 }));
        expect(writes).toEqual([['devConfig.update', { uuid: 'U-OLD', opt: 'down' }]]);
    });

    it('refuses nothing to change, and a schedule', async () => {
        expect(await code(controller().net.plan(update('old', {})))).toBe('INVALID');
        expect(await code(controller().net.plan(update('old', { enabled: false })))).toBe('INVALID');
        expect(await code(controller().net.plan(update('old', { position: 1 })))).toBe('INVALID');
        expect(await code(controller().net.plan(update('old', { schedule: { kind: 'during', windows: [{ days: ['mon'], from: '22:00', to: '24:00' }] } })))).toBe('UNSUPPORTED');
    });
});

describe('Ruijie rules: when the router differs or fails', () => {
    it('a list changed since the plan is a CONFLICT and nothing is written', async () => {
        const { net, state, writes } = controller();
        const plan = await net.plan(create());
        state.entries.push({ ...OLD, ruleName: 'late', uuid: 'U-L' });
        await expect(net.apply(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(writes).toEqual([]);
    });

    it('the basis names the change', async () => {
        const { net } = controller();
        expect((await net.plan(create())).basis).toBe((await net.plan(create())).basis);
        expect((await net.plan(create())).basis).not.toBe((await net.plan(create({ name: 'other' }))).basis);
    });

    it('a refused add stops there and leaves nothing', async () => {
        const { state, writes, apply } = controller({
            write: () => {
                throw new RuijieError('The Ruijie router refused the call', 'refused');
            },
        });
        await expect(apply(create())).rejects.toBeInstanceOf(RuijieError);
        expect(writes).toHaveLength(1);
        expect(state.entries).toHaveLength(1);
    });

    it('an add sent but unanswered says it may be stored', async () => {
        const { apply } = controller({
            write: () => {
                throw new RuijieError('The Ruijie router is not reachable', 'unreachable', false);
            },
        });
        await expect(apply(create())).rejects.toThrow(/may or may not be done; check net_listRules/);
    });

    it('a failed switch-on removes the new rule again and reports the failure', async () => {
        const { state, writes, apply } = controller({
            write: (method, data) => {
                if (method === 'devConfig.update' && data.list) throw new RuijieError('The Ruijie router refused the call', 'refused');
                return undefined;
            },
        });
        await expect(apply(create())).rejects.toThrow(/refused the call/);
        expect(writes.at(-1)).toEqual(['devConfig.del', { uuid: ['U1'] }]);
        expect(state.entries.map((e) => e.ruleName)).toEqual(['old']);
    });

    it('a failed move removes the new rule again', async () => {
        const { state, apply } = controller({
            addAtTop: true,
            write: (_method, data) => {
                if (data.opt) throw new RuijieError('The Ruijie router refused the call', 'refused');
                return undefined;
            },
        });
        await expect(apply(create())).rejects.toBeInstanceOf(RuijieError);
        expect(state.entries.map((e) => e.ruleName)).toEqual(['old']);
    });

    it('says so when the new rule can\'t be removed either', async () => {
        const { apply } = controller({
            write: (method, data) => {
                if ((method === 'devConfig.update' && data.list) || method === 'devConfig.del') throw new RuijieError('The Ruijie router refused the call', 'refused');
                return undefined;
            },
        });
        await expect(apply(create())).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('it may still be stored, switched off or on') });
    });

    it('a new rule it can\'t find again is a CONFLICT', async () => {
        const { apply } = controller({ readBack: () => ({ list: [OLD] }) });
        await expect(apply(create())).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('could not find it again') });
    });

    const refuse = () => {
        throw new RuijieError('The Ruijie router refused the call', 'refused');
    };
    const pair = [{ ...OLD, enable: '1', src: 'vlan20', destIP: '8.8.8.8' }, { ...OLD, ruleName: 'b', uuid: 'U-B' }, { ...OLD, ruleName: 'c', uuid: 'U-C' }];

    it('a change that fails on its first write changed nothing and says so plainly', async () => {
        const { state, apply } = controller({ entries: pair, write: refuse });
        await expect(apply(update('old', { to: [{ addresses: ['1.1.1.1'] }], position: 2 }))).rejects.toThrow('The Ruijie router refused the call');
        expect(state.entries).toEqual(pair);
    });

    it('a new rule edited by someone else while it was moving isn\'t overwritten', async () => {
        const { state, writes, apply } = controller({
            addAtTop: true,
            write: (_method, data) => {
                if (data.opt) {
                    const mine = state.entries.find((e) => e.uuid === data.uuid)!;
                    mine.ruleName = 'iot-out';
                    mine.src = 'vlan233';
                }
                return undefined;
            },
        });
        await expect(apply(create())).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('changed while it was being created') });
        expect(writes.filter(([, d]) => d.list && (d.list as Raw[])[0].enable === '1')).toEqual([]);
    });

    it('a delete the router ignores while undoing a new rule is reported', async () => {
        const { state, apply } = controller({
            write: (method, data) => {
                if (method === 'devConfig.update' && data.list) throw new RuijieError('The Ruijie router refused the call', 'refused');
                return method === 'devConfig.del' ? { rcode: '00000000' } : undefined;
            },
        });
        await expect(apply(create())).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('it may still be stored, switched off or on') });
        expect(state.entries.map((e) => e.ruleName)).toEqual(['old', 'iot-out']);
    });

    it('never takes someone else\'s rule of the same name for the new one', async () => {
        const other = { ...base, ruleName: 'iot-out', enable: '1', src: 'vlan20', destIP: '9.9.9.9', uuid: 'U-OTHER' };
        const { writes, apply } = controller({ readBack: () => ({ list: [OLD, other] }) });
        await expect(apply(create())).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('could not find it again') });
        expect(writes.map(([m]) => m)).toEqual(['devConfig.add']);
    });

    it('never takes a rule that was already there for the new one, even if it now says the same', async () => {
        const lookalike = { ...base, ruleName: 'iot-out', enable: '0', src: 'vlan20', uuid: 'U-OLD' };
        const { writes, apply } = controller({ readBack: () => ({ list: [lookalike] }) });
        await expect(apply(create())).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('could not find it again') });
        expect(writes.map(([m]) => m)).toEqual(['devConfig.add']);
    });

    it('two rules that both look like the new one are reported, and neither is touched', async () => {
        const twin = (uuid: string) => ({ ...base, ruleName: 'iot-out', enable: '0', src: 'vlan20', srcPort: '', destPort: '', uuid });
        const { writes, apply } = controller({ readBack: () => ({ list: [OLD, twin('U-A'), twin('U-B')] }) });
        await expect(apply(create())).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('could not find it again') });
        expect(writes.map(([m]) => m)).toEqual(['devConfig.add']);
    });

    it('a rule changed by someone else during a move is reported, not a success', async () => {
        const entries = [OLD, { ...OLD, ruleName: 'b', uuid: 'U-B' }];
        const edited = { ...OLD, destIP: '1.1.1.1' };
        await expect(controller({ entries, readBack: () => ({ list: [entries[1], edited] }) }).apply({ op: 'move', kind: 'rule', ref: { name: 'old' }, position: 2 })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('a new rule stored without an id is reported, not moved', async () => {
        const { writes, apply } = controller({ readBack: () => ({ list: [OLD, { ...base, ruleName: 'iot-out', enable: '0', src: 'vlan20' }] }) });
        await expect(apply(create())).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('gives it no id') });
        expect(writes.map(([m]) => m)).toEqual(['devConfig.add']);
    });

    it('a new rule it can\'t read back after adding says it may be stored', async () => {
        await expect(controller({ readBackFails: true }).apply(create())).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('may be stored, switched off') });
    });

    it('a staged change whose move fails puts the old settings back and says where the rule is', async () => {
        const { state, writes, apply } = controller({
            entries: pair,
            write: (_method, data) => {
                if (data.opt) refuse();
                return undefined;
            },
        });
        await expect(apply(update('old', { to: [{ addresses: ['1.1.1.1'] }], position: 2 }))).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('put back as it was, at position 1') });
        expect(state.entries).toEqual(pair);
        expect(writes.at(-1)).toEqual(['devConfig.update', { list: [pair[0]] }]);
    });

    it('a staged change whose switch-on fails goes back as it was, position included', async () => {
        let list = 0;
        const { state, apply } = controller({
            entries: pair,
            write: (_method, data) => {
                if (data.list && ++list === 2) refuse();
                return undefined;
            },
        });
        await expect(apply(update('old', { to: [{ addresses: ['1.1.1.1'] }], position: 2 }))).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('put back as it was, at position 1') });
        expect(state.entries).toEqual(pair);
    });

    it('a rule edited by someone else during a staged change isn\'t overwritten', async () => {
        const { state, writes, apply } = controller({
            entries: pair,
            write: (_method, data) => {
                if (data.opt) state.entries.find((e) => e.uuid === 'U-OLD')!.proto = 'udp';
                return undefined;
            },
        });
        await expect(apply(update('old', { to: [{ addresses: ['1.1.1.1'] }], position: 2 }))).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('changed while it was being changed') });
        expect(writes.filter(([, d]) => d.list)).toHaveLength(1);
        expect(state.entries.find((e) => e.uuid === 'U-OLD')).toMatchObject({ proto: 'udp', enable: '0' });
    });

    it('a failure doesn\'t write the old settings over someone else\'s edit', async () => {
        const { state, writes, apply } = controller({
            entries: pair,
            write: (_method, data) => {
                if (data.opt) {
                    state.entries.find((e) => e.uuid === 'U-OLD')!.proto = 'udp';
                    refuse();
                }
                return undefined;
            },
        });
        await expect(apply(update('old', { to: [{ addresses: ['1.1.1.1'] }], position: 2 }))).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining("couldn't be confirmed") });
        expect(writes.filter(([, d]) => d.list)).toHaveLength(1);
        expect(state.entries.find((e) => e.uuid === 'U-OLD')).toMatchObject({ proto: 'udp' });
    });

    it('a move that stops halfway goes back to where it was', async () => {
        let moves = 0;
        const { state, apply } = controller({
            entries: pair,
            write: (_method, data) => {
                if (data.opt && ++moves === 2) refuse();
                return undefined;
            },
        });
        await expect(apply({ op: 'move', kind: 'rule', ref: { name: 'old' }, position: 3 })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('put back as it was, at position 1') });
        expect(state.entries).toEqual(pair);
    });

    it('a move that can\'t go back says where the rule is', async () => {
        let moves = 0;
        const { state, apply } = controller({
            entries: pair,
            write: (_method, data) => {
                if (data.opt && ++moves >= 2) refuse();
                return undefined;
            },
        });
        await expect(apply({ op: 'move', kind: 'rule', ref: { name: 'old' }, position: 3 })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('it is at position 2 (it was at 1)') });
        expect(state.entries.map((e) => e.ruleName)).toEqual(['b', 'old', 'c']);
    });

    it('says what it can\'t tell when the old settings can\'t be put back', async () => {
        let list = 0;
        const { apply } = controller({
            entries: pair,
            write: (_method, data) => {
                if (data.opt || (data.list && ++list >= 2)) refuse();
                return undefined;
            },
        });
        await expect(apply(update('old', { to: [{ addresses: ['1.1.1.1'] }], position: 2 }))).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('may be switched off or at another position; check net_listRules') });
    });

    it('a rule gone by then is reported, not recreated', async () => {
        const { state, writes, apply } = controller({
            entries: pair,
            write: (_method, data) => {
                if (data.opt) {
                    state.entries = state.entries.filter((e) => e.uuid !== 'U-OLD');
                    refuse();
                }
                return undefined;
            },
        });
        await expect(apply(update('old', { to: [{ addresses: ['1.1.1.1'] }], position: 2 }))).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('may be switched off or at another position') });
        expect(writes.filter(([, d]) => d.list)).toHaveLength(1);
    });

    it('a read-back that differs is a CONFLICT, never a success', async () => {
        const change = update('old', { name: 'new' });
        await expect(controller({ readBack: () => ({ list: [OLD] }) }).apply(change)).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(controller({ readBack: () => ({ list: [{ ...OLD, ruleName: 'new', destIP: '1.1.1.1' }] }) }).apply(change)).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(controller({ readBack: () => ({ list: [{ ...OLD, ruleName: 'new', state: '1' }] }) }).apply(change)).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(controller({ readBack: () => ({ list: [OLD] }) }).apply({ op: 'delete', kind: 'rule', ref: { name: 'old' } })).rejects.toMatchObject({ code: 'CONFLICT' });
        const entries = [OLD, { ...OLD, ruleName: 'b', uuid: 'U-B' }];
        await expect(controller({ entries, readBack: () => ({ list: entries }) }).apply({ op: 'move', kind: 'rule', ref: { name: 'old' }, position: 2 })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('a rule changed and moved but read back elsewhere is a CONFLICT', async () => {
        const entries = [OLD, { ...OLD, ruleName: 'b', uuid: 'U-B' }];
        await expect(controller({ entries, readBack: () => ({ list: [{ ...OLD, ruleName: 'new' }, entries[1]] }) }).apply(update('old', { name: 'new', position: 2 }))).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('refuses switching on a rule whose destination it can\'t read: it may hold the router or this server', async () => {
        const odd: Raw = { ...base, ruleName: 'odd', uuid: 'U-ODD', enable: '0', src: 'vlan20', dest: 'wan', destIP: '8.8.8.8,nope' };
        const { net, writes } = controller({ entries: [odd] });
        // A list the model can read only when every part is an address: this one is foreign, so it isn't changed at all.
        expect(await code(net.plan(update('odd', { enabled: true })))).toBe('UNSUPPORTED');
        expect(writes).toEqual([]);
    });

    it('a list of destinations the model can read is checked address by address', async () => {
        const two: Raw = { ...base, ruleName: 'two', uuid: 'U-T', enable: '0', src: 'vlan20', dest: 'all', destIP: '8.8.8.8,192.168.110.1' };
        expect(await code(controller({ entries: [two] }).net.plan(update('two', { enabled: true })))).toBe('PROTECTED');
    });

    it('a read-back that fails is a warning: the router accepted it', async () => {
        const result = await controller({ readBackFails: true }).apply(update('old', { name: 'new' }));
        expect(result.applied).toBe(true);
        expect(result.warnings?.[0]).toContain('reading it back failed');
    });

    it('other changes stay refused', async () => {
        const { net, writes } = controller();
        await expect(net.plan({ op: 'delete', kind: 'network', ref: { name: 'IoT' } })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
        expect(writes).toEqual([]);
    });
});

