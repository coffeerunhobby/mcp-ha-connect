/**
 * Omada adapter of the vendor-neutral network model, against a fake controller that
 * keeps state: networks and Wi-Fi (2.4.5), rules (2.4.7).
 */

import { randomBytes } from 'node:crypto';

import { describe, it, expect, vi } from 'vitest';

import { OmadaNetworkController } from '../../src/net/adapters/omada.js';
import { NetError, type Change } from '../../src/net/model.js';
import { ALWAYS_PROFILE_NAME } from '../../src/omadaClient/network.js';
import type { OmadaClient } from '../../src/omadaClient/index.js';

// Pass-through by default; a test can force what the next random draw returns (a name collision).
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

const SECRET = 'HouseWifiPassw0rd!';

type Raw = Record<string, unknown>;

const base = (...a: Parameters<typeof controller>) => controller(...a);

function controller(controllerHost = '10.0.0.250', resolveHost?: (host: string) => Promise<string[]>, serverHosts?: string[]) {
    const state = {
        networks: [
            { id: 'net-default', name: 'Default', purpose: 1, vlan: 1, primary: true, interfaceIds: ['lan1', 'lan2'], gatewaySubnet: '10.0.0.1/24', dhcpSettingsVO: { enable: true, ipRangePool: [{ ipaddrStart: '10.0.0.100', ipaddrEnd: '10.0.0.200' }], ipRangeStart: 1, ipRangeEnd: 2, dhcpns: 'auto', leasetime: 120 }, lanNetworkIpv6Config: { proto: 3, enable: 1 }, igmpSnoopEnable: false, existRA: true },
            { id: 'net-iot', name: 'IoT', purpose: 1, vlan: 2, primary: false, interfaceIds: ['lan2'], gatewaySubnet: '10.0.1.1/24', dhcpSettingsVO: { enable: true, ipRangePool: [{ ipaddrStart: '10.0.1.1', ipaddrEnd: '10.0.1.254' }], dhcpns: 'auto', leasetime: 120 }, lanNetworkIpv6Config: { proto: 0, enable: 0 }, igmpSnoopEnable: false },
            { id: 'net-lab', name: 'Engineering', purpose: 1, vlan: 70, primary: false, interfaceIds: ['lan2'], gatewaySubnet: '10.0.70.1/24', dhcpSettingsVO: { enable: true, ipRangePool: [{ ipaddrStart: '10.0.70.100', ipaddrEnd: '10.0.70.200' }], dhcpns: 'auto', leasetime: 120 }, lanNetworkIpv6Config: { proto: 0, enable: 0 }, igmpSnoopEnable: false },
        ] as Raw[],
        ssids: [
            {
                wlanId: 'wlan-1',
                ssidId: 'ssid-home',
                detail: { name: 'home-wifi', deviceType: 3, band: 7, guestNetEnable: false, security: 3, broadcast: true, vlanEnable: false, vlanSetting: { mode: 0, customConfig: {} }, pskSetting: { securityKey: SECRET, versionPsk: 4, encryptionPsk: 3, gikRekeyPskEnable: false }, mloEnable: false, pmfMode: 2, enable11r: false, macFilter: { macFilterEnable: false }, ssidEnable: true, bandSteer: {} },
            },
        ] as Array<{ wlanId: string; ssidId: string; detail: Raw }>,
        clients: [{ mac: '02:00:00:00:00:01', name: 'phone', ip: '10.0.0.101', vid: 1, ssid: 'home-wifi', active: true }] as Raw[],
        macGroups: [{ groupId: 'mg-known', name: 'KnownWiFi', type: 2, macAddressList: [{ name: 'phone', macAddress: '02-00-00-00-00-01' }] }],
        reservations: [] as Raw[],
        acls: { 'osg-acls': [] as Raw[], 'osw-acls': [] as Raw[], 'eap-acls': [] as Raw[] } as Record<string, Raw[]>,
        lanProfiles: [] as Raw[],
        /** Per network id: the devices whose ports carry it (switchInfo.affectedPorts); the gateway entry says whether it has Wi-Fi. */
        networkPorts: { 'net-default': [{ type: 'gateway', mac: 'GW', name: 'gateway-gw1', gatewayInfo: { gatewayDetail: { wirelessRouter: false } } }] } as Record<string, Raw[]>,
        /** Adopted devices: a gateway without a radio (like an ER605) and one access point. */
        devices: [
            { type: 'gateway', mac: 'GW', name: 'gateway-gw1' },
            { type: 'ap', mac: 'AP1', name: 'eap' },
        ] as Raw[],
        timeRanges: [] as Array<{ profileId: string; name: string }>,
        /** IP groups (0) and IP-port groups (1). */
        groups: { 0: [{ groupId: 'ip-any', name: 'IPGroup_Any', buildIn: true, ipList: [{ ip: '0.0.0.0', mask: 0 }] }], 1: [] } as Record<number, Raw[]>,
        /** A write op that fails once (to check what a half-done change leaves behind). */
        failOn: undefined as string | undefined,
        /** A write op that takes effect, then reports an error once (its answer got lost); with skip, on a later call. */
        failAfter: undefined as string | { op: string; skip: number } | undefined,
        /** Runs at the start of every write (e.g. someone editing in the web UI at that moment). */
        beforeWrite: undefined as undefined | ((op: string, args: unknown[]) => void),
        /** The gateway ACL list after every write, to check intermediate states. */
        history: [] as Raw[][],
        /** A read that fails once, after letting `skip` calls through (an answer lost after a write); listAcls counts gateway ACL reads only. */
        failRead: undefined as undefined | { op: 'listAcls' | 'listGroups' | 'listClients' | 'listDhcpReservations'; skip: number },
        nextId: 0,
    };
    const writes: Array<{ op: string; args: unknown[] }> = [];
    const failRead = (op: 'listAcls' | 'listGroups' | 'listClients' | 'listDhcpReservations') => {
        if (state.failRead?.op !== op) return;
        if (state.failRead.skip-- > 0) return;
        state.failRead = undefined;
        throw new Error(`${op} timed out`);
    };
    const record = (op: string) => async (...args: unknown[]) => {
        state.beforeWrite?.(op, args);
        if (state.failOn === op) {
            state.failOn = undefined;
            throw new Error(`${op} refused by the controller`);
        }
        writes.push({ op, args: structuredClone(args) });
        const gacls = () => state.acls['osg-acls'];
        if (op === 'createGroup') state.groups[(args[0] as Raw).type as number].push({ groupId: `g-${++state.nextId}`, ...(args[0] as Raw) });
        if (op === 'deleteGroup') state.groups[args[0] as number] = state.groups[args[0] as number].filter((g) => g.groupId !== args[1]);
        if (op === 'createGatewayAcl') gacls().push({ id: `acl-${++state.nextId}`, index: gacls().length + 1, ...(args[0] as Raw) });
        if (op === 'updateGatewayAcl') state.acls['osg-acls'] = gacls().map((a) => (a.id === args[0] ? { id: a.id, index: a.index, ...(args[1] as Raw) } : a));
        if (op === 'deleteGatewayAcl') {
            state.acls['osg-acls'] = gacls()
                .filter((a) => a.id !== args[0])
                .sort((a, b) => Number(a.index) - Number(b.index))
                .map((a, i) => ({ ...a, index: i + 1 }));
        }
        if (op === 'reorderGatewayAcls') state.acls['osg-acls'] = gacls().map((a) => ({ ...a, index: (args[0] as Record<string, number>)[a.id as string] }));
        state.history.push(structuredClone(gacls().slice().sort((a, b) => Number(a.index) - Number(b.index))));
        const after = typeof state.failAfter === 'string' ? { op: state.failAfter, skip: 0 } : state.failAfter;
        if (after?.op === op && after.skip-- <= 0) {
            state.failAfter = undefined;
            throw new Error(`${op}: no answer from the controller`);
        }
        if (after && typeof state.failAfter === 'object') state.failAfter = after;
        if (op === 'createLanNetwork') state.networks.push({ id: `net-new-${state.networks.length}`, ...(args[0] as Raw) });
        if (op === 'updateLanNetwork') state.networks = state.networks.map((n) => (n.id === args[0] ? { ...n, ...(args[1] as Raw) } : n));
        if (op === 'deleteLanNetwork') state.networks = state.networks.filter((n) => n.id !== args[0]);
        if (op === 'createSsid') state.ssids.push({ wlanId: args[0] as string, ssidId: `ssid-new-${state.ssids.length}`, detail: { ...(args[1] as Raw), ssidEnable: true, macFilter: { macFilterEnable: false } } });
        if (op === 'updateSsidBasic') state.ssids = state.ssids.map((s) => (s.ssidId === args[1] ? { ...s, detail: { ...s.detail, ...(args[2] as Raw) } } : s));
        if (op === 'updateSsidMacFilter') state.ssids = state.ssids.map((s) => (s.ssidId === args[1] ? { ...s, detail: { ...s.detail, macFilter: args[2] } } : s));
        if (op === 'deleteSsid') state.ssids = state.ssids.filter((s) => s.ssidId !== args[1]);
        if (op === 'createDhcpReservation') state.reservations.push(args[0] as Raw);
        if (op === 'updateDhcpReservation') state.reservations = state.reservations.map((r) => (r.mac === args[0] ? (args[1] as Raw) : r));
        if (op === 'deleteDhcpReservation') state.reservations = state.reservations.filter((r) => r.mac !== args[0]);
    };
    const client = {
        controllerHost: '10.0.0.250',
        resolveSiteId: (id?: string) => id ?? 'site-1',
        networkConfig: {
            listLanNetworks: vi.fn(async () => structuredClone(state.networks)),
            listLanProfiles: vi.fn(async () => structuredClone(state.lanProfiles)),
            listNetworkPorts: vi.fn(async (id: string) => structuredClone(state.networkPorts[id] ?? [])),
            listAcls: vi.fn(async (list: string) => {
                if (list === 'osg-acls') failRead('listAcls');
                return structuredClone(state.acls[list]);
            }),
            // Like the real controller: every SSID again under the pseudo WLAN group 'gateway', listed first.
            listSsidSummaries: vi.fn(async () => [
                { wlanId: 'gateway', wlanName: 'gateway', ssidList: state.ssids.map((s) => ({ ssidId: s.ssidId, ssidName: String(s.detail.name) })) },
                { wlanId: 'wlan-1', wlanName: 'Default', ssidList: state.ssids.map((s) => ({ ssidId: s.ssidId, ssidName: String(s.detail.name) })) },
            ]),
            getSsidDetail: vi.fn(async (wlanId: string, ssidId: string) => {
                if (wlanId === 'gateway') throw new Error('Invalid request parameters.');
                return structuredClone(state.ssids.find((s) => s.ssidId === ssidId)!.detail);
            }),
            createLanNetwork: vi.fn(record('createLanNetwork')),
            updateLanNetwork: vi.fn(record('updateLanNetwork')),
            deleteLanNetwork: vi.fn(record('deleteLanNetwork')),
            createSsid: vi.fn(record('createSsid')),
            updateSsidBasic: vi.fn(record('updateSsidBasic')),
            updateSsidMacFilter: vi.fn(record('updateSsidMacFilter')),
            deleteSsid: vi.fn(record('deleteSsid')),
            listGroups: vi.fn(async (type: number) => {
                failRead('listGroups');
                return structuredClone(state.groups[type]);
            }),
            createGroup: vi.fn(record('createGroup')),
            deleteGroup: vi.fn(record('deleteGroup')),
            createGatewayAcl: vi.fn(record('createGatewayAcl')),
            updateGatewayAcl: vi.fn(record('updateGatewayAcl')),
            deleteGatewayAcl: vi.fn(record('deleteGatewayAcl')),
            reorderGatewayAcls: vi.fn(record('reorderGatewayAcls')),
            createDhcpReservation: vi.fn(record('createDhcpReservation')),
            updateDhcpReservation: vi.fn(record('updateDhcpReservation')),
            deleteDhcpReservation: vi.fn(record('deleteDhcpReservation')),
        },
        listClients: vi.fn(async () => {
            failRead('listClients');
            return structuredClone(state.clients);
        }),
        listMacGroups: vi.fn(async () => structuredClone(state.macGroups)),
        listDevices: vi.fn(async () => structuredClone(state.devices)),
        accessControl: {
            listDhcpReservations: vi.fn(async () => {
                if (state.failRead?.op === 'listDhcpReservations') failRead('listDhcpReservations');
                return structuredClone(state.reservations);
            }),
            listTimeRanges: vi.fn(async () => structuredClone(state.timeRanges)),
        },
    };
    const net = new OmadaNetworkController(client as unknown as OmadaClient, { controllerHost, ...(resolveHost ? { resolveHost } : {}), ...(serverHosts ? { serverHosts } : {}) });
    const apply = async (change: Change, allowLockout = false) => net.apply(await net.plan(change), { allowLockout });
    return { state, writes, net, apply };
}

const newNetwork = (over: Partial<Extract<Change, { op: 'create'; kind: 'network' }>['value']> = {}): Change => ({
    op: 'create',
    kind: 'network',
    value: { name: 'Untrusted', purpose: 'normal', vlan: 3, gateway: '10.0.3.1/24', dhcp: { enabled: true, range: { from: '10.0.3.100', to: '10.0.3.200' } }, ipv6: false, isolated: false, ...over },
});
const newWifi = (over: Partial<Extract<Change, { op: 'create'; kind: 'wifi' }>['value']> = {}): Change => ({
    op: 'create',
    kind: 'wifi',
    value: { name: 'iot-wifi', network: { name: 'IoT' }, bands: ['2.4'], security: 'wpa2', pmf: 'optional', clientIsolation: false, hidden: false, fastRoaming: false, macFilter: null, enabled: true, ...over },
    passphrase: { kind: 'temporary' },
});
const code = async (promise: Promise<unknown>) => promise.then(() => 'ok', (e) => (e instanceof NetError ? e.code : `not a NetError: ${String(e)}`));
const message = async (promise: Promise<unknown>) => promise.then(() => 'ok', (e) => String((e as Error).message));

describe('reading', () => {
    it('maps networks, marking the primary one and the controller\'s as protected', async () => {
        const { net } = controller();

        const networks = await net.listNetworks();

        expect(networks.map((n) => [n.name, n.vlan, n.gateway, n.protected, n.ipv6])).toEqual([
            ['Default', 1, '10.0.0.1/24', true, true],
            ['IoT', 2, '10.0.1.1/24', false, false],
            ['Engineering', 70, '10.0.70.1/24', false, false],
        ]);
        expect(networks[0].dhcp).toEqual({ enabled: true, range: { from: '10.0.0.100', to: '10.0.0.200' }, leaseMinutes: 120 });
    });

    it('protects the primary network and, separately, the network the controller is on', async () => {
        const { net } = controller('10.0.70.5');

        expect((await net.listNetworks()).map((n) => [n.name, n.protected])).toEqual([
            ['Default', true],
            ['IoT', false],
            ['Engineering', true],
        ]);
    });

    it('resolves a controller host name to protect its network, and protects every routed network when it cannot', async () => {
        const named = controller('omada.home.test', async () => ['10.0.70.5']);
        expect((await named.net.listNetworks()).map((n) => [n.name, n.protected])).toEqual([
            ['Default', true],
            ['IoT', false],
            ['Engineering', true],
        ]);

        const unknown = controller('omada.home.test', async () => {
            throw new Error('ENOTFOUND');
        });
        expect((await unknown.net.listNetworks()).every((n) => n.protected)).toBe(true);
        expect(await code(unknown.apply({ op: 'delete', kind: 'network', ref: { name: 'IoT' } }))).toBe('PROTECTED');
        expect(unknown.writes).toEqual([]);
    });

    it('reports a Wi-Fi network switched off by omada_setSsidEnabled (24/7 radio-off schedule) as off', async () => {
        const { state, net } = controller();
        state.timeRanges.push({ profileId: 'tr-always', name: ALWAYS_PROFILE_NAME });
        state.ssids[0].detail.wlanSchedule = { wlanScheduleEnable: true, action: 0, scheduleId: 'tr-always' };
        state.ssids.push({ wlanId: 'wlan-1', ssidId: 'ssid-kids', detail: { name: 'kids', security: 0, band: 1, ssidEnable: true, wlanSchedule: { wlanScheduleEnable: true, action: 0, scheduleId: 'tr-school' } } });

        expect((await net.listWifi()).map((w) => [w.name, w.enabled])).toEqual([
            ['home-wifi', false],
            ['kids', true], // switched off only part of the time: still on
        ]);
    });

    it('copes with a device that has no IPv4 address yet, placing it by VLAN', async () => {
        const { state, net } = controller();
        state.clients.push({ mac: '02:00:00:00:00:07', name: 'waiting', ip: '', vid: 2, active: true });
        state.clients.push({ mac: '02:00:00:00:00:08', name: 'odd', ip: 'n/a', active: true });

        const clients = await net.listClients();

        expect(clients.find((c) => c.name === 'waiting')).toEqual({ mac: '02-00-00-00-00-07', name: 'waiting', network: { id: 'net-iot' }, online: true });
        expect(clients.find((c) => c.name === 'odd')).toEqual({ mac: '02-00-00-00-00-08', name: 'odd', online: true });
        expect(await net.listNetworks()).toHaveLength(3);
    });

    it('maps Wi-Fi without its password, skipping the pseudo WLAN group', async () => {
        const { net } = controller();

        const wifi = await net.listWifi();

        expect(wifi).toEqual([
            { id: 'ssid-home', name: 'home-wifi', network: { id: 'net-default' }, bands: ['2.4', '5', '6'], security: 'wpa3', pmf: 'optional', clientIsolation: false, hidden: false, fastRoaming: false, macFilter: null, enabled: true },
        ]);
        expect(JSON.stringify(wifi)).not.toContain(SECRET);
    });
});

describe('networks', () => {
    it('creates a routed VLAN on the primary network\'s LAN ports, IPv6 off', async () => {
        const { writes, apply } = controller();

        const result = await apply(newNetwork());

        expect(writes).toEqual([
            {
                op: 'createLanNetwork',
                args: [
                    {
                        name: 'Untrusted',
                        purpose: 1,
                        vlan: 3,
                        igmpSnoopEnable: false,
                        interfaceIds: ['lan1', 'lan2'],
                        vlanType: 0,
                        application: 0,
                        gatewaySubnet: '10.0.3.1/24',
                        dhcpSettingsVO: { enable: true, ipRangePool: [{ ipaddrStart: '10.0.3.100', ipaddrEnd: '10.0.3.200' }], leasetime: 120, dhcpns: 'auto' },
                        mldSnoopEnable: false,
                        dhcpL2RelayEnable: false,
                        dhcpGuard: { enable: false },
                        dhcpv6Guard: { enable: false },
                        lanNetworkIpv6Config: { proto: 0, enable: 0 },
                    },
                    'site-1',
                ],
            },
        ]);
        expect(result.object).toMatchObject({ name: 'Untrusted', vlan: 3, protected: false });
    });

    it('creates a switch-only VLAN without gateway or DHCP', async () => {
        const { writes, apply } = controller();

        await apply(newNetwork({ name: 'Transit', purpose: 'vlanOnly', vlan: 99, gateway: undefined, dhcp: undefined }));

        expect(writes[0].args[0]).toEqual({ name: 'Transit', purpose: 0, vlan: 99, igmpSnoopEnable: false });
    });

    it('plans without writing', async () => {
        const { writes, net } = controller();

        const plan = await net.plan(newNetwork());

        expect(plan.steps).toEqual([{ action: 'create', object: 'omada.lanNetwork', name: 'Untrusted', detail: 'VLAN 3, 10.0.3.1/24' }]);
        expect(plan.wouldLockOut).toEqual([]);
        expect(writes).toEqual([]);
    });

    it.each([
        ['a VLAN in use', newNetwork({ vlan: 70 }), 'EXISTS'],
        ['a name in use', newNetwork({ name: 'iot' }), 'EXISTS'],
        ['an overlapping subnet', newNetwork({ gateway: '10.0.1.129/25', dhcp: { enabled: false } }), 'EXISTS'],
        ['VLAN 1', newNetwork({ vlan: 1 }), 'INVALID'],
        ['a gateway on the network address', newNetwork({ gateway: '10.0.3.0/24' }), 'INVALID'],
        ['a DHCP range outside the subnet', newNetwork({ dhcp: { enabled: true, range: { from: '10.0.4.10', to: '10.0.4.20' } } }), 'INVALID'],
        ['a DHCP range over the gateway', newNetwork({ dhcp: { enabled: true, range: { from: '10.0.3.1', to: '10.0.3.20' } } }), 'INVALID'],
        ['a guest network type', newNetwork({ purpose: 'guest' }), 'UNSUPPORTED'],
        ['isolation', newNetwork({ isolated: true }), 'UNSUPPORTED'],
        ['IPv6 on', newNetwork({ ipv6: true }), 'UNSUPPORTED'],
        ['a switch-only network with a gateway or DHCP', newNetwork({ purpose: 'vlanOnly', vlan: 99 }), 'INVALID'],
    ])('refuses %s, writing nothing', async (_label, change, expected) => {
        const { writes, apply } = controller();

        expect(await code(apply(change))).toBe(expected);
        expect(writes).toEqual([]);
    });

    it('updates DHCP, sending back the writable fields only', async () => {
        const { writes, apply } = controller();

        await apply({ op: 'update', kind: 'network', value: { ref: { name: 'Engineering' }, set: { dhcp: { enabled: true, range: { from: '10.0.70.50', to: '10.0.70.90' }, leaseMinutes: 60 } } } });

        const body = writes[0].args[1] as Raw;
        expect(writes[0]).toMatchObject({ op: 'updateLanNetwork', args: ['net-lab', expect.any(Object), 'site-1'] });
        expect(body.dhcpSettingsVO).toEqual({ enable: true, ipRangePool: [{ ipaddrStart: '10.0.70.50', ipaddrEnd: '10.0.70.90' }], leasetime: 60, dhcpns: 'auto' });
        expect(Object.keys(body)).not.toContain('primary');
        expect(body).toMatchObject({ name: 'Engineering', vlan: 70, gatewaySubnet: '10.0.70.1/24', interfaceIds: ['lan2'] });
    });

    it('keeps DHCP settings the change does not mention (options, next server, DNS)', async () => {
        const { state, writes, apply } = controller();
        Object.assign(state.networks[2].dhcpSettingsVO as Raw, { dhcpns: 'manual', priDns: '10.0.0.53', dhcpNextServer: '10.0.70.5', options: [{ code: 42, type: 1, value: '10.0.0.1' }] });

        await apply({ op: 'update', kind: 'network', value: { ref: { name: 'Engineering' }, set: { dhcp: { enabled: true, leaseMinutes: 600 } } } });

        expect((writes[0].args[1] as Raw).dhcpSettingsVO).toEqual({
            enable: true,
            ipRangePool: [{ ipaddrStart: '10.0.70.100', ipaddrEnd: '10.0.70.200' }],
            dhcpns: 'manual',
            priDns: '10.0.0.53',
            leasetime: 600,
            dhcpNextServer: '10.0.70.5',
            options: [{ code: 42, type: 1, value: '10.0.0.1' }],
        });
    });

    it('replaces the DNS servers when given: two become one, an empty list means automatic', async () => {
        const { state, writes, apply } = controller();
        Object.assign(state.networks[2].dhcpSettingsVO as Raw, { dhcpns: 'manual', priDns: '10.0.0.53', sndDns: '10.0.0.54' });

        await apply({ op: 'update', kind: 'network', value: { ref: { name: 'Engineering' }, set: { dhcp: { enabled: true, dns: ['10.0.0.60'] } } } });
        const one = writes[0].args[1] as Raw;
        expect(one.dhcpSettingsVO).toMatchObject({ dhcpns: 'manual', priDns: '10.0.0.60' });
        expect(one.dhcpSettingsVO).not.toHaveProperty('sndDns');

        await apply({ op: 'update', kind: 'network', value: { ref: { name: 'Engineering' }, set: { dhcp: { enabled: true, dns: [] } } } });
        const auto = writes[1].args[1] as Raw;
        expect(auto.dhcpSettingsVO).toMatchObject({ dhcpns: 'auto' });
        expect(auto.dhcpSettingsVO).not.toHaveProperty('priDns');
        expect(auto.dhcpSettingsVO).not.toHaveProperty('sndDns');
    });

    it('refuses DHCP or gateway changes on a switch-only network, even combined with a rename', async () => {
        const { state, writes, apply } = controller();
        state.networks.push({ id: 'net-transit', name: 'Transit', purpose: 0, vlan: 99 });

        expect(await code(apply({ op: 'update', kind: 'network', value: { ref: { name: 'Transit' }, set: { name: 'Transit-99', dhcp: { enabled: true, range: { from: '10.0.99.10', to: '10.0.99.20' } } } } }))).toBe('INVALID');
        expect(await code(apply({ op: 'update', kind: 'network', value: { ref: { name: 'Transit' }, set: { gateway: '10.0.99.1/24' } } }))).toBe('INVALID');
        expect(writes).toEqual([]);
    });

    it('keeps every DHCP pool when the range is not given, and checks each against a new gateway', async () => {
        const { state, writes, apply } = controller();
        const pools = [{ ipaddrStart: '10.0.70.100', ipaddrEnd: '10.0.70.150' }, { ipaddrStart: '10.0.71.10', ipaddrEnd: '10.0.71.50' }];
        Object.assign(state.networks[2], { gatewaySubnet: '10.0.70.1/23' });
        (state.networks[2].dhcpSettingsVO as Raw).ipRangePool = pools;

        await apply({ op: 'update', kind: 'network', value: { ref: { name: 'Engineering' }, set: { dhcp: { enabled: true, leaseMinutes: 60 } } } });
        expect((writes[0].args[1] as Raw).dhcpSettingsVO).toMatchObject({ ipRangePool: pools, leasetime: 60 });

        const error = await apply({ op: 'update', kind: 'network', value: { ref: { name: 'Engineering' }, set: { gateway: '10.0.70.1/24' } } }, true).catch((e: NetError) => e);
        expect(error).toMatchObject({ code: 'INVALID', message: expect.stringContaining("10.0.71.10-10.0.71.50 doesn't fit") });
        expect(writes).toHaveLength(1);

        // The same when the gateway and a DHCP setting change together.
        const combined = await apply({ op: 'update', kind: 'network', value: { ref: { name: 'Engineering' }, set: { gateway: '10.0.70.1/24', dhcp: { enabled: true, leaseMinutes: 30 } } } }, true).catch((e: NetError) => e);
        expect(combined).toMatchObject({ code: 'INVALID' });
        expect(writes).toHaveLength(1);
    });

    it('moves the DHCP router address with the gateway, and refuses a custom one the new subnet does not hold', async () => {
        const { state, writes, apply } = controller();
        (state.networks[2].dhcpSettingsVO as Raw).gateway = '10.0.70.1';
        const move: Change = { op: 'update', kind: 'network', value: { ref: { name: 'Engineering' }, set: { gateway: '10.0.71.1/24', dhcp: { enabled: true, range: { from: '10.0.71.100', to: '10.0.71.200' } } } } };

        await apply(move, true);
        expect((writes[0].args[1] as Raw).dhcpSettingsVO).toMatchObject({ gateway: '10.0.71.1' });

        (state.networks[2] as Raw).gatewaySubnet = '10.0.70.1/24';
        (state.networks[2].dhcpSettingsVO as Raw).gateway = '10.0.70.254';
        expect(await code(apply(move, true))).toBe('INVALID');
        expect(writes).toHaveLength(1);
    });

    it('may switch IPv6 off on the protected network, but never change its VLAN or gateway', async () => {
        const { writes, apply } = controller();

        expect(await code(apply({ op: 'update', kind: 'network', value: { ref: { name: 'Default' }, set: { vlan: 10 } } }))).toBe('PROTECTED');
        expect(await code(apply({ op: 'update', kind: 'network', value: { ref: { name: 'Default' }, set: { gateway: '10.0.9.1/24' } } }))).toBe('PROTECTED');
        expect(writes).toEqual([]);

        // The phone on Default is online: switching IPv6 off needs allowLockout.
        expect(await code(apply({ op: 'update', kind: 'network', value: { ref: { name: 'Default' }, set: { ipv6: false } } }))).toBe('LOCKOUT');
        expect(writes).toEqual([]);
        await apply({ op: 'update', kind: 'network', value: { ref: { name: 'Default' }, set: { ipv6: false } } }, true);
        expect((writes[0].args[1] as Raw).lanNetworkIpv6Config).toEqual({ proto: 0, enable: 0 });
    });

    it('needs allowLockout to re-address a network devices are on', async () => {
        const { state, writes, apply } = controller();
        state.clients.push({ mac: '02:00:00:00:00:02', name: 'scope', ip: '10.0.70.120', vid: 70, active: true });
        const change: Change = { op: 'update', kind: 'network', value: { ref: { name: 'Engineering' }, set: { gateway: '10.0.71.1/24', dhcp: { enabled: true, range: { from: '10.0.71.100', to: '10.0.71.200' } } } } };

        expect(await code(apply(change))).toBe('LOCKOUT');
        expect(writes).toEqual([]);
        expect(await code(apply(change, true))).toBe('ok');
    });

    it('refuses a new gateway whose subnet the kept DHCP range does not fit', async () => {
        const { writes, apply } = controller();

        const error = await apply({ op: 'update', kind: 'network', value: { ref: { name: 'Engineering' }, set: { gateway: '10.0.71.1/24' } } }, true).catch((e: NetError) => e);

        expect(error).toMatchObject({ code: 'INVALID', message: expect.stringContaining("10.0.70.100-10.0.70.200 doesn't fit 10.0.71.1/24") });
        expect(writes).toEqual([]);
    });

    it('keeps a DHCP range that still fits a changed gateway', async () => {
        const { writes, apply } = controller();

        await apply({ op: 'update', kind: 'network', value: { ref: { name: 'Engineering' }, set: { gateway: '10.0.70.1/23' } } }, true);

        expect((writes[0].args[1] as Raw).dhcpSettingsVO).toEqual({ enable: true, ipRangePool: [{ ipaddrStart: '10.0.70.100', ipaddrEnd: '10.0.70.200' }], leasetime: 120, dhcpns: 'auto' });
    });

    it('refuses to delete a network something still uses, listing the users', async () => {
        const { state, writes, net, apply } = controller();
        state.reservations.push({ mac: '02-00-00-00-00-09', ip: '10.0.1.9', netId: 'net-iot' });
        state.acls['osw-acls'].push({ description: 'Deny IoT to Home', sourceType: 0, sourceIds: ['net-iot'], destinationType: 0, destinationIds: ['net-default'] });
        state.lanProfiles.push({ name: 'IoT ports', nativeNetworkId: 'net-iot' });
        // Ports 3 and 5 and LAG 1 carry IoT untagged, port 9 only tagged (fine to delete under); the gateway has no switch ports.
        state.networkPorts['net-iot'] = [
            { type: 'gateway', mac: 'GW', name: 'gateway-gw1' },
            { type: 'switch', mac: 'SW', name: 'switch-sw1', switchInfo: { affectedPorts: { nativePorts: [5, 4], untagPorts: [3, 5], tagPorts: [9], nativeLags: [2], untagLags: [1], tagLags: [] } } },
            { type: 'switch', mac: 'SW2', switchInfo: { affectedPorts: { nativePorts: [], untagPorts: [], tagPorts: [], nativeLags: [], untagLags: [], tagLags: [], tagPorts: [1, 2] } } },
            { type: 'switch', mac: 'SW3', switchInfo: { affectedPorts: { nativePorts: [], untagPorts: [], tagPorts: [], nativeLags: [], untagLags: [], tagLags: [], untagLags: [3] } } },
        ];
        state.ssids.push({ wlanId: 'wlan-1', ssidId: 'ssid-iot', detail: { name: 'iot-wifi', security: 0, band: 1, vlanSetting: { mode: 1, customConfig: { customMode: 0, lanNetworkVlanIds: { 'net-iot': [2] } } } } });

        const error = await net.plan({ op: 'delete', kind: 'network', ref: { name: 'IoT' } }).catch((e: NetError) => e);

        expect(error).toMatchObject({ code: 'IN_USE' });
        expect((error as NetError).details.users).toEqual([
            "Wi-Fi 'iot-wifi'",
            "port profile 'IoT ports'",
            "switch 'switch-sw1' ports 3, 4, 5 and LAGs 1, 2 (untagged)",
            "switch 'SW3' LAGs 3 (untagged)",
            'DHCP reservation 02-00-00-00-00-09',
            "switch rule 'Deny IoT to Home'",
        ]);
        expect(await code(apply({ op: 'delete', kind: 'network', ref: { name: 'Default' } }))).toBe('PROTECTED');
        expect(writes).toEqual([]);
    });

    it('refuses to delete a network while a switch\'s port lists for it can\'t be read, writing nothing', async () => {
        for (const entry of [
            { type: 'switch', mac: 'SW', name: 'switch-sw1' },
            { type: 'switch', mac: 'SW', name: 'switch-sw1', switchInfo: { affectedPorts: 'all' } },
            { type: 'switch', mac: 'SW', name: 'switch-sw1', switchInfo: { affectedPorts: { nativePorts: [], untagPorts: [], tagPorts: [] } } }, // no LAG lists
            { type: 'switch', mac: 'SW', name: 'switch-sw1', switchInfo: { affectedPorts: { nativePorts: [], untagPorts: [], tagPorts: [], nativeLags: [], untagLags: [], tagLags: [], nativePorts: '5' } } },
            { mac: 'SW', name: 'switch-sw1', switchInfo: {} }, // no type, but switch details
        ]) {
            const { state, writes, apply } = controller();
            state.networkPorts['net-lab'] = [{ type: 'gateway', mac: 'GW', name: 'gateway-gw1' }, entry];

            const error = await apply({ op: 'delete', kind: 'network', ref: { name: 'Engineering' } }).catch((e: NetError) => e);

            expect(error).toMatchObject({ code: 'IN_USE', details: { users: ["switch 'switch-sw1' (which of its ports carry it can't be read)"] } });
            expect(writes).toEqual([]);
        }
    });

    it('refuses to delete any network an SSID maps to, not just the first', async () => {
        const { state, writes, apply } = controller();
        state.ssids.push({ wlanId: 'wlan-1', ssidId: 'ssid-multi', detail: { name: 'multi', security: 0, band: 1, vlanSetting: { mode: 1, customConfig: { customMode: 0, lanNetworkVlanIds: { 'net-iot': [2], 'net-lab': [70] } } } } });

        const error = await apply({ op: 'delete', kind: 'network', ref: { name: 'Engineering' } }).catch((e: NetError) => e);

        expect(error).toMatchObject({ code: 'IN_USE', details: { users: ["Wi-Fi 'multi'"] } });
        expect(writes).toEqual([]);
    });

    it('deletes an unused network', async () => {
        const { writes, apply } = controller();

        await apply({ op: 'delete', kind: 'network', ref: { name: 'Engineering' } });

        expect(writes).toEqual([{ op: 'deleteLanNetwork', args: ['net-lab', 'site-1'] }]);
    });
});

describe('Wi-Fi', () => {
    it('puts a new Wi-Fi network on the access points, and on the gateway only when it has Wi-Fi', async () => {
        const wifiGateway = (s: ReturnType<typeof controller>['state']) => {
            s.networkPorts['net-default'] = [{ type: 'gateway', mac: 'GW', gatewayInfo: { gatewayDetail: { wirelessRouter: true } } }];
        };
        const both = controller();
        wifiGateway(both.state);
        await both.apply(newWifi());
        expect((both.writes[0].args[1] as Raw).deviceType).toBe(3);

        const gatewayOnly = controller();
        wifiGateway(gatewayOnly.state);
        gatewayOnly.state.devices = gatewayOnly.state.devices.filter((d) => d.type !== 'ap');
        await gatewayOnly.apply(newWifi());
        expect((gatewayOnly.writes[0].args[1] as Raw).deviceType).toBe(2);

        const neither = controller();
        neither.state.devices = neither.state.devices.filter((d) => d.type !== 'ap');
        expect(await message(neither.net.plan(newWifi()))).toBe('Nothing could broadcast this Wi-Fi network: the site has no access point and the gateway has no Wi-Fi');
        expect(neither.writes).toEqual([]);
    });

    it('refuses to apply when what could broadcast the Wi-Fi changed after planning', async () => {
        const { state, writes, net } = controller();
        const plan = await net.plan(newWifi());
        state.networkPorts['net-default'] = [{ type: 'gateway', mac: 'GW', gatewayInfo: { gatewayDetail: { wirelessRouter: true } } }];

        expect(await code(net.apply(plan))).toBe('CONFLICT');
        expect(writes).toEqual([]);
    });

    it('creates an SSID tagged into the network\'s VLAN with a temporary password nobody sees', async () => {
        const { writes, net } = controller();

        const plan = await net.plan(newWifi());
        const result = await net.apply(plan);

        const body = writes[0].args[1] as Raw;
        expect(writes[0]).toMatchObject({ op: 'createSsid', args: ['wlan-1', expect.any(Object), 'site-1'] });
        expect(body).toMatchObject({
            name: 'iot-wifi',
            deviceType: 1, // access points only: the gateway has no radio (not copied from home-wifi's 3)
            band: 1,
            security: 3,
            broadcast: true,
            guestNetEnable: false,
            pmfMode: 2,
            enable11r: false,
            hidePwd: true,
            vlanEnable: false,
            vlanSetting: { mode: 1, customConfig: { customMode: 0, lanNetworkVlanIds: { 'net-iot': [2] } } },
            pskSetting: { versionPsk: 2, encryptionPsk: 3, gikRekeyPskEnable: false },
        });
        const key = (body.pskSetting as Raw).securityKey as string;
        expect(key).toMatch(/^[A-Za-z0-9]{32}$/);
        expect(JSON.stringify([plan, result])).not.toContain(key);
        expect(plan.effects.join(' ')).toMatch(/set the real password in the controller web UI/);
    });

    it('applies a MAC filter right after creating', async () => {
        const { writes, apply } = controller();

        await apply(newWifi({ macFilter: { policy: 'allow', group: { name: 'KnownWiFi' } } }));

        expect(writes.map((w) => w.op)).toEqual(['createSsid', 'updateSsidMacFilter']);
        expect(writes[1].args[2]).toEqual({ macFilterEnable: true, policy: 1, macFilterId: 'mg-known' });
    });

    it('creates an open Wi-Fi network with a MAC filter locked first, opening it only once the filter is in place', async () => {
        const { writes, apply } = controller();

        await apply(newWifi({ security: 'open', macFilter: { policy: 'allow', group: { name: 'KnownWiFi' } } }));

        expect(writes.map((w) => w.op)).toEqual(['createSsid', 'updateSsidMacFilter', 'updateSsidBasic']);
        expect(writes[0].args[1]).toMatchObject({ security: 3, pskSetting: { versionPsk: 2 } });
        expect(writes[2].args[2]).toMatchObject({ security: 0 });
        expect(writes[2].args[2]).not.toHaveProperty('pskSetting');
    });

    it('leaves the new Wi-Fi network locked if its MAC filter cannot be set', async () => {
        const { state, net } = controller();
        const plan = await net.plan(newWifi({ security: 'open', macFilter: { policy: 'allow', group: { name: 'KnownWiFi' } } }));
        const fake = (net as unknown as { client: { networkConfig: { updateSsidMacFilter: ReturnType<typeof vi.fn> } } }).client;
        fake.networkConfig.updateSsidMacFilter.mockRejectedValueOnce(new Error('controller refused'));

        await expect(net.apply(plan)).rejects.toThrow('controller refused');

        const created = state.ssids.find((x) => x.detail.name === 'iot-wifi')!;
        expect(created.detail).toMatchObject({ security: 3 });
    });

    it.each([
        ['a name in use', newWifi({ name: 'HOME-WIFI' }), 'EXISTS'],
        ['WPA2/WPA3 mixed mode', newWifi({ security: 'wpa2wpa3' }), 'UNSUPPORTED'],
        ['an unknown network', newWifi({ network: { name: 'Nowhere' } }), 'NOT_FOUND'],
        ['an unknown MAC group', newWifi({ macFilter: { policy: 'allow', group: { name: 'Nope' } } }), 'NOT_FOUND'],
        ['no band', newWifi({ bands: [] }), 'INVALID'],
    ])('refuses %s, writing nothing', async (_label, change, expected) => {
        const { writes, apply } = controller();

        expect(await code(apply(change))).toBe(expected);
        expect(writes).toEqual([]);
    });

    it('refuses to put Wi-Fi devices on a switch-only network (no address for them)', async () => {
        const { state, writes, apply } = controller();
        state.networks.push({ id: 'net-transit', name: 'Transit', purpose: 0, vlan: 99 });

        expect(await code(apply(newWifi({ network: { name: 'Transit' } })))).toBe('INVALID');
        expect(writes).toEqual([]);
    });

    it('refuses to move a Wi-Fi network onto a switch-only network', async () => {
        const { state, writes, apply } = controller();
        state.networks.push({ id: 'net-transit', name: 'Transit', purpose: 0, vlan: 99 });

        expect(await code(apply({ op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { network: { name: 'Transit' } } }, passphrase: { kind: 'unchanged' } }, true))).toBe('INVALID');
        expect(writes).toEqual([]);
    });

    it('narrows a Wi-Fi network mapped to two networks down to one', async () => {
        const { state, writes, apply } = controller();
        state.ssids[0].detail.vlanSetting = { mode: 1, customConfig: { customMode: 0, lanNetworkVlanIds: { 'net-iot': [2], 'net-lab': [70] } } };

        await apply({ op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { network: { name: 'IoT' } } }, passphrase: { kind: 'unchanged' } }, true);

        expect((writes[0].args[2] as Raw).vlanSetting).toEqual({ mode: 1, customConfig: { customMode: 0, lanNetworkVlanIds: { 'net-iot': [2] } } });
    });

    it('resends the unchanged password on update without ever showing it', async () => {
        const { writes, net } = controller();

        const plan = await net.plan({ op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { hidden: true, fastRoaming: true } }, passphrase: { kind: 'unchanged' } });
        const result = await net.apply(plan);

        expect((writes[0].args[2] as Raw).pskSetting).toMatchObject({ securityKey: SECRET });
        expect(writes[0].args[2]).toMatchObject({ broadcast: false, enable11r: true });
        expect(plan.wouldLockOut).toEqual([]);
        expect(JSON.stringify([plan, result])).not.toContain(SECRET);
    });

    it('keeps the existing password when only the security mode changes', async () => {
        const { writes, apply } = controller();

        await apply({ op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { security: 'wpa2' } }, passphrase: { kind: 'unchanged' } }, true);

        expect((writes[0].args[2] as Raw).pskSetting).toEqual({ securityKey: SECRET, versionPsk: 2, encryptionPsk: 3, gikRekeyPskEnable: false });
    });

    it('needs allowLockout for changes that disconnect devices, and can reset the password', async () => {
        const { writes, net, apply } = controller();
        const change: Change = { op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: {} }, passphrase: { kind: 'temporary' } };

        const plan = await net.plan(change);
        expect(plan.wouldLockOut.map((c) => c.name)).toEqual(['phone']);
        expect(await code(apply(change))).toBe('LOCKOUT');
        expect(writes).toEqual([]);

        await apply(change, true);
        const key = ((writes[0].args[2] as Raw).pskSetting as Raw).securityKey;
        expect(key).not.toBe(SECRET);
        expect(key).toMatch(/^[A-Za-z0-9]{32}$/);
    });

    it('treats a PMF change as disconnecting the devices on the Wi-Fi network', async () => {
        const { writes, net, apply } = controller();
        const change: Change = { op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { pmf: 'required' } }, passphrase: { kind: 'unchanged' } };

        expect((await net.plan(change)).wouldLockOut.map((c) => c.name)).toEqual(['phone']);
        expect(await code(apply(change))).toBe('LOCKOUT');
        expect(writes).toEqual([]);
    });

    it('opening a Wi-Fi network with a new MAC filter installs the filter first, while the password still protects it', async () => {
        const { writes, apply } = controller();
        const change: Change = { op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { security: 'open', macFilter: { policy: 'allow', group: { name: 'KnownWiFi' } } } }, passphrase: { kind: 'unchanged' } };

        await apply(change, true);

        expect(writes.map((w) => w.op)).toEqual(['updateSsidMacFilter', 'updateSsidBasic']);
        expect(writes[1].args[2]).toMatchObject({ security: 0 });
    });

    it('leaves a Wi-Fi network protected by its password if the new MAC filter cannot be set', async () => {
        const { state, net } = controller();
        const plan = await net.plan({ op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { security: 'open', macFilter: { policy: 'allow', group: { name: 'KnownWiFi' } } } }, passphrase: { kind: 'unchanged' } });
        const fake = (net as unknown as { client: { networkConfig: { updateSsidMacFilter: ReturnType<typeof vi.fn> } } }).client;
        fake.networkConfig.updateSsidMacFilter.mockRejectedValueOnce(new Error('controller refused'));

        await expect(net.apply(plan, { allowLockout: true })).rejects.toThrow('controller refused');

        expect(state.ssids[0].detail).toMatchObject({ security: 3, pskSetting: { securityKey: SECRET } });
    });

    it('moving an open Wi-Fi network to another network installs its MAC filter before the move, and stays put if that fails', async () => {
        const { state, writes, net } = controller();
        state.ssids[0].detail.security = 0;
        const change: Change = { op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { network: { name: 'Engineering' }, macFilter: { policy: 'allow', group: { name: 'KnownWiFi' } } } }, passphrase: { kind: 'unchanged' } };
        const fake = (net as unknown as { client: { networkConfig: { updateSsidMacFilter: ReturnType<typeof vi.fn> } } }).client;

        fake.networkConfig.updateSsidMacFilter.mockRejectedValueOnce(new Error('controller refused'));
        await expect(net.apply(await net.plan(change), { allowLockout: true })).rejects.toThrow('controller refused');
        expect(state.ssids[0].detail.vlanSetting).toEqual({ mode: 0, customConfig: {} });

        await net.apply(await net.plan(change), { allowLockout: true });
        expect(writes.map((w) => w.op)).toEqual(['updateSsidMacFilter', 'updateSsidBasic']);
    });

    it('refuses to apply a MAC filter plan when its group was renamed or replaced meanwhile', async () => {
        const { state, writes, net } = controller();
        const plan = await net.plan({ op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { macFilter: { policy: 'allow', group: { name: 'KnownWiFi' } } } }, passphrase: { kind: 'unchanged' } });
        state.macGroups[0].name = 'OldKnown';
        state.macGroups.push({ groupId: 'mg-other', name: 'KnownWiFi', type: 2, macAddressList: [] });

        expect(await code(net.apply(plan, { allowLockout: true }))).toBe('CONFLICT');
        expect(writes).toEqual([]);
    });

    it('reads legacy WPA/WPA2 as such, and a request for WPA2 really changes it', async () => {
        const { state, writes, net, apply } = controller();
        (state.ssids[0].detail.pskSetting as Raw).versionPsk = 3;

        expect((await net.listWifi())[0].security).toBe('wpa1wpa2');
        await apply({ op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { security: 'wpa2', hidden: true } }, passphrase: { kind: 'unchanged' } }, true);

        expect(writes[0].args[2]).toMatchObject({ broadcast: false, pskSetting: { versionPsk: 2, securityKey: SECRET } });
    });

    it.each([
        ['Enterprise', 2],
        ['PPSK', 4],
    ])('replaces %s security with WPA2 using a temporary password and says so', async (_label, security) => {
        const { state, writes, net, apply } = controller();
        state.ssids[0].detail.security = security;
        state.ssids[0].detail.pskSetting = undefined;
        const change: Change = { op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { security: 'wpa2' } }, passphrase: { kind: 'unchanged' } };

        const plan = await net.plan(change);
        await apply(change, true);

        const key = ((writes[0].args[2] as Raw).pskSetting as Raw).securityKey;
        expect(key).toMatch(/^[A-Za-z0-9]{32}$/);
        expect(plan.effects.join(' ')).toMatch(/set the real password in the controller web UI/);
        expect(JSON.stringify(plan)).not.toContain(String(key));
    });

    it('does not revive an old shared password left on an Enterprise network', async () => {
        const { state, writes, apply } = controller();
        state.ssids[0].detail.security = 2; // pskSetting still holds the old shared key

        await apply({ op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { security: 'wpa2' } }, passphrase: { kind: 'unchanged' } }, true);

        expect(((writes[0].args[2] as Raw).pskSetting as Raw).securityKey).not.toBe(SECRET);
    });

    it('leaves Enterprise and PPSK Wi-Fi networks to the web UI unless their security is replaced', async () => {
        const { state, writes, net, apply } = controller();
        state.ssids[0].detail.security = 2;

        expect((await net.listWifi())[0].security).toBe('enterprise');
        expect(await code(apply({ op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { hidden: true } }, passphrase: { kind: 'unchanged' } }, true))).toBe('INVALID');
        expect(writes).toEqual([]);
    });

    it('treats switching on client isolation (guest mode) as cutting devices off from the other networks', async () => {
        const { writes, net, apply } = controller();
        const change: Change = { op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { clientIsolation: true } }, passphrase: { kind: 'unchanged' } };

        const plan = await net.plan(change);
        expect(plan.wouldLockOut.map((c) => c.name)).toEqual(['phone']);
        expect(plan.effects.join(' ')).toMatch(/lose access to each other and to every private network/);
        expect(await code(apply(change))).toBe('LOCKOUT');
        expect(writes).toEqual([]);
    });

    it('locks out only the devices a new allow list leaves out', async () => {
        const { state, net } = controller();
        state.clients.push({ mac: '02:00:00:00:00:03', name: 'random-mac', ssid: 'home-wifi', active: true });

        const plan = await net.plan({ op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { macFilter: { policy: 'allow', group: { name: 'KnownWiFi' } } } }, passphrase: { kind: 'unchanged' } });

        expect(plan.wouldLockOut.map((c) => c.name)).toEqual(['random-mac']);
    });

    it('refuses switching a Wi-Fi network off here, and deleting the only one', async () => {
        const { writes, apply } = controller();

        expect(await code(apply({ op: 'update', kind: 'wifi', value: { ref: { name: 'home-wifi' }, set: { enabled: false } }, passphrase: { kind: 'unchanged' } }))).toBe('UNSUPPORTED');
        expect(await code(apply({ op: 'delete', kind: 'wifi', ref: { name: 'home-wifi' } }, true))).toBe('PROTECTED');
        expect(writes).toEqual([]);
    });

    it('deletes a Wi-Fi network, with allowLockout when devices are on it', async () => {
        const { state, writes, apply } = controller();
        state.ssids.push({ wlanId: 'wlan-1', ssidId: 'ssid-iot', detail: { name: 'iot-wifi', security: 0, band: 1 } });
        state.clients.push({ mac: '02:00:00:00:00:04', name: 'plug', ssid: 'iot-wifi', active: true });

        expect(await code(apply({ op: 'delete', kind: 'wifi', ref: { name: 'iot-wifi' } }))).toBe('LOCKOUT');
        await apply({ op: 'delete', kind: 'wifi', ref: { name: 'iot-wifi' } }, true);
        expect(writes).toEqual([{ op: 'deleteSsid', args: ['wlan-1', 'ssid-iot', 'site-1'] }]);
    });

    it('refuses a plan whose devices to cut off changed before it is applied, even with allowLockout', async () => {
        const { state, writes, net } = controller();
        state.ssids.push({ wlanId: 'wlan-1', ssidId: 'ssid-iot', detail: { name: 'iot-wifi', security: 0, band: 1 } });
        state.clients.push({ mac: '02:00:00:00:00:04', name: 'plug', ssid: 'iot-wifi', active: true });

        const plan = await net.plan({ op: 'delete', kind: 'wifi', ref: { name: 'iot-wifi' } });
        expect(plan.wouldLockOut.map((c) => c.name)).toEqual(['plug']);
        state.clients.push({ mac: '02:00:00:00:00:05', name: 'camera', ssid: 'iot-wifi', active: true });

        expect(await code(net.apply(plan, { allowLockout: true }))).toBe('CONFLICT');
        expect(writes).toEqual([]);
    });
});

describe('plan and apply', () => {
    it('refuses to apply a plan when the controller changed since, writing nothing', async () => {
        const { state, writes, net } = controller();

        const plan = await net.plan(newNetwork());
        state.networks.push({ id: 'net-x', name: 'Someone else', purpose: 1, vlan: 50, gatewaySubnet: '10.0.50.1/24' });

        expect(await code(net.apply(plan))).toBe('CONFLICT');
        expect(writes).toEqual([]);
    });

    it('reports what the net_ tools do not do (yet) as unsupported', async () => {
        const { net } = controller();

        expect(await code(net.plan({ op: 'delete', kind: 'group', ref: { name: 'x' } }))).toBe('UNSUPPORTED');
        expect(await code(net.plan({ op: 'delete', kind: 'portProfile', ref: { name: 'IoT' } }))).toBe('UNSUPPORTED');
        expect((await net.capabilities()).wifi.security).toEqual(['open', 'wpa2', 'wpa3']);
    });
});

// ---- DHCP reservations (2.5.4) ----------------------------------------------------------------

describe('reservations', () => {
    // Where this server is must be known for reservations to move (see the protection tests).
    const controller = (controllerHost = '10.0.0.250', resolveHost?: (host: string) => Promise<string[]>, serverHosts: string[] = ['10.0.0.9']) => base(controllerHost, resolveHost, serverHosts);
    const reserve = (mac: string, ip: string, extra: Partial<Extract<Change, { kind: 'reservation'; op: 'set' }>['value']> = {}): Change => ({ op: 'set', kind: 'reservation', value: { mac, ip, ...extra } });
    const RESERVED = { netId: 'net-iot', mac: '02-00-00-00-00-05', ip: '10.0.1.50', description: 'plug', status: true, options: [{ code: 42 }] };

    it('creates one with the same body as omada_setDhcpReservation and reads it back', async () => {
        const { writes, apply } = controller();

        const result = await apply(reserve('02:aa:bb:cc:dd:ee', '10.0.1.40', { description: ' printer ' }));

        expect(writes).toEqual([{ op: 'createDhcpReservation', args: [{ netId: 'net-iot', mac: '02-AA-BB-CC-DD-EE', ip: '10.0.1.40', description: 'printer', status: true, options: [] }, 'site-1'] }]);
        expect(result).toEqual({ applied: true, object: { mac: '02-AA-BB-CC-DD-EE', ip: '10.0.1.40', network: { id: 'net-iot' }, description: 'printer' }, owned: [] });
        expect(await controller().net.listReservations()).toEqual([]);
    });

    it('changes one in place (PATCH by its MAC), keeping its DHCP options and description', async () => {
        const { state, writes, net, apply } = controller();
        state.reservations.push(structuredClone(RESERVED));

        const plan = await net.plan(reserve('02-00-00-00-00-05', '10.0.1.51'));
        expect(plan.steps).toEqual([{ action: 'update', object: 'omada.dhcpReservation', name: '02-00-00-00-00-05', detail: '10.0.1.50 → 10.0.1.51' }]);
        await apply(reserve('02-00-00-00-00-05', '10.0.1.51'));

        expect(writes).toEqual([{ op: 'updateDhcpReservation', args: ['02-00-00-00-00-05', { netId: 'net-iot', mac: '02-00-00-00-00-05', ip: '10.0.1.51', description: 'plug', status: true, options: [{ code: 42 }] }, 'site-1'] }]);
    });

    it('moving an online device needs allowLockout; pinning it to its address does not', async () => {
        const { writes, apply } = controller();

        expect(await code(apply(reserve('02-00-00-00-00-01', '10.0.0.150')))).toBe('LOCKOUT');
        expect(writes).toEqual([]);
        expect(await code(apply(reserve('02-00-00-00-00-01', '10.0.0.101')))).toBe('ok');
        expect(await code(apply(reserve('02-00-00-00-00-01', '10.0.0.150'), true))).toBe('ok');
    });

    it('removes one by its MAC as the controller has it', async () => {
        const { state, writes, apply } = controller();
        state.reservations.push({ ...structuredClone(RESERVED), mac: '02-00-00-00-00-05' });

        expect(await apply({ op: 'delete', kind: 'reservation', mac: '02:00:00:00:00:05' })).toEqual({ applied: true, owned: [] });
        expect(writes).toEqual([{ op: 'deleteDhcpReservation', args: ['02-00-00-00-00-05', 'site-1'] }]);
        expect(state.reservations).toEqual([]);
    });

    it('never moves or removes the reservation of the controller or this server; pinning them is fine', async () => {
        const { state, writes, apply } = controller('10.0.0.250', undefined, ['10.0.0.9']);
        state.clients.push({ mac: '02:00:00:00:00:09', name: 'mcp', ip: '10.0.0.9', vid: 1, active: true });
        state.reservations.push({ netId: 'net-default', mac: '02-00-00-00-00-0A', ip: '10.0.0.250', status: true, options: [] });

        await expect(apply(reserve('02-00-00-00-00-09', '10.0.0.10'), true)).rejects.toMatchObject({ code: 'PROTECTED', message: '02-00-00-00-00-09 is this server: its address is never moved or released through the tools' });
        await expect(apply({ op: 'delete', kind: 'reservation', mac: '02-00-00-00-00-0A' })).rejects.toMatchObject({ code: 'PROTECTED', message: expect.stringContaining('is the controller') });
        await expect(apply(reserve('02-00-00-00-00-0A', '10.0.0.251'))).rejects.toMatchObject({ code: 'PROTECTED' });
        // Nor is their address reserved for another device (while they are offline and unreserved, nothing else would stop it).
        state.reservations = [];
        await expect(apply(reserve('02-AA-BB-CC-DD-EE', '10.0.0.250'))).rejects.toMatchObject({ code: 'PROTECTED', message: "10.0.0.250 is the controller's address; it can't be reserved for another device" });
        state.clients = state.clients.filter((c) => c.mac !== '02:00:00:00:00:09');
        await expect(apply(reserve('02-AA-BB-CC-DD-EE', '10.0.0.9'))).rejects.toMatchObject({ code: 'PROTECTED', message: expect.stringContaining("is this server's address") });
        expect(writes).toEqual([]);
        state.clients.push({ mac: '02:00:00:00:00:09', name: 'mcp', ip: '10.0.0.9', vid: 1, active: true });
        expect(await code(apply(reserve('02-00-00-00-00-09', '10.0.0.9')))).toBe('ok');
    });

    it('while where the controller or this server is can\'t be told, existing reservations are neither moved nor removed', async () => {
        const unset = controller('10.0.0.250', undefined, []);
        unset.state.reservations.push(structuredClone(RESERVED));
        await expect(unset.apply(reserve('02-00-00-00-00-05', '10.0.1.51'))).rejects.toMatchObject({ code: 'PROTECTED', message: expect.stringContaining("this server's address isn't configured (MCP_SERVER_ADDRESSES)") });
        await expect(unset.apply({ op: 'delete', kind: 'reservation', mac: '02-00-00-00-00-05' })).rejects.toMatchObject({ code: 'PROTECTED' });
        // Moving an online device without a reservation is refused too; a new one for an offline device or a pin is fine.
        await expect(unset.apply(reserve('02-00-00-00-00-01', '10.0.0.150'), true)).rejects.toMatchObject({ code: 'PROTECTED' });
        expect(await code(unset.apply(reserve('02-00-00-00-00-01', '10.0.0.101')))).toBe('ok');
        expect(await code(unset.apply(reserve('02-AA-BB-CC-DD-EE', '10.0.1.40')))).toBe('ok');

        const unknown = controller('omada.home.test', async () => {
            throw new Error('ENOTFOUND');
        });
        unknown.state.reservations.push(structuredClone(RESERVED));
        await expect(unknown.apply(reserve('02-00-00-00-00-05', '10.0.1.51'))).rejects.toMatchObject({ code: 'PROTECTED', message: expect.stringContaining("the controller's address can't be resolved") });
        expect(unset.writes.map((w) => w.op)).toEqual(['createDhcpReservation', 'createDhcpReservation']);
        expect(unknown.writes).toEqual([]);

        // No controller address given at all: as blind as one that doesn't resolve.
        const none = controller('');
        none.state.reservations.push(structuredClone(RESERVED));
        await expect(none.apply({ op: 'delete', kind: 'reservation', mac: '02-00-00-00-00-05' })).rejects.toMatchObject({ code: 'PROTECTED', message: expect.stringContaining("the controller's address isn't known") });
        expect(none.writes).toEqual([]);
    });

    it('a reservation changed in the controller after the dry run is a CONFLICT', async () => {
        const { state, writes, net } = controller();
        const plan = await net.plan(reserve('02-AA-BB-CC-DD-EE', '10.0.1.40'));
        state.reservations.push(structuredClone(RESERVED));

        expect(await code(net.apply(plan))).toBe('CONFLICT');
        expect(writes).toEqual([]);
    });

    it('reads every change back: something else stored is a CONFLICT, an unreadable answer a warning', async () => {
        const ignored = controller();
        ignored.state.beforeWrite = (op) => {
            if (op === 'createDhcpReservation') ignored.state.reservations.push({ netId: 'net-iot', mac: '02-AA-BB-CC-DD-EE', ip: '10.0.1.99', status: true });
        };
        // The fake stores the body too, after the one pushed first: the first match (10.0.1.99) is read back.
        expect(await code(ignored.apply(reserve('02-AA-BB-CC-DD-EE', '10.0.1.40')))).toBe('CONFLICT');

        const kept = controller();
        kept.state.reservations.push(structuredClone(RESERVED));
        kept.state.beforeWrite = (op) => {
            if (op === 'deleteDhcpReservation') kept.state.reservations.push({ ...structuredClone(RESERVED), mac: '02:00:00:00:00:05' });
        };
        expect(await code(kept.apply({ op: 'delete', kind: 'reservation', mac: '02-00-00-00-00-05' }))).toBe('CONFLICT');

        // The address is stored, but the controller kept the old description.
        const described = controller();
        described.state.reservations.push(structuredClone(RESERVED));
        described.state.beforeWrite = (op, args) => {
            if (op === 'updateDhcpReservation') (args[1] as Raw).description = 'plug';
        };
        expect(await code(described.apply(reserve('02-00-00-00-00-05', '10.0.1.50', { description: 'kitchen plug' })))).toBe('CONFLICT');

        const unread = controller();
        // The snapshot, the plan and apply's re-plan read the reservations; the read after the write fails.
        unread.state.failRead = { op: 'listDhcpReservations', skip: 2 };
        expect(await unread.apply(reserve('02-AA-BB-CC-DD-EE', '10.0.1.40'))).toEqual({
            applied: true,
            owned: [],
            warnings: ['The reservation change was accepted, but reading it back failed; check it with net_listReservations.'],
        });
    });
});

// ---- rules (2.4.7) ------------------------------------------------------------------------

const rule = (over: Partial<Extract<Change, { op: 'create'; kind: 'rule' }>['value']> = {}): Change => ({
    op: 'create',
    kind: 'rule',
    value: {
        name: 'IoT to Home',
        action: 'block',
        from: [{ network: { name: 'IoT' } }],
        to: [{ network: { name: 'Default' } }],
        protocol: 'any',
        replies: 'allow',
        schedule: { kind: 'always' },
        enabled: true,
        ...over,
    },
});
const gatewayAcls = (state: ReturnType<typeof controller>['state']) => state.acls['osg-acls'].slice().sort((a, b) => Number(a.index) - Number(b.index));
const ruleWrites = (writes: ReturnType<typeof controller>['writes']) => writes.filter((w) => /Group|GatewayAcl/.test(w.op));

describe('rules', () => {
    it('reports rules between networks, to the internet and stateful replies as native', async () => {
        const { net } = controller();
        expect((await net.capabilities()).rules).toMatchObject({ between: 'native', toInternet: 'native', stateful: 'native', deviceMatch: 'unsupported', wifiMatch: 'unsupported', schedule: 'unsupported' });
    });

    it('creates a stateful LAN to LAN block between two networks', async () => {
        const { writes, apply } = controller();

        const result = await apply(rule());

        expect(ruleWrites(writes)).toEqual([
            {
                op: 'createGatewayAcl',
                args: [
                    {
                        description: expect.stringMatching(/^IoT to Home \[net:[0-9a-f]{8}\]$/),
                        status: true,
                        policy: 0,
                        protocols: [256],
                        sourceType: 0,
                        sourceIds: ['net-iot'],
                        destinationType: 0,
                        destinationIds: ['net-default'],
                        syslog: false,
                        direction: { lanToWan: false, lanToLan: true, wanInIds: [], vpnInIds: [] },
                        stateMode: 0,
                    },
                    'site-1',
                ],
            },
        ]);
        expect(result.object).toMatchObject({ name: 'IoT to Home', action: 'block', from: [{ network: { name: 'IoT' } }], to: [{ network: { name: 'Default' } }], position: 1, enabled: true });
        expect(result.object).not.toHaveProperty('foreign');
    });

    it('plans without writing, saying replies still pass and where the rule sits', async () => {
        const { writes, net } = controller();

        const plan = await net.plan(rule());

        expect(plan.steps).toEqual([{ action: 'create', object: 'omada.gatewayAcl', name: 'IoT to Home', detail: 'LAN to LAN' }]);
        expect(plan.effects.join(' ')).toMatch(/IoT can no longer start connections to Default.*Replies to connections started from the other side still pass.*rule 1 of 1/);
        expect(writes).toEqual([]);
    });

    it('allows an address on ports through an IP-port group the rule owns, placed first', async () => {
        const { state, writes, apply } = controller();
        await apply(rule());

        const result = await apply(rule({ name: 'IoT to HA', action: 'allow', to: [{ addresses: ['10.0.0.19'] }], protocol: { tcpUdpPorts: '1883, 8123' }, position: 1 }));

        const group = state.groups[1][0];
        expect(group).toMatchObject({ type: 1, ipList: [{ ip: '10.0.0.19', mask: 32 }], portType: 0, portList: ['1883', '8123'] });
        expect(String(group.name)).toMatch(/^\[net:[0-9a-f]{8}\] to [0-9a-f]{16}$/);
        const acl = gatewayAcls(state)[0];
        expect(acl).toMatchObject({ policy: 1, protocols: [6, 17], sourceType: 0, sourceIds: ['net-iot'], destinationType: 2, destinationIds: [group.groupId], direction: { lanToLan: true, lanToWan: false } });
        expect(String(acl.description)).toMatch(/^IoT to HA \[net:[0-9a-f]{8}\]$/);
        expect(String(group.name).slice(0, 14)).toBe(String(acl.description).slice(-14));
        expect(gatewayAcls(state).map((a) => ruleNameOf(a))).toEqual(['IoT to HA', 'IoT to Home']);
        expect(writes.some((w) => w.op === 'reorderGatewayAcls')).toBe(true);
        // Read back as the model wrote it: the owned group is shown as addresses, the tag hidden.
        expect(result.object).toMatchObject({ name: 'IoT to HA', action: 'allow', to: [{ addresses: ['10.0.0.19'] }], protocol: { tcpUdpPorts: '1883,8123' }, position: 1 });
    });

    it('blocks a network from the internet with the built-in everything group, LAN to WAN', async () => {
        const { state, apply } = controller();

        await apply(rule({ name: 'Lab offline', from: [{ network: { name: 'Engineering' } }], to: [{ internet: true }] }));

        expect(gatewayAcls(state)[0]).toMatchObject({ destinationType: 1, destinationIds: ['ip-any'], direction: { lanToWan: true, lanToLan: false } });
        expect((await controller().net.listRules()).length).toBe(0);
    });

    it.each([
        ['the gateway itself', { to: [{ gateway: true as const }] }, 'UNSUPPORTED'],
        ['one device by MAC', { from: [{ device: '02:00:00:00:00:01' }] }, 'UNSUPPORTED'],
        ['a Wi-Fi network as the source', { from: [{ wifi: { name: 'home-wifi' } }] }, 'UNSUPPORTED'],
        ['matching replies (stateless)', { replies: 'match' as const }, 'UNSUPPORTED'],
        ['a schedule', { schedule: { kind: 'during' as const, windows: [{ days: ['mon' as const], from: '22:00', to: '24:00' }] } }, 'UNSUPPORTED'],
        ['two kinds of source', { from: [{ network: { name: 'IoT' } }, { addresses: ['10.0.70.5'] }] }, 'INVALID'],
        ['the same network on both sides', { to: [{ network: { name: 'IoT' } }] }, 'INVALID'],
        ['ports towards a network', { protocol: { tcpUdpPorts: '1883' } }, 'INVALID'],
        ['a port range', { to: [{ addresses: ['10.0.0.19'] }], protocol: { tcpUdpPorts: '8000-8100' } }, 'UNSUPPORTED'],
        ['a bad port', { to: [{ addresses: ['10.0.0.19'] }], protocol: { tcpUdpPorts: '70000' } }, 'INVALID'],
        ['ports towards the internet', { to: [{ addresses: ['203.0.113.7'] }], protocol: { tcpUdpPorts: '443' } }, 'UNSUPPORTED'],
        ['addresses mixing own networks and the internet', { to: [{ addresses: ['10.0.0.19', '203.0.113.7'] }] }, 'INVALID'],
        ['a range partly inside a network', { to: [{ addresses: ['10.0.0.0/16'] }] }, 'INVALID'],
        ['a bad address', { to: [{ addresses: ['10.0.0.300'] }] }, 'INVALID'],
        ['an unknown network', { to: [{ network: { name: 'Nope' } }] }, 'NOT_FOUND'],
        ['cutting the controller network off the internet', { from: [{ network: { name: 'Default' } }], to: [{ internet: true }] }, 'PROTECTED'],
        ['cutting the controller itself off the internet', { from: [{ addresses: ['10.0.0.250'] }], to: [{ internet: true }] }, 'PROTECTED'],
        ['cutting a range holding the controller off the internet', { from: [{ addresses: ['10.0.0.128/25'] }], to: [{ internet: true }] }, 'PROTECTED'],
    ])('refuses %s, writing nothing', async (_what, over, expected) => {
        const { writes, net } = controller();

        expect(await code(net.plan(rule(over as never)))).toBe(expected);
        expect(writes).toEqual([]);
    });

    it('refuses a switch-only network and a duplicate name', async () => {
        const { state, writes, net, apply } = controller();
        state.networks.push({ id: 'net-sw', name: 'Cameras', purpose: 0, vlan: 30 });

        expect(await code(net.plan(rule({ to: [{ network: { name: 'Cameras' } }] })))).toBe('INVALID');
        await apply(rule());
        expect(await code(net.plan(rule({ name: 'iot TO home', to: [{ network: { name: 'Engineering' } }] })))).toBe('EXISTS');
        expect(ruleWrites(writes)).toHaveLength(1);
    });

    it('may block one other device on the controller network from the internet (a curfew), and allow the whole network', async () => {
        const { state, apply } = controller();

        await apply(rule({ name: 'Kid offline', from: [{ addresses: ['10.0.0.23'] }], to: [{ internet: true }] }));
        await apply(rule({ name: 'Home may use the internet', action: 'allow', from: [{ network: { name: 'Default' } }], to: [{ internet: true }] }));
        expect(gatewayAcls(state)).toHaveLength(2);
    });

    it('treats any address on a protected network as possibly the controller when its address is unknown', async () => {
        const { writes, net } = controller('omada.lan', async () => []);

        expect(await code(net.plan(rule({ name: 'Kid offline', from: [{ addresses: ['10.0.0.23'] }], to: [{ internet: true }] })))).toBe('PROTECTED');
        expect(writes).toEqual([]);
    });

    it('protects this server\'s network like the controller\'s (MCP_SERVER_ADDRESSES): its VLAN, deleting it, and its internet access', async () => {
        const { writes, net, apply } = controller('10.0.0.250', undefined, ['10.0.70.18']);

        expect((await net.listNetworks()).map((n) => [n.name, n.protected])).toEqual([
            ['Default', true],
            ['IoT', false],
            ['Engineering', true],
        ]);
        expect(await message(apply({ op: 'delete', kind: 'network', ref: { name: 'Engineering' } }))).toBe("'Engineering' carries the controller, this server or the primary network and can't be deleted");
        expect(await code(net.plan({ op: 'update', kind: 'network', value: { ref: { name: 'Engineering' }, set: { vlan: 71 } } }))).toBe('PROTECTED');
        expect(await code(net.plan(rule({ name: 'Lab offline', from: [{ network: { name: 'Engineering' } }], to: [{ internet: true }] })))).toBe('PROTECTED');
        expect(await message(net.plan(rule({ name: 'Lab offline', from: [{ addresses: ['10.0.70.18'] }], to: [{ internet: true }] })))).toBe(
            "This could cut the controller or this server off the internet: rule 'Lab offline' would then be in the way of its traffic. Nothing was changed."
        );
        expect(await code(net.plan(rule({ name: 'Lab offline', from: [{ addresses: ['10.0.70.23'] }], to: [{ internet: true }] })))).toBe('ok');
        expect(writes).toEqual([]);
    });

    it('protects every routed network when this server\'s address can\'t be resolved; one outside the site, or none set, holds nothing back', async () => {
        const unknown = controller('10.0.0.250', async () => [], ['mcp.home.test']);
        expect((await unknown.net.listNetworks()).every((n) => n.protected)).toBe(true);
        expect(await code(unknown.net.plan(rule({ name: 'Kid offline', from: [{ addresses: ['10.0.1.23'] }], to: [{ internet: true }] })))).toBe('PROTECTED');
        expect(unknown.writes).toEqual([]);

        for (const c of [controller('10.0.0.250', undefined, ['198.51.100.4']), controller('10.0.0.250', undefined, [])]) {
            expect((await c.net.listNetworks()).map((n) => n.protected)).toEqual([true, false, false]);
            expect(await code(c.net.plan(rule({ name: 'Lab offline', from: [{ network: { name: 'Engineering' } }], to: [{ internet: true }] })))).toBe('ok');
        }
    });

    it('removes the group it made when the controller refuses the rule', async () => {
        const { state, apply } = controller();
        state.failOn = 'createGatewayAcl';

        await expect(apply(rule({ name: 'IoT to HA', action: 'allow', to: [{ addresses: ['10.0.0.19'] }], protocol: { tcpUdpPorts: '1883' } }))).rejects.toThrow(/refused/);

        expect(state.groups[1]).toEqual([]);
        expect(gatewayAcls(state)).toEqual([]);
    });

    it('refuses to apply a plan when the rules changed meanwhile', async () => {
        const { state, writes, net } = controller();
        const plan = await net.plan(rule());
        state.acls['osg-acls'].push({ id: 'acl-web', index: 1, description: 'Made in the web UI', status: true, policy: 0, protocols: [256], sourceType: 0, sourceIds: ['net-lab'], destinationType: 0, destinationIds: ['net-default'], direction: { lanToWan: false, lanToLan: true, wanInIds: [], vpnInIds: [] }, stateMode: 0 });

        expect(await code(net.apply(plan))).toBe('CONFLICT');
        expect(writes).toEqual([]);
    });

    describe('reading rules made elsewhere', () => {
        const seeded = () => {
            const c = controller();
            c.state.groups[0].push({ groupId: 'ip-kid', name: 'node-1271', ipList: [{ ip: '10.0.0.23', mask: 32 }] });
            c.state.acls['osg-acls'].push(
                { id: 'acl-1', index: 1, description: 'Deny-RFC1918', status: true, policy: 0, protocols: [256], sourceType: 1, sourceIds: ['ip-any'], destinationType: 1, destinationIds: ['ip-any'], direction: { lanToWan: false, lanToLan: false, wanInIds: ['wan1'], vpnInIds: [] }, stateMode: 0 },
                { id: 'acl-2', index: 2, description: 'Curfew', status: true, policy: 0, protocols: [256], sourceType: 1, sourceIds: ['ip-kid'], destinationType: 1, destinationIds: ['ip-any'], direction: { lanToWan: true, lanToLan: false, wanInIds: [], vpnInIds: [] }, stateMode: 0, timeRangeId: 'tr-1' },
                { id: 'acl-3', index: 3, description: 'Kid offline', status: false, policy: 0, protocols: [256], sourceType: 1, sourceIds: ['ip-kid'], destinationType: 1, destinationIds: ['ip-any'], direction: { lanToWan: true, lanToLan: false, wanInIds: [], vpnInIds: [] }, stateMode: 0 },
                { id: 'acl-4', index: 4, description: 'Manual states', status: true, policy: 0, protocols: [256], sourceType: 0, sourceIds: ['net-iot'], destinationType: 0, destinationIds: ['net-default'], direction: { lanToWan: false, lanToLan: true, wanInIds: [], vpnInIds: [] }, stateMode: 1, states: [0] }
            );
            return c;
        };

        it('maps them, marking what net_ cannot express as foreign', async () => {
            const { net } = seeded();

            const rules = await net.listRules();

            expect(rules.map((r) => [r.position, r.name, r.foreign ? 'foreign' : 'ok'])).toEqual([
                [1, 'Deny-RFC1918', 'foreign'],
                [2, 'Curfew', 'foreign'],
                [3, 'Kid offline', 'ok'],
                [4, 'Manual states', 'foreign'],
            ]);
            expect(rules[0].foreign?.reason).toMatch(/coming in from the WAN/);
            expect(rules[1].foreign?.reason).toMatch(/schedule/);
            expect(rules[3].foreign?.reason).toMatch(/manual connection states/);
            expect(rules[2]).toMatchObject({ from: [{ group: { name: 'node-1271' } }], to: [{ internet: true }], enabled: false });
        });

        it('switches on a rule made elsewhere, keeping its objects', async () => {
            const { state, writes, apply } = seeded();

            await apply({ op: 'update', kind: 'rule', value: { ref: { name: 'Kid offline' }, set: { enabled: true } } });

            expect(ruleWrites(writes).map((w) => w.op)).toEqual(['updateGatewayAcl']);
            expect(gatewayAcls(state)[2]).toMatchObject({ status: true, description: 'Kid offline', sourceIds: ['ip-kid'], destinationIds: ['ip-any'] });
        });

        it('refuses to change or delete a foreign rule, but may move it', async () => {
            const { state, writes, net, apply } = seeded();

            expect(await code(net.plan({ op: 'update', kind: 'rule', value: { ref: { name: 'Curfew' }, set: { enabled: false } } }))).toBe('UNSUPPORTED');
            expect(await code(net.plan({ op: 'delete', kind: 'rule', ref: { name: 'Deny-RFC1918' } }))).toBe('UNSUPPORTED');
            expect(writes).toEqual([]);

            await apply({ op: 'move', kind: 'rule', ref: { name: 'Manual states' }, position: 1 });
            expect(gatewayAcls(state).map((a) => a.description)).toEqual(['Manual states', 'Deny-RFC1918', 'Curfew', 'Kid offline']);
        });
    });

    describe('changing a rule that owns a group', () => {
        const withHaRule = async () => {
            const c = controller();
            await c.apply(rule({ name: 'IoT to HA', action: 'allow', to: [{ addresses: ['10.0.0.19'] }], protocol: { tcpUdpPorts: '1883, 8123' } }));
            c.writes.length = 0;
            return c;
        };
        const update = (set: Record<string, unknown>): Change => ({ op: 'update', kind: 'rule', value: { ref: { name: 'IoT to HA' }, set } });

        it('switching it off keeps its group', async () => {
            const { state, writes, apply } = await withHaRule();
            const group = state.groups[1][0];

            await apply(update({ enabled: false }));

            expect(ruleWrites(writes).map((w) => w.op)).toEqual(['updateGatewayAcl']);
            expect(state.groups[1]).toEqual([group]);
            expect(gatewayAcls(state)[0]).toMatchObject({ status: false, destinationIds: [group.groupId] });
        });

        it('new ports get a new group and the old one goes', async () => {
            const { state, apply } = await withHaRule();
            const old = state.groups[1][0];

            const result = await apply(update({ protocol: { tcpUdpPorts: '1883' } }));

            expect(state.groups[1]).toHaveLength(1);
            expect(state.groups[1][0].groupId).not.toBe(old.groupId);
            expect(state.groups[1][0].portList).toEqual(['1883']);
            expect(result.object).toMatchObject({ protocol: { tcpUdpPorts: '1883' } });
        });

        it('dropping the ports turns the IP-port group into an IP group', async () => {
            const { state, apply } = await withHaRule();

            const result = await apply(update({ protocol: 'any' }));

            expect(state.groups[1]).toEqual([]);
            const ipGroup = state.groups[0].find((g) => String(g.name).startsWith('[net:'))!;
            expect(gatewayAcls(state)[0]).toMatchObject({ protocols: [256], destinationType: 1, destinationIds: [ipGroup.groupId] });
            expect(result.object).toMatchObject({ protocol: 'any', to: [{ addresses: ['10.0.0.19'] }] });
        });

        it('renaming keeps the tag that ties it to its group', async () => {
            const { state, apply } = await withHaRule();
            const tag = String(gatewayAcls(state)[0].description).slice(-14);

            const result = await apply(update({ name: 'IoT may reach HA' }));

            expect(gatewayAcls(state)[0].description).toBe(`IoT may reach HA ${tag}`);
            expect(result.object).toMatchObject({ name: 'IoT may reach HA', to: [{ addresses: ['10.0.0.19'] }] });
        });

        it('refuses an update that changes nothing', async () => {
            const { net } = await withHaRule();
            expect(await code(net.plan(update({ enabled: true })))).toBe('INVALID');
        });

        it('a failed update removes the new group and keeps the old rule and group', async () => {
            const { state, apply } = await withHaRule();
            const before = structuredClone({ acls: state.acls['osg-acls'], groups: state.groups });
            state.failOn = 'updateGatewayAcl';

            await expect(apply(update({ protocol: { tcpUdpPorts: '8123' } }))).rejects.toThrow(/refused/);

            expect({ acls: state.acls['osg-acls'], groups: state.groups }).toEqual(before);
        });

        it('deleting it removes its group, and leaves other groups alone', async () => {
            const { state, apply } = await withHaRule();
            state.groups[0].push({ groupId: 'ip-kid', name: 'node-1271', ipList: [{ ip: '10.0.0.23', mask: 32 }] });

            await apply({ op: 'delete', kind: 'rule', ref: { name: 'IoT to HA' } });

            expect(gatewayAcls(state)).toEqual([]);
            expect(state.groups[1]).toEqual([]);
            expect(state.groups[0].map((g) => g.name)).toEqual(['IPGroup_Any', 'node-1271']);
        });
    });

    it('moves rules, refusing a position out of range or the current one', async () => {
        const { state, net, apply } = controller();
        await apply(rule());
        await apply(rule({ name: 'Lab to Home', from: [{ network: { name: 'Engineering' } }] }));

        await apply({ op: 'move', kind: 'rule', ref: { name: 'Lab to Home' }, position: 1 });

        expect(gatewayAcls(state).map(ruleNameOf)).toEqual(['Lab to Home', 'IoT to Home']);
        expect(await code(net.plan({ op: 'move', kind: 'rule', ref: { name: 'Lab to Home' }, position: 3 }))).toBe('INVALID');
        expect(await code(net.plan({ op: 'move', kind: 'rule', ref: { name: 'Lab to Home' }, position: 1 }))).toBe('INVALID');
    });

    it('lists address and MAC groups', async () => {
        const { net } = controller();
        expect(await net.listGroups()).toEqual([
            { id: 'ip-any', name: 'IPGroup_Any', kind: 'address', entries: [{ value: '0.0.0.0/0' }] },
            { id: 'mg-known', name: 'KnownWiFi', kind: 'mac', entries: [{ value: '02-00-00-00-00-01', name: 'phone' }] },
        ]);
        expect((await net.listGroups('mac')).map((g) => g.name)).toEqual(['KnownWiFi']);
    });
});

function ruleNameOf(acl: Raw): string {
    return String(acl.description).replace(/\s*\[net:[0-9a-f]{8}\]$/, '');
}

describe('rules: changes that fail part-way (Codex review of 2.4.7)', () => {
    const haRule = (over: Record<string, unknown> = {}) => rule({ name: 'IoT to HA', action: 'allow', to: [{ addresses: ['10.0.0.19'] }], protocol: { tcpUdpPorts: '1883' }, ...over });
    const seededWithTwo = async () => {
        const c = controller();
        await c.apply(rule());
        await c.apply(rule({ name: 'Lab to Home', from: [{ network: { name: 'Engineering' } }] }));
        c.writes.length = 0;
        return c;
    };

    it('creates a rule that must move switched off, moves it, then switches it on', async () => {
        const { state, writes, apply } = await seededWithTwo();

        await apply(haRule({ position: 1 }));

        const ops = ruleWrites(writes);
        expect(ops.map((w) => w.op)).toEqual(['createGroup', 'createGatewayAcl', 'reorderGatewayAcls', 'updateGatewayAcl']);
        expect((ops[1].args[0] as Raw).status).toBe(false);
        expect((ops[3].args[1] as Raw).status).toBe(true);
        expect(gatewayAcls(state)[0]).toMatchObject({ status: true, policy: 1 });
    });

    it('a failed move after create removes the new rule and its group', async () => {
        const { state, apply } = await seededWithTwo();
        const before = structuredClone({ acls: gatewayAcls(state), groups: state.groups });
        state.failOn = 'reorderGatewayAcls';

        await expect(apply(haRule({ position: 1 }))).rejects.toThrow(/refused/);

        expect({ acls: gatewayAcls(state), groups: state.groups }).toEqual(before);
    });

    it('a create whose read-back is lost is found by its description and removed, before its group', async () => {
        const { state, writes, apply } = await seededWithTwo();
        const before = structuredClone({ acls: gatewayAcls(state), groups: state.groups });
        // Let the plan, the fresh plan and the group read through; fail the first read after the ACL create.
        state.failRead = { op: 'listAcls', skip: 2 };

        await expect(apply(haRule())).rejects.toThrow(/timed out/);

        expect({ acls: gatewayAcls(state), groups: state.groups }).toEqual(before);
        const ops = ruleWrites(writes).map((w) => w.op);
        expect(ops.indexOf('deleteGatewayAcl')).toBeLessThan(ops.indexOf('deleteGroup'));
    });

    it('keeps the group, and says so, when it cannot confirm whether the rule was created', async () => {
        const { state, apply } = await seededWithTwo();
        state.failOn = 'createGatewayAcl';
        // The create is refused, and the read that would confirm it fails too.
        state.failRead = { op: 'listAcls', skip: 2 };

        await expect(apply(haRule())).rejects.toThrow(/may have been created; check net_listRules.*groups were kept/);

        expect(state.groups[1]).toHaveLength(1);
    });

    it('a group whose read-back is lost is found by name and removed', async () => {
        const { state, writes, apply } = await seededWithTwo();
        // Let the plan and the fresh plan read both group lists, and the check before the create; fail the read right after it.
        state.failRead = { op: 'listGroups', skip: 5 };

        await expect(apply(haRule())).rejects.toThrow(/timed out/);

        expect(writes.map((w) => w.op)).toEqual(['createGroup', 'deleteGroup']);
        expect(state.groups[1]).toEqual([]);
        expect(gatewayAcls(state)).toHaveLength(2);
    });

    it('a failed move after an update puts the rule back as it was, with its old group', async () => {
        const { state, apply } = await seededWithTwo();
        await apply(haRule());
        const before = structuredClone({ acls: gatewayAcls(state), groups: state.groups });
        state.failOn = 'reorderGatewayAcls';

        await expect(apply({ op: 'update', kind: 'rule', value: { ref: { name: 'IoT to HA' }, set: { protocol: { tcpUdpPorts: '8123' }, action: 'block', position: 1 } } })).rejects.toThrow(/refused/);

        expect({ acls: gatewayAcls(state), groups: state.groups }).toEqual(before);
    });

    it('treats a rule with a source port group as foreign, so it can never be switched on through net_', async () => {
        const { state, writes, net } = controller();
        state.groups[1].push({ groupId: 'ipp-ctrl', name: 'controller-ports', type: 1, ipList: [{ ip: '10.0.0.250', mask: 32 }], portType: 0, portList: ['443'] });
        state.acls['osg-acls'].push({ id: 'acl-x', index: 1, description: 'Controller offline', status: false, policy: 0, protocols: [6], sourceType: 2, sourceIds: ['ipp-ctrl'], destinationType: 1, destinationIds: ['ip-any'], direction: { lanToWan: true, lanToLan: false, wanInIds: [], vpnInIds: [] }, stateMode: 0 });

        expect((await net.listRules())[0].foreign?.reason).toMatch(/source with ports/);
        expect(await code(net.plan({ op: 'update', kind: 'rule', value: { ref: { name: 'Controller offline' }, set: { enabled: true } } }))).toBe('UNSUPPORTED');
        expect(writes).toEqual([]);
    });

    it('treats a rule whose group does not match its direction as foreign, and never flips a matching one', async () => {
        const { state, writes, net, apply } = controller();
        state.groups[0].push({ groupId: 'ip-ha', name: 'HA', ipList: [{ ip: '10.0.0.19', mask: 32 }] }, { groupId: 'ip-dns', name: 'Public DNS', ipList: [{ ip: '9.9.9.9', mask: 32 }] });
        const acl = (id: string, description: string, dest: string, lanToLan: boolean) => ({ id, index: state.acls['osg-acls'].length + 1, description, status: true, policy: 0, protocols: [256], sourceType: 0, sourceIds: ['net-iot'], destinationType: 1, destinationIds: [dest], direction: { lanToWan: !lanToLan, lanToLan, wanInIds: [], vpnInIds: [] }, stateMode: 0 });
        state.acls['osg-acls'].push(acl('acl-a', 'HA via WAN', 'ip-ha', false), acl('acl-b', 'HA local', 'ip-ha', true), acl('acl-c', 'No public DNS', 'ip-dns', false));

        const rules = await net.listRules();
        expect(rules.map((r) => (r.foreign ? 'foreign' : 'ok'))).toEqual(['foreign', 'ok', 'ok']);
        expect(rules[0].foreign?.reason).toMatch(/doesn't match that direction/);
        expect(await code(net.plan({ op: 'update', kind: 'rule', value: { ref: { name: 'HA via WAN' }, set: { name: 'x' } } }))).toBe('UNSUPPORTED');

        await apply({ op: 'update', kind: 'rule', value: { ref: { name: 'HA local' }, set: { name: 'HA local renamed' } } });
        await apply({ op: 'update', kind: 'rule', value: { ref: { name: 'No public DNS' }, set: { enabled: false } } });
        expect(gatewayAcls(state).map((a) => [a.description, (a.direction as Raw).lanToLan])).toEqual([
            ['HA via WAN', false],
            ['HA local renamed', true],
            ['No public DNS', false],
        ]);
        expect(writes.filter((w) => w.op === 'updateGatewayAcl')).toHaveLength(2);
    });

    it('never lets another rule use a group a rule owns, and removes an owned group once its last user is gone', async () => {
        const { state, net, apply } = controller();
        await apply(haRule({ protocol: 'any' }));
        const owned = state.groups[0].find((g) => String(g.name).startsWith('[net:'))!;

        expect(await code(net.plan(rule({ name: 'Lab to HA', from: [{ network: { name: 'Engineering' } }], to: [{ group: { name: String(owned.name) } }] })))).toBe('INVALID');

        // A rule made in the web UI may still point at it: deleting the owner keeps the group for it...
        state.acls['osg-acls'].push({ id: 'acl-web', index: 2, description: 'Lab to HA (web UI)', status: true, policy: 1, protocols: [256], sourceType: 0, sourceIds: ['net-lab'], destinationType: 1, destinationIds: [owned.groupId], direction: { lanToWan: false, lanToLan: true, wanInIds: [], vpnInIds: [] }, stateMode: 0 });
        await apply({ op: 'delete', kind: 'rule', ref: { name: 'IoT to HA' } });
        expect(state.groups[0].map((g) => g.groupId)).toContain(owned.groupId);

        // ...and deleting that last user removes it.
        await apply({ op: 'delete', kind: 'rule', ref: { name: 'Lab to HA (web UI)' } });
        expect(state.groups[0].map((g) => g.groupId)).not.toContain(owned.groupId);
    });
});

describe('rules: order, staging and cleanup (second Codex review of 2.4.7)', () => {
    /** The controller (10.0.0.250 on Default) may use the internet; Default is blocked from it below that exception. */
    const withControllerException = () => {
        const c = controller();
        c.state.groups[0].push({ groupId: 'ip-ctrl', name: 'controller', ipList: [{ ip: '10.0.0.250', mask: 32 }] });
        const wan = { lanToWan: true, lanToLan: false, wanInIds: [], vpnInIds: [] };
        c.state.acls['osg-acls'].push(
            { id: 'acl-allow', index: 1, description: 'Controller may use the internet', status: true, policy: 1, protocols: [256], sourceType: 1, sourceIds: ['ip-ctrl'], destinationType: 1, destinationIds: ['ip-any'], direction: wan, stateMode: 0 },
            { id: 'acl-lab', index: 2, description: 'Lab to Home', status: true, policy: 0, protocols: [256], sourceType: 0, sourceIds: ['net-lab'], destinationType: 0, destinationIds: ['net-default'], direction: { lanToWan: false, lanToLan: true, wanInIds: [], vpnInIds: [] }, stateMode: 0 },
            { id: 'acl-block', index: 3, description: 'Home offline', status: true, policy: 0, protocols: [256], sourceType: 0, sourceIds: ['net-default'], destinationType: 1, destinationIds: ['ip-any'], direction: wan, stateMode: 0 }
        );
        return c;
    };
    const order = (state: ReturnType<typeof controller>['state']) => gatewayAcls(state).map(ruleNameOf);

    it("refuses a move that changes which rule decides the controller's internet traffic, writing nothing", async () => {
        const { writes, net } = withControllerException();

        expect(await code(net.plan({ op: 'move', kind: 'rule', ref: { name: 'Home offline' }, position: 1 }))).toBe('PROTECTED');
        expect(await code(net.plan({ op: 'move', kind: 'rule', ref: { name: 'Controller may use the internet' }, position: 3 }))).toBe('PROTECTED');
        expect(await code(net.plan({ op: 'update', kind: 'rule', value: { ref: { name: 'Controller may use the internet' }, set: { position: 3 } } }))).toBe('PROTECTED');
        expect(writes).toEqual([]);
    });

    it('allows moves that keep that order', async () => {
        const { state, apply } = withControllerException();

        await apply({ op: 'move', kind: 'rule', ref: { name: 'Lab to Home' }, position: 1 });
        await apply({ op: 'move', kind: 'rule', ref: { name: 'Lab to Home' }, position: 3 });

        expect(order(state)).toEqual(['Controller may use the internet', 'Home offline', 'Lab to Home']);
    });

    it('puts the order back when a move happened but its answer was lost', async () => {
        const { state, apply } = withControllerException();
        const before = order(state);
        state.failAfter = 'reorderGatewayAcls';

        await expect(apply({ op: 'move', kind: 'rule', ref: { name: 'Lab to Home' }, position: 1 })).rejects.toThrow(/no answer/);

        expect(order(state)).toEqual(before);
    });

    it('puts order and content back when a changed rule was moved but the answer was lost', async () => {
        const c = controller();
        await c.apply(rule());
        await c.apply(rule({ name: 'Lab to Home', from: [{ network: { name: 'Engineering' } }] }));
        await c.apply(rule({ name: 'IoT to HA', action: 'allow', to: [{ addresses: ['10.0.0.19'] }], protocol: { tcpUdpPorts: '1883' } }));
        const before = structuredClone({ acls: gatewayAcls(c.state), groups: c.state.groups });
        c.state.failAfter = 'reorderGatewayAcls';

        await expect(c.apply({ op: 'update', kind: 'rule', value: { ref: { name: 'IoT to HA' }, set: { protocol: { tcpUdpPorts: '8123' }, position: 1 } } })).rejects.toThrow(/no answer/);
        expect({ acls: gatewayAcls(c.state), groups: c.state.groups }).toEqual(before);

        // A move-only update too.
        c.state.failAfter = 'reorderGatewayAcls';
        await expect(c.apply({ op: 'update', kind: 'rule', value: { ref: { name: 'IoT to HA' }, set: { position: 1 } } })).rejects.toThrow(/no answer/);
        expect(gatewayAcls(c.state)).toEqual(before.acls);
    });

    it('writes a changed and moved rule switched off, moves it, then switches it on', async () => {
        const c = controller();
        await c.apply(rule());
        await c.apply(rule({ name: 'Lab to Home', from: [{ network: { name: 'Engineering' } }], action: 'allow' }));
        c.writes.length = 0;

        await c.apply({ op: 'update', kind: 'rule', value: { ref: { name: 'Lab to Home' }, set: { action: 'block', position: 1 } } });

        const ops = ruleWrites(c.writes);
        expect(ops.map((w) => w.op)).toEqual(['updateGatewayAcl', 'reorderGatewayAcls', 'updateGatewayAcl']);
        expect(ops[0].args[1]).toMatchObject({ status: false, policy: 0 });
        expect(ops[2].args[1]).toMatchObject({ status: true, policy: 0 });
        expect(order(c.state)).toEqual(['Lab to Home', 'IoT to Home']);
    });

    it('keeps an owned group a switch ACL still uses', async () => {
        const c = controller();
        await c.apply(rule({ name: 'IoT to HA', action: 'allow', to: [{ addresses: ['10.0.0.19'] }] }));
        const owned = c.state.groups[0].find((g) => String(g.name).startsWith('[net:'))!;
        c.state.acls['osw-acls'].push({ id: 'sw-1', description: 'switch rule', sourceType: 1, sourceIds: [owned.groupId], destinationType: 1, destinationIds: ['ip-any'] });

        const plan = await c.net.plan({ op: 'delete', kind: 'rule', ref: { name: 'IoT to HA' } });
        expect(plan.steps.map((st) => st.object)).toEqual(['omada.gatewayAcl']);
        await c.net.apply(plan);

        expect(c.state.groups[0].map((g) => g.groupId)).toContain(owned.groupId);
    });

    it('reports a cleanup that failed as a warning, and the next change finishes it', async () => {
        const c = controller();
        await c.apply(rule({ name: 'IoT to HA', action: 'allow', to: [{ addresses: ['10.0.0.19'] }] }));
        const owned = c.state.groups[0].find((g) => String(g.name).startsWith('[net:'))!;
        c.state.failOn = 'deleteGroup';

        const result = await c.apply({ op: 'delete', kind: 'rule', ref: { name: 'IoT to HA' } });

        expect(result.applied).toBe(true);
        expect(result.warnings?.join(' ')).toMatch(/Could not remove the unused group.*next rule change removes them/);
        expect(c.state.groups[0].map((g) => g.groupId)).toContain(owned.groupId);
        expect(gatewayAcls(c.state)).toEqual([]);

        await c.apply(rule());
        expect(c.state.groups[0].map((g) => g.groupId)).not.toContain(owned.groupId);
    });
});

describe('rules: the controller stays online in every state (third Codex review of 2.4.7)', () => {
    const withControllerException = () => {
        const c = controller();
        c.state.groups[0].push({ groupId: 'ip-ctrl', name: 'controller', ipList: [{ ip: '10.0.0.250', mask: 32 }] });
        const wan = { lanToWan: true, lanToLan: false, wanInIds: [], vpnInIds: [] };
        c.state.acls['osg-acls'].push(
            { id: 'acl-allow', index: 1, description: 'Controller may use the internet', status: true, policy: 1, protocols: [256], sourceType: 1, sourceIds: ['ip-ctrl'], destinationType: 1, destinationIds: ['ip-any'], direction: wan, stateMode: 0 },
            { id: 'acl-lab', index: 2, description: 'Lab to Home', status: true, policy: 0, protocols: [256], sourceType: 0, sourceIds: ['net-lab'], destinationType: 0, destinationIds: ['net-default'], direction: { lanToWan: false, lanToLan: true, wanInIds: [], vpnInIds: [] }, stateMode: 0 },
            { id: 'acl-block', index: 3, description: 'Home offline', status: true, policy: 0, protocols: [256], sourceType: 0, sourceIds: ['net-default'], destinationType: 1, destinationIds: ['ip-any'], direction: wan, stateMode: 0 }
        );
        return c;
    };
    const exception = (set: Record<string, unknown>): Change => ({ op: 'update', kind: 'rule', value: { ref: { name: 'Controller may use the internet' }, set } });

    it.each([
        ['deleting it', { op: 'delete', kind: 'rule', ref: { name: 'Controller may use the internet' } } as Change],
        ['switching it off', exception({ enabled: false })],
        ['narrowing its source to another device', exception({ from: [{ addresses: ['10.0.0.23'] }] })],
        ['narrowing its destination', exception({ to: [{ addresses: ['203.0.113.7'] }] })],
        ['narrowing its protocol', exception({ protocol: 'tcp' })],
        ['turning it into a block', exception({ action: 'block' })],
        ['renaming it while moving it (staged off on the way)', exception({ name: 'Controller online', position: 2 })],
        ['a block placed above it', rule({ name: 'All offline', from: [{ network: { name: 'Default' } }], to: [{ internet: true }], position: 1 })],
    ])("refuses %s when that would cut the controller off, writing nothing", async (_what, change) => {
        const { writes, net } = withControllerException();

        expect(await code(net.plan(change))).toBe('PROTECTED');
        expect(writes).toEqual([]);
    });

    it('allows what keeps the controller online: moving the exception without changing it, a block below it, renaming it in place', async () => {
        const { state, apply } = withControllerException();

        await apply(exception({ position: 2 }));
        await apply(rule({ name: 'Home offline 2', from: [{ network: { name: 'Default' } }], to: [{ internet: true }] }));
        await apply(exception({ name: 'Controller online' }));

        expect(gatewayAcls(state).map(ruleNameOf)).toEqual(['Lab to Home', 'Controller online', 'Home offline', 'Home offline 2']);
    });

    it('undoing a staged update whose last answer was lost never leaves changed content active at the old place', async () => {
        const c = controller();
        await c.apply(rule({ name: 'Lab to Home', action: 'allow', from: [{ network: { name: 'Engineering' } }] }));
        await c.apply(rule());
        const before = structuredClone(gatewayAcls(c.state));
        const labId = before[0].id;
        c.state.history.length = 0;
        // Fail the second ACL update (switching the moved rule on) after it took effect.
        c.state.failAfter = { op: 'updateGatewayAcl', skip: 1 };

        await expect(c.apply({ op: 'update', kind: 'rule', value: { ref: { name: 'Lab to Home' }, set: { action: 'block', position: 2 } } })).rejects.toThrow(/no answer/);

        expect(gatewayAcls(c.state)).toEqual(before);
        // In no state after the failure was the new content (a block) switched on in first place.
        const failedAt = c.state.history.findIndex((h, i) => i > 0 && h.find((a) => a.id === labId)?.status === true && h.findIndex((a) => a.id === labId) === 1);
        expect(failedAt).toBeGreaterThan(0);
        for (const h of c.state.history.slice(failedAt + 1)) {
            const lab = h.find((a) => a.id === labId)!;
            expect(h.indexOf(lab) === 0 && lab.status === true && lab.policy === 0).toBe(false);
        }
    });

    it('reports a change whose read-back failed as applied, with a warning', async () => {
        const { state, apply } = controller();
        // The plan and the fresh plan read clients; fail the read-back after the change.
        state.failRead = { op: 'listClients', skip: 2 };

        const result = await apply(rule());

        expect(result.applied).toBe(true);
        expect(result.object).toBeUndefined();
        expect(result.warnings?.join(' ')).toMatch(/applied, but reading the rule back failed.*net_listRules/);
        expect(gatewayAcls(state)).toHaveLength(1);
    });
});

describe('rules: names and uncertain blocks (fourth Codex review of 2.4.7)', () => {
    const wan = { lanToWan: true, lanToLan: false, wanInIds: [], vpnInIds: [] };

    it.each(['[net:deadbeef]', 'Home offline [net:12345678]', 'x [NET:abc'])("refuses the reserved tag in a rule name (%s), writing nothing", async (name) => {
        const { writes, net } = controller();

        expect(await code(net.plan(rule({ name, from: [{ network: { name: 'Default' } }], to: [{ internet: true }] })))).toBe('INVALID');
        expect(await code(net.plan(rule({ name })))).toBe('INVALID');
        expect(writes).toEqual([]);
    });

    it('an undone create never removes a rule with the same description made meanwhile', async () => {
        const { state, apply } = controller();
        state.failOn = 'createGatewayAcl';
        state.beforeWrite = (op) => {
            if (op !== 'createGatewayAcl') return;
            state.beforeWrite = undefined;
            state.acls['osg-acls'].push({ id: 'acl-web', index: 1, description: 'IoT to Home', status: true, policy: 0, protocols: [256], sourceType: 0, sourceIds: ['net-iot'], destinationType: 0, destinationIds: ['net-default'], direction: { lanToWan: false, lanToLan: true, wanInIds: [], vpnInIds: [] }, stateMode: 0 });
        };

        await expect(apply(rule())).rejects.toThrow(/refused/);

        expect(gatewayAcls(state).map((a) => a.id)).toEqual(['acl-web']);
    });

    describe('a block that may not apply right now waives nothing', () => {
        const seeded = (block: Raw) => {
            const c = controller();
            c.state.timeRanges.push({ profileId: 'tr-night', name: 'Night' });
            c.state.acls['osg-acls'].push({ id: 'acl-maybe', index: 1, description: 'Home offline at night', status: true, policy: 0, protocols: [256], sourceType: 0, sourceIds: ['net-default'], destinationType: 1, destinationIds: ['ip-any'], direction: wan, stateMode: 0, ...block });
            return c;
        };

        it.each([
            ['a scheduled block', { timeRangeId: 'tr-night' }],
            ['a TCP-only block', { protocols: [6], description: 'Home TCP offline' }],
        ])('with %s, an unconditional block below it is still refused', async (_what, block) => {
            const { writes, net } = seeded(block);

            expect(await code(net.plan(rule({ name: 'Home offline', from: [{ network: { name: 'Default' } }], to: [{ internet: true }] })))).toBe('PROTECTED');
            expect(writes).toEqual([]);
        });

        it('while unrelated rules can still be made', async () => {
            const { state, apply } = seeded({ timeRangeId: 'tr-night' });

            await apply(rule());
            expect(gatewayAcls(state)).toHaveLength(2);
        });

        it('but a controller that is certainly cut off already is not protected any further', async () => {
            const c = controller();
            c.state.groups[0].push({ groupId: 'ip-ctrl', name: 'controller', ipList: [{ ip: '10.0.0.250', mask: 32 }] });
            c.state.acls['osg-acls'].push({ id: 'acl-cut', index: 1, description: 'Controller offline', status: true, policy: 0, protocols: [256], sourceType: 1, sourceIds: ['ip-ctrl'], destinationType: 1, destinationIds: ['ip-any'], direction: wan, stateMode: 0 });

            // Even above the block that cuts it off: there is nothing left to protect.
            await c.apply(rule({ name: 'Home offline', from: [{ network: { name: 'Default' } }], to: [{ internet: true }], position: 1 }));
            expect(gatewayAcls(c.state).map(ruleNameOf)).toEqual(['Home offline', 'Controller offline']);
        });

        it('a block that only may hold the controller (its address unknown) is not a certain cut-off', async () => {
            const c = controller('omada.lan', async () => []);
            c.state.groups[0].push({ groupId: 'ip-kid', name: 'node-1271', ipList: [{ ip: '10.0.0.23', mask: 32 }] });
            c.state.acls['osg-acls'].push({ id: 'acl-kid', index: 1, description: 'Kid offline', status: true, policy: 0, protocols: [256], sourceType: 1, sourceIds: ['ip-kid'], destinationType: 1, destinationIds: ['ip-any'], direction: wan, stateMode: 0 });

            expect(await code(c.net.plan(rule({ name: 'Home offline', from: [{ network: { name: 'Default' } }], to: [{ internet: true }], position: 1 })))).toBe('PROTECTED');
            expect(c.writes).toEqual([]);
        });

        it('a full block that only may hold the controller hides nothing below it', async () => {
            const c = controller('omada.lan', async () => []);
            c.state.groups[0].push({ groupId: 'ip-kid', name: 'node-1271', ipList: [{ ip: '10.0.0.23', mask: 32 }] });
            c.state.acls['osg-acls'].push({ id: 'acl-kid', index: 1, description: 'Kid offline', status: true, policy: 0, protocols: [256], sourceType: 1, sourceIds: ['ip-kid'], destinationType: 1, destinationIds: ['ip-any'], direction: wan, stateMode: 0 });

            expect(await code(c.net.plan(rule({ name: 'Home offline', from: [{ network: { name: 'Default' } }], to: [{ internet: true }] })))).toBe('PROTECTED');
            expect(c.writes).toEqual([]);
        });

        it('making a partial block complete counts as a new one in the way', async () => {
            const { writes, net } = seeded({ protocols: [6], description: 'Home TCP offline' });

            expect(await code(net.plan({ op: 'update', kind: 'rule', value: { ref: { name: 'Home TCP offline' }, set: { protocol: 'any' } } }))).toBe('PROTECTED');
            expect(writes).toEqual([]);
        });
    });
});

describe('rules: narrow blocks and group names (fifth Codex review of 2.4.7)', () => {
    const wan = { lanToWan: true, lanToLan: false, wanInIds: [], vpnInIds: [] };

    it.each([
        ['from the controller to its DNS servers', { from: [{ addresses: ['10.0.0.250'] }], to: [{ addresses: ['9.9.9.9', '149.112.112.112'] }] }],
        ['from its whole network to one address', { from: [{ network: { name: 'Default' } }], to: [{ addresses: ['203.0.113.7'] }] }],
    ])('refuses a narrow block %s: part of its traffic would be cut off', async (_what, over) => {
        const { writes, net } = controller();

        expect(await code(net.plan(rule({ name: 'Narrow block', ...over } as never)))).toBe('PROTECTED');
        expect(writes).toEqual([]);
    });

    it('refuses switching on, or moving above the exception, a narrow block made elsewhere', async () => {
        const c = controller();
        c.state.groups[0].push({ groupId: 'ip-ctrl', name: 'controller', ipList: [{ ip: '10.0.0.250', mask: 32 }] }, { groupId: 'ip-dns', name: 'Public DNS', ipList: [{ ip: '9.9.9.9', mask: 32 }] });
        c.state.acls['osg-acls'].push(
            { id: 'acl-allow', index: 1, description: 'Controller may use the internet', status: true, policy: 1, protocols: [256], sourceType: 1, sourceIds: ['ip-ctrl'], destinationType: 1, destinationIds: ['ip-any'], direction: wan, stateMode: 0 },
            { id: 'acl-dns', index: 2, description: 'No public DNS', status: false, policy: 0, protocols: [256], sourceType: 0, sourceIds: ['net-default'], destinationType: 1, destinationIds: ['ip-dns'], direction: wan, stateMode: 0 }
        );

        // Below the unconditional exception it never meets the controller's traffic: switching it on is fine.
        await c.apply({ op: 'update', kind: 'rule', value: { ref: { name: 'No public DNS' }, set: { enabled: true } } });
        c.writes.length = 0;
        expect(await code(c.net.plan({ op: 'move', kind: 'rule', ref: { name: 'No public DNS' }, position: 1 }))).toBe('PROTECTED');
        expect(await code(c.net.plan({ op: 'delete', kind: 'rule', ref: { name: 'Controller may use the internet' } }))).toBe('PROTECTED');
        expect(c.writes).toEqual([]);
    });

    it('a narrow block made elsewhere waives nothing for a full block after it', async () => {
        const c = controller();
        c.state.groups[0].push({ groupId: 'ip-dns', name: 'Public DNS', ipList: [{ ip: '9.9.9.9', mask: 32 }] });
        c.state.acls['osg-acls'].push({ id: 'acl-dns', index: 1, description: 'No public DNS', status: true, policy: 0, protocols: [256], sourceType: 0, sourceIds: ['net-default'], destinationType: 1, destinationIds: ['ip-dns'], direction: wan, stateMode: 0 });

        expect(await code(c.net.plan(rule({ name: 'Home offline', from: [{ network: { name: 'Default' } }], to: [{ internet: true }] })))).toBe('PROTECTED');
        expect(c.writes).toEqual([]);
    });

    it('shows a rule pointing at a port group made elsewhere as foreign', async () => {
        const { state, writes, net } = controller();
        state.groups[1].push({ groupId: 'ipp-ha', name: 'HA ports', type: 1, ipList: [{ ip: '10.0.0.19', mask: 32 }], portType: 0, portList: ['1883'] });
        state.acls['osg-acls'].push({ id: 'acl-ha', index: 1, description: 'IoT to HA (web UI)', status: true, policy: 1, protocols: [6, 17], sourceType: 0, sourceIds: ['net-iot'], destinationType: 2, destinationIds: ['ipp-ha'], direction: { lanToWan: false, lanToLan: true, wanInIds: [], vpnInIds: [] }, stateMode: 0 });

        const [listed] = await net.listRules();
        expect(listed.foreign?.reason).toMatch(/port group HA ports made elsewhere/);
        expect(await code(net.plan({ op: 'update', kind: 'rule', value: { ref: { name: 'IoT to HA (web UI)' }, set: { enabled: false } } }))).toBe('UNSUPPORTED');
        expect(writes).toEqual([]);
    });

    it('never reuses the name of an existing group, even when the random draw repeats it', async () => {
        const c = controller();
        await c.apply(rule({ name: 'IoT to HA', action: 'allow', to: [{ addresses: ['10.0.0.19'] }], protocol: { tcpUdpPorts: '1883' } }));
        const old = c.state.groups[1][0];
        const suffix = Buffer.from(String(old.name).split(' ').pop()!, 'hex');
        // The next draw for a group name repeats the existing group's suffix; then the controller refuses the create.
        vi.mocked(randomBytes).mockImplementationOnce((() => suffix) as never);
        const attempted: string[] = [];
        c.state.beforeWrite = (op, args) => {
            if (op === 'createGroup') attempted.push(String((args[0] as Raw).name));
        };
        c.state.failOn = 'createGroup';

        await expect(c.apply({ op: 'update', kind: 'rule', value: { ref: { name: 'IoT to HA' }, set: { protocol: { tcpUdpPorts: '8123' } } } })).rejects.toThrow(/refused/);

        expect(attempted).toHaveLength(1);
        expect(attempted[0]).not.toBe(old.name);
        expect(attempted[0]).toMatch(/^\[net:[0-9a-f]{8}\] to [0-9a-f]{16}$/);
        // The undo looked the refused group up by its own name, so the existing group and the rule are untouched.
        expect(c.state.groups[1]).toEqual([old]);
        expect(gatewayAcls(c.state)[0].destinationIds).toEqual([old.groupId]);
    });
});

describe('rules: partial exceptions and lost deletes (seventh Codex review of 2.4.7)', () => {
    const wan = { lanToWan: true, lanToLan: false, wanInIds: [], vpnInIds: [] };
    const acl = (id: string, index: number, description: string, over: Raw): Raw => ({ id, index, description, status: true, policy: 0, protocols: [256], sourceType: 0, sourceIds: ['net-default'], destinationType: 1, destinationIds: ['ip-any'], direction: wan, stateMode: 0, ...over });
    const seeded = (...acls: Raw[]) => {
        const c = controller();
        c.state.groups[0].push({ groupId: 'ip-ctrl', name: 'controller', ipList: [{ ip: '10.0.0.250', mask: 32 }] }, { groupId: 'ip-dns', name: 'Public DNS', ipList: [{ ip: '9.9.9.9', mask: 32 }] });
        c.state.acls['osg-acls'].push(...acls);
        return c;
    };
    const dnsAllow = acl('acl-dns-ok', 1, 'Controller may use public DNS', { policy: 1, sourceType: 1, sourceIds: ['ip-ctrl'], destinationIds: ['ip-dns'] });
    const dnsBlock = acl('acl-dns-no', 2, 'No public DNS', { destinationIds: ['ip-dns'] });
    const update = (name: string, set: Record<string, unknown>): Change => ({ op: 'update', kind: 'rule', value: { ref: { name }, set } });

    it.each([
        ['deleting it', { op: 'delete', kind: 'rule', ref: { name: 'Controller may use public DNS' } } as Change],
        ['switching it off', update('Controller may use public DNS', { enabled: false })],
        ['narrowing it to TCP', update('Controller may use public DNS', { protocol: 'tcp' })],
        ['moving it below the block', { op: 'move', kind: 'rule', ref: { name: 'Controller may use public DNS' }, position: 2 } as Change],
    ])('refuses %s: a destination-specific exception shields the controller from a block', async (_what, change) => {
        const { writes, net } = seeded(dnsAllow, dnsBlock);

        expect(await code(net.plan(change))).toBe('PROTECTED');
        expect(writes).toEqual([]);
    });

    it('refuses removing a protocol-specific exception in front of a block', async () => {
        const { writes, net } = seeded(acl('acl-tcp-ok', 1, 'Controller TCP', { policy: 1, protocols: [6], sourceType: 1, sourceIds: ['ip-ctrl'] }), acl('acl-tcp-no', 2, 'Home TCP offline', { protocols: [6] }));

        expect(await code(net.plan({ op: 'delete', kind: 'rule', ref: { name: 'Controller TCP' } }))).toBe('PROTECTED');
        expect(writes).toEqual([]);
    });

    it('still allows adding exceptions and removing blocks', async () => {
        const { state, apply } = seeded(dnsAllow, dnsBlock);

        await apply(rule({ name: 'Controller may use the internet', action: 'allow', from: [{ addresses: ['10.0.0.250'] }], to: [{ internet: true }], position: 1 }));
        await apply({ op: 'delete', kind: 'rule', ref: { name: 'No public DNS' } });

        expect(gatewayAcls(state).map(ruleNameOf)).toEqual(['Controller may use the internet', 'Controller may use public DNS']);
    });

    it('an exception in front of a complete block means the controller is not certainly cut off', async () => {
        const { writes, net } = seeded(dnsAllow, acl('acl-cut', 2, 'Controller offline', { sourceType: 1, sourceIds: ['ip-ctrl'] }));

        expect(await code(net.plan({ op: 'delete', kind: 'rule', ref: { name: 'Controller may use public DNS' } }))).toBe('PROTECTED');
        expect(writes).toEqual([]);
    });

    it('a delete whose answer was lost is reported as done once the rule is seen gone, and its group is cleaned up', async () => {
        const c = controller();
        await c.apply(rule({ name: 'IoT to HA', action: 'allow', to: [{ addresses: ['10.0.0.19'] }] }));
        c.state.failAfter = 'deleteGatewayAcl';

        const result = await c.apply({ op: 'delete', kind: 'rule', ref: { name: 'IoT to HA' } });

        expect(result.applied).toBe(true);
        expect(result.warnings?.join(' ')).toMatch(/answer was lost, but the rule is gone/);
        expect(gatewayAcls(c.state)).toEqual([]);
        expect(c.state.groups[0].map((g) => g.name)).toEqual(['IPGroup_Any']);
    });

    it('a delete the controller refused stays an error, and one it cannot confirm says so', async () => {
        const c = controller();
        await c.apply(rule());
        c.state.failOn = 'deleteGatewayAcl';
        await expect(c.apply({ op: 'delete', kind: 'rule', ref: { name: 'IoT to Home' } })).rejects.toThrow(/refused/);
        expect(gatewayAcls(c.state)).toHaveLength(1);

        c.state.failOn = 'deleteGatewayAcl';
        // The plan and fresh plan read the list; fail the read that would confirm.
        c.state.failRead = { op: 'listAcls', skip: 2 };
        await expect(c.apply({ op: 'delete', kind: 'rule', ref: { name: 'IoT to Home' } })).rejects.toThrow(/was deleted is unknown; check net_listRules/);
    });
});

describe('rules: group ownership and references (eighth Codex review of 2.4.7)', () => {
    it('never deletes a group that merely starts with the tag', async () => {
        const c = controller();
        c.state.groups[0].push({ groupId: 'ip-fake', name: '[net:deadbeef] DNS', ipList: [{ ip: '9.9.9.9', mask: 32 }] }, { groupId: 'ip-fake2', name: '[net:deadbeef] to 0011', ipList: [{ ip: '9.9.9.9', mask: 32 }] });

        await c.apply(rule());
        await c.apply({ op: 'delete', kind: 'rule', ref: { name: 'IoT to Home' } });

        expect(c.state.groups[0].map((g) => g.groupId)).toEqual(['ip-any', 'ip-fake', 'ip-fake2']);
    });

    it('omada_createGroup refuses the reserved prefix', async () => {
        const { AccessControlOperations } = await import('../../src/omadaClient/accessControl.js');
        const request = { get: vi.fn(async () => ({ errorCode: 0, result: [] })), request: vi.fn(), ensureSuccess: (r: { result?: unknown }) => r.result } as never;
        const ops = new AccessControlOperations(request, { resolveSiteId: () => 'site-1' } as never, (p: string) => p, {} as never, { listMacGroups: async () => [] } as never, {} as never);

        await expect(ops.createGroup({ name: '[net:deadbeef] DNS', type: 'ip', ips: ['9.9.9.9'] })).rejects.toThrow(/reserved for groups the net_ rule tools own/);
        await expect(ops.createGroup({ name: ' [NET:x', type: 'ip', ips: ['9.9.9.9'] })).rejects.toThrow(/reserved/);
    });

    it("a rename keeps the destination group when a group's name is another group's id", async () => {
        const c = controller();
        c.state.groups[0].push({ groupId: 'a', name: 'b', ipList: [{ ip: '10.0.0.19', mask: 32 }] }, { groupId: 'b', name: 'Other', ipList: [{ ip: '10.0.0.20', mask: 32 }] });
        c.state.acls['osg-acls'].push({ id: 'acl-1', index: 1, description: 'IoT to HA', status: true, policy: 1, protocols: [256], sourceType: 0, sourceIds: ['net-iot'], destinationType: 1, destinationIds: ['a'], direction: { lanToWan: false, lanToLan: true, wanInIds: [], vpnInIds: [] }, stateMode: 0 });

        expect((await c.net.listRules())[0].to).toEqual([{ group: { id: 'a' } }]);
        await c.apply({ op: 'update', kind: 'rule', value: { ref: { name: 'IoT to HA' }, set: { name: 'IoT may reach HA' } } });

        expect(gatewayAcls(c.state)[0]).toMatchObject({ description: 'IoT may reach HA', destinationIds: ['a'] });
    });
});


describe('firmware (2.5.1)', () => {
    it('lists what every device runs, as not upgradable through the tools', async () => {
        const { net, state } = controller();
        state.devices = [
            { type: 'gateway', mac: '5C-E9-31-00-00-01', name: 'gateway-gw1', model: 'ER605 v2.0', firmwareVersion: '2.4.5 Build 20260721 Rel.81048' },
            { type: 'ap', mac: 'a8:29:48:00:00:02' },
        ];
        expect(await net.listFirmware()).toEqual([
            { device: { mac: '5C-E9-31-00-00-01' }, name: 'gateway-gw1', model: 'ER605 v2.0', current: '2.4.5 Build 20260721 Rel.81048', upgradable: false },
            { device: { mac: 'A8-29-48-00-00-02' }, current: 'unknown', upgradable: false },
        ]);
        expect((await net.capabilities()).firmware).toBe('unsupported');
    });

    it('refuses an upgrade, writing nothing', async () => {
        const { net, writes } = controller();
        await expect(net.plan({ op: 'upgrade', kind: 'firmware' })).rejects.toMatchObject({ code: 'UNSUPPORTED', details: { capability: 'firmware' } });
        expect(writes).toEqual([]);
    });
});
