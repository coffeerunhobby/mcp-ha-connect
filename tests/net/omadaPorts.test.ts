/**
 * Omada adapter, 2.4.8: the network each client is on (wireless clients report vid 0),
 * switch ports (the networks a port carries) and port profiles, and the mDNS repeater.
 * The fake controller is shaped like the live one (6.3.0.45, 2026-10-20): the switch's
 * uplink and the hardware controller come from the site topology; profiles set no networks
 * (vlanConfigEnable false), each port has its own, and what a port carries is read from each
 * network's list of ports (switchInfo.affectedPorts).
 */

import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';

import { OmadaNetworkController } from '../../src/net/adapters/omada.js';
import { cutOff, describeNetworks, linkPorts, toMdns, toPortNetworks, toPortProfile } from '../../src/net/adapters/omadaPorts.js';
import { NetError, type Change, type Client, type PortNetworks, type PortRef } from '../../src/net/model.js';
import type { OmadaClient } from '../../src/omadaClient/index.js';
import { Permission } from '../../src/permissions/index.js';
import { registerNetTools } from '../../src/tools/net/index.js';

type Raw = Record<string, unknown>;

const SW = 'AA-BB-CC-00-00-01';
const port = (n: number, over: Raw = {}): Raw => ({ port: n, name: `Port${n}`, profileId: 'p-all', profileName: 'All', profileOverrideEnable: false, poeMode: 1, lagPort: false, status: 1, ...over });
const ALL_NETS = ['net-default', 'net-iot', 'net-lab'];
/** A port's own networks: native network id, networkTagsSetting (0 all, 1 none, 2 the list) and the tagged list. */
type Vlans = { native?: string; setting: number; tags: string[] };
const DEFAULT_VLANS: Vlans = { native: 'net-default', setting: 0, tags: [] };
/** The body that gives port n its own networks. */
const body = (n: number, native: string, setting = 1, tags: string[] = []): Raw => ({
    name: `Port${n}`,
    profileId: 'p-all',
    profileOverrideEnable: false,
    profileVlanOverrideEnable: true,
    nativeNetworkId: native,
    networkTagsSetting: setting,
    tagNetworkIds: tags,
    untagNetworkIds: [],
});

/** This server runs on the NAS (10.0.0.18, port 3) unless a test says otherwise. */
function controller(controllerHost = '10.0.0.250', resolveHost?: (host: string) => Promise<string[]>, serverHosts: string[] | null = ['10.0.0.18']) {
    const state = {
        networks: [
            { id: 'net-default', name: 'Default', purpose: 1, vlan: 1, primary: true, gatewaySubnet: '10.0.0.1/24', dhcpSettingsVO: { enable: true } },
            { id: 'net-iot', name: 'IoT', purpose: 1, vlan: 2, primary: false, gatewaySubnet: '10.0.1.1/24', dhcpSettingsVO: { enable: true } },
            { id: 'net-lab', name: 'Engineering', purpose: 1, vlan: 70, primary: false, gatewaySubnet: '10.0.70.1/24', dhcpSettingsVO: { enable: true } },
            { id: 'net-cam', name: 'Cameras', purpose: 0, vlan: 80, primary: false },
        ] as Raw[],
        ssids: [
            { wlanId: 'wlan-1', ssidId: 'ssid-home', detail: { name: 'home-wifi', band: 3, security: 3, vlanEnable: false, vlanSetting: { mode: 0 }, pskSetting: { securityKey: 'x', versionPsk: 2 }, ssidEnable: true } },
            { wlanId: 'wlan-1', ssidId: 'ssid-iot', detail: { name: 'iot-wifi', band: 1, security: 3, vlanEnable: true, vlanId: 2, vlanSetting: { mode: 0 }, pskSetting: { securityKey: 'y', versionPsk: 2 }, ssidEnable: true } },
            {
                wlanId: 'wlan-1',
                ssidId: 'ssid-multi',
                detail: { name: 'multi-wifi', band: 1, security: 0, vlanSetting: { mode: 1, customConfig: { lanNetworkVlanIds: { 'net-iot': [2], 'net-lab': [70] } } }, ssidEnable: true },
            },
        ] as Array<{ wlanId: string; ssidId: string; detail: Raw }>,
        clients: [
            { mac: '02:00:00:00:00:01', name: 'phone', ip: '10.0.0.101', wireless: true, vid: 0, ssid: 'home-wifi', active: true },
            { mac: '02:00:00:00:00:02', name: 'sensor', ip: '10.0.1.33', wireless: true, vid: 0, ssid: 'iot-wifi', active: true },
            { mac: '02:00:00:00:00:03', name: 'waiting', ip: '', wireless: true, vid: 0, ssid: 'iot-wifi', active: true },
            { mac: '02:00:00:00:00:04', name: 'roamer', ip: '', wireless: true, vid: 0, ssid: 'multi-wifi', active: true },
            { mac: '02:00:00:00:00:05', name: 'controller', ip: '10.0.0.250', wireless: false, vid: 1, switchMac: SW, port: 2, active: true },
            { mac: '02:00:00:00:00:06', name: 'nas', ip: '10.0.0.18', wireless: false, vid: 1, switchMac: SW, port: 3, active: true },
            { mac: '02:00:00:00:00:07', name: 'plug', ip: '10.0.0.144', wireless: false, vid: 1, switchMac: SW, port: 5, active: true },
            { mac: '02:00:00:00:00:08', name: 'lab-vm', ip: '10.0.70.10', wireless: false, vid: 70, switchMac: SW, port: 6, active: true },
            { mac: '02:00:00:00:00:09', name: 'router', ip: '10.0.0.19', wireless: false, vid: 1, gatewayMac: 'GW', active: true },
        ] as Raw[],
        devices: [
            { type: 'gateway', mac: '5C-00-00-00-00-01', name: 'gateway-gw1' },
            { type: 'switch', mac: SW, name: 'switch-sw1' },
            { type: 'ap', mac: 'A8-00-00-00-00-01', name: 'eap' },
        ] as Raw[],
        ports: { [SW]: [port(1), port(2), port(3), port(4), port(5), port(6), port(7, { lagPort: true }), port(8, { profileOverrideEnable: true }), port(9)] } as Record<string, Raw[]>,
        topology: {
            topologyNodes: [
                { type: 'gateway', name: 'gateway-gw1', mac: '5C-00-00-00-00-01' },
                { type: 'switch', name: 'switch-sw1', mac: SW, upperInfo: { port: { port: 1 }, upLinkPort: { port: 4, name: 'LAN4' } } },
                { type: 'ap', name: 'eap', mac: 'A8-00-00-00-00-01', wiredUpLink: { upLinkPort: { port: 4, name: 'Port4' } } },
                { type: 'omada controller', name: 'Omada Controller', mac: 'AC-00-00-00-00-01', wiredUpLink: { upLinkPort: { port: 2 } } },
            ],
            topologyEdges: [
                { upLinkMac: '5C-00-00-00-00-01', downLinkMac: SW },
                { upLinkMac: SW, downLinkMac: 'A8-00-00-00-00-01' },
                { upLinkMac: SW, downLinkMac: 'AC-00-00-00-00-01' },
            ],
        } as Raw,
        topologyFails: false,
        /** Each port's own networks; what the networks' port lists report is derived from it. */
        vlans: { [SW]: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [n, { ...DEFAULT_VLANS }])) } as Record<string, Record<number, Vlans>>,
        /** Changes what a network's port list reports (to make the lists contradict each other, or list things in another order). */
        carryHook: undefined as undefined | ((networkId: string, devices: Raw[]) => Raw[]),
        profiles: [
            { id: 'p-all', name: 'All', vlanConfigEnable: false, nativeNetworkId: 'net-default', networkTagsSetting: 0, tagNetworkIds: ['net-iot', 'net-lab'], untagNetworkIds: ['net-default'], portIsolationEnable: false },
            { id: 'p-default', name: 'Default', nativeNetworkId: 'net-default', networkTagsSetting: 1, tagNetworkIds: [], untagNetworkIds: ['net-default'], portIsolationEnable: false },
            { id: 'p-off', name: 'Disable', vlanConfigEnable: true, networkTagsSetting: 1, tagNetworkIds: [], untagNetworkIds: [], portIsolationEnable: false },
            { id: 'p-lab-trunk', name: 'Lab trunk', vlanConfigEnable: true, nativeNetworkId: 'net-iot', networkTagsSetting: 2, tagNetworkIds: ['net-lab'], untagNetworkIds: ['net-iot', 'net-cam'], portIsolationEnable: true },
        ] as Raw[],
        mdns: [
            { id: 'm1', name: 'Repeater', status: true, profileIds: ['buildIn-1', 'buildIn-2', 'custom-9'], type: 1, osg: { serviceNetworks: [...ALL_NETS], clientNetworks: [...ALL_NETS] } },
        ] as Raw[],
        /** What the controller does with a write (default: store it). */
        onWrite: undefined as undefined | ((op: string, args: unknown[]) => void),
        /** A read that fails once after `skip` calls (an answer lost after a write). */
        failRead: undefined as undefined | { op: 'getSwitch' | 'listMdnsRules' | 'listNetworkPorts'; skip: number },
    };
    const writes: Array<{ op: string; args: unknown[] }> = [];
    const failRead = (op: 'getSwitch' | 'listMdnsRules' | 'listNetworkPorts') => {
        if (state.failRead?.op !== op) return;
        if (state.failRead.skip-- > 0) return;
        state.failRead = undefined;
        throw new Error(`${op} timed out`);
    };
    /** The devices whose ports carry a network, as the controller lists them (the native network is also untagged). */
    const carrying = (networkId: string): Raw[] => {
        const devices: Raw[] = [{ type: 'gateway', mac: '5C-00-00-00-00-01', name: 'gateway-gw1', gatewayInfo: {} }];
        for (const [mac, ports] of Object.entries(state.vlans)) {
            const native: number[] = [];
            const tagged: number[] = [];
            for (const [n, v] of Object.entries(ports)) {
                if (v.native === networkId) native.push(Number(n));
                else if (v.setting === 0 || (v.setting === 2 && v.tags.includes(networkId))) tagged.push(Number(n));
            }
            devices.push({ type: 'switch', mac, name: 'switch-sw1', switchInfo: { affectedPorts: { nativePorts: native, nativeLags: [], tagPorts: tagged, tagLags: [], untagPorts: [...native], untagLags: [], vlan: 1, mode: 1 }, clients: [] } });
        }
        return state.carryHook ? state.carryHook(networkId, devices) : devices;
    };
    const client = {
        controllerHost,
        resolveSiteId: (id?: string) => id ?? 'site-1',
        networkConfig: {
            listLanNetworks: vi.fn(async () => structuredClone(state.networks)),
            listLanProfiles: vi.fn(async () => []),
            listAcls: vi.fn(async () => []),
            listGroups: vi.fn(async () => []),
            listSsidSummaries: vi.fn(async () => [{ wlanId: 'wlan-1', wlanName: 'Default', ssidList: state.ssids.map((s) => ({ ssidId: s.ssidId, ssidName: String(s.detail.name) })) }]),
            getSsidDetail: vi.fn(async (_w: string, ssidId: string) => structuredClone(state.ssids.find((s) => s.ssidId === ssidId)!.detail)),
            listPortProfiles: vi.fn(async () => structuredClone(state.profiles)),
            getSwitch: vi.fn(async (mac: string) => {
                failRead('getSwitch');
                return state.ports[mac] ? { mac, portList: structuredClone(state.ports[mac]) } : { mac };
            }),
            getTopology: vi.fn(async () => {
                if (state.topologyFails) throw new Error('Unsupported request path');
                return structuredClone(state.topology);
            }),
            listNetworkPorts: vi.fn(async (networkId: string) => {
                failRead('listNetworkPorts');
                return structuredClone(carrying(networkId));
            }),
            updateSwitchPort: vi.fn(async (...args: unknown[]) => {
                writes.push({ op: 'updateSwitchPort', args: structuredClone(args) });
                if (state.onWrite) return state.onWrite('updateSwitchPort', args);
                const [mac, n, b] = args as [string, number, Raw];
                state.vlans[mac][n] = { native: b.nativeNetworkId as string, setting: b.networkTagsSetting as number, tags: b.tagNetworkIds as string[] };
            }),
            listMdnsRules: vi.fn(async () => {
                failRead('listMdnsRules');
                return structuredClone(state.mdns);
            }),
            updateMdnsRule: vi.fn(async (...args: unknown[]) => {
                writes.push({ op: 'updateMdnsRule', args: structuredClone(args) });
                if (state.onWrite) return state.onWrite('updateMdnsRule', args);
                const [id, body] = args as [string, Raw];
                state.mdns = state.mdns.map((r) => (r.id === id ? { id, ...body } : r));
            }),
        },
        listClients: vi.fn(async () => structuredClone(state.clients)),
        listDevices: vi.fn(async () => structuredClone(state.devices)),
        listMacGroups: vi.fn(async () => []),
        accessControl: { listTimeRanges: vi.fn(async () => []), listDhcpReservations: vi.fn(async () => []) },
    };
    const net = new OmadaNetworkController(client as unknown as OmadaClient, { controllerHost, ...(serverHosts ? { serverHosts } : {}), ...(resolveHost ? { resolveHost } : {}) });
    const apply = async (change: Change, allowLockout = false) => net.apply(await net.plan(change), { allowLockout });
    return { state, writes, net, apply, client };
}

const code = async (promise: Promise<unknown>) => promise.then(() => 'ok', (e) => (e instanceof NetError ? e.code : `not a NetError: ${String(e)}`));
const message = async (promise: Promise<unknown>) => promise.then(() => 'ok', (e) => String((e as Error).message));
const assign = (p: number, native: string, tagged: 'all' | 'none' | string[] = 'none', device: PortRef['device'] = { name: 'switch-sw1' }): Change => ({
    op: 'assign',
    kind: 'port',
    port: { device, port: p },
    networks: { native: { name: native }, tagged: Array.isArray(tagged) ? tagged.map((name) => ({ name })) : tagged },
});
/** What the default ports carry: Default untagged, every other network tagged. */
const DEFAULT_CARRIED: PortNetworks = { native: { id: 'net-default' }, tagged: [{ id: 'net-iot' }, { id: 'net-lab' }, { id: 'net-cam' }] };

describe('clients', () => {
    it('puts each client on its network: wired by VLAN, wireless (vid 0) by address, else by its Wi-Fi network', async () => {
        const { net } = controller();

        const clients = await net.listClients();
        const on = (name: string) => clients.find((c) => c.name === name);

        expect(on('phone')).toEqual({ mac: '02-00-00-00-00-01', name: 'phone', ip: '10.0.0.101', network: { id: 'net-default' }, wifi: { name: 'home-wifi' }, online: true });
        expect(on('sensor')?.network).toEqual({ id: 'net-iot' });
        expect(on('waiting')).toEqual({ mac: '02-00-00-00-00-03', name: 'waiting', network: { id: 'net-iot' }, wifi: { name: 'iot-wifi' }, online: true });
        // A Wi-Fi network that puts devices on several networks doesn't tell which one.
        expect(on('roamer')?.network).toBeUndefined();
        expect(on('lab-vm')).toEqual({ mac: '02-00-00-00-00-08', name: 'lab-vm', ip: '10.0.70.10', network: { id: 'net-lab' }, port: { device: { mac: SW }, port: 6 }, online: true });
        expect(on('router')?.port).toBeUndefined();
    });

    it('ignores a VLAN reported for a wireless client and a VLAN no network has', async () => {
        const { state, net } = controller();
        state.clients = [
            { mac: '02:00:00:00:00:10', name: 'odd-wireless', ip: '10.0.1.40', wireless: true, vid: 70, ssid: 'iot-wifi', active: true },
            { mac: '02:00:00:00:00:11', name: 'unknown-vlan', ip: '10.0.0.40', wireless: false, vid: 99, switchMac: SW, port: 9, active: true },
            { mac: '02:00:00:00:00:12', name: 'bad-port', ip: '10.0.0.41', wireless: false, vid: 1, switchMac: SW, port: 0, active: true },
        ];

        const clients = await net.listClients();

        expect(clients.map((c) => [c.name, c.network])).toEqual([
            ['odd-wireless', { id: 'net-iot' }],
            ['unknown-vlan', { id: 'net-default' }],
            ['bad-port', { id: 'net-default' }],
        ]);
        expect(clients[2].port).toBeUndefined();
    });
});

describe('port profiles', () => {
    it('gives a profile networks only when it sets them (no vlanConfigEnable field: older controllers, where it does)', async () => {
        const { net } = controller();

        expect(await net.listPortProfiles()).toEqual([
            { id: 'p-all', name: 'All', isolation: false },
            { id: 'p-default', name: 'Default', networks: { native: { id: 'net-default' }, tagged: 'none' }, isolation: false },
            { id: 'p-off', name: 'Disable', networks: { tagged: 'none' }, isolation: false },
            { id: 'p-lab-trunk', name: 'Lab trunk', networks: { native: { id: 'net-iot' }, untagged: [{ id: 'net-cam' }], tagged: [{ id: 'net-lab' }] }, isolation: true },
        ]);
    });

    it('maps all, none and a tagged list; a profile without a tag mode by its list', () => {
        expect(toPortProfile({ id: 'a', name: 'a', nativeNetworkId: 'n1', networkTagsSetting: 0, tagNetworkIds: ['n2'] }).networks).toEqual({ native: { id: 'n1' }, tagged: 'all' });
        expect(toPortProfile({ id: 'a', name: 'a', nativeNetworkId: 'n1', tagNetworkIds: ['n2'] }).networks).toEqual({ native: { id: 'n1' }, tagged: [{ id: 'n2' }] });
        expect(toPortProfile({ id: 'b', name: 'b', nativeNetworkId: '', tagNetworkIds: [] })).toEqual({ id: 'b', name: 'b', networks: { tagged: 'none' }, isolation: false });
    });

    it('describes networks by name, falling back to ids and given names', () => {
        const networks = [{ id: 'n1', name: 'Default' }] as Parameters<typeof describeNetworks>[1];
        expect(describeNetworks({ native: { id: 'n9' }, tagged: [{ id: 'n1' }, { name: 'Lab' }] }, networks)).toBe('untagged = n9, tagged = Default, Lab');
        expect(describeNetworks({ native: { name: 'IoT' }, tagged: 'all' }, networks)).toBe('untagged = IoT, tagged = all networks');
        expect(describeNetworks({ native: { id: 'n1' }, untagged: [{ id: 'n2' }], tagged: 'none' }, networks)).toBe('untagged = Default, n2, tagged = none');
        expect(describeNetworks({ tagged: 'none' }, networks)).toBe('untagged = none, tagged = none');
    });
});

describe('what a port carries, from each network\'s list of ports', () => {
    const lists = (entries: Record<string, Raw>) => new Map(Object.entries(entries));

    it('takes the native network (also listed untagged), further untagged and tagged networks', () => {
        const affected = lists({
            n1: { nativePorts: [5], untagPorts: [5, 6] },
            n2: { untagPorts: ['5'], tagPorts: [6] },
            n3: { tagPorts: [5, 6] },
            n4: { nativePorts: [6], tagPorts: [7] },
            n5: {},
        });

        expect(toPortNetworks(affected, 5)).toEqual({ native: { id: 'n1' }, untagged: [{ id: 'n2' }], tagged: [{ id: 'n3' }] });
        expect(toPortNetworks(affected, 6)).toEqual({ native: { id: 'n4' }, untagged: [{ id: 'n1' }], tagged: [{ id: 'n2' }, { id: 'n3' }] });
        expect(toPortNetworks(affected, 9)).toEqual({ tagged: 'none' });
        expect(toPortNetworks(lists({ n1: { nativePorts: 'x', tagPorts: null } }), 5)).toEqual({ tagged: 'none' });
    });

    it('is unknown when the lists contradict each other: two native networks, or one both tagged and untagged', () => {
        expect(toPortNetworks(lists({ n1: { nativePorts: [5] }, n2: { nativePorts: [5] } }), 5)).toBeUndefined();
        expect(toPortNetworks(lists({ n1: { nativePorts: [5], tagPorts: [5] } }), 5)).toBeUndefined();
        expect(toPortNetworks(lists({ n1: { untagPorts: [5], tagPorts: [5] } }), 5)).toBeUndefined();
    });
});

describe('ports', () => {
    it('lists ports with their profile, the online devices on them, uplinks and why a port is protected', async () => {
        const { net } = controller();

        const ports = await net.listPorts();
        const at = (n: number) => ports.find((p) => p.port === n)!;

        expect(ports).toHaveLength(9);
        expect(at(1)).toEqual({
            device: { mac: SW },
            port: 1,
            name: 'Port1',
            profile: { id: 'p-all' },
            networks: DEFAULT_CARRIED,
            customSettings: false,
            seen: [],
            uplink: true,
            protected: "it links the switch to gateway 'gateway-gw1'",
        });
        expect(at(2).protected).toBe("it carries omada controller 'Omada Controller'");
        expect(at(2).uplink).toBe(true);
        expect(at(4).protected).toBe("it carries ap 'eap'");
        expect(at(3)).toMatchObject({ uplink: false, seen: [{ name: 'nas' }], protected: 'this server is on it' });
        expect(at(5)).toMatchObject({ uplink: false, seen: [{ name: 'plug' }] });
        expect(at(5).protected).toBeUndefined();
        expect(at(7).protected).toBe('it is part of a link aggregation (LAG); change it in the controller web UI');
        expect(at(8)).toMatchObject({ customSettings: true });
        expect(at(8).protected).toBeUndefined();
    });

    it('protects the port a software controller is on (by its address)', async () => {
        const { net } = controller('10.0.0.144');

        expect((await net.listPorts()).find((p) => p.port === 5)?.protected).toBe('the controller is on it');
    });

    it('never reassigns the port this server is on, even with allowLockout; a host name is resolved', async () => {
        const { writes, net } = controller('10.0.0.250', async (host) => (host === 'mcp.home.test' ? ['10.0.0.144'] : []), ['mcp.home.test']);

        expect((await net.listPorts()).find((p) => p.port === 5)?.protected).toBe('this server is on it');
        expect(await code(net.plan(assign(5, 'IoT')))).toBe('PROTECTED');
        expect(writes).toEqual([]);
    });

    it('leaves ports with devices alone when where the controller or this server is can\'t be told; empty ports stay assignable', async () => {
        const cases: Array<[string, ReturnType<typeof controller>]> = [
            ["this server's address isn't configured (MCP_SERVER_ADDRESSES), so its port can't be told; ports with devices on them are left alone", controller('10.0.0.250', undefined, null)],
            ["this server's address isn't configured (MCP_SERVER_ADDRESSES), so its port can't be told; ports with devices on them are left alone", controller('10.0.0.250', undefined, [])],
            ["this server's address can't be resolved, so its port can't be told; ports with devices on them are left alone", controller('10.0.0.250', async () => [], ['mcp.home.test'])],
            ["this server's address can't be resolved, so its port can't be told; ports with devices on them are left alone", controller('10.0.0.250', async () => { throw new Error('ENOTFOUND'); }, ['10.0.0.18', 'mcp.home.test'])],
            ["the controller's address can't be resolved, so its port can't be told; ports with devices on them are left alone", controller('omada.home.test', async () => { throw new Error('ENOTFOUND'); })],
            ["this server isn't seen on a switch port, so its port can't be told; ports with devices on them are left alone", controller('10.0.0.250', undefined, ['10.0.1.99'])],
            ["the controller isn't seen on a switch port, so its port can't be told; ports with devices on them are left alone", controller('10.0.70.99')],
            // Seen, but not on a switch port (on Wi-Fi, or straight on the gateway): where it hangs off can't be told.
            ["this server isn't seen on a switch port, so its port can't be told; ports with devices on them are left alone", controller('10.0.0.250', undefined, ['10.0.0.101'])],
            ["this server isn't seen on a switch port, so its port can't be told; ports with devices on them are left alone", controller('10.0.0.250', undefined, ['10.0.0.19'])],
        ];
        for (const [reason, c] of cases) {
            const ports = await c.net.listPorts();
            expect(ports.find((p) => p.port === 5)?.protected).toBe(reason);
            expect(ports.find((p) => p.port === 9)?.protected).toBeUndefined();
            expect(await code(c.net.plan(assign(5, 'IoT')))).toBe('PROTECTED');
            await c.apply(assign(9, 'IoT'));
            expect(c.writes).toEqual([{ op: 'updateSwitchPort', args: [SW, 9, body(9, 'net-iot'), 'site-1'] }]);
        }
    });

    it('lets a server or controller outside the site\'s networks (e.g. in the cloud) not hold anything back', async () => {
        const { net } = controller('203.0.113.7', undefined, ['198.51.100.4', '10.0.0.18']);

        const ports = await net.listPorts();

        expect(ports.find((p) => p.port === 5)?.protected).toBeUndefined();
        expect(ports.find((p) => p.port === 3)?.protected).toBe('this server is on it');
    });

    it('protects every port when an adopted device is missing from the topology (node and link both gone), even with allowLockout', async () => {
        const { state, writes, net, apply } = controller();
        state.topology = {
            topologyNodes: (state.topology.topologyNodes as Raw[]).filter((n) => n.type !== 'ap'),
            topologyEdges: (state.topology.topologyEdges as Raw[]).filter((e) => e.downLinkMac !== 'A8-00-00-00-00-01'),
        };

        expect((await net.listPorts()).find((p) => p.port === 4)?.protected).toBe("the controller's topology doesn't show which port links switch 'switch-sw1' to the network");
        expect(await code(apply(assign(4, 'IoT'), true))).toBe('PROTECTED');
        expect(writes).toEqual([]);
    });

    it('protects every port when a device below the switch reports two different ports, even with allowLockout', async () => {
        const { state, writes, apply } = controller();
        state.topology = { ...state.topology, topologyNodes: (state.topology.topologyNodes as Raw[]).map((n) => (n.type === 'ap' ? { ...n, upperInfo: { upLinkPort: { port: 9 } } } : n)) };

        expect(await code(apply(assign(9, 'IoT'), true))).toBe('PROTECTED');
        expect(writes).toEqual([]);
    });

    it('protects every port when the topology names a port the switch doesn\'t have, even with allowLockout', async () => {
        const { state, writes, net, apply } = controller();
        state.topology = { ...state.topology, topologyNodes: (state.topology.topologyNodes as Raw[]).map((n) => (n.type === 'ap' ? { ...n, wiredUpLink: { upLinkPort: { port: 12 } } } : n)) };

        expect((await net.listPorts()).find((p) => p.port === 4)?.protected).toBe("the controller's topology doesn't show which port links switch 'switch-sw1' to the network");
        expect(await code(apply(assign(4, 'IoT'), true))).toBe('PROTECTED');
        expect(writes).toEqual([]);
    });

    it('protects every port when the topology can\'t tell the uplinks', async () => {
        const noTopology = controller();
        noTopology.state.topologyFails = true;
        const ports = await noTopology.net.listPorts();
        expect(ports.every((p) => p.protected === "the controller's topology doesn't show which port links switch 'switch-sw1' to the network")).toBe(true);
        expect(ports.every((p) => p.uplink === false)).toBe(true);
        expect(await code(noTopology.apply(assign(9, 'IoT')))).toBe('PROTECTED');
        expect(noTopology.writes).toEqual([]);
    });

    it('copes with a nameless switch, a switch without ports, a port without name or profile, and a site without switches', async () => {
        const { state, net, client } = controller();
        state.devices.push({ type: 'switch', mac: 'BB-00-00-00-00-02' });
        (state.topology.topologyNodes as Raw[]).push({ type: 'switch', mac: 'BB-00-00-00-00-02', upperInfo: { port: { port: 1 } } });
        (state.topology.topologyEdges as Raw[]).push({ upLinkMac: '5C-00-00-00-00-01', downLinkMac: 'BB-00-00-00-00-02' });
        state.ports[SW] = [port(1), port(2), port(4), { port: 9 }];

        const ports = await net.listPorts();

        expect(ports.find((p) => p.port === 9)).toEqual({ device: { mac: SW }, port: 9, networks: DEFAULT_CARRIED, customSettings: false, seen: [], uplink: false });
        expect(await net.listPorts({ name: 'BB-00-00-00-00-02' })).toEqual([]);
        state.devices = [];
        client.networkConfig.listNetworkPorts.mockClear();
        expect(await message(net.listPorts({ mac: SW }))).toBe(`No switch with MAC '${SW}'. Switches: (none)`);
        expect(client.networkConfig.listNetworkPorts).not.toHaveBeenCalled(); // no switch: nothing to read
    });

    it('lists the ports of one switch, by name or MAC (any notation)', async () => {
        const { net } = controller();

        expect(await net.listPorts({ name: 'switch-sw1' })).toHaveLength(9);
        expect(await net.listPorts({ mac: 'aa:bb:cc:00:00:01' })).toHaveLength(9);
        expect(await net.listPorts({ id: SW })).toHaveLength(9);
        expect(await code(net.listPorts({ mac: 'AA-BB-CC-00-00-99' }))).toBe('NOT_FOUND');
        expect(await code(net.listPorts({ mac: '--' }))).toBe('NOT_FOUND');
        expect(await code(net.listPorts({ name: 'switch-sw2' }))).toBe('NOT_FOUND');
    });
});

describe('the uplinks from the topology', () => {
    const topo = (over: Raw = {}) => ({
        topologyNodes: [
            { type: 'gateway', name: 'gw', mac: 'GW-00' },
            { type: 'switch', name: 'sw', mac: SW, upperInfo: { port: { port: 10 } } },
            { type: 'ap', name: 'mesh', mac: 'A8-00-00-00-00-02', wirelessUpLink: { uplinkMac: 'x' } },
            { type: 'switch', name: 'sw2', mac: 'BB-00-00-00-00-02', wiredUpLink: { upLinkPort: { port: 3 } } },
        ],
        topologyEdges: [
            { upLinkMac: 'GW-00', downLinkMac: SW },
            { upLinkMac: SW, downLinkMac: 'A8-00-00-00-00-02' },
            { upLinkMac: SW, downLinkMac: 'BB-00-00-00-00-02' },
        ],
        ...over,
    });

    it('is unknown when a device the controller manages is missing from it', () => {
        expect(linkPorts(topo(), SW, ['GW-00', SW, 'a8:00:00:00:00:02', 'BB-00-00-00-00-02'])).toBeDefined();
        expect(linkPorts(topo(), SW, ['GW-00', SW, 'A8-00-00-00-00-09'])).toBeUndefined();
    });

    it('takes the switch\'s own uplink and the wired devices below, not wireless ones', () => {
        expect([...linkPorts(topo(), 'aa:bb:cc:00:00:01', [])!]).toEqual([
            [10, "it links the switch to gateway 'gw'"],
            [3, "it carries switch 'sw2'"],
        ]);
    });

    it('is unknown when the topology contradicts itself: a device listed twice, linked upwards twice, or a link to or from a device it doesn\'t describe', () => {
        const twice = topo();
        twice.topologyNodes.push({ type: 'switch', name: 'sw', mac: 'aa:bb:cc:00:00:01', upperInfo: { port: { port: 9 } } });
        expect(linkPorts(twice, SW, [])).toBeUndefined();
        expect(linkPorts(topo({ topologyEdges: [...topo().topologyEdges, { upLinkMac: 'BB-00-00-00-00-02', downLinkMac: SW }] }), SW, [])).toBeUndefined();
        expect(linkPorts(topo({ topologyNodes: topo().topologyNodes.slice(1) }), SW, [])).toBeUndefined(); // the gateway above isn't described
        // a device linked to itself, and two switches linked to each other with no way up to the gateway
        expect(linkPorts(topo({ topologyEdges: [{ upLinkMac: 'GW-00', downLinkMac: SW }, { upLinkMac: SW, downLinkMac: 'A8-00-00-00-00-02' }, { upLinkMac: 'BB-00-00-00-00-02', downLinkMac: 'BB-00-00-00-00-02' }] }), SW, [])).toBeUndefined();
        const island = topo({ topologyEdges: [{ upLinkMac: 'BB-00-00-00-00-02', downLinkMac: SW }, { upLinkMac: SW, downLinkMac: 'BB-00-00-00-00-02' }, { upLinkMac: SW, downLinkMac: 'A8-00-00-00-00-02' }] });
        (island.topologyNodes[3] as Raw).wiredUpLink = { upLinkPort: { port: 3 } };
        expect(linkPorts(island, SW, [])).toBeUndefined();
        // the gateway linked upwards (to the switch below it): a loop, whatever ports it names
        const loop = topo({ topologyEdges: [...topo().topologyEdges, { upLinkMac: SW, downLinkMac: 'GW-00' }] });
        (loop.topologyNodes[0] as Raw).wiredUpLink = { upLinkPort: { port: 7 } };
        expect(linkPorts(loop, SW, [])).toBeUndefined();
    });

    it('is unknown when the topology is incomplete: no list of links, or a device (other than the gateway) linked to nothing', () => {
        expect(linkPorts(topo({ topologyEdges: undefined }), SW, [])).toBeUndefined();
        expect(linkPorts(topo({ topologyNodes: 'x' }), SW, [])).toBeUndefined();
        // the access point below lost its link: which port it is on can't be told
        expect(linkPorts(topo({ topologyEdges: [{ upLinkMac: 'GW-00', downLinkMac: SW }, { upLinkMac: SW, downLinkMac: 'BB-00-00-00-00-02' }] }), SW, [])).toBeUndefined();
        // the switch itself linked to nothing above it
        expect(linkPorts(topo({ topologyEdges: [{ upLinkMac: SW, downLinkMac: 'A8-00-00-00-00-02' }, { upLinkMac: SW, downLinkMac: 'BB-00-00-00-00-02' }] }), SW, [])).toBeUndefined();
    });

    it('is unknown when the switch is missing, has no uplink port, or a wired device below has no port', () => {
        expect(linkPorts(topo({ topologyNodes: [] }), SW, [])).toBeUndefined();
        expect(linkPorts({}, SW, [])).toBeUndefined();
        const t = topo();
        (t.topologyNodes[1] as Raw).upperInfo = {};
        expect(linkPorts(t, SW, [])).toBeUndefined();
        const below = topo();
        (below.topologyNodes[3] as Raw).wiredUpLink = {};
        expect(linkPorts(below, SW, [])).toBeUndefined();
        // A device below the switch that the topology doesn't describe: its port can't be told.
        expect(linkPorts(topo({ topologyEdges: [...topo().topologyEdges, { upLinkMac: SW, downLinkMac: 'CC-00-00-00-00-03' }] }), SW, [])).toBeUndefined();
    });

    it('names a device by MAC and as a device when the topology leaves out its name and type', () => {
        const t = topo();
        (t.topologyNodes[3] as Raw) = { mac: 'BB-00-00-00-00-02', wiredUpLink: { upLinkPort: { port: 3 } } };
        expect(linkPorts(t, SW, [])!.get(3)).toBe("it carries device 'BB-00-00-00-00-02'");
    });

    it('takes the port a switch below reports in upperInfo, and refuses reports that disagree', () => {
        const below = topo();
        (below.topologyNodes[3] as Raw) = { type: 'switch', name: 'sw2', mac: 'BB-00-00-00-00-02', upperInfo: { port: { port: 1 }, upLinkPort: { port: 3 } } };
        expect([...linkPorts(below, SW, [])!.keys()]).toEqual([10, 3]);
        const agree = topo();
        (agree.topologyNodes[3] as Raw).upperInfo = { port: { port: 1 }, upLinkPort: { port: 3 } };
        expect([...linkPorts(agree, SW, [])!.keys()]).toEqual([10, 3]);
        const emptyWired = topo();
        (emptyWired.topologyNodes[2] as Raw).wiredUpLink = {}; // the mesh access point also claims a wired link, without a port
        expect(linkPorts(emptyWired, SW, [])).toBeUndefined();
        const disagree = topo();
        (disagree.topologyNodes[3] as Raw).upperInfo = { port: { port: 1 }, upLinkPort: { port: 5 } };
        expect(linkPorts(disagree, SW, [])).toBeUndefined();
    });

    it('protects a wired link even when the device also reports a wireless one', () => {
        const both = topo();
        (both.topologyNodes[2] as Raw).wiredUpLink = { upLinkPort: { port: 5 } };
        expect([...linkPorts(both, SW, [])!.keys()]).toEqual([10, 5, 3]);
    });
});

describe('who a port change cuts off', () => {
    const all: PortNetworks = { native: { id: 'n1' }, tagged: 'all' };
    const iot: PortNetworks = { native: { id: 'n2' }, tagged: 'none' };
    const trunk: PortNetworks = { native: { id: 'n2' }, tagged: [{ id: 'n3' }] };
    const off: PortNetworks = { tagged: 'none' };
    const dev = (net?: string): Client => ({ mac: `02-00-00-00-00-${net ?? 'xx'}`, online: true, ...(net ? { network: { id: net } } : {}) });

    it('keeps a device whose network reaches it the same way (untagged, or tagged)', () => {
        expect(cutOff([dev('n2')], iot, trunk)).toEqual([]);
        expect(cutOff([dev('n3')], all, trunk)).toEqual([]);
        expect(cutOff([dev('n1')], all, { ...all })).toEqual([]);
    });

    it('cuts off a device whose network changes, turns from tagged to untagged, or is unknown, and everyone on a port that carries nothing', () => {
        expect(cutOff([dev('n1')], all, iot)).toEqual([dev('n1')]);
        expect(cutOff([dev('n2')], all, iot)).toEqual([dev('n2')]); // tagged before, untagged native now
        expect(cutOff([dev('n2')], all, { ...all, native: { id: 'n2' } })).toEqual([dev('n2')]); // "all tagged" leaves out the native network
        expect(cutOff([dev('n3')], trunk, iot)).toEqual([dev('n3')]);
        expect(cutOff([dev()], all, all)).toEqual([dev()]);
        expect(cutOff([dev('n9')], iot, all)).toEqual([dev('n9')]); // its network didn't reach this port before
        expect(cutOff([dev('n2')], undefined, iot)).toEqual([dev('n2')]); // what the port carries now is unknown
        expect(cutOff([dev('n1'), dev('n2')], all, off)).toHaveLength(2);
    });

    it('treats an extra untagged network as its own way of reaching a device', () => {
        const extra: PortNetworks = { native: { id: 'n1' }, untagged: [{ id: 'n2' }], tagged: 'all' };
        const taggedN2: PortNetworks = { native: { id: 'n1' }, tagged: [{ id: 'n2' }] };
        // untagged before, tagged after (and "all tagged" leaves out the extra untagged one)
        expect(cutOff([dev('n2')], extra, taggedN2)).toEqual([dev('n2')]);
        expect(cutOff([dev('n2')], taggedN2, extra)).toEqual([dev('n2')]);
        // the same extra untagged network before and after: kept
        expect(cutOff([dev('n2')], extra, { ...extra, tagged: 'none' })).toEqual([]);
        expect(cutOff([dev('n3')], extra, { ...extra })).toEqual([]);
        // native before, a further untagged one after: its untagged traffic now lands on the new native network
        expect(cutOff([dev('n2')], iot, { native: { id: 'n1' }, untagged: [{ id: 'n2' }], tagged: 'none' })).toEqual([dev('n2')]);
        // a network that reached the port neither before nor after
        expect(cutOff([dev('n9')], iot, { ...iot })).toEqual([dev('n9')]);
    });
});

describe('setting the networks a port carries', () => {
    it('gives a free port its own networks, keeping its name and profile, and reads it back', async () => {
        const { writes, net, apply } = controller();

        const plan = await net.plan(assign(9, 'IoT'));
        expect(plan.steps).toEqual([{ action: 'update', object: 'omada.switchPort', name: 'switch-sw1 port 9', detail: 'untagged = Default, tagged = IoT, Engineering, Cameras → untagged = IoT, tagged = none' }]);
        expect(plan.effects).toEqual(["port 9 on 'switch-sw1' carries untagged = IoT, tagged = none; its other settings keep following profile 'All'."]);
        expect(plan.wouldLockOut).toEqual([]);

        const result = await apply(assign(9, 'iot'));

        expect(writes).toEqual([{ op: 'updateSwitchPort', args: [SW, 9, body(9, 'net-iot'), 'site-1'] }]);
        expect(result).toEqual({
            applied: true,
            object: { device: { mac: SW }, port: 9, name: 'Port9', profile: { id: 'p-all' }, networks: { native: { id: 'net-iot' }, tagged: 'none' }, customSettings: false, seen: [], uplink: false },
            owned: [],
        });
    });

    it('sends a tagged list once each, or all networks', async () => {
        const list = controller();
        await list.apply(assign(9, 'IoT', ['Engineering', 'engineering', 'net-cam']));
        expect(list.writes[0].args[2]).toEqual(body(9, 'net-iot', 2, ['net-lab', 'net-cam']));

        const empty = controller();
        await empty.apply({ op: 'assign', kind: 'port', port: { device: { name: 'switch-sw1' }, port: 9 }, networks: { native: { name: 'IoT' }, tagged: [] } });
        expect(empty.writes[0].args[2]).toEqual(body(9, 'net-iot', 1, [])); // an empty list is none

        const all = controller();
        const plan = await all.net.plan(assign(9, 'Engineering', 'all'));
        expect(plan.steps[0].detail).toBe('untagged = Default, tagged = IoT, Engineering, Cameras → untagged = Engineering, tagged = all networks');
        await all.net.apply(plan);
        expect(all.writes[0].args[2]).toEqual(body(9, 'net-lab', 0));
        expect((await all.net.listPorts()).find((p) => p.port === 9)?.networks).toEqual({ native: { id: 'net-lab' }, tagged: [{ id: 'net-default' }, { id: 'net-iot' }, { id: 'net-cam' }] });
    });

    it('needs allowLockout when online devices on the port would lose their network', async () => {
        const { writes, net, apply } = controller();

        const plan = await net.plan(assign(5, 'IoT'));
        expect(plan.wouldLockOut.map((c) => c.name)).toEqual(['plug']);
        expect(plan.effects[1]).toBe('Devices on it lose their network: plug.');
        expect(await code(net.apply(plan))).toBe('LOCKOUT');
        expect(writes).toEqual([]);

        await apply(assign(5, 'IoT'), true);
        expect(writes).toEqual([{ op: 'updateSwitchPort', args: [SW, 5, body(5, 'net-iot'), 'site-1'] }]);
    });

    it('refuses with CONFLICT, even with allowLockout, when another device joined the port after planning', async () => {
        const { state, writes, net } = controller();
        const plan = await net.plan(assign(5, 'IoT'));
        state.clients.push({ mac: '02:00:00:00:00:0b', name: 'printer', ip: '10.0.0.150', wireless: false, vid: 1, switchMac: SW, port: 5, active: true });

        expect(await code(net.apply(plan, { allowLockout: true }))).toBe('CONFLICT');
        expect(writes).toEqual([]);
    });

    it('keeps a device whose network the port still carries the same way, and cuts it off when that changes', async () => {
        const { net } = controller();

        // lab-vm on port 6 is on Engineering, which reaches it tagged
        expect((await net.plan(assign(6, 'IoT', ['Engineering']))).wouldLockOut).toEqual([]);
        expect((await net.plan(assign(6, 'Default', ['Engineering']))).wouldLockOut).toEqual([]);
        expect((await net.plan(assign(6, 'Engineering'))).wouldLockOut.map((c) => c.name)).toEqual(['lab-vm']);
        expect((await net.plan(assign(6, 'IoT'))).wouldLockOut.map((c) => c.name)).toEqual(['lab-vm']);
    });

    it('refuses uplinks, the controller\'s port and LAG ports (PROTECTED), and ports with their own settings, writing nothing', async () => {
        const { writes, net } = controller();

        expect(await message(net.plan(assign(1, 'IoT')))).toBe("port 1 on 'switch-sw1' can't be reassigned here: it links the switch to gateway 'gateway-gw1'");
        for (const p of [2, 3, 4, 7]) expect(await code(net.plan(assign(p, 'IoT')))).toBe('PROTECTED');
        expect(await message(net.plan(assign(8, 'IoT')))).toBe("port 8 on 'switch-sw1' has its own settings (profile override); change its networks in the controller web UI");
        expect(writes).toEqual([]);
    });

    it('refuses an unknown switch, port or network, no untagged network, one both untagged and tagged, further untagged ones, and no change', async () => {
        const { net } = controller();
        const raw = (networks: PortNetworks): Change => ({ op: 'assign', kind: 'port', port: { device: { name: 'switch-sw1' }, port: 9 }, networks });

        expect(await code(net.plan(assign(9, 'IoT', 'none', { name: 'switch-sw2' })))).toBe('NOT_FOUND');
        expect(await message(net.plan(assign(11, 'IoT')))).toBe("Switch 'switch-sw1' has no port 11 (ports 1, 2, 3, 4, 5, 6, 7, 8, 9)");
        expect(await code(net.plan(assign(9, 'Guests')))).toBe('NOT_FOUND');
        expect(await code(net.plan(assign(9, 'IoT', ['Guests'])))).toBe('NOT_FOUND');
        expect(await message(net.plan(raw({ tagged: 'all' })))).toBe("port 9 on 'switch-sw1' needs an untagged (native) network");
        expect(await message(net.plan(assign(9, 'IoT', ['Engineering', 'IoT'])))).toBe("'IoT' can't be both untagged and tagged on a port");
        expect(await message(net.plan(raw({ native: { name: 'IoT' }, untagged: [{ name: 'Cameras' }], tagged: 'none' })))).toBe('Further untagged networks besides the native one are not offered here');
        expect(await message(net.plan(assign(9, 'Default', 'all')))).toBe("port 9 on 'switch-sw1' already carries that (untagged = Default, tagged = all networks)");
        expect(await code(net.plan(assign(9, 'Default', ['Cameras', 'IoT', 'Engineering'])))).toBe('INVALID');
        expect(await code(net.plan(assign(9, 'Default', ['IoT'])))).toBe('ok');
    });

    it('treats a port whose networks can\'t be told as cutting off its devices (named by MAC when nameless)', async () => {
        const twice = (id: string, devices: Raw[]) => (id === 'net-iot' ? [...devices, devices[1]] : devices); // the switch listed twice
        const noPorts = (id: string, devices: Raw[]) => (id === 'net-iot' ? devices.map((d) => (d.type === 'switch' ? { ...d, switchInfo: {} } : d)) : devices);
        const notAList = (id: string, devices: Raw[]) => (id === 'net-iot' ? devices.map((d) => (d.type === 'switch' ? { ...d, switchInfo: { affectedPorts: 'all' } } : d)) : devices);
        const twoNative = (id: string, devices: Raw[]) =>
            id === 'net-iot' ? devices.map((d) => (d.type === 'switch' ? { ...d, switchInfo: { affectedPorts: { nativePorts: [], untagPorts: [], tagPorts: [], nativeLags: [], untagLags: [], tagLags: [], nativePorts: [5], untagPorts: [5] } } } : d)) : devices;
        const missingList = (id: string, devices: Raw[]) =>
            id === 'net-iot' ? devices.map((d) => (d.type === 'switch' ? { ...d, switchInfo: { affectedPorts: { nativePorts: [], untagPorts: [], tagPorts: [5] } } } : d)) : devices; // no LAG lists
        for (const hook of [twice, noPorts, notAList, twoNative, missingList]) {
            const { state, net } = controller();
            state.carryHook = hook;
            state.clients.push({ mac: '02:00:00:00:00:0a', ip: '10.0.0.77', wireless: false, vid: 1, switchMac: SW, port: 5, active: true });

            const plan = await net.plan(assign(5, 'Default', 'all'));

            expect(plan.steps[0].detail).toBe('unknown → untagged = Default, tagged = all networks');
            expect(plan.wouldLockOut.map((c) => c.name ?? c.mac)).toEqual(['plug', '02-00-00-00-00-0A']);
            expect(plan.effects[1]).toBe('Devices on it lose their network: plug, 02-00-00-00-00-0A.');
            expect((await net.listPorts()).find((p) => p.port === 5)?.networks).toBeUndefined();
        }
    });

    it('finds the switch in a network\'s list by MAC in any notation', async () => {
        const { state, net } = controller();
        state.carryHook = (_id, devices) => devices.map((d) => (d.type === 'switch' ? { ...d, mac: String(d.mac).toLowerCase().replace(/-/g, ':') } : d));

        expect((await net.listPorts()).find((p) => p.port === 9)?.networks).toEqual(DEFAULT_CARRIED);
    });

    it('counts a further untagged network the port carries now as something to change', async () => {
        const { state, net } = controller();
        // port 9 also carries Cameras untagged
        state.carryHook = (id, devices) =>
            id === 'net-cam' ? devices.map((d) => (d.type === 'switch' ? { ...d, switchInfo: { affectedPorts: { nativePorts: [], untagPorts: [], tagPorts: [], nativeLags: [], untagLags: [], tagLags: [], untagPorts: [9], tagPorts: [1, 2, 3, 4, 5, 6, 7, 8] } } } : d)) : devices;

        const plan = await net.plan(assign(9, 'Default', ['IoT', 'Engineering']));

        expect(plan.steps[0].detail).toBe('untagged = Default, Cameras, tagged = IoT, Engineering → untagged = Default, tagged = IoT, Engineering');
    });

    it('reads a switch a network doesn\'t list as carrying it on no port', async () => {
        const { state, net } = controller();
        state.carryHook = (id, devices) => (id === 'net-cam' ? devices.filter((d) => d.type !== 'switch') : devices);

        expect((await net.listPorts()).find((p) => p.port === 9)?.networks).toEqual({ native: { id: 'net-default' }, tagged: [{ id: 'net-iot' }, { id: 'net-lab' }] });
    });

    it('refuses to apply when the port, what the switch\'s ports carry or the uplinks changed after planning, writing nothing', async () => {
        for (const change of [
            (s: ReturnType<typeof controller>['state']) => (s.ports[SW][8] = { ...s.ports[SW][8], profileId: 'p-default' }),
            (s: ReturnType<typeof controller>['state']) => (s.vlans[SW][9] = { native: 'net-default', setting: 2, tags: ['net-iot'] }),
            (s: ReturnType<typeof controller>['state']) => (s.vlans[SW][4] = { native: 'net-lab', setting: 1, tags: [] }), // another port of the switch
            (s: ReturnType<typeof controller>['state']) => (s.topology = { ...s.topology, topologyNodes: [...(s.topology.topologyNodes as Raw[]), { type: 'ap', name: 'new-ap', mac: 'A8-00-00-00-00-09', wiredUpLink: { upLinkPort: { port: 8 } } }], topologyEdges: [...(s.topology.topologyEdges as Raw[]), { upLinkMac: SW, downLinkMac: 'A8-00-00-00-00-09' }] }),
        ]) {
            const { state, writes, net } = controller();
            const plan = await net.plan(assign(9, 'IoT'));
            change(state);
            expect(await code(net.apply(plan))).toBe('CONFLICT');
            expect(writes).toEqual([]);
        }
    });

    it('does not count the same topology, ports and port lists in another order, or other devices\' details, as a change', async () => {
        const { state, writes, net } = controller();
        const plan = await net.plan(assign(9, 'IoT'));
        state.topology = { topologyNodes: [...(state.topology.topologyNodes as Raw[])].reverse(), topologyEdges: [...(state.topology.topologyEdges as Raw[])].reverse() };
        state.ports[SW].reverse();
        state.carryHook = (_id, devices) =>
            devices
                .map((d) => {
                    const a = (d.switchInfo as Raw | undefined)?.affectedPorts as Record<string, number[]> | undefined;
                    if (!a) return { ...d, name: 'renamed' };
                    const reversed = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Array.isArray(v) ? [...v].reverse() : v]).reverse());
                    return { ...d, switchInfo: { affectedPorts: reversed, clients: [{ mac: 'x', port: 3 }] } };
                })
                .reverse();

        await net.apply(plan);

        expect(writes).toHaveLength(1);
    });

    it('does not count link changes and counters as a change of the port', async () => {
        const { state, writes, net } = controller();
        const plan = await net.plan(assign(9, 'IoT'));
        state.ports[SW] = state.ports[SW].map((p) => ({ ...p, status: 0, poeMode: 0 }));

        await net.apply(plan);

        expect(writes).toHaveLength(1);
    });

    it('reports a port that reads back carrying something else, and turns a lost read-back into a warning', async () => {
        const ignored = controller();
        ignored.state.onWrite = () => undefined; // accepted, not stored
        expect(await message(ignored.apply(assign(9, 'IoT')))).toBe(
            "The controller accepted the change, but port 9 on 'switch-sw1' carries untagged = Default, tagged = IoT, Engineering, Cameras; check it with net_listPorts."
        );

        const partly = controller();
        partly.state.onWrite = (_op, args) => {
            partly.state.vlans[SW][args[1] as number] = { native: 'net-iot', setting: 2, tags: ['net-lab'] }; // an extra tagged network
        };
        expect(await code(partly.apply(assign(9, 'IoT')))).toBe('CONFLICT');

        const unclear = controller();
        unclear.state.onWrite = () => {
            unclear.state.carryHook = (id, devices) => (id === 'net-iot' ? [...devices, devices[1]] : devices);
        };
        expect(await message(unclear.apply(assign(9, 'IoT')))).toBe("The controller accepted the change, but port 9 on 'switch-sw1' carries something that can't be told; check it with net_listPorts.");

        const lost = controller();
        lost.state.failRead = { op: 'listNetworkPorts', skip: 8 }; // plan and apply read the 4 networks' ports once each
        expect(await lost.apply(assign(9, 'IoT'))).toEqual({ applied: true, owned: [], warnings: ['The port is changed, but reading it back failed; check it with net_listPorts.'] });
        expect(lost.state.vlans[SW][9]).toEqual({ native: 'net-iot', setting: 1, tags: [] });
    });

    it('refuses creating or deleting port profiles', async () => {
        const { net } = controller();

        expect(await message(net.plan({ op: 'create', kind: 'portProfile', value: { name: 'x', networks: { native: { name: 'IoT' }, tagged: 'none' }, isolation: false } }))).toBe(
            "Omada can't do creating or deleting port profiles here (do it in the controller web UI) through its API"
        );
    });
});

describe('a dry run\'s basis covers the change itself', () => {
    it('differs for another port or other networks, also when the same devices are cut off', async () => {
        const { net } = controller();
        const basis = async (change: Change) => (await net.plan(change)).basis;

        expect(await basis(assign(5, 'IoT'))).not.toBe(await basis(assign(5, 'Engineering'))); // both cut off the plug
        expect(await basis(assign(9, 'IoT'))).not.toBe(await basis(assign(9, 'Engineering')));
        expect(await basis(assign(9, 'IoT'))).not.toBe(await basis(assign(9, 'IoT', ['Engineering'])));
        expect(await basis({ op: 'set', kind: 'mdnsRepeater', enabled: true, networks: [{ name: 'Default' }, { name: 'IoT' }] })).not.toBe(
            await basis({ op: 'set', kind: 'mdnsRepeater', enabled: true, networks: [{ name: 'Default' }, { name: 'Engineering' }] })
        );
        expect(await basis(assign(9, 'IoT'))).toBe(await basis(assign(9, 'IoT')));
    });

    it('refuses a plan carrying another change than the one planned, writing nothing', async () => {
        const { writes, net } = controller();
        const plan = await net.plan(assign(5, 'IoT'));

        expect(await code(net.apply({ ...plan, change: assign(5, 'Engineering') }, { allowLockout: true }))).toBe('CONFLICT');
        expect(writes).toEqual([]);
    });

    it('through the tool: a dry run\'s basis doesn\'t let another change through', async () => {
        const { writes, net } = controller();
        type Handler = (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
        const handlers = new Map<string, Handler>();
        registerNetTools({ registerTool: vi.fn((name: string, _c: unknown, h: Handler) => handlers.set(name, h)) } as unknown as McpServer, net);
        const call = (args: object) => handlers.get('net_assignPort')!(args, { sessionId: 's', http: { authInfo: { extra: { permissions: Permission.CONFIGURE } } } });

        const dry = JSON.parse((await call({ switch: 'switch-sw1', port: 5, network: 'IoT', dryRun: true })).content[0].text) as { basis: string; wouldLockOut: unknown[] };
        expect(dry.wouldLockOut).toHaveLength(1);

        const other = await call({ switch: 'switch-sw1', port: 5, network: 'Engineering', basis: dry.basis, allowLockout: true });
        expect(other.isError).toBe(true);
        expect(other.content[0].text).toContain('This is not the change the dry run was for');
        expect(writes).toEqual([]);

        expect((await call({ switch: 'switch-sw1', port: 5, network: 'IoT', basis: dry.basis, allowLockout: true })).isError).toBeFalsy();
        expect(writes).toEqual([{ op: 'updateSwitchPort', args: [SW, 5, body(5, 'net-iot'), 'site-1'] }]);
    });
});

describe('mDNS repeater', () => {
    it('reads the one gateway rule that repeats both ways', async () => {
        const { net } = controller();

        expect(await net.getMdnsRepeater()).toEqual({ enabled: true, networks: [{ id: 'net-default' }, { id: 'net-iot' }, { id: 'net-lab' }] });
        expect((await net.capabilities()).mdnsRepeater).toBe('native');
        expect((await net.capabilities()).ports).toEqual({ profiles: 'unsupported', assign: 'native' });
    });

    it('reports no rule as off, and access point rules, several rules or one-way rules as foreign', () => {
        expect(toMdns([])).toEqual({ repeater: { enabled: false, networks: [] }, networkIds: [] });
        expect(toMdns([{ type: 0, status: true }]).repeater).toEqual({ enabled: true, networks: [], foreign: { reason: 'The controller has access point mDNS rules (by VLAN id); they are managed in the controller web UI.' } });
        expect(toMdns([{ type: 1, status: false }, { type: 1, status: false }]).repeater.foreign?.reason).toBe('The controller has 2 gateway mDNS rules; the model has one repeater. Manage them in the controller web UI.');
        const oneWay = toMdns([{ type: 1, name: 'HA', status: true, osg: { serviceNetworks: ['a'], clientNetworks: ['a', 'b'] } }]);
        expect(oneWay.repeater.foreign?.reason).toBe("mDNS rule 'HA' repeats from some networks to others (one way); the model repeats between networks both ways.");
        expect(toMdns([{ type: 1, status: true, osg: { serviceNetworks: ['a', 'b'], clientNetworks: ['b', 'c'] } }]).repeater.foreign).toBeDefined();
        expect(toMdns([{ type: 1, status: true, osg: { serviceNetworks: ['b', 'a', 'a'], clientNetworks: ['a', 'b'] } }]).repeater).toEqual({ enabled: true, networks: [{ id: 'b' }, { id: 'a' }] });
        expect(toMdns([{ type: 1, status: false }]).repeater).toEqual({ enabled: false, networks: [] });
    });

    it('changes the networks, keeping the rule\'s name and services, and reads it back', async () => {
        const { writes, net, apply } = controller();

        const plan = await net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: true, networks: [{ name: 'Default' }, { name: 'iot' }, { name: 'IoT' }] });
        expect(plan.steps).toEqual([{ action: 'update', object: 'omada.mdnsRule', name: 'Repeater', detail: 'networks Default, IoT, Engineering → Default, IoT' }]);
        expect(plan.effects[0]).toContain('repeated between Default, IoT:');

        const result = await apply({ op: 'set', kind: 'mdnsRepeater', enabled: true, networks: [{ name: 'Default' }, { name: 'IoT' }] });

        expect(writes).toEqual([
            {
                op: 'updateMdnsRule',
                args: ['m1', { name: 'Repeater', status: true, profileIds: ['buildIn-1', 'buildIn-2', 'custom-9'], type: 1, osg: { serviceNetworks: ['net-default', 'net-iot'], clientNetworks: ['net-default', 'net-iot'] } }, 'site-1'],
            },
        ]);
        expect(result).toEqual({ applied: true, object: { enabled: true, networks: [{ id: 'net-default' }, { id: 'net-iot' }] }, owned: [] });
    });

    it('switches off keeping the networks, and on again', async () => {
        const { writes, net, apply } = controller();

        const off = await net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: false });
        expect(off.steps[0].detail).toBe('switched off');
        expect(off.effects).toEqual(['mDNS announcements are no longer repeated between networks; devices only discover services on their own network.']);
        await apply({ op: 'set', kind: 'mdnsRepeater', enabled: false });
        await apply({ op: 'set', kind: 'mdnsRepeater', enabled: true });

        expect(writes.map((w) => (w.args[1] as Raw).status)).toEqual([false, true]);
        expect(writes.every((w) => JSON.stringify((w.args[1] as Raw).osg) === JSON.stringify({ serviceNetworks: ALL_NETS, clientNetworks: ALL_NETS }))).toBe(true);
    });

    it('names a network the rule still lists after it was deleted by its id, and an empty rule as none', async () => {
        const gone = controller();
        gone.state.mdns[0] = { ...gone.state.mdns[0], osg: { serviceNetworks: ['net-default', 'net-old'], clientNetworks: ['net-old', 'net-default'] } };
        expect((await gone.net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: true, networks: [{ name: 'Default' }, { name: 'IoT' }] })).steps[0].detail).toBe('networks Default, net-old → Default, IoT');

        const empty = controller();
        empty.state.mdns[0] = { ...empty.state.mdns[0], status: false, osg: { serviceNetworks: [], clientNetworks: [] } };
        expect((await empty.net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: true, networks: [{ name: 'Default' }, { name: 'IoT' }] })).steps[0].detail).toBe('switched on; networks (none) → Default, IoT');
    });

    it('checks the networks the rule keeps: a deleted or switch-only one must be replaced, writing nothing', async () => {
        const gone = controller();
        gone.state.mdns[0] = { ...gone.state.mdns[0], status: false, osg: { serviceNetworks: ['net-default', 'net-old'], clientNetworks: ['net-default', 'net-old'] } };
        expect(await message(gone.net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: true }))).toBe("The mDNS rule repeats over a network that no longer exists (net-old); give the networks to repeat between");
        const cam = controller();
        cam.state.mdns[0] = { ...cam.state.mdns[0], status: false, osg: { serviceNetworks: ['net-default', 'net-cam'], clientNetworks: ['net-default', 'net-cam'] } };
        expect(await message(cam.net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: true }))).toBe("'Cameras' is switch-only; the gateway repeats mDNS only between routed networks");
        expect(gone.writes).toEqual([]);
        expect(cam.writes).toEqual([]);
    });

    it('refuses fewer than two networks when on, a switch-only network, an unknown one and no change', async () => {
        const { writes, net } = controller();

        expect(await message(net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: true, networks: [{ name: 'IoT' }] }))).toBe('The mDNS repeater needs at least two networks to repeat between');
        expect(await message(net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: true, networks: [{ name: 'IoT' }, { name: 'Cameras' }] }))).toBe(
            "'Cameras' is switch-only; the gateway repeats mDNS only between routed networks"
        );
        expect(await code(net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: true, networks: [{ name: 'IoT' }, { name: 'Guests' }] }))).toBe('NOT_FOUND');
        expect(await message(net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: true, networks: [{ name: 'Engineering' }, { name: 'IoT' }, { name: 'Default' }] }))).toBe('Nothing to change on the mDNS repeater');
        expect(await code(net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: false, networks: [{ name: 'IoT' }] }))).toBe('ok'); // off with one network is fine
        expect(writes).toEqual([]);
    });

    it('refuses when there is no rule yet or the setup is foreign', async () => {
        const none = controller();
        none.state.mdns = [];
        expect(await message(none.net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: true, networks: [{ name: 'IoT' }, { name: 'Default' }] }))).toContain('There is no mDNS rule yet');

        const ap = controller();
        ap.state.mdns.push({ id: 'm2', name: 'AP rule', status: true, type: 0, ap: { serviceVlan: '1', clientVlan: '2' } });
        expect(await code(ap.net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: false }))).toBe('UNSUPPORTED');
        expect(none.writes).toEqual([]);
        expect(ap.writes).toEqual([]);
    });

    it('does not count the same services and networks listed in another order as a change', async () => {
        const { state, writes, net } = controller();
        const plan = await net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: false });
        state.mdns[0] = { ...state.mdns[0], profileIds: [...(state.mdns[0].profileIds as string[])].reverse(), osg: { serviceNetworks: [...ALL_NETS].reverse(), clientNetworks: [ALL_NETS[1], ALL_NETS[0], ALL_NETS[2]] } };

        await net.apply(plan);

        expect(writes).toHaveLength(1);
    });

    it('refuses to apply when the rules changed after planning, writing nothing', async () => {
        const { state, writes, net } = controller();
        const plan = await net.plan({ op: 'set', kind: 'mdnsRepeater', enabled: false });
        state.mdns[0] = { ...state.mdns[0], profileIds: ['buildIn-1'] };

        expect(await code(net.apply(plan))).toBe('CONFLICT');
        expect(writes).toEqual([]);
    });

    it('reports a rule that reads back differently, and turns a lost read-back into a warning', async () => {
        const ignored = controller();
        ignored.state.onWrite = () => undefined;
        expect(await message(ignored.apply({ op: 'set', kind: 'mdnsRepeater', enabled: false }))).toBe('The controller accepted the mDNS change but shows something else now; check it with net_getMdnsRepeater.');

        const partly = controller();
        partly.state.onWrite = () => {
            partly.state.mdns[0] = { ...partly.state.mdns[0], osg: { serviceNetworks: ['net-default'], clientNetworks: ['net-default'] } };
        };
        expect(await code(partly.apply({ op: 'set', kind: 'mdnsRepeater', enabled: true, networks: [{ name: 'Default' }, { name: 'IoT' }] }))).toBe('CONFLICT');

        // The networks and status came back, but a service the rule repeated is gone.
        const services = controller();
        services.state.onWrite = (_op, args) => {
            const [id, body] = args as [string, Raw];
            services.state.mdns = services.state.mdns.map((r) => (r.id === id ? { id, ...body, profileIds: ['buildIn-1', 'buildIn-2'] } : r));
        };
        expect(await code(services.apply({ op: 'set', kind: 'mdnsRepeater', enabled: false }))).toBe('CONFLICT');
        // The same services in another order are the same.
        const reordered = controller();
        reordered.state.onWrite = (_op, args) => {
            const [id, body] = args as [string, Raw];
            reordered.state.mdns = reordered.state.mdns.map((r) => (r.id === id ? { id, ...body, profileIds: ['custom-9', 'buildIn-2', 'buildIn-1'] } : r));
        };
        expect(await code(reordered.apply({ op: 'set', kind: 'mdnsRepeater', enabled: false }))).toBe('ok');
        // Renamed, or another rule now: not the change that was asked for.
        const renamed = controller();
        renamed.state.onWrite = (_op, args) => {
            const [id, body] = args as [string, Raw];
            renamed.state.mdns = renamed.state.mdns.map((r) => (r.id === id ? { id: 'm9', ...body, name: 'Other' } : r));
        };
        expect(await code(renamed.apply({ op: 'set', kind: 'mdnsRepeater', enabled: false }))).toBe('CONFLICT');

        const lost = controller();
        lost.state.failRead = { op: 'listMdnsRules', skip: 2 };
        expect(await lost.apply({ op: 'set', kind: 'mdnsRepeater', enabled: false })).toEqual({
            applied: true,
            owned: [],
            warnings: ['The mDNS repeater is changed, but reading it back failed; check it with net_getMdnsRepeater.'],
        });
    });
});
