/**
 * The FortiGate adapter (read-only) on FortiOS 7.4 answer shapes (tests/net/fixtures/fortigate.ts):
 * networks, ports, policies as rules (and which are foreign), groups, reservations, clients,
 * firmware, and the refusal of every change.
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { FortiGateError, type FortiGateClient } from '../../src/fortigateClient/index.js';
import { FortiGateNetworkController, compareVersions, maskToPrefix, toCidr } from '../../src/net/adapters/fortigate.js';
import { NetError } from '../../src/net/model.js';

import * as fx from './fixtures/fortigate.js';

type Answer = unknown | (() => never);

/** A fake client answering cmdb/monitor calls from the fixtures (or overrides; a function throws). */
function controller(over: Record<string, Answer> = {}, options: { host?: string; serverHosts?: string[] } = {}) {
    const answers: Record<string, Answer> = {
        'cmdb system/interface': fx.interfaces,
        'cmdb system.dhcp/server': fx.dhcpServers,
        'cmdb system/virtual-switch': fx.virtualSwitch,
        'cmdb firewall/policy': fx.policies,
        'cmdb firewall/address': fx.addresses,
        'cmdb firewall/addrgrp': fx.addressGroups,
        'monitor system/status': fx.systemStatus,
        'monitor system/interface': fx.liveInterfaces,
        'monitor system/dhcp': fx.dhcpLeases,
        'monitor network/arp': fx.arp,
        'monitor system/firmware': fx.firmware,
        ...over,
    };
    const calls: string[] = [];
    const answer = (key: string) => {
        calls.push(key);
        if (!(key in answers)) throw new Error(`unexpected call ${key}`);
        const a = answers[key];
        if (typeof a === 'function') (a as () => never)();
        return { results: a, serial: 'FGT80FTK00000001', version: 'v7.4.4', build: 2662 };
    };
    const client = {
        host: options.host ?? '192.168.0.126',
        serverAddresses: options.serverHosts ?? [],
        cmdb: async (path: string, name: string) => answer(`cmdb ${path}/${name}`),
        monitor: async (path: string, name: string) => answer(`monitor ${path}/${name}`),
    } as unknown as FortiGateClient;
    return { adapter: new FortiGateNetworkController(client, { serverHosts: options.serverHosts }), calls };
}

const forbidden = () => {
    throw new FortiGateError('no', 'forbidden');
};

describe('FortiGate helpers', () => {
    it('reads FortiOS address/mask pairs', () => {
        expect(maskToPrefix('255.255.255.0')).toBe(24);
        expect(maskToPrefix('255.255.255.255')).toBe(32);
        expect(maskToPrefix('0.0.0.0')).toBe(0);
        expect(maskToPrefix('255.0.255.0')).toBeUndefined();
        expect(maskToPrefix('nonsense')).toBeUndefined();
        expect(toCidr('192.168.1.99 255.255.255.0')).toBe('192.168.1.99/24');
        expect(toCidr('0.0.0.0 0.0.0.0')).toBeUndefined();
        expect(toCidr('192.168.1.1')).toBeUndefined();
        expect(toCidr('300.1.1.1 255.255.255.0')).toBeUndefined();
    });

    it('compares FortiOS versions by number, not as text', () => {
        expect(compareVersions('v7.4.10', 'v7.4.9')).toBeGreaterThan(0);
        expect(compareVersions('v7.2.10', 'v7.4.4')).toBeLessThan(0);
        expect(compareVersions('v7.4.4', 'v7.4.4')).toBe(0);
    });
});

describe('FortiGateNetworkController (read-only)', () => {
    it('lists the routed LAN-side interfaces as networks, with their DHCP; WAN, tunnels and unaddressed ports are left out', async () => {
        const { adapter } = controller();
        const networks = await adapter.listNetworks();
        expect(networks.map((n) => n.id)).toEqual(['dmz', 'lan', 'iot', 'fortilink']);
        const lan = networks.find((n) => n.id === 'lan')!;
        expect(lan).toEqual({
            id: 'lan',
            name: 'Home LAN',
            purpose: 'normal',
            vlan: 1,
            gateway: '192.168.1.99/24',
            dhcp: { enabled: true, range: { from: '192.168.1.110', to: '192.168.1.210' }, leaseMinutes: 10080 },
            ipv6: false,
            isolated: false,
            protected: false,
        });
        expect(networks.find((n) => n.id === 'iot')).toMatchObject({ vlan: 20, gateway: '192.168.20.1/24', dhcp: { enabled: false, leaseMinutes: 60, dns: ['1.1.1.1'] } });
        expect(networks.find((n) => n.id === 'dmz')).toMatchObject({ dhcp: { enabled: false } });
    });

    it('marks the network holding this server as protected', async () => {
        const { adapter } = controller({}, { serverHosts: ['192.168.20.5', 'not-an-address'] });
        const networks = await adapter.listNetworks();
        expect(networks.filter((n) => n.protected).map((n) => n.id)).toEqual(['iot']);
        expect((await adapter.protectedResources()).networks).toEqual([{ id: 'iot' }]);
    });

    it('still lists networks when the API profile may not read DHCP', async () => {
        const { adapter } = controller({ 'cmdb system.dhcp/server': forbidden });
        expect((await adapter.listNetworks()).find((n) => n.id === 'lan')?.dhcp).toEqual({ enabled: false });
    });

    it('passes other errors on (an unreachable FortiGate is not "no DHCP")', async () => {
        const { adapter } = controller({
            'cmdb system.dhcp/server': () => {
                throw new FortiGateError('down', 'unreachable');
            },
        });
        await expect(adapter.listNetworks()).rejects.toThrow('down');
    });

    it('lists the physical ports with the network each carries; the WAN ports and the one this server uses are protected', async () => {
        const { adapter } = controller();
        const ports = await adapter.listPorts();
        expect(ports.map((p) => p.name)).toEqual(['a', 'b', 'dmz', 'internal1', 'internal2 (down)', 'internal3', 'internal4', 'internal5', 'internal6', 'wan1', 'wan2 (down)']);
        const internal1 = ports.find((p) => p.name === 'internal1')!;
        expect(internal1).toMatchObject({ device: { id: 'FGT80FTK00000001' }, uplink: false, networks: { native: { id: 'lan' }, tagged: [{ id: 'iot' }] } });
        expect(internal1.protected).toBeUndefined();
        expect(ports.find((p) => p.name === 'wan1')).toMatchObject({ uplink: true, protected: 'This server reaches the FortiGate through this port', networks: { tagged: 'none' } });
        expect(ports.find((p) => p.name === 'wan2 (down)')).toMatchObject({ uplink: true, protected: 'WAN port' });
        expect(ports.find((p) => p.name === 'a')?.networks).toEqual({ tagged: 'none' });
        expect(ports.map((p) => p.port)).toEqual(ports.map((_, i) => i + 1));
    });

    it('lists ports without a virtual-switch table (other models / profiles)', async () => {
        const { adapter } = controller({
            'cmdb system/virtual-switch': () => {
                throw new FortiGateError('no', 'notFound');
            },
        });
        const ports = await adapter.listPorts();
        expect(ports.find((p) => p.name === 'internal1')?.networks).toEqual({ tagged: 'none' });
    });

    it('accepts only this FortiGate as the device', async () => {
        const { adapter } = controller();
        expect(await adapter.listPorts({ name: 'FGT80F-Home' })).toHaveLength(11);
        expect(await adapter.listPorts({ id: 'fgt80ftk00000001' })).toHaveLength(11);
        await expect(adapter.listPorts({ name: 'other-switch' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('reads policies as rules in evaluation order; what the model cannot say is foreign', async () => {
        const { adapter } = controller();
        const rules = await adapter.listRules();
        expect(rules.map((r) => [r.id, r.position])).toEqual([
            ['1', 1],
            ['5', 2],
            ['3', 3],
            ['4', 4],
            ['6', 5],
            ['7', 6],
        ]);
        expect(rules[0]).toEqual({
            id: '1',
            name: 'LAN to internet',
            action: 'allow',
            from: [{ network: { id: 'lan' } }],
            to: [{ internet: true }],
            protocol: 'any',
            replies: 'allow',
            schedule: { kind: 'always' },
            enabled: true,
            position: 1,
        });
        expect(rules[1]).toMatchObject({ action: 'block', from: [{ network: { id: 'iot' } }], to: [{ network: { id: 'lan' } }] });
        expect(rules[1].foreign).toBeUndefined();
        expect(rules[2]).toMatchObject({ enabled: false, from: [{ device: '02-00-00-00-00-77' }], protocol: 'tcp' });
        expect(rules[3]).toMatchObject({ from: [], to: [{ addresses: ['192.168.1.50', '192.168.1.32/28'] }], protocol: 'icmp' });
        // 'servers' also holds an FQDN, which its listed entries leave out: the rule matches more than they say.
        expect(rules[3].foreign?.reason).toContain("group 'servers'");
        expect(rules[4].foreign?.reason).toMatch(/service HTTPS.*schedule 'school-nights'/);
        const seventh = rules[5].foreign?.reason ?? '';
        for (const why of ['any interface', 'negates', 'internet services', 'user groups']) expect(seventh).toContain(why);
        expect(rules[5].name).toBe('policy 7');
    });

    it('marks policies on unknown interfaces, mixed "all", FQDN addresses and several MACs as foreign', async () => {
        const base = { status: 'enable', action: 'accept', service: [{ name: 'ALL' }], schedule: 'always', dstintf: [{ name: 'wan1' }], dstaddr: [{ name: 'all' }] };
        const { adapter } = controller({
            'cmdb firewall/policy': [
                { ...base, policyid: 1, srcintf: [{ name: 'zone-office' }], srcaddr: [{ name: 'all' }] },
                { ...base, policyid: 2, srcintf: [{ name: 'lan' }], srcaddr: [{ name: 'all' }, { name: 'node-c6' }] },
                { ...base, policyid: 3, srcintf: [{ name: 'lan' }], srcaddr: [{ name: 'guest-range' }] },
                { ...base, policyid: 4, srcintf: [{ name: 'lan' }], srcaddr: [{ name: 'two-macs' }] },
                { ...base, policyid: 5, srcintf: [{ name: 'lan' }], srcaddr: [{ name: 'all' }], action: 'ipsec' },
                { ...base, policyid: 6, srcintf: [{ name: 'lan' }], srcaddr: [{ name: 'all' }], service: [{ name: 'ALL_TCP' }, { name: 'ALL_UDP' }] },
            ],
        });
        const reasons = (await adapter.listRules()).map((r) => r.foreign?.reason ?? '');
        expect(reasons[0]).toContain('zones');
        expect(reasons[1]).toContain('mixes "all"');
        expect(reasons[2]).toContain("'guest-range'");
        expect(reasons[3]).toContain('several MACs');
        expect(reasons[4]).toContain("action 'ipsec'");
        expect(reasons[5]).toContain('ALL_TCP, ALL_UDP');
    });

    it('a policy mixing WAN and LAN interfaces is foreign, and so is a negate or internet-service flag in any form', async () => {
        const base = { status: 'enable', action: 'accept', service: [{ name: 'ALL' }], schedule: 'always', srcintf: [{ name: 'lan' }], srcaddr: [{ name: 'all' }], dstintf: [{ name: 'wan1' }], dstaddr: [{ name: 'all' }] };
        const { adapter } = controller({
            'cmdb firewall/policy': [
                { ...base, policyid: 1, srcintf: [{ name: 'lan' }, { name: 'wan1' }] },
                { ...base, policyid: 2, 'srcaddr-negate': true },
                { ...base, policyid: 3, 'internet-service': 1 },
                { ...base, policyid: 4, 'dstaddr-negate': 'disable', 'internet-service': false },
                { ...base, policyid: 5, dstintf: [] },
                { ...base, policyid: 6, srcintf: undefined },
            ],
        });
        const rules = await adapter.listRules();
        expect(rules[0].foreign?.reason).toContain('mixes WAN and LAN interfaces');
        expect(rules[1].foreign?.reason).toContain('negates');
        expect(rules[2].foreign?.reason).toContain('internet services');
        expect(rules[3].foreign).toBeUndefined();
        expect(rules[4].foreign?.reason).toContain('destination names no interface');
        expect(rules[5].foreign?.reason).toContain('source names no interface');
    });

    it('reads the real factory policy of a FortiGate 80F on 7.4.4 (174 fields, empty internet-service lists) as an ordinary rule', async () => {
        const real = JSON.parse(readFileSync(new URL('./fixtures/fortigate-policy-7.4.4.json', import.meta.url), 'utf8')) as Record<string, unknown>;
        // On that box the LAN is called "internal"; here it is "lan".
        const policy = { ...real, srcintf: [{ name: 'lan', q_origin_key: 'lan' }] };
        const { adapter } = controller({ 'cmdb firewall/policy': [policy] });
        const [rule] = await adapter.listRules();
        expect(rule.foreign).toBeUndefined();
        expect(rule).toMatchObject({ id: '1', action: 'allow', from: [{ network: { id: 'lan' } }], to: [{ internet: true }], protocol: 'any', enabled: true });
    });

    it('marks policies whose match is narrowed or changed by FortiOS-only fields as foreign (VIP matching, ZTNA, reputation, vendor MACs, ToS, tags, dynamic services, FSSO, VLAN filter)', async () => {
        const real = JSON.parse(readFileSync(new URL('./fixtures/fortigate-policy-7.4.4.json', import.meta.url), 'utf8')) as Record<string, unknown>;
        const base = { ...real, srcintf: [{ name: 'lan' }] };
        const variants: Array<[Record<string, unknown>, string]> = [
            [{ action: 'deny', 'match-vip': 'disable' }, 'virtual IPs'],
            [{ 'match-vip-only': 'enable' }, 'virtual IPs'],
            [{ 'ztna-status': 'enable' }, 'ztna-status'],
            [{ 'ztna-ems-tag': [{ name: 'tag' }] }, 'ztna-ems-tag'],
            [{ 'network-service-dynamic': [{ name: 'svc' }] }, 'network-service-dynamic'],
            [{ 'reputation-minimum': 20 }, 'reputation-minimum'],
            [{ 'src-vendor-mac': [{ id: 1 }] }, 'src-vendor-mac'],
            [{ 'tos-mask': '0x0f', tos: '0x04' }, 'tos-mask'],
            [{ 'sgt-check': 'enable', sgt: [{ id: 5 }] }, 'sgt'],
            [{ 'fsso-groups': [{ name: 'g' }] }, 'fsso-groups'],
            [{ 'vlan-filter': '10-20' }, 'vlan-filter'],
        ];
        const { adapter } = controller({ 'cmdb firewall/policy': [{ ...base, action: 'deny' }, ...variants.map(([over], i) => ({ ...base, policyid: i + 2, ...over }))] });
        const rules = await adapter.listRules();
        // A deny with match-vip on (the default) also blocks port-forwarded traffic: what the neutral block says.
        expect(rules[0].foreign).toBeUndefined();
        variants.forEach(([, why], i) => expect(rules[i + 1].foreign?.reason, why).toContain(why));
    });

    it('PING (echo requests only) is narrower than the model\'s icmp: foreign; ALL_ICMP is icmp', async () => {
        const base = { status: 'enable', action: 'accept', schedule: 'always', srcintf: [{ name: 'lan' }], srcaddr: [{ name: 'all' }], dstintf: [{ name: 'wan1' }], dstaddr: [{ name: 'all' }] };
        const { adapter } = controller({ 'cmdb firewall/policy': [{ ...base, policyid: 1, service: [{ name: 'PING' }] }, { ...base, policyid: 2, service: [{ name: 'ALL_ICMP' }] }] });
        const [ping, icmp] = await adapter.listRules();
        expect(ping.foreign?.reason).toContain('service PING');
        expect(icmp.foreign).toBeUndefined();
        expect(icmp.protocol).toBe('icmp');
    });

    it('reads a policy on a group the model can say in full as an ordinary rule', async () => {
        const { adapter } = controller({
            'cmdb firewall/addrgrp': [{ name: 'servers', member: [{ name: 'node-c6' }, { name: 'printers' }] }, { name: 'nested', member: [{ name: 'servers' }] }],
            'cmdb firewall/policy': [
                { policyid: 4, status: 'enable', srcintf: [{ name: 'lan' }], dstintf: [{ name: 'lan' }], srcaddr: [{ name: 'servers' }], dstaddr: [{ name: 'node-c6' }], action: 'accept', service: [{ name: 'ALL_ICMP' }], schedule: 'always' },
                { policyid: 8, status: 'enable', srcintf: [{ name: 'lan' }], dstintf: [{ name: 'lan' }], srcaddr: [{ name: 'nested' }], dstaddr: [{ name: 'node-c6' }], action: 'accept', service: [{ name: 'ALL_ICMP' }], schedule: 'always' },
            ],
        });
        const [plain, nested] = await adapter.listRules();
        expect(plain.foreign).toBeUndefined();
        expect(plain.from).toEqual([{ group: { name: 'servers' } }]);
        expect(nested.foreign?.reason).toContain("group 'nested'");
    });

    it('marks as foreign: negation and internet services of any kind, IPv6 addresses, groups with exclusions', async () => {
        const base = { status: 'enable', action: 'accept', service: [{ name: 'ALL' }], schedule: 'always', srcintf: [{ name: 'lan' }], srcaddr: [{ name: 'all' }], dstintf: [{ name: 'wan1' }], dstaddr: [{ name: 'all' }] };
        const { adapter } = controller({
            'cmdb firewall/addrgrp': [{ name: 'minus', member: [{ name: 'printers' }], exclude: 'enable', 'exclude-member': [{ name: 'node-c6' }] }],
            'cmdb firewall/policy': [
                { ...base, policyid: 1, 'dstaddr-negate': 'enable' },
                { ...base, policyid: 2, 'internet-service-negate': 'enable' },
                { ...base, policyid: 3, 'internet-service-src-negate': 'enable' },
                { ...base, policyid: 4, 'internet-service6': 'enable' },
                { ...base, policyid: 5, srcaddr6: [{ name: 'all' }], dstaddr6: [{ name: 'all' }] },
                { ...base, policyid: 6, srcaddr: [{ name: 'minus' }] },
                { ...base, policyid: 7, srcaddr6: [], dstaddr6: [] },
            ],
        });
        const rules = await adapter.listRules();
        expect(rules.slice(0, 6).map((r) => r.foreign === undefined)).toEqual([false, false, false, false, false, false]);
        expect(rules[4].foreign?.reason).toContain('IPv6');
        expect(rules[5].foreign?.reason).toContain("group 'minus'");
        expect(rules[6].foreign).toBeUndefined();
    });

    it('lists the address groups the model can say in full; groups with FQDN, range, nested or excluded members are left out', async () => {
        const { adapter } = controller();
        // 'servers' holds an FQDN (FortiOS's own "G Suite" and "Microsoft Office 365" are such groups).
        expect(await adapter.listGroups()).toEqual([
            {
                id: 'kids',
                name: 'kids',
                kind: 'mac',
                entries: [
                    { value: '02-00-00-00-00-77', name: 'laptop-mac' },
                    { value: '02-00-00-00-00-78', name: 'two-macs' },
                    { value: '02-00-00-00-00-79', name: 'two-macs' },
                ],
            },
        ]);
        expect(await adapter.listGroups('address')).toEqual([]);
        const clean = controller({ 'cmdb firewall/addrgrp': [{ name: 'servers', member: [{ name: 'node-c6' }, { name: 'printers' }] }] });
        expect(await clean.adapter.listGroups('address')).toEqual([
            { id: 'servers', name: 'servers', kind: 'address', entries: [{ value: '192.168.1.50', name: 'node-c6' }, { value: '192.168.1.32/28', name: 'printers' }] },
        ]);
    });

    it('lists DHCP reservations: action "reserved" (the default); "assign" and "block" entries are MAC access rules, not reservations', async () => {
        const { adapter } = controller();
        expect(await adapter.listReservations()).toEqual([
            { mac: '02-00-00-00-00-50', ip: '192.168.1.50', network: { id: 'lan' }, description: 'node-c6' },
            { mac: '02-00-00-00-00-53', ip: '192.168.1.53', network: { id: 'lan' }, description: 'action left out: reserved' },
        ]);
    });

    it('merges DHCP leases and the ARP table into clients; online = in the ARP table', async () => {
        const { adapter } = controller();
        const clients = await adapter.listClients();
        expect(clients).toEqual([
            { mac: '02-00-00-00-00-10', name: 'phone', ip: '192.168.1.110', network: { id: 'lan' }, online: false },
            { mac: '02-00-00-00-00-50', name: 'node-c6', ip: '192.168.1.50', network: { id: 'lan' }, online: true },
            { mac: '02-00-00-00-00-01', ip: '192.168.0.1', network: { id: 'wan1' }, online: true },
        ]);
    });

    it('offers the newest version on the running branch (7.4.13 Mature for 7.4.4), and names newer branches; nothing is upgradable here', async () => {
        const { adapter } = controller();
        expect(await adapter.listFirmware()).toEqual([
            {
                device: { id: 'FGT80FTK00000001' },
                name: 'FGT80F-Home',
                model: 'FortiGate 80F',
                current: 'v7.4.4',
                available: { version: 'v7.4.13', notes: 'Mature release, the newest on the running 7.4 branch. Newer branches offered: v8.0.2 (Feature), v7.6.8 (Mature).' },
                upgradable: false,
            },
        ]);
    });

    it('offers a newer branch when the running one has nothing newer', async () => {
        const { adapter } = controller({
            'monitor system/firmware': { current: { version: 'v7.4.13' }, available: [{ version: 'v8.0.2', maturity: 'F' }, { version: 'v7.6.0', maturity: 'F' }, { version: 'v7.6.8', maturity: 'M' }, { version: 'v7.4.13', maturity: 'M' }] },
        });
        expect((await adapter.listFirmware())[0].available).toEqual({ version: 'v7.6.8', notes: 'Mature release, on a newer branch (7.6).' });
    });

    it('reports only the running version when the firmware list is not available', async () => {
        const { adapter } = controller({ 'monitor system/firmware': forbidden });
        const [fw] = await adapter.listFirmware();
        expect(fw.current).toBe('v7.4.4');
        expect(fw.available).toBeUndefined();
    });

    it('offers nothing older than what runs', async () => {
        const { adapter } = controller({ 'monitor system/firmware': { current: { version: 'v7.4.10' }, available: [{ version: 'v7.2.10' }] } });
        expect((await adapter.listFirmware())[0].available).toBeUndefined();
    });

    it('has no Wi-Fi, port profiles or mDNS repeater, and every capability is unsupported', async () => {
        const { adapter } = controller();
        expect(await adapter.listWifi()).toEqual([]);
        expect(await adapter.listPortProfiles()).toEqual([]);
        expect((await adapter.getMdnsRepeater()).foreign).toBeDefined();
        const caps = await adapter.capabilities();
        expect(caps.vendor).toBe('fortigate');
        expect(JSON.stringify(caps)).not.toMatch(/native|emulated/);
        expect(adapter.id).toBe('fortigate:192.168.0.126');
    });

    it('refuses every change without calling the FortiGate', async () => {
        const { adapter, calls } = controller();
        const plan = adapter.plan({ op: 'delete', kind: 'rule', ref: { id: '1' } });
        await expect(plan).rejects.toBeInstanceOf(NetError);
        await expect(plan).rejects.toMatchObject({ code: 'UNSUPPORTED', details: { capability: 'rule' } });
        await expect(adapter.apply()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
        expect(calls).toEqual([]);
    });
});
