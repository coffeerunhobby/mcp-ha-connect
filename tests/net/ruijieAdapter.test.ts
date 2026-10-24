/**
 * The Ruijie adapter (2.5.0, read-only) on recordings of a real RG-EG105G-V3 (ReyeeOS 2.324,
 * 2026-10-24; MACs, serial and the upstream network replaced by documentation values), plus the
 * rule shapes the model can't express (listed as foreign) and the refusal of every change.
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import { RuijieNetworkController, maskToPrefix, toClients, toNetwork, toRule } from '../../src/net/adapters/ruijie.js';
import { NetError, type Network, type Plan } from '../../src/net/model.js';
import type { RuijieClient } from '../../src/ruijieClient/index.js';

type Raw = Record<string, unknown>;
/** A recorded answer's `data` (the recordings are the router's complete answers). */
const fixture = (name: string): Raw => (JSON.parse(readFileSync(new URL(`./fixtures/ruijie/${name}.json`, import.meta.url), 'utf8')) as { data: Raw }).data;

/** A fake client answering from the recordings (or overrides). */
function controller(over: Record<string, Raw> = {}, host = '192.168.110.1') {
    const answers: Record<string, Raw> = {
        'devConfig.get network': fixture('network'),
        'devConfig.get dhcp_static': fixture('dhcp_static'),
        'devConfig.get access_ctrl': fixture('access_ctrl'),
        'devSta.get dhcp_lease': fixture('dhcp_lease'),
        'devSta.get arp': fixture('arp'),
        'devSta.get port_status': fixture('port_status'),
        'devSta.get sysinfo': fixture('sysinfo'),
        ...over,
    };
    const calls: string[] = [];
    const answer = (key: string) => {
        calls.push(key);
        if (!(key in answers)) throw new Error(`unexpected call ${key}`);
        return answers[key];
    };
    const client = {
        host,
        config: async (module: string) => answer(`devConfig.get ${module}`),
        status: async (module: string) => answer(`devSta.get ${module}`),
    } as unknown as RuijieClient;
    return { net: new RuijieNetworkController(client), calls };
}

const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof NetError ? e.code : `not a NetError: ${String(e)}`));
const LAN: Network[] = [
    { id: 'vlan233', name: 'LAN', purpose: 'normal', vlan: 233, gateway: '192.168.110.1/24', ipv6: false, isolated: false, protected: true },
    { id: 'vlan20', name: 'VLAN 20', purpose: 'normal', vlan: 20, gateway: '192.168.20.1/24', ipv6: false, isolated: false, protected: false },
];

describe('networks', () => {
    it('lists the router\'s LAN with its VLAN, gateway and DHCP, protected', async () => {
        const { net } = controller();

        expect(await net.listNetworks()).toEqual([
            {
                id: 'vlan233',
                name: 'LAN',
                purpose: 'normal',
                vlan: 233,
                gateway: '192.168.110.1/24',
                dhcp: { enabled: true, range: { from: '192.168.110.1', to: '192.168.110.254' }, leaseMinutes: 30 },
                ipv6: false,
                isolated: false,
                protected: true,
            },
        ]);
    });

    it('names further LANs by their description or VLAN, protects only the one the router is reached through, and skips unreadable ones', () => {
        const second = { ipaddr: '192.168.20.1', netmask: '255.255.255.0', vlanid: '20', ignore: '1', ipstart: '192.168.20.100', limit: '50', leasetime: '' };
        expect(toNetwork(second, 1, '192.168.110.1')).toEqual({
            id: 'vlan20',
            name: 'VLAN 20',
            purpose: 'normal',
            vlan: 20,
            gateway: '192.168.20.1/24',
            dhcp: { enabled: false, range: { from: '192.168.20.100', to: '192.168.20.149' } },
            ipv6: false,
            isolated: false,
            protected: false,
        });
        expect(toNetwork({ ...second, desc: 'Lab' }, 1, '192.168.110.1')?.name).toBe('Lab');
        expect(toNetwork({ ...second, name: 'Cams' }, 1, '192.168.110.1')?.name).toBe('Cams');
        expect(toNetwork(second, 1, '192.168.20.1')?.protected).toBe(true); // reached through this LAN
        expect(toNetwork(second, 1, 'router.local')?.protected).toBe(false); // a host name: only the first LAN counts
        expect(toNetwork({ ...second, ipstart: 'x' }, 1, '192.168.110.1')?.dhcp).toEqual({ enabled: false });
        expect(toNetwork({ ...second, limit: '0' }, 1, '192.168.110.1')?.dhcp).toEqual({ enabled: false });
        expect(toNetwork({ ...second, vlanid: 'x' }, 1, '192.168.110.1')?.vlan).toBe(0);
        expect(toNetwork({ ...second, ipaddr: 'nope' }, 1, '192.168.110.1')).toBeUndefined();
        expect(toNetwork({ ...second, netmask: '255.0.255.0' }, 1, '192.168.110.1')).toBeUndefined();
    });

    it('turns netmasks into prefixes, refusing non-contiguous ones', () => {
        expect(maskToPrefix('255.255.255.0')).toBe(24);
        expect(maskToPrefix('255.255.0.0')).toBe(16);
        expect(maskToPrefix('255.255.255.252')).toBe(30);
        expect(maskToPrefix('255.255.255.255')).toBe(32);
        expect(maskToPrefix('0.0.0.0')).toBe(0);
        expect(maskToPrefix('255.0.255.0')).toBeUndefined();
        expect(maskToPrefix('0.255.255.255')).toBeUndefined();
        expect(maskToPrefix('mask')).toBeUndefined();
    });
});

describe('clients, reservations and ports', () => {
    it('lists the leased clients with their network, not the upstream devices the WAN side sees', async () => {
        const { net } = controller();

        expect(await net.listClients()).toEqual([{ mac: '02-00-00-00-00-03', name: 'pc-1', ip: '192.168.110.2', network: { id: 'vlan233' }, online: true }]);
    });

    it('lists the devices the router sees on its LAN (ARP), with the name their lease gives, once; a lease alone is no online device', () => {
        const clients = toClients(
            [
                { mac: '02:00:00:00:00:aa', ip: '192.168.110.50', hostname: '*' },
                { mac: 'bad', ip: '1.1.1.1' },
                { mac: '02:00:00:00:00:aa', ip: '192.168.110.51', hostname: 'again' },
                { mac: '02:00:00:00:00:ee', ip: '192.168.110.70', hostname: 'laptop-switched-off' },
                { mac: '02:00:00:00:00:bb', ip: '192.168.110.60', hostname: 'printer' },
            ],
            [
                { hardware: '02:00:00:00:00:bb', intf: 'br-lan', address: '192.168.110.60' },
                { hardware: '02:00:00:00:00:aa', intf: 'br-lan', address: '192.168.110.50' },
                { hardware: '02:00:00:00:00:aa', intf: 'br-lan', address: '192.168.110.50' },
                { hardware: '02:00:00:00:00:cc', intf: 'br-wan', address: '198.51.100.9' },
                { hardware: '02:00:00:00:00:dd', intf: 'br-lan.20', address: '10.9.9.9' },
                { hardware: '00:00:00:00:00:00', intf: 'br-lan', address: '192.168.110.99' }, // not resolved: nobody answered
                { hardware: 'zz', intf: 'br-lan', address: '192.168.110.61' },
            ],
            LAN
        );
        expect(clients).toEqual([
            { mac: '02-00-00-00-00-BB', name: 'printer', ip: '192.168.110.60', network: { id: 'vlan233' }, online: true },
            { mac: '02-00-00-00-00-AA', ip: '192.168.110.50', network: { id: 'vlan233' }, online: true },
            { mac: '02-00-00-00-00-DD', ip: '10.9.9.9', online: true },
        ]);
    });

    it('lists reservations with their network', async () => {
        const { net } = controller();
        expect(await net.listReservations()).toEqual([{ mac: '02-00-00-00-00-03', ip: '192.168.110.2', network: { id: 'vlan233' } }]);

        const odd = controller({ 'devConfig.get dhcp_static': { dhcp_static: [{ macaddr: '02:00:00:00:00:09', ipaddr: '10.0.0.5' }, { macaddr: 'x', ipaddr: '192.168.110.9' }, { macaddr: '02:00:00:00:00:08' }] } });
        expect(await odd.net.listReservations()).toEqual([{ mac: '02-00-00-00-00-09', ip: '10.0.0.5', network: { name: "outside the router's networks" } }]);
    });

    it('lists the five ports, the WAN port as the protected uplink', async () => {
        const { net } = controller();
        const ports = await net.listPorts();

        expect(ports.map((p) => [p.port, p.name, p.uplink, p.protected ?? null])).toEqual([
            [1, 'LAN0', false, null],
            [2, 'LAN1', false, null],
            [3, 'LAN2', false, null],
            [4, 'LAN3/WAN1', false, null],
            [5, 'WAN', true, "it is the router's internet (WAN) port"],
        ]);
        expect(ports[0]).toEqual({ device: { mac: '02-00-00-00-00-02' }, port: 1, name: 'LAN0', seen: [], uplink: false });
    });

    it('takes the router by MAC (any notation), model or "router", and refuses another device', async () => {
        const { net } = controller();
        expect(await net.listPorts({ mac: '02:00:00:00:00:02' })).toHaveLength(5);
        expect(await net.listPorts({ name: 'EG105G-V3' })).toHaveLength(5);
        expect(await net.listPorts({ name: 'router' })).toHaveLength(5);
        expect(await net.listPorts({ id: '020000000002' })).toHaveLength(5);
        expect(await code(net.listPorts({ name: 'switch-sw1' }))).toBe('NOT_FOUND');
    });

    it('reports what is protected: the router\'s LAN and its WAN port', async () => {
        const { net } = controller();
        expect(await net.protectedResources()).toEqual({ networks: [{ id: 'vlan233' }], ports: [{ device: { mac: '02-00-00-00-00-02' }, port: 5 }], devices: [] });
    });
});

describe('rules', () => {
    it('reads the recorded rule: a disabled block from the LAN to one address', async () => {
        const { net } = controller();

        expect(await net.listRules()).toEqual([
            {
                id: 'AA54F74D39A22CFE181B',
                name: 'mcp-test',
                action: 'block',
                from: [{ network: { id: 'vlan233' } }],
                to: [{ addresses: ['10.99.99.99'] }],
                protocol: 'any',
                replies: 'match',
                schedule: { kind: 'always' },
                enabled: false,
                position: 1,
            },
        ]);
    });

    const base = { ruleName: 'r', enable: '1', by: 'ip', src: 'lan', dest: 'wan', srcIP: '', destIP: '', srcPort: '', destPort: '', proto: 'all', netProto: 'ipv4', target: 'DROP', state: '0', tmngtName: '所有时段', uuid: 'u1' };

    it('maps actions, the internet, networks by interface, devices by MAC and destination ports', () => {
        expect(toRule({ ...base, target: 'ACCEPT' }, 0, LAN)).toMatchObject({ action: 'allow', from: [{ network: { id: 'vlan233' } }, { network: { id: 'vlan20' } }], to: [{ internet: true }], enabled: true });
        expect(toRule({ ...base, target: 'REJECT' }, 0, LAN).action).toBe('block');
        expect(toRule({ ...base, src: 'vlan20', dest: 'vlan233' }, 2, LAN)).toMatchObject({ from: [{ network: { id: 'vlan20' } }], to: [{ network: { id: 'vlan233' } }], position: 3 });
        expect(toRule({ ...base, by: 'mac', mac: '02:00:00:00:00:07' }, 0, LAN).from).toEqual([{ device: '02-00-00-00-00-07' }]);
        expect(toRule({ ...base, by: 'mac', mac: '02:00:00:00:00:07', src: 'all' }, 0, LAN).foreign).toBeUndefined();
        const dns = toRule({ ...base, proto: 'tcpudp', destPort: '53' }, 0, LAN);
        expect(dns.protocol).toEqual({ tcpUdpPorts: '53' });
        expect(dns.foreign).toBeUndefined();
        expect(toRule({ ...base, proto: 'udp' }, 0, LAN).protocol).toBe('udp');
        expect(toRule({ ...base, proto: 'icmp' }, 0, LAN).protocol).toBe('icmp');
        const two = toRule({ ...base, srcIP: '192.168.110.5, 192.168.110.6' }, 0, LAN);
        expect(two.from).toEqual([{ addresses: ['192.168.110.5', '192.168.110.6'] }]);
        expect(two.foreign).toBeUndefined();
        expect(toRule({ ...base, tmngtName: '' }, 0, LAN).foreign).toBeUndefined();
        expect(toRule({ ...base, state: '' }, 0, LAN).foreign).toBeUndefined();
        expect(toRule({ uuid: '', ruleid: 'R9', target: 'DROP' }, 4, LAN)).toMatchObject({ id: 'R9', name: 'rule 5' });
        expect(toRule({ target: 'DROP' }, 4, LAN).id).toBe('rule-5');
    });

    it('keeps addresses only where they imply the interface the rule names', () => {
        const ok = (over: Raw) => toRule({ ...base, ...over }, 0, LAN).foreign;
        expect(ok({ src: 'lan', srcIP: '192.168.110.0/25' })).toBeUndefined(); // inside a LAN
        expect(ok({ src: 'vlan20', srcIP: '192.168.20.7' })).toBeUndefined(); // inside that VLAN
        expect(ok({ src: 'all', srcIP: '203.0.113.9' })).toBeUndefined(); // any interface
        expect(ok({ dest: 'wan', destIP: '203.0.113.0/24' })).toBeUndefined(); // outside every LAN
        expect(toRule({ ...base, src: 'vlan20', srcIP: '0.0.0.0/0' }, 0, LAN).foreign?.reason).toBe("Read-only here: it uses addresses (0.0.0.0/0) limited to the interface 'vlan20'.");
        expect(toRule({ ...base, src: 'lan', srcIP: '10.5.5.5' }, 0, LAN).foreign?.reason).toBe("Read-only here: it uses addresses (10.5.5.5) limited to the interface 'lan'.");
        expect(toRule({ ...base, dest: 'wan', destIP: '192.168.20.9' }, 0, LAN).foreign?.reason).toBe("Read-only here: it uses addresses (192.168.20.9) limited to the interface 'wan'.");
        expect(toRule({ ...base, dest: 'vlan99', destIP: '10.1.1.1' }, 0, LAN).foreign?.reason).toBe("Read-only here: it uses addresses (10.1.1.1) limited to the interface 'vlan99'.");
        expect(toRule({ ...base, srcIP: 'nonsense' }, 0, LAN).foreign?.reason).toBe('Read-only here: it uses an address it can\'t read (nonsense).');
    });

    it('lists what the model can\'t say as foreign, with every reason', () => {
        const reason = (over: Raw) => toRule({ ...base, ...over }, 0, LAN).foreign?.reason;
        expect(reason({ src: 'all' })).toBe('Read-only here: it uses traffic from anywhere, the internet included.');
        expect(reason({ dest: 'all' })).toBe('Read-only here: it uses traffic to anywhere.');
        expect(reason({ src: 'vlan99' })).toBe("Read-only here: it uses the interface 'vlan99'.");
        expect(reason({ srcIP: '192.168.110.5-192.168.110.9' })).toBe('Read-only here: it uses an address range (192.168.110.5-192.168.110.9).');
        expect(reason({ srcPort: '1234' })).toBe('Read-only here: it uses source ports.');
        expect(reason({ destPort: '80' })).toBe('Read-only here: it uses destination ports without TCP or UDP.');
        expect(reason({ proto: 'tcp', destPort: '443' })).toBe('Read-only here: it uses destination ports for tcp only (the model\'s ports mean TCP and UDP).');
        expect(reason({ proto: 'udp', destPort: '53' })).toBe('Read-only here: it uses destination ports for udp only (the model\'s ports mean TCP and UDP).');
        expect(reason({ proto: 'gre' })).toBe("Read-only here: it uses the protocol 'gre'.");
        expect(reason({ proto: 'tcpudp' })).toBe('Read-only here: it uses TCP and UDP together without ports.');
        expect(reason({ netProto: 'ipv6' })).toBe('Read-only here: it uses an ipv6 rule.');
        expect(reason({ userGroupList: ['g1'] })).toBe('Read-only here: it uses user groups.');
        expect(reason({ user: [{ name: 'u' }] })).toBe('Read-only here: it uses user groups.');
        expect(reason({ user_group_list: [{ id: '1' }] })).toBe('Read-only here: it uses user groups.');
        expect(reason({ tmngtName: 'workday' })).toBe("Read-only here: it uses a schedule ('workday').");
        expect(reason({ state: '1,2' })).toBe('Read-only here: it uses only some connection states (1,2).');
        expect(reason({ target: 'LOG' })).toBe("Read-only here: it uses an unknown action 'LOG'.");
        expect(reason({ by: 'mac', mac: 'zz' })).toBe('Read-only here: it uses a device match without a readable MAC.');
        expect(reason({ by: 'mac', mac: '02:00:00:00:00:07', src: 'vlan20' })).toBe("Read-only here: it uses a device match limited to the interface 'vlan20'.");
        expect(reason({ src: 'all', srcPort: '9' })).toBe('Read-only here: it uses traffic from anywhere, the internet included, source ports.');
    });
});

describe('the rest of the model', () => {
    it('reports every change but firmware as unsupported and refuses each one, writing nothing', async () => {
        const { net, calls } = controller();
        const caps = await net.capabilities();

        expect(caps.vendor).toBe('ruijie');
        expect(caps.reservations).toBe('unsupported');
        expect(caps.rules.between).toBe('unsupported');
        expect(caps.networks.create).toBe('unsupported');
        expect(caps.firmware).toBe('native');
        await expect(net.plan({ op: 'delete', kind: 'reservation', mac: '02:00:00:00:00:03' })).rejects.toMatchObject({ code: 'UNSUPPORTED', details: { capability: 'reservation' } });
        expect(await code(net.apply({ change: { op: 'delete', kind: 'reservation', mac: '02:00:00:00:00:03' } } as Plan))).toBe('UNSUPPORTED');
        expect(calls).toEqual([]);
    });

    it('has no Wi-Fi, port profiles, groups or mDNS repeater', async () => {
        const { net } = controller();
        expect(await net.listWifi()).toEqual([]);
        expect(await net.listPortProfiles()).toEqual([]);
        expect(await net.listGroups()).toEqual([]);
        expect(await net.getMdnsRepeater()).toEqual({ enabled: false, networks: [], foreign: { reason: 'This Ruijie router has no mDNS repeater the tools manage.' } });
        expect(net.vendor).toBe('ruijie');
        expect(net.id).toBe('ruijie:192.168.110.1');
    });

    it('copes with missing or odd lists from the router', async () => {
        const { net } = controller({
            'devConfig.get network': { lan: 'x' },
            'devSta.get dhcp_lease': {},
            'devSta.get arp': { arpList: [null, 3] },
            'devSta.get port_status': {},
            'devConfig.get access_ctrl': {},
            'devConfig.get dhcp_static': {},
            'devSta.get sysinfo': {},
        });
        expect(await net.listNetworks()).toEqual([]);
        expect(await net.listClients()).toEqual([]);
        expect(await net.listPorts()).toEqual([]);
        expect(await net.listRules()).toEqual([]);
        expect(await net.listReservations()).toEqual([]);
        expect(await code(net.listPorts({ mac: '02:00:00:00:00:01' }))).toBe('NOT_FOUND');
        expect(await net.listPorts({ name: 'router' })).toEqual([]);
    });
});
