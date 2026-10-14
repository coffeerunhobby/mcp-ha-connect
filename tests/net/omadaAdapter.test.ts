/**
 * Omada adapter of the vendor-neutral network model, against a fake controller that
 * keeps state: networks and Wi-Fi (2.4.5).
 */

import { describe, it, expect, vi } from 'vitest';

import { OmadaNetworkController } from '../../src/net/adapters/omada.js';
import { NetError, type Change } from '../../src/net/model.js';
import { ALWAYS_PROFILE_NAME } from '../../src/omadaClient/network.js';
import type { OmadaClient } from '../../src/omadaClient/index.js';

const SECRET = 'HouseWifiPassw0rd!';

type Raw = Record<string, unknown>;

function controller(controllerHost = '10.0.0.250', resolveHost?: (host: string) => Promise<string[]>) {
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
        timeRanges: [] as Array<{ profileId: string; name: string }>,
    };
    const writes: Array<{ op: string; args: unknown[] }> = [];
    const record = (op: string) => async (...args: unknown[]) => {
        writes.push({ op, args: structuredClone(args) });
        if (op === 'createLanNetwork') state.networks.push({ id: `net-new-${state.networks.length}`, ...(args[0] as Raw) });
        if (op === 'updateLanNetwork') state.networks = state.networks.map((n) => (n.id === args[0] ? { ...n, ...(args[1] as Raw) } : n));
        if (op === 'deleteLanNetwork') state.networks = state.networks.filter((n) => n.id !== args[0]);
        if (op === 'createSsid') state.ssids.push({ wlanId: args[0] as string, ssidId: `ssid-new-${state.ssids.length}`, detail: { ...(args[1] as Raw), ssidEnable: true, macFilter: { macFilterEnable: false } } });
        if (op === 'updateSsidBasic') state.ssids = state.ssids.map((s) => (s.ssidId === args[1] ? { ...s, detail: { ...s.detail, ...(args[2] as Raw) } } : s));
        if (op === 'updateSsidMacFilter') state.ssids = state.ssids.map((s) => (s.ssidId === args[1] ? { ...s, detail: { ...s.detail, macFilter: args[2] } } : s));
        if (op === 'deleteSsid') state.ssids = state.ssids.filter((s) => s.ssidId !== args[1]);
    };
    const client = {
        controllerHost: '10.0.0.250',
        resolveSiteId: (id?: string) => id ?? 'site-1',
        networkConfig: {
            listLanNetworks: vi.fn(async () => structuredClone(state.networks)),
            listLanProfiles: vi.fn(async () => structuredClone(state.lanProfiles)),
            listAcls: vi.fn(async (list: string) => structuredClone(state.acls[list])),
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
        },
        listClients: vi.fn(async () => structuredClone(state.clients)),
        listMacGroups: vi.fn(async () => structuredClone(state.macGroups)),
        accessControl: {
            listDhcpReservations: vi.fn(async () => structuredClone(state.reservations)),
            listTimeRanges: vi.fn(async () => structuredClone(state.timeRanges)),
        },
    };
    const net = new OmadaNetworkController(client as unknown as OmadaClient, { controllerHost, ...(resolveHost ? { resolveHost } : {}) });
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
        state.ssids.push({ wlanId: 'wlan-1', ssidId: 'ssid-iot', detail: { name: 'iot-wifi', security: 0, band: 1, vlanSetting: { mode: 1, customConfig: { customMode: 0, lanNetworkVlanIds: { 'net-iot': [2] } } } } });

        const error = await net.plan({ op: 'delete', kind: 'network', ref: { name: 'IoT' } }).catch((e: NetError) => e);

        expect(error).toMatchObject({ code: 'IN_USE' });
        expect((error as NetError).details.users).toEqual(["Wi-Fi 'iot-wifi'", "port profile 'IoT ports'", 'DHCP reservation 02-00-00-00-00-09', "switch rule 'Deny IoT to Home'"]);
        expect(await code(apply({ op: 'delete', kind: 'network', ref: { name: 'Default' } }))).toBe('PROTECTED');
        expect(writes).toEqual([]);
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
    it('creates an SSID tagged into the network\'s VLAN with a temporary password nobody sees', async () => {
        const { writes, net } = controller();

        const plan = await net.plan(newWifi());
        const result = await net.apply(plan);

        const body = writes[0].args[1] as Raw;
        expect(writes[0]).toMatchObject({ op: 'createSsid', args: ['wlan-1', expect.any(Object), 'site-1'] });
        expect(body).toMatchObject({
            name: 'iot-wifi',
            deviceType: 3,
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
});

describe('plan and apply', () => {
    it('refuses to apply a plan when the controller changed since, writing nothing', async () => {
        const { state, writes, net } = controller();

        const plan = await net.plan(newNetwork());
        state.networks.push({ id: 'net-x', name: 'Someone else', purpose: 1, vlan: 50, gatewaySubnet: '10.0.50.1/24' });

        expect(await code(net.apply(plan))).toBe('CONFLICT');
        expect(writes).toEqual([]);
    });

    it('reports later releases\' features as not yet available', async () => {
        const { net } = controller();

        expect(await code(net.listRules())).toBe('UNSUPPORTED');
        expect(await code(net.plan({ op: 'delete', kind: 'rule', ref: { name: 'x' } }))).toBe('UNSUPPORTED');
        expect((await net.capabilities()).wifi.security).toEqual(['open', 'wpa2', 'wpa3']);
    });
});
