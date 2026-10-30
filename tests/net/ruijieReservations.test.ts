/**
 * Ruijie DHCP reservations (2.5.4) against a fake router that keeps dhcp_static like the real one
 * (recorded on a RG-EG105G-V3: `{name_uuid, macaddr, ipaddr}`; add `{list}`, update `{new, old}`,
 * del `{macaddr: [...]}` as the router's page sends them). Every change is planned, checked again
 * right before writing, and read back.
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { RuijieNetworkController } from '../../src/net/adapters/ruijie.js';
import { NetError, type Change } from '../../src/net/model.js';
import { RuijieError, type RuijieClient } from '../../src/ruijieClient/index.js';

type Raw = Record<string, unknown>;
const fixture = (name: string): Raw => (JSON.parse(readFileSync(new URL(`./fixtures/ruijie/${name}.json`, import.meta.url), 'utf8')) as { data: Raw }).data;

/** The recordings: pc-1 (02:00:00:00:00:03) online at .2, reserved for .2; the LAN is 192.168.110.0/24. */
function controller(over: { readOnly?: boolean; write?: (method: string, data: Raw) => unknown; readBack?: () => Raw; networkAfterWrite?: Raw } = {}) {
    const state = { entries: structuredClone(fixture('dhcp_static').dhcp_static) as Raw[], arp: fixture('arp'), lease: fixture('dhcp_lease'), reads: 0 };
    const writes: Array<[string, Raw]> = [];
    let next = 0;
    const client = {
        host: '192.168.110.1',
        ...(over.readOnly !== undefined ? { readOnly: over.readOnly } : {}),
        config: async (module: string) => {
            if (module === 'network') return over.networkAfterWrite && writes.length ? over.networkAfterWrite : fixture('network');
            if (module === 'dhcp_static') {
                state.reads++;
                if (over.readBack && writes.length) return over.readBack();
                return { dhcp_static: structuredClone(state.entries) };
            }
            throw new Error(`unexpected config ${module}`);
        },
        status: async (module: string) => {
            if (module === 'sysinfo') return fixture('sysinfo');
            if (module === 'arp') return state.arp;
            if (module === 'dhcp_lease') return state.lease;
            throw new Error(`unexpected status ${module}`);
        },
        call: async (method: string, module: string, data: Raw) => {
            if (module !== 'dhcp_static') throw new Error(`unexpected ${method} ${module}`);
            writes.push([method, structuredClone(data)]);
            if (over.write) return over.write(method, data);
            if (method === 'devConfig.add') for (const e of data.list as Raw[]) state.entries.push({ name_uuid: `UUID${++next}`, ...e });
            if (method === 'devConfig.update') state.entries = state.entries.map((e) => (e.name_uuid === (data.old as Raw).name_uuid ? (data.new as Raw) : e));
            if (method === 'devConfig.del') state.entries = state.entries.filter((e) => !(data.macaddr as string[]).includes(e.macaddr as string));
            return { message: 'Configuration success', rcode: '00000000' };
        },
    } as unknown as RuijieClient;
    const net = new RuijieNetworkController(client);
    return { net, state, writes, apply: async (change: Change, allowLockout = false) => net.apply(await net.plan(change), { allowLockout }) };
}

const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof NetError ? e.code : `not a NetError: ${String(e)}`));
const reserve = (mac: string, ip: string, extra: Partial<Extract<Change, { kind: 'reservation'; op: 'set' }>['value']> = {}): Change => ({ op: 'set', kind: 'reservation', value: { mac, ip, ...extra } });

describe('Ruijie reservations', () => {
    it('lists them and says it can change them (unless changes are switched off)', async () => {
        expect(await controller().net.listReservations()).toEqual([{ mac: '02-00-00-00-00-03', ip: '192.168.110.2', network: { id: 'vlan233' } }]);
        expect((await controller().net.capabilities()).reservations).toBe('native');
        expect((await controller({ readOnly: true }).net.capabilities()).reservations).toBe('unsupported');
    });

    it('adds a reservation like the router\'s page (MAC lower case with colons) and reads it back', async () => {
        const { net, writes, apply } = controller();

        const plan = await net.plan(reserve('02-AA-BB-CC-DD-EE', '192.168.110.40'));
        expect(plan.steps).toEqual([{ action: 'create', object: 'ruijie.dhcp_static', name: '02-AA-BB-CC-DD-EE', detail: '192.168.110.40' }]);
        expect(plan.wouldLockOut).toEqual([]);
        expect(writes).toEqual([]);

        const result = await apply(reserve('02-AA-BB-CC-DD-EE', '192.168.110.40'));
        expect(writes).toEqual([['devConfig.add', { list: [{ macaddr: '02:aa:bb:cc:dd:ee', ipaddr: '192.168.110.40' }] }]]);
        expect(result).toEqual({ applied: true, object: { mac: '02-AA-BB-CC-DD-EE', ip: '192.168.110.40', network: { id: 'vlan233' } }, owned: [] });
    });

    it('moves a reservation with {new, old} (the entry as read), and an online device only with allowLockout', async () => {
        const { net, writes, apply } = controller();

        const plan = await net.plan(reserve('02:00:00:00:00:03', '192.168.110.9'));
        expect(plan.wouldLockOut.map((c) => c.mac)).toEqual(['02-00-00-00-00-03']);
        expect(plan.steps[0]).toMatchObject({ action: 'update', detail: '192.168.110.2 → 192.168.110.9', name: 'pc-1 (02-00-00-00-00-03)' });
        await expect(net.apply(plan)).rejects.toMatchObject({ code: 'LOCKOUT', details: { clients: [expect.objectContaining({ mac: '02-00-00-00-00-03' })] } });
        expect(writes).toEqual([]);

        await apply(reserve('02:00:00:00:00:03', '192.168.110.9'), true);
        expect(writes).toEqual([
            [
                'devConfig.update',
                {
                    new: { name_uuid: '82D01CC886B604714F77', macaddr: '02:00:00:00:00:03', ipaddr: '192.168.110.9' },
                    old: { name_uuid: '82D01CC886B604714F77', macaddr: '02:00:00:00:00:03', ipaddr: '192.168.110.2' },
                },
            ],
        ]);
    });

    it('removes a reservation by the MAC exactly as the router stores it, without a lock-out', async () => {
        const { net, writes, state, apply } = controller();

        const plan = await net.plan({ op: 'delete', kind: 'reservation', mac: '02-00-00-00-00-03' });
        expect(plan.wouldLockOut).toEqual([]);
        expect(plan.effects[1]).toMatch(/keeps its address until its lease runs out/);

        expect(await apply({ op: 'delete', kind: 'reservation', mac: '02-00-00-00-00-03' })).toEqual({ applied: true, owned: [] });
        expect(writes).toEqual([['devConfig.del', { macaddr: ['02:00:00:00:00:03'] }]]);
        expect(state.entries).toEqual([]);
    });

    it('refuses a description (the router keeps none with a reservation), switched-off changes and the 301st reservation, writing nothing', async () => {
        const { writes, apply, state } = controller();
        expect(await code(apply(reserve('02-AA-BB-CC-DD-EE', '192.168.110.40', { description: 'printer' })))).toBe('UNSUPPORTED');
        expect(await code(controller({ readOnly: true }).apply(reserve('02-AA-BB-CC-DD-EE', '192.168.110.40')))).toBe('UNSUPPORTED');

        state.entries = Array.from({ length: 300 }, (_, i) => ({ name_uuid: `U${i}`, macaddr: `02:00:00:00:${(i >> 8).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}`.replace('02:00:00:00:00:03', '02:00:00:00:99:99'), ipaddr: `10.9.${i >> 8}.${i & 255}` }));
        await expect(apply(reserve('02-AA-BB-CC-DD-EE', '192.168.110.40'))).rejects.toMatchObject({ code: 'LIMIT', message: expect.stringContaining('at most 300') });
        // Changing one of the 300 is still fine.
        state.entries[0].ipaddr = '192.168.110.50';
        expect(await code(apply(reserve(state.entries[0].macaddr as string, '192.168.110.51')))).toBe('ok');
        expect(writes.map(([m]) => m)).toEqual(['devConfig.update']);
    });

    it('a reservation changed on the router after the dry run is a CONFLICT, nothing written', async () => {
        const { net, writes, state } = controller();
        const plan = await net.plan(reserve('02-AA-BB-CC-DD-EE', '192.168.110.40'));
        state.entries.push({ name_uuid: 'X', macaddr: '02:00:00:00:00:77', ipaddr: '192.168.110.77' });

        expect(await code(net.apply(plan))).toBe('CONFLICT');
        expect(writes).toEqual([]);
    });

    it('an answer that never came (sent) is "may or may not be stored"; one never sent is the router\'s own error', async () => {
        const lost = controller({
            write: () => {
                throw new RuijieError('The Ruijie router is not reachable', 'unreachable');
            },
        });
        await expect(lost.apply(reserve('02-AA-BB-CC-DD-EE', '192.168.110.40'))).rejects.toThrow(/may or may not be stored; check net_listReservations/);

        const notSent = controller({
            write: () => {
                throw new RuijieError('The Ruijie router is not reachable', 'unreachable', true);
            },
        });
        await expect(notSent.apply(reserve('02-AA-BB-CC-DD-EE', '192.168.110.40'))).rejects.toThrow(/^The Ruijie router is not reachable$/);

        const refused = controller({
            write: () => {
                throw new RuijieError('The Ruijie router refused devConfig.add dhcp_static (rcode 1)');
            },
        });
        await expect(refused.apply(reserve('02-AA-BB-CC-DD-EE', '192.168.110.40'))).rejects.toThrow(/refused devConfig\.add dhcp_static/);
    });

    it('reads every change back: something else stored is a CONFLICT, an unreadable answer a warning', async () => {
        const other = controller({ write: () => ({ rcode: '00000000' }) });
        expect(await code(other.apply(reserve('02-AA-BB-CC-DD-EE', '192.168.110.40')))).toBe('CONFLICT');
        const kept = controller({ write: () => ({ rcode: '00000000' }) });
        expect(await code(kept.apply({ op: 'delete', kind: 'reservation', mac: '02-00-00-00-00-03' }))).toBe('CONFLICT');

        // The right address, but the router now puts it in another network: not what was planned.
        const lan = fixture('network');
        const moved = controller({ networkAfterWrite: { ...lan, lan: (lan.lan as Raw[]).map((l) => ({ ...l, vlanid: '20' })) } });
        expect(await code(moved.apply(reserve('02-AA-BB-CC-DD-EE', '192.168.110.40')))).toBe('CONFLICT');

        const unread = controller({
            readBack: () => {
                throw new RuijieError('The Ruijie router is not reachable', 'unreachable');
            },
        });
        expect(await unread.apply(reserve('02-AA-BB-CC-DD-EE', '192.168.110.40'))).toEqual({
            applied: true,
            owned: [],
            warnings: ['The router accepted the reservation change, but reading it back failed; check it with net_listReservations.'],
        });
    });
});
