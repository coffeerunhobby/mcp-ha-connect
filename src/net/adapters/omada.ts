/**
 * Omada adapter for the vendor-neutral network model (src/net/model.ts).
 *
 * 2.4.5 covers networks (LAN networks / VLANs) and Wi-Fi (SSIDs); 2.4.7 rules (gateway
 * ACLs, see omadaRules.ts) and listing groups; 2.4.8 switch ports (the networks a port
 * carries), listing port profiles and the mDNS repeater (see omadaPorts.ts). Creating
 * port profiles, groups and reservations is refused with NetError UNSUPPORTED.
 *
 * Omada specifics handled here:
 * - networks have no "guest" purpose and no isolation flag in the API (guest is per
 *   SSID), so both are reported unsupported; IPv6 can be switched off but not on;
 * - WPA2/WPA3 mixed mode is not in the API (WPA, WPA2, WPA/WPA2 or WPA3 only);
 * - updating an SSID requires resending its password: the current one is read and sent
 *   back internally and never appears in a plan, step, error or log;
 * - Omada lists every SSID again under a pseudo WLAN group "gateway" without detail.
 */

import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';

import type { OmadaClient } from '../../omadaClient/index.js';
import { formatMac, normalizeMac } from '../../omadaClient/client.js';
import { ALWAYS_PROFILE_NAME } from '../../omadaClient/network.js';
import type { MacGroup } from '../../omadaClient/macGroups.js';
import type { RawRecord } from '../../omadaClient/networkConfig.js';
import { accessControlLockKey, serialize } from '../../omadaClient/serialize.js';
import { inSubnet, ipToNumber } from '../../utils/ipv4.js';
import { redactSecrets } from '../../utils/redact.js';
import {
    NetError,
    type ApplyResult,
    type Band,
    type Capabilities,
    type Change,
    type Client,
    type Group,
    type Firmware,
    type MdnsRepeater,
    type Network,
    type NetworkController,
    type PassphraseSource,
    type Plan,
    type Port,
    type PortNetworks,
    type PortProfile,
    type PortRef,
    type ProtectedResources,
    type Ref,
    type Reservation,
    type Rule,
    type Step,
    type Wifi,
    type WifiSecurity,
} from '../model.js';
import { MAX_NETWORK_NAME, MAX_WIFI_NAME, checkBands, checkDhcp, checkGateway, checkName, checkNetworkUnique, checkVlan } from '../validate.js';
import { checkReservationDelete, checkReservationSet } from '../reservations.js';

import {
    GROUP_TYPE,
    controllerPath,
    controllerRisk,
    draftAsAcl,
    draftRule,
    isOwnedGroup,
    newRuleKey,
    ownedGroupName,
    resolve,
    ruleKey,
    tagged,
    toRule,
    type Endpoint,
    type RuleDraft,
    type RuleFields,
    type RuleWorld,
} from './omadaRules.js';
import { MDNS_GATEWAY, TAGS, cutOff, describeNetworks, linkPorts, toMdns, toPortNetworks, toPortProfile } from './omadaPorts.js';

const PSEUDO_WLAN_ID = 'gateway';
/** Omada LAN network purpose: 0 = VLAN only (switches), 1 = interface (routed by the gateway). */
const PURPOSE_VLAN = 0;
const PURPOSE_INTERFACE = 1;
const BAND_BITS: Record<Band, number> = { '2.4': 1, '5': 2, '6': 4 };
/** Listing order (Object.keys would put '5' and '6' before '2.4'). */
const BANDS: Band[] = ['2.4', '5', '6'];
const PMF = { required: 1, optional: 2, off: 3 } as const;
/** WPA-Personal versions (pskSetting.versionPsk); 3 = WPA/WPA2 is not offered by the model. */
const PSK_VERSION = { wpa2: 2, wpa3: 4 } as const;
const SECURITY_NONE = 0;
const SECURITY_WPA_PERSONAL = 3;
const ENCRYPTION_AES = 3;
/** Writable fields of a LAN network (v2 create/modify body). */
const NETWORK_FIELDS = [
    'name', 'purpose', 'interfaceIds', 'vlanType', 'vlans', 'vlan', 'application', 'gatewaySubnet', 'dhcpSettingsVO', 'domain',
    'igmpSnoopEnable', 'mldSnoopEnable', 'dhcpL2RelayEnable', 'dhcpGuard', 'dhcpv6Guard', 'lanNetworkIpv6Config', 'allLan', 'qosQueueEnable', 'queueId',
];
const DHCP_FIELDS = ['enable', 'ipRangePool', 'dhcpns', 'priDns', 'sndDns', 'leasetime', 'gateway', 'dhcpNextServer', 'options'];
/** Writable fields of an SSID's basic config (update-basic-config body). */
const SSID_FIELDS = [
    'name', 'band', 'guestNetEnable', 'security', 'oweEnable', 'broadcast', 'vlanEnable', 'vlanId', 'pskSetting', 'mloEnable', 'pmfMode',
    'enable11r', 'hidePwd', 'greEnable', 'vlanSetting', 'prohibitWifiShare',
];

interface SsidRaw {
    wlanId: string;
    ssidId: string;
    detail: RawRecord;
}

interface Snapshot {
    siteId: string;
    networksRaw: RawRecord[];
    networks: Network[];
    ssids: SsidRaw[];
    clients: Client[];
    macGroups: MacGroup[];
    /** Gateway ACLs in evaluation order, and the IP / IP-port groups rules use. */
    acls: RawRecord[];
    /** Switch and access point ACLs: they can reference the same groups. */
    otherAcls: RawRecord[];
    ipGroups: RawRecord[];
    ipPortGroups: RawRecord[];
    /** The 24/7 time range omada_setSsidEnabled switches SSIDs off with (absent until first used). */
    alwaysProfileId?: string;
}

/**
 * A switch with its ports, the ports that link it to other network devices (undefined: unknown)
 * and which of its ports carry each network (network id -> affectedPorts).
 */
interface SwitchRaw {
    mac: string;
    name: string;
    ports: RawRecord[];
    links?: Map<number, string>;
    /** Undefined when the controller's lists contradict each other: what its ports carry is unknown. */
    affected?: Map<string, RawRecord>;
}

/** For each network, the devices whose ports carry it (getGridVlanNetworkAffectedDevicePorts). */
type Carrying = Array<{ id: string; devices: RawRecord[] }>;

/** Lists a switch's entry under a network has (live, 6.3.0.45: always all six). */
const AFFECTED_LISTS = ['nativePorts', 'untagPorts', 'tagPorts', 'nativeLags', 'untagLags', 'tagLags'];

/** A switch's `affectedPorts` with every list in place, or undefined: then which of its ports carry the network can't be told. */
function affectedPortsOf(device: RawRecord): RawRecord | undefined {
    const affected = (device.switchInfo as RawRecord | undefined)?.affectedPorts as RawRecord | undefined;
    return affected && AFFECTED_LISTS.every((k) => Array.isArray(affected[k])) ? affected : undefined;
}

/**
 * Which ports of one switch carry each network (a network that doesn't list the switch reaches
 * none of them); undefined when a network lists the switch twice or without all its lists.
 */
function affectedOf(carrying: Carrying, mac: string): Map<string, RawRecord> | undefined {
    const out = new Map<string, RawRecord>();
    for (const { id, devices } of carrying) {
        const entries = devices.filter((d) => typeof d.mac === 'string' && normalizeMac(d.mac) === normalizeMac(mac));
        if (entries.length > 1) return undefined;
        if (!entries.length) {
            out.set(id, {});
            continue;
        }
        const affected = affectedPortsOf(entries[0]);
        if (!affected) return undefined;
        out.set(id, affected);
    }
    return out;
}

/** What port changes read on top of the snapshot. */
interface PortWorld {
    switches: SwitchRaw[];
}

/** Port fields a port change depends on (link state and counters change all the time and are left out). */
const PORT_FIELDS = ['port', 'name', 'profileId', 'profileOverrideEnable', 'lagPort'];

/** What plan() hands to apply(): the steps as closures (never serialized, never returned). */
type Executor = (snapshot: Snapshot) => Promise<ApplyResult>;

const pick = (raw: RawRecord, fields: string[]): RawRecord =>
    Object.fromEntries(fields.filter((f) => raw[f] !== undefined).map((f) => [f, raw[f]]));

export interface OmadaAdapterOptions {
    siteId?: string;
    /** The controller's host name or address (host of OMADA_BASE_URL): its network is protected. */
    controllerHost?: string;
    /** Where this server runs (MCP_SERVER_ADDRESSES): the switch port it is on is never reassigned. */
    serverHosts?: string[];
    /** Resolves a host name to IPv4 addresses (default: the system resolver). */
    resolveHost?: (host: string) => Promise<string[]>;
}

export class OmadaNetworkController implements NetworkController {
    readonly vendor = 'omada' as const;
    readonly id: string;
    private readonly executors = new WeakMap<Plan, Executor>();
    /** The controller's IPv4 addresses; 'unknown' when its host name can't be resolved (then every routed network is protected). */
    private controllerAddresses: number[] | 'unknown' = [];
    /** This server's IPv4 addresses; 'unset' when not configured, 'unknown' when one can't be resolved. */
    private serverAddresses: number[] | 'unknown' | 'unset' = 'unset';
    /**
     * The controller's and this server's addresses together: their networks are protected and rules
     * must not cut them off the internet. 'unknown' when either can't be resolved (then every routed
     * network is protected); this server's are left out while not configured.
     */
    private hostAddresses: number[] | 'unknown' = [];

    constructor(
        private readonly client: OmadaClient,
        private readonly options: OmadaAdapterOptions = {}
    ) {
        this.id = `omada:${options.siteId ?? 'default'}`;
    }

    async capabilities(): Promise<Capabilities> {
        return {
            vendor: 'omada',
            networks: { create: 'native', isolation: 'unsupported', ipv6: 'unsupported', guestPurpose: 'unsupported' },
            wifi: { create: 'native', bands: ['2.4', '5', '6'], security: ['open', 'wpa2', 'wpa3'], pmf: 'native', fastRoaming: 'native', bandSteering: 'unsupported' },
            // Port profiles are listed and assigned; they are created in the controller web UI.
            ports: { profiles: 'unsupported', assign: 'native' },
            rules: { between: 'native', toInternet: 'native', deviceMatch: 'unsupported', wifiMatch: 'unsupported', stateful: 'native', schedule: 'unsupported' },
            groups: { address: 'unsupported', mac: 'unsupported' },
            reservations: 'native',
            mdnsRepeater: 'native',
            firmware: 'unsupported',
        };
    }

    // ---- reads -----------------------------------------------------------------------

    private async resolveController(): Promise<void> {
        const host = this.options.controllerHost;
        this.controllerAddresses = host ? await this.addressesOf([host]) : [];
        const server = this.options.serverHosts ?? [];
        this.serverAddresses = server.length ? await this.addressesOf(server) : 'unset';
        const both = [this.controllerAddresses, this.serverAddresses === 'unset' ? [] : this.serverAddresses];
        this.hostAddresses = both.some((a) => a === 'unknown') ? 'unknown' : both.flatMap((a) => a as number[]);
    }

    /** IPv4 addresses of hosts given by address or name; 'unknown' if any can't be resolved. */
    private async addressesOf(hosts: string[]): Promise<number[] | 'unknown'> {
        const all: number[] = [];
        for (const host of hosts) {
            try {
                all.push(ipToNumber(host));
                continue;
            } catch {
                // a host name
            }
            try {
                const resolve = this.options.resolveHost ?? (async (name: string) => (await lookup(name, { all: true, family: 4 })).map((a) => a.address));
                const addresses = await resolve(host);
                if (!addresses.length) return 'unknown';
                all.push(...addresses.map(ipToNumber));
            } catch {
                return 'unknown';
            }
        }
        return all;
    }

    private async snapshot(): Promise<Snapshot> {
        await this.resolveController();
        const siteId = this.client.resolveSiteId(this.options.siteId);
        const networksRaw = await this.client.networkConfig.listLanNetworks(siteId);
        const networks = networksRaw.map((raw) => this.toNetwork(raw));
        const ssids: SsidRaw[] = [];
        const seen = new Set<string>();
        for (const wlan of await this.client.networkConfig.listSsidSummaries(siteId)) {
            if (wlan.wlanId === PSEUDO_WLAN_ID) continue;
            for (const s of wlan.ssidList ?? []) {
                if (seen.has(s.ssidId)) continue;
                seen.add(s.ssidId);
                ssids.push({ wlanId: wlan.wlanId, ssidId: s.ssidId, detail: await this.client.networkConfig.getSsidDetail(wlan.wlanId, s.ssidId, siteId) });
            }
        }
        const clients = (await this.client.listClients(siteId)).map((c) => this.toClient(c as RawRecord, networks, ssids));
        const alwaysProfileId = (await this.client.accessControl.listTimeRanges(siteId)).find((p) => p.name === ALWAYS_PROFILE_NAME)?.profileId;
        const macGroups = await this.client.listMacGroups(siteId);
        const acls = (await this.client.networkConfig.listAcls('osg-acls', siteId)).sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
        const otherAcls = [...(await this.client.networkConfig.listAcls('osw-acls', siteId)), ...(await this.client.networkConfig.listAcls('eap-acls', siteId))];
        const ipGroups = await this.client.networkConfig.listGroups(GROUP_TYPE.ip, siteId);
        const ipPortGroups = await this.client.networkConfig.listGroups(GROUP_TYPE.ipPort, siteId);
        return { siteId, networksRaw, networks, ssids, clients, macGroups, acls, otherAcls, ipGroups, ipPortGroups, ...(alwaysProfileId ? { alwaysProfileId } : {}) };
    }

    private toNetwork(raw: RawRecord): Network {
        const dhcp = (raw.dhcpSettingsVO ?? {}) as RawRecord;
        const pool = ((dhcp.ipRangePool as RawRecord[] | undefined) ?? [])[0];
        const purpose = raw.purpose === PURPOSE_VLAN ? 'vlanOnly' : 'normal';
        const gateway = typeof raw.gatewaySubnet === 'string' ? raw.gatewaySubnet : undefined;
        return {
            id: String(raw.id),
            name: String(raw.name),
            purpose,
            vlan: Number(raw.vlan ?? 1),
            ...(gateway ? { gateway } : {}),
            ...(purpose === 'normal'
                ? {
                      dhcp: {
                          enabled: dhcp.enable === true,
                          ...(pool ? { range: { from: String(pool.ipaddrStart), to: String(pool.ipaddrEnd) } } : {}),
                          ...(typeof dhcp.leasetime === 'number' ? { leaseMinutes: dhcp.leasetime } : {}),
                          ...(dhcp.dhcpns === 'manual' ? { dns: [dhcp.priDns, dhcp.sndDns].filter((d): d is string => typeof d === 'string' && d !== '') } : {}),
                      },
                  }
                : {}),
            ipv6: (raw.lanNetworkIpv6Config as RawRecord | undefined)?.enable === 1,
            isolated: false,
            protected: this.isProtected(raw),
        };
    }

    private isProtected(raw: RawRecord): boolean {
        if (raw.primary === true) return true;
        if (typeof raw.gatewaySubnet !== 'string') return false;
        // Fail closed: if the controller's or this server's address is unknown, any routed network could be its own.
        if (this.hostAddresses === 'unknown') return true;
        const subnet = raw.gatewaySubnet;
        return this.hostAddresses.some((address) => inSubnet(address, subnet));
    }

    private toClient(raw: RawRecord, networks: Network[], ssids: SsidRaw[]): Client {
        // A device still waiting for DHCP reports no (or an empty) address.
        const ip = typeof raw.ip === 'string' && isIpv4(raw.ip) ? raw.ip : undefined;
        const ssid = typeof raw.ssid === 'string' && raw.ssid ? raw.ssid : undefined;
        let network: Network | undefined;
        // Wireless clients report vid 0 (the field is for wired ones; no network has VLAN 0).
        if (typeof raw.vid === 'number' && raw.wireless !== true) network = networks.find((n) => n.vlan === raw.vid);
        if (!network && ip) network = networks.find((n) => n.gateway && inSubnet(ipToNumber(ip), n.gateway));
        if (!network && ssid) {
            // No address yet: the network its Wi-Fi puts it on, when that is a single one.
            const found = ssids.filter((s) => s.detail.name === ssid);
            const ids = found.length === 1 ? this.ssidNetworkIds(found[0].detail, networks) : [];
            if (ids.length === 1) network = networks.find((n) => n.id === ids[0]);
        }
        const port = Number(raw.port);
        return {
            mac: formatMac(String(raw.mac)),
            ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
            ...(ip ? { ip } : {}),
            ...(network ? { network: { id: network.id } } : {}),
            ...(ssid ? { wifi: { name: ssid } } : {}),
            ...(raw.wireless !== true && typeof raw.switchMac === 'string' && Number.isInteger(port) && port > 0 ? { port: { device: { mac: formatMac(raw.switchMac) }, port } } : {}),
            online: raw.active !== false,
        };
    }

    private toWifi(ssid: SsidRaw, networks: Network[], macGroups: Array<{ groupId: string; name: string }>, alwaysProfileId?: string): Wifi {
        const d = ssid.detail;
        const psk = (d.pskSetting ?? {}) as RawRecord;
        const security = securityOf(d, psk);
        const band = Number(d.band ?? 0);
        const filter = (d.macFilter ?? {}) as RawRecord;
        const group = macGroups.find((g) => g.groupId === filter.macFilterId);
        return {
            id: ssid.ssidId,
            name: String(d.name),
            network: { id: this.ssidNetwork(d, networks)?.id ?? '' },
            bands: BANDS.filter((b) => (band & BAND_BITS[b]) !== 0),
            security,
            pmf: d.pmfMode === PMF.required ? 'required' : d.pmfMode === PMF.off ? 'off' : 'optional',
            clientIsolation: d.guestNetEnable === true,
            hidden: d.broadcast === false,
            fastRoaming: d.enable11r === true,
            macFilter: filter.macFilterEnable ? { policy: filter.policy === 1 ? 'allow' : 'deny', group: group ? { id: group.groupId } : { id: String(filter.macFilterId) } } : null,
            // Omada has no on/off flag: omada_setSsidEnabled switches an SSID off with a radio-off WLAN schedule on the 24/7 profile.
            enabled: d.ssidEnable !== false && !radioOffAlways(d, alwaysProfileId),
        };
    }

    /** The network an SSID puts its clients on: its custom VLAN mapping, else the untagged primary network. */
    private ssidNetwork(detail: RawRecord, networks: Network[]): Network | undefined {
        const setting = (detail.vlanSetting ?? {}) as RawRecord;
        const mapped = (setting.customConfig as RawRecord | undefined)?.lanNetworkVlanIds as Record<string, unknown> | undefined;
        if (setting.mode === 1 && mapped) {
            const id = Object.keys(mapped)[0];
            const found = networks.find((n) => n.id === id);
            if (found) return found;
        }
        if (detail.vlanEnable === true && typeof detail.vlanId === 'number') return networks.find((n) => n.vlan === detail.vlanId);
        return networks.find((n) => n.vlan === 1) ?? networks.find((n) => n.protected);
    }

    /** Every network an SSID puts devices on (Omada can map one SSID to several). */
    private ssidNetworkIds(detail: RawRecord, networks: Network[]): string[] {
        const setting = (detail.vlanSetting ?? {}) as RawRecord;
        const mapped = (setting.customConfig as RawRecord | undefined)?.lanNetworkVlanIds as Record<string, unknown> | undefined;
        const ids = setting.mode === 1 && mapped ? Object.keys(mapped) : [];
        const single = this.ssidNetwork(detail, networks)?.id;
        return [...new Set([...ids, ...(single ? [single] : [])])];
    }

    async protectedResources(): Promise<ProtectedResources> {
        const networks = (await this.snapshot()).networks.filter((n) => n.protected);
        return { networks: networks.map((n) => ({ id: n.id })), ports: [], devices: [] };
    }

    async listNetworks(): Promise<Network[]> {
        return (await this.snapshot()).networks;
    }

    async listWifi(): Promise<Wifi[]> {
        const snap = await this.snapshot();
        const groups = snap.macGroups;
        return snap.ssids.map((s) => this.toWifi(s, snap.networks, groups, snap.alwaysProfileId));
    }

    async listClients(): Promise<Client[]> {
        return (await this.snapshot()).clients;
    }

    async listReservations(): Promise<Reservation[]> {
        return toReservations(await this.client.accessControl.listDhcpReservations(this.options.siteId));
    }

    async listPortProfiles(): Promise<PortProfile[]> {
        return (await this.client.networkConfig.listPortProfiles(this.options.siteId)).map(toPortProfile);
    }

    async listPorts(device?: PortRef['device']): Promise<Port[]> {
        const snap = await this.snapshot();
        const world = await this.portWorld(snap);
        const switches = device ? [this.resolveSwitch(world, device)] : world.switches;
        return switches.flatMap((sw) => sw.ports.map((p) => this.toPort(sw, p, snap)));
    }
    async listRules(): Promise<Rule[]> {
        const snap = await this.snapshot();
        const world = this.ruleWorld(snap);
        return snap.acls.map((raw, i) => toRule(raw, i + 1, world));
    }

    async listGroups(kind?: Group['kind']): Promise<Group[]> {
        const snap = await this.snapshot();
        const address: Group[] = snap.ipGroups.map((g) => ({
            id: String(g.groupId),
            name: String(g.name),
            kind: 'address',
            entries: ((g.ipList as Array<{ ip: string; mask: number; description?: string }> | undefined) ?? []).map((e) => ({
                value: Number(e.mask) === 32 ? e.ip : `${e.ip}/${e.mask}`,
                ...(e.description ? { name: e.description } : {}),
            })),
        }));
        const mac: Group[] = snap.macGroups.map((g) => ({
            id: g.groupId,
            name: g.name,
            kind: 'mac',
            entries: (g.macAddressList ?? []).map((e) => ({ value: formatMac(e.macAddress), ...(e.name ? { name: e.name } : {}) })),
        }));
        return kind === 'address' ? address : kind === 'mac' ? mac : [...address, ...mac];
    }
    /** The running firmware of every adopted device; whether a newer one exists isn't read here (the controller has to check first). */
    async listFirmware(): Promise<Firmware[]> {
        const devices = await this.client.listDevices(this.client.resolveSiteId(this.options.siteId));
        return devices.map((d) => {
            const raw = d as unknown as RawRecord;
            return {
                device: { mac: formatMac(String(raw.mac)) },
                ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
                ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
                current: String(raw.firmwareVersion ?? 'unknown'),
                upgradable: false,
            };
        });
    }

    async getMdnsRepeater(): Promise<MdnsRepeater> {
        return toMdns(await this.client.networkConfig.listMdnsRules(this.options.siteId)).repeater;
    }

    // ---- switch ports and the mDNS repeater (mapping in omadaPorts.ts) ------------------------

    private async portWorld(snap: Snapshot): Promise<PortWorld> {
        const adopted = await this.client.listDevices(snap.siteId);
        const devices = adopted.filter((d) => d.type === 'switch');
        if (!devices.length) return { switches: [] };
        let topology: RawRecord | undefined;
        try {
            topology = await this.client.networkConfig.getTopology(snap.siteId);
        } catch {
            // Unknown topology: every port is protected (linkPorts undefined), listing still works.
        }
        const carrying = await this.carrying(snap.networks, snap.siteId);
        const switches: SwitchRaw[] = [];
        for (const d of devices) {
            const mac = String(d.mac);
            const detail = await this.client.networkConfig.getSwitch(mac, snap.siteId);
            const ports = (detail.portList as RawRecord[] | undefined) ?? [];
            let links = topology ? linkPorts(topology, mac, adopted.map((a) => String(a.mac))) : undefined;
            // A link on a port the switch doesn't have: the topology is stale, so the real port is unknown.
            if (links && [...links.keys()].some((n) => !ports.some((p) => Number(p.port) === n))) links = undefined;
            const affected = affectedOf(carrying, mac);
            switches.push({ mac, name: String(d.name ?? mac), ports, ...(links ? { links } : {}), ...(affected ? { affected } : {}) });
        }
        return { switches };
    }

    /** For each network, the devices whose ports carry it. */
    private async carrying(networks: Network[], siteId: string): Promise<Carrying> {
        const out: Carrying = [];
        for (const n of networks) out.push({ id: n.id, devices: await this.client.networkConfig.listNetworkPorts(n.id, n.vlan, siteId) });
        return out;
    }

    /** A switch by name, or by MAC (as { mac } or as its id). */
    private resolveSwitch(world: PortWorld, device: PortRef['device']): SwitchRaw {
        if ('name' in device) return resolve(world.switches.map((s) => ({ ...s, id: s.mac })), device, 'switch');
        const wanted = 'mac' in device ? device.mac : device.id;
        const found = normalizeMac(wanted) === '' ? undefined : world.switches.find((s) => normalizeMac(s.mac) === normalizeMac(wanted));
        if (!found) throw new NetError('NOT_FOUND', `No switch with MAC '${wanted}'. Switches: ${world.switches.map((s) => `${s.name} (${s.mac})`).join(', ') || '(none)'}`);
        return found;
    }

    /**
     * Why a port can't be reassigned, or undefined. Never: an uplink, the port the controller
     * or this server is on (allowLockout doesn't change that). When where they are can't be
     * told (address unknown or not configured, or inside the site but not seen on it), ports
     * with online devices are left alone; empty ports can still be assigned.
     */
    private portProtection(sw: SwitchRaw, raw: RawRecord, seen: Client[], clients: Client[], networks: Network[]): string | undefined {
        if (!sw.links) return `the controller's topology doesn't show which port links switch '${sw.name}' to the network`;
        const link = sw.links.get(Number(raw.port));
        if (link) return link;
        if (raw.lagPort === true) return 'it is part of a link aggregation (LAG); change it in the controller web UI';
        const hosts = [
            { who: 'the controller', addresses: this.controllerAddresses },
            { who: 'this server', addresses: this.serverAddresses },
        ];
        const on = (c: Client, addresses: number[]) => c.ip !== undefined && addresses.includes(ipToNumber(c.ip));
        for (const { who, addresses } of hosts) {
            if (Array.isArray(addresses) && seen.some((c) => on(c, addresses))) return `${who} is on it`;
        }
        if (seen.length === 0) return undefined;
        for (const { who, addresses } of hosts) {
            if (addresses === 'unset') return `${who}'s address isn't configured (MCP_SERVER_ADDRESSES), so its port can't be told; ports with devices on them are left alone`;
            if (addresses === 'unknown') return `${who}'s address can't be resolved, so its port can't be told; ports with devices on them are left alone`;
            const inSite = (a: number) => networks.some((n) => n.gateway && inSubnet(a, n.gateway));
            // Located only when seen on a switch port: on Wi-Fi or straight on the gateway, what it hangs off can't be told.
            if (addresses.some((a) => inSite(a) && !clients.some((c) => c.port !== undefined && on(c, [a])))) {
                return `${who} isn't seen on a switch port, so its port can't be told; ports with devices on them are left alone`;
            }
        }
        return undefined;
    }

    private toPort(sw: SwitchRaw, raw: RawRecord, snap: Pick<Snapshot, 'clients' | 'networks'>): Port {
        const port = Number(raw.port);
        const seen = snap.clients.filter((c) => c.online && c.port && 'mac' in c.port.device && normalizeMac(c.port.device.mac) === normalizeMac(sw.mac) && c.port.port === port);
        const protection = this.portProtection(sw, raw, seen, snap.clients, snap.networks);
        const networks = sw.affected ? toPortNetworks(sw.affected, port) : undefined;
        return {
            device: { mac: formatMac(sw.mac) },
            port,
            ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
            ...(typeof raw.profileId === 'string' ? { profile: { id: raw.profileId } } : {}),
            ...(networks ? { networks } : {}),
            customSettings: raw.profileOverrideEnable === true,
            seen,
            uplink: sw.links?.has(port) === true,
            ...(protection ? { protected: protection } : {}),
        };
    }

    /**
     * Gives a port its own networks (untagged + tagged); its other settings keep following its
     * profile. What it carries before and after comes from each network's list of ports.
     */
    private async buildPortAssign(target: PortRef, wanted: PortNetworks, snap: Snapshot): Promise<Built> {
        const world = await this.portWorld(snap);
        const sw = this.resolveSwitch(world, target.device);
        const raw = sw.ports.find((p) => Number(p.port) === target.port);
        if (!raw) throw new NetError('NOT_FOUND', `Switch '${sw.name}' has no port ${target.port} (ports ${sw.ports.map((p) => p.port).join(', ')})`);
        const where = `port ${target.port} on '${sw.name}'`;
        const port = this.toPort(sw, raw, snap);
        if (port.protected) throw new NetError('PROTECTED', `${where} can't be reassigned here: ${port.protected}`);
        if (port.customSettings) {
            throw new NetError('UNSUPPORTED', `${where} has its own settings (profile override); change its networks in the controller web UI`, { capability: 'ports.assign' });
        }
        if (wanted.untagged?.length) throw new NetError('UNSUPPORTED', 'Further untagged networks besides the native one are not offered here', { capability: 'ports.assign' });
        if (!wanted.native) throw new NetError('INVALID', `${where} needs an untagged (native) network`);
        const native = resolve(snap.networks, wanted.native, 'network');
        const tagged = Array.isArray(wanted.tagged) ? [...new Set(wanted.tagged.map((r) => resolve(snap.networks, r, 'network')))] : wanted.tagged;
        if (Array.isArray(tagged) && tagged.includes(native)) throw new NetError('INVALID', `'${native.name}' can't be both untagged and tagged on a port`);
        const goal: PortNetworks = { native: { id: native.id }, tagged: Array.isArray(tagged) ? (tagged.length ? tagged.map((n) => ({ id: n.id })) : 'none') : tagged };
        // What it carries now, as each network lists it ("all tagged" is every network but the native one).
        const flat = (c: PortNetworks) => {
            const nativeId = c.native && 'id' in c.native ? c.native.id : undefined;
            const list = (refs: Ref[]) => refs.map((r) => ('id' in r ? r.id : r.name)).sort();
            const taggedIds = c.tagged === 'all' ? snap.networks.map((n) => n.id).filter((id) => id !== nativeId) : c.tagged === 'none' ? [] : c.tagged.map((r) => ('id' in r ? r.id : r.name));
            return JSON.stringify([nativeId, list(c.untagged ?? []), [...taggedIds].sort()]);
        };
        if (port.networks && flat(port.networks) === flat(goal)) throw new NetError('INVALID', `${where} already carries that (${describeNetworks(goal, snap.networks)})`);
        const affected = cutOff(port.seen, port.networks, goal);
        const body: RawRecord = {
            // Both required by the controller; unchanged.
            name: raw.name,
            profileId: raw.profileId,
            profileOverrideEnable: false,
            profileVlanOverrideEnable: true,
            nativeNetworkId: native.id,
            networkTagsSetting: goal.tagged === 'all' ? TAGS.all : goal.tagged === 'none' ? TAGS.none : TAGS.custom,
            tagNetworkIds: Array.isArray(goal.tagged) ? goal.tagged.map((r) => ('id' in r ? r.id : r.name)) : [],
            untagNetworkIds: [],
        };
        const now = port.networks ? describeNetworks(port.networks, snap.networks) : 'unknown';
        return {
            steps: [{ action: 'update', object: 'omada.switchPort', name: `${sw.name} port ${target.port}`, detail: `${now} → ${describeNetworks(goal, snap.networks)}` }],
            effects: [
                `${where} carries ${describeNetworks(goal, snap.networks)}; its other settings keep following profile '${String(raw.profileName ?? raw.profileId ?? 'unknown')}'.`,
                ...(affected.length ? [`Devices on it lose their network: ${affected.map((c) => c.name ?? c.mac).join(', ')}.`] : []),
            ],
            wouldLockOut: affected,
            reads: { networks: true },
            // Known here: a switch without known links has every port protected (refused above).
            // In a fixed order: the same state listed differently by the controller is no change.
            extra: {
                switch: sw.mac,
                ports: sw.ports.map((p) => pick(p, PORT_FIELDS)).sort((a, b) => Number(a.port) - Number(b.port)),
                links: [...sw.links!].sort((a, b) => a[0] - b[0]),
                // In the order of the networks, which the fingerprint already covers as listed.
                carried: sw.affected ? [...sw.affected].map(([id, a]) => [id, canonical(a)]) : null,
            },
            execute: async (s) => {
                await this.client.networkConfig.updateSwitchPort(sw.mac, target.port, body, s.siteId);
                let after: Map<string, RawRecord> | undefined;
                try {
                    after = affectedOf(await this.carrying(s.networks, s.siteId), sw.mac);
                } catch {
                    return { applied: true, owned: [], warnings: ['The port is changed, but reading it back failed; check it with net_listPorts.'] };
                }
                const carried = after ? toPortNetworks(after, target.port) : undefined;
                if (!carried || flat(carried) !== flat(goal)) {
                    const shown = carried ? describeNetworks(carried, s.networks) : 'something that can\'t be told';
                    throw new NetError('CONFLICT', `The controller accepted the change, but ${where} carries ${shown}; check it with net_listPorts.`);
                }
                return { applied: true, object: this.toPort({ ...sw, affected: after! }, raw, s), owned: [] };
            },
        };
    }

    private async buildMdnsSet(enabled: boolean, refs: Ref[] | undefined, snap: Snapshot): Promise<Built> {
        const rulesRaw = await this.client.networkConfig.listMdnsRules(snap.siteId);
        const { repeater, rule, networkIds: currentIds } = toMdns(rulesRaw);
        if (repeater.foreign) throw new NetError('UNSUPPORTED', repeater.foreign.reason, { capability: 'mdnsRepeater' });
        if (!rule) {
            throw new NetError('UNSUPPORTED', 'There is no mDNS rule yet: create one in the controller web UI (Settings > Services > mDNS, type Gateway, with the services to repeat); after that it can be changed here.', {
                capability: 'mdnsRepeater',
            });
        }
        // The networks given, or the ones the rule keeps: each must exist and be routed.
        const chosen = refs
            ? [...new Set(refs.map((r) => resolve(snap.networks, r, 'network')))]
            : currentIds.map((id) => {
                  const found = snap.networks.find((n) => n.id === id);
                  if (!found) throw new NetError('INVALID', `The mDNS rule repeats over a network that no longer exists (${id}); give the networks to repeat between`);
                  return found;
              });
        const ids = chosen.map((n) => {
            if (n.purpose !== 'normal') throw new NetError('INVALID', `'${n.name}' is switch-only; the gateway repeats mDNS only between routed networks`);
            return n.id;
        });
        if (enabled && ids.length < 2) throw new NetError('INVALID', 'The mDNS repeater needs at least two networks to repeat between');
        const same = ids.length === currentIds.length && ids.every((id) => currentIds.includes(id));
        if (same && enabled === repeater.enabled) throw new NetError('INVALID', 'Nothing to change on the mDNS repeater');
        const name = (id: string) => snap.networks.find((n) => n.id === id)?.name ?? id;
        const changes = [
            ...(enabled !== repeater.enabled ? [enabled ? 'switched on' : 'switched off'] : []),
            ...(same ? [] : [`networks ${currentIds.map(name).join(', ') || '(none)'} → ${ids.map(name).join(', ')}`]),
        ];
        const body: RawRecord = {
            name: rule.name,
            status: enabled,
            // The services the rule repeats are kept as they are (the controller requires them).
            profileIds: rule.profileIds,
            type: MDNS_GATEWAY,
            osg: { serviceNetworks: ids, clientNetworks: ids },
        };
        return {
            steps: [{ action: 'update', object: 'omada.mdnsRule', name: String(rule.name), detail: changes.join('; ') }],
            effects: [
                enabled
                    ? `mDNS (Bonjour) announcements are repeated between ${ids.map(name).join(', ')}: devices there discover each other's services (AirPlay, Chromecast, HomeKit, printers). Discovery only: traffic still follows the rules. The services the rule repeats stay as set in the controller.`
                    : 'mDNS announcements are no longer repeated between networks; devices only discover services on their own network.',
            ],
            wouldLockOut: [],
            reads: { networks: true },
            extra: { mdns: rulesRaw.map(canonical) },
            execute: async (s) => {
                await this.client.networkConfig.updateMdnsRule(String(rule.id), body, s.siteId);
                let after: ReturnType<typeof toMdns>;
                try {
                    after = toMdns(await this.client.networkConfig.listMdnsRules(s.siteId));
                } catch {
                    return { applied: true, owned: [], warnings: ['The mDNS repeater is changed, but reading it back failed; check it with net_getMdnsRepeater.'] };
                }
                const stored = after.networkIds;
                const services = (r: RawRecord | undefined) => [...new Set(((r?.profileIds as unknown[] | undefined) ?? []).map(String))].sort().join(',');
                const sameRule = after.rule?.id === rule.id && after.rule?.name === rule.name && services(after.rule) === services(rule);
                if (after.repeater.foreign || !sameRule || after.repeater.enabled !== enabled || stored.length !== ids.length || !ids.every((id) => stored.includes(id))) {
                    throw new NetError('CONFLICT', 'The controller accepted the mDNS change but shows something else now; check it with net_getMdnsRepeater.');
                }
                return { applied: true, object: after.repeater, owned: [] };
            },
        };
    }

    // ---- DHCP reservations (the checks every vendor shares are in ../reservations.ts) -------------

    private async buildReservation(change: Extract<Change, { kind: 'reservation' }>, snap: Snapshot): Promise<Built> {
        const raw = await this.client.accessControl.listDhcpReservations(snap.siteId);
        const world = { networks: snap.networks, reservations: toReservations(raw), clients: snap.clients };
        const rawOf = (mac: string) => raw.find((r) => normalizeMac(r.mac) === normalizeMac(mac));
        // The controller's and this server's own reservations are never moved or removed; while where
        // either is can't be told, no existing reservation is (like ports with devices on them).
        const guard = (mac: string, ips: Array<string | undefined>) => {
            const at = (addresses: number[] | 'unknown' | 'unset') => Array.isArray(addresses) && ips.some((ip) => ip !== undefined && addresses.includes(ipToNumber(ip)));
            const who = at(this.controllerAddresses) ? 'the controller' : at(this.serverAddresses) ? 'this server' : undefined;
            if (who) throw new NetError('PROTECTED', `${mac} is ${who}: its address is never moved or released through the tools`);
            const blind = !this.options.controllerHost
                ? "the controller's address isn't known"
                : this.controllerAddresses === 'unknown'
                  ? "the controller's address can't be resolved"
                  : this.serverAddresses === 'unknown'
                    ? "this server's address can't be resolved"
                    : this.serverAddresses === 'unset'
                      ? "this server's address isn't configured (MCP_SERVER_ADDRESSES)"
                      : undefined;
            if (blind) throw new NetError('PROTECTED', `${blind}, so its reservation can't be told apart: existing reservations are not moved or removed (a new one, or pinning a device to the address it has, still works)`);
        };
        const online = (mac: string) => snap.clients.find((c) => c.online && normalizeMac(c.mac) === normalizeMac(mac));
        const extra = { reservations: raw.map(canonical) };
        if (change.op === 'delete') {
            const checked = checkReservationDelete(change.mac, world);
            guard(checked.mac, [checked.current.ip, online(checked.mac)?.ip]);
            const target = formatMac(rawOf(checked.mac)!.mac);
            return {
                steps: [{ ...checked.step, object: 'omada.dhcpReservation' }],
                effects: checked.effects,
                wouldLockOut: [],
                reads: { networks: true },
                extra,
                execute: async (s) => {
                    await this.client.networkConfig.deleteDhcpReservation(target, s.siteId);
                    const after = await this.readBack(s.siteId, checked.mac);
                    if (after === 'unread') return { applied: true, owned: [], warnings: [UNREAD] };
                    if (after) throw new NetError('CONFLICT', `The controller accepted the removal but still shows a reservation for ${checked.mac}; check it with net_listReservations.`);
                    return { applied: true, owned: [] };
                },
            };
        }
        const checked = checkReservationSet(change.value, world, { descriptions: true });
        const device = online(checked.mac);
        // Their address is theirs: reserved for anyone else, that device could take it at its next DHCP request.
        const target = ipToNumber(checked.ip);
        for (const [who, addresses] of [['the controller', this.controllerAddresses], ['this server', this.serverAddresses]] as const) {
            if (Array.isArray(addresses) && addresses.includes(target) && device?.ip !== checked.ip) {
                throw new NetError('PROTECTED', `${checked.ip} is ${who}'s address; it can't be reserved for another device`);
            }
        }
        // Pinning such a device to the address it has is fine; moving it is not.
        if ((checked.current && checked.current.ip !== checked.ip) || (device?.ip !== undefined && device.ip !== checked.ip)) guard(checked.mac, [checked.current?.ip, device?.ip]);
        const before = rawOf(checked.mac);
        const body: RawRecord = {
            netId: checked.network.id,
            mac: checked.mac,
            ip: checked.ip,
            description: checked.description || undefined,
            status: true,
            options: before?.options ?? [],
        };
        return {
            steps: [{ ...checked.step, object: 'omada.dhcpReservation' }],
            effects: checked.effects,
            wouldLockOut: checked.wouldLockOut,
            reads: { networks: true },
            extra,
            execute: async (s) => {
                if (before) await this.client.networkConfig.updateDhcpReservation(formatMac(before.mac), body, s.siteId);
                else await this.client.networkConfig.createDhcpReservation(body, s.siteId);
                const after = await this.readBack(s.siteId, checked.mac);
                if (after === 'unread') return { applied: true, owned: [], warnings: [UNREAD] };
                if (!after || after.ip !== checked.ip || !('id' in after.network) || after.network.id !== checked.network.id || after.description !== checked.description) {
                    throw new NetError('CONFLICT', `The controller accepted the reservation but shows something else for ${checked.mac} now; check it with net_listReservations.`);
                }
                return { applied: true, object: after, owned: [] };
            },
        };
    }

    /** The device's reservation as the controller has it now (undefined: none; 'unread': the read failed). */
    private async readBack(siteId: string, mac: string): Promise<Reservation | undefined | 'unread'> {
        let rows;
        try {
            rows = await this.client.accessControl.listDhcpReservations(siteId);
        } catch {
            return 'unread';
        }
        return toReservations(rows).find((r) => normalizeMac(r.mac) === normalizeMac(mac));
    }

    // ---- plan / apply ------------------------------------------------------------------

    async plan(change: Change): Promise<Plan> {
        return await this.planWith(change, await this.snapshot());
    }

    async apply(plan: Plan, options: { allowLockout?: boolean } = {}): Promise<ApplyResult> {
        const siteId = this.client.resolveSiteId(this.options.siteId);
        // One write at a time per site, shared with the Omada access control tools.
        return await serialize(accessControlLockKey(siteId), async () => {
            const snap = await this.snapshot();
            const fresh = await this.planWith(plan.change, snap);
            if (fresh.basis !== plan.basis) {
                throw new NetError('CONFLICT', 'The controller changed after this change was planned; nothing was written. Plan it again.');
            }
            if (fresh.wouldLockOut.length > 0 && !options.allowLockout) {
                throw new NetError('LOCKOUT', `This would cut off ${fresh.wouldLockOut.length} online device(s): ${describeClients(fresh.wouldLockOut)}. Nothing was changed; repeat with allowLockout if that is intended.`, {
                    clients: fresh.wouldLockOut,
                });
            }
            const execute = this.executors.get(fresh);
            if (!execute) throw new NetError('INVALID', 'Nothing to apply');
            return await execute(snap);
        });
    }

    private async planWith(change: Change, snap: Snapshot): Promise<Plan> {
        const built = await this.build(change, snap);
        const redacted = redactSecrets(change);
        const plan: Plan = {
            change: redacted,
            vendor: 'omada',
            steps: built.steps,
            effects: built.effects,
            wouldLockOut: built.wouldLockOut,
            // What was agreed to: this change (a basis can't vouch for another one) and the devices it
            // cuts off (a different set at apply time is a CONFLICT, allowLockout or not).
            basis: fingerprint(snap, built.reads, { change: redacted, extra: built.extra, lockOut: built.wouldLockOut.map((c) => normalizeMac(c.mac)).sort() }),
        };
        this.executors.set(plan, built.execute);
        return plan;
    }

    private async build(change: Change, snap: Snapshot): Promise<Built> {
        switch (change.kind) {
            case 'network':
                if (change.op === 'create') return this.buildNetworkCreate(change.value, snap);
                if (change.op === 'update') return this.buildNetworkUpdate(change.value.ref, change.value.set, snap);
                if (change.op === 'delete') return await this.buildNetworkDelete(change.ref, snap);
                break;
            case 'wifi':
                if (change.op === 'create') return await this.buildWifiCreate(change.value, snap);
                if (change.op === 'update') return await this.buildWifiUpdate(change.value.ref, change.value.set, change.passphrase, snap);
                if (change.op === 'delete') return this.buildWifiDelete(change.ref, snap);
                break;
            case 'port':
                return await this.buildPortAssign(change.port, change.networks, snap);
            case 'portProfile':
                throw unsupported('creating or deleting port profiles here (do it in the controller web UI)', 'ports.profiles');
            case 'mdnsRepeater':
                return await this.buildMdnsSet(change.enabled, change.networks, snap);
            case 'reservation':
                return await this.buildReservation(change, snap);
            case 'firmware':
                // The Open API can (start-online-upgrade), but it isn't live-tested here yet.
                throw new NetError('UNSUPPORTED', 'Upgrading Omada firmware through the net_ tools is not available yet; use the controller web UI (Devices > upgrade).', { capability: 'firmware' });
            case 'rule':
                if (change.op === 'create') return this.buildRuleCreate(change.value, snap);
                if (change.op === 'update') return this.buildRuleUpdate(change.value.ref, change.value.set, snap);
                if (change.op === 'delete') return this.buildRuleDelete(change.ref, snap);
                if (change.op === 'move') return this.buildRuleMove(change.ref, change.position, snap);
                break;
            default:
                throw notYet(`${change.kind} changes`, 'a later release (use omada_createGroup / omada_deleteGroup)');
        }
        throw new NetError('INVALID', 'This change is not supported');
    }

    // ---- rules (gateway ACLs; mapping and checks in omadaRules.ts) ---------------------------

    private ruleWorld(snap: Snapshot): RuleWorld {
        return {
            networks: snap.networks,
            acls: snap.acls,
            ipGroups: snap.ipGroups,
            ipPortGroups: snap.ipPortGroups,
            ssids: snap.ssids.map((s) => ({ id: s.ssidId, name: String(s.detail.name) })),
            // This server's addresses too: a rule must not cut it off the internet either.
            controllerAddresses: this.hostAddresses,
        };
    }

    /** The rule as the model sees it, with its raw ACL; a rule the model can't express is refused. */
    private editableRule(ref: Ref, snap: Snapshot, what: string): { raw: RawRecord; rule: Rule } {
        const world = this.ruleWorld(snap);
        const rules = snap.acls.map((raw, i) => ({ raw, rule: toRule(raw, i + 1, world) }));
        const found = resolve(
            rules.map((r) => ({ ...r, id: r.rule.id, name: r.rule.name })),
            ref,
            'rule'
        );
        if (found.rule.foreign) throw new NetError('UNSUPPORTED', `Rule '${found.rule.name}' can't be ${what} through net_: ${found.rule.foreign.reason} Use the omada_ gateway ACL tools for it.`, { capability: 'rules' });
        return { raw: found.raw, rule: found.rule };
    }

    private checkPosition(position: number, count: number): number {
        if (!Number.isInteger(position) || position < 1 || position > count) throw new NetError('INVALID', `Position must be 1 to ${count}`);
        return position;
    }

    /**
     * Refuses a change if any rule list it passes through (the end state, and the staged
     * one where the rule is switched off) could expose some of the controller's (and this
     * server's) internet traffic to a block that doesn't reach it today (controllerRisk).
     * Waived only when the controller is certainly cut off already.
     */
    private guardController(snap: Snapshot, states: Array<{ acls: RawRecord[]; world: RuleWorld }>): void {
        const today = controllerPath(snap.acls, this.ruleWorld(snap));
        for (const state of states) {
            const risk = controllerRisk(today, controllerPath(state.acls, state.world));
            if (risk) throw new NetError('PROTECTED', `This could cut the controller or this server off the internet: ${risk}. Nothing was changed.`);
        }
    }

    private buildRuleCreate(value: Extract<Change, { op: 'create'; kind: 'rule' }>['value'], snap: Snapshot): Built {
        const world = this.ruleWorld(snap);
        const draft = draftRule(value, world);
        const position = value.position === undefined ? undefined : this.checkPosition(value.position, snap.acls.length + 1);
        const moves = position !== undefined && position <= snap.acls.length;
        const steps = [
            ...groupSteps(draft),
            { action: 'create' as const, object: 'omada.gatewayAcl', name: draft.name, detail: draft.direction === 'lanToLan' ? 'LAN to LAN' : 'LAN to internet' },
            ...(moves ? [{ action: 'update' as const, object: 'omada.gatewayAclOrder', name: draft.name, detail: `position ${position}` }] : []),
            ...(moves && draft.enabled ? [{ action: 'update' as const, object: 'omada.gatewayAcl', name: draft.name, detail: 'switched on once in place' }] : []),
        ];
        const at = position ?? snap.acls.length + 1;
        const placed = draftAsAcl(draft, 'new-rule', world);
        this.guardController(snap, [{ acls: placeAt(snap.acls, placed.acl, at), world: placed.world }]);
        return {
            steps,
            effects: [...draft.effects, `It is rule ${at} of ${snap.acls.length + 1}; rules are checked in order and the first match decides.`],
            wouldLockOut: [],
            reads: { networks: true, ssids: true, rules: true },
            execute: async (s) => {
                // Every new rule carries a fresh tag: its description is unique, so the rule is found
                // again (and undone) by it, never mistaken for one made elsewhere at the same moment.
                const key = newRuleKey();
                const description = tagged(draft.name, key);
                const made: TrackedGroup[] = [];
                // 'none': nothing sent; 'sent': the create was sent and may have happened.
                let acl: 'none' | 'sent' = 'none';
                let aclId: string | undefined;
                try {
                    const source = await this.materialize(draft.source, key, 'from', s.siteId, made);
                    const destination = await this.materialize(draft.destination, key, 'to', s.siteId, made);
                    // A rule that still has to move is created switched off, so it never acts from the wrong place.
                    const body = aclBody(draft, description, source, destination, false);
                    acl = 'sent';
                    await this.client.networkConfig.createGatewayAcl({ ...body, status: moves ? false : draft.enabled }, s.siteId);
                    const acls = await this.sortedAcls(s.siteId);
                    aclId = acls.find((a) => a.description === description)?.id as string | undefined;
                    if (!aclId) throw new NetError('CONFLICT', `Created rule '${draft.name}' but could not find it again`);
                    if (moves) {
                        await this.reorder(acls, aclId, position, s.siteId);
                        if (draft.enabled) await this.client.networkConfig.updateGatewayAcl(aclId, body, s.siteId);
                    }
                } catch (error) {
                    throw await this.undoCreate(error, acl, description, made, s.siteId);
                }
                return await this.done(aclId, await this.sweepOwnedGroups(s.siteId), [
                    ...made.map((g) => ({ object: g.type === GROUP_TYPE.ip ? 'omada.ipGroup' : 'omada.ipPortGroup', id: g.id ?? g.name })),
                    { object: 'omada.gatewayAcl', id: aclId },
                ]);
            },
        };
    }

    private buildRuleUpdate(ref: Ref, set: Partial<RuleFields> & { position?: number }, snap: Snapshot): Built {
        const current = this.editableRule(ref, snap, 'changed');
        const world = this.ruleWorld(snap);
        const { position, ...fields } = set;
        const next: RuleFields = { ...current.rule, ...fields };
        const draft = draftRule(next, world, current);
        const target = position === undefined ? undefined : this.checkPosition(position, snap.acls.length);
        const moves = target !== undefined && target !== current.rule.position;
        const changes = describeRuleChanges(current.rule, next);
        if (changes.length === 0 && !moves) throw new NetError('INVALID', `Nothing to change on rule '${current.rule.name}'`);
        const oldKey = ruleKey(String(current.raw.description));
        // Changed and moved: written switched off, moved, then switched on, so the new content never acts from the old place.
        const staged = moves && changes.length > 0 && draft.enabled;
        {
            const id = String(current.raw.id);
            const others = snap.acls.filter((a) => String(a.id) !== id);
            const after = draftAsAcl(draft, id, world);
            const states = [{ acls: placeAt(others, after.acl, target ?? current.rule.position), world: after.world }];
            // Switched off on the way (staging, and the first step of undoing it): as if the rule were gone.
            if (staged) states.push({ acls: others, world });
            this.guardController(snap, states);
        }
        const steps = [
            ...groupSteps(draft),
            ...(changes.length ? [{ action: 'update' as const, object: 'omada.gatewayAcl', name: current.rule.name, detail: `${changes.join('; ')}${staged ? ' (switched off until in place)' : ''}` }] : []),
            ...(moves ? [{ action: 'update' as const, object: 'omada.gatewayAclOrder', name: current.rule.name, detail: `position ${target}` }] : []),
            ...(staged ? [{ action: 'update' as const, object: 'omada.gatewayAcl', name: current.rule.name, detail: 'switched on in place' }] : []),
        ];
        return {
            steps,
            effects: [
                ...(changes.length ? [`'${current.rule.name}': ${changes.join('; ')}.`, ...draft.effects] : []),
                ...(moves ? [`It moves from position ${current.rule.position} to ${target} of ${snap.acls.length}.`] : []),
            ],
            wouldLockOut: [],
            reads: { networks: true, ssids: true, rules: true },
            execute: async (s) => {
                const aclId = String(current.raw.id);
                const original = writableAcl(current.raw);
                const originalOrder = orderOf(s.acls);
                const made: TrackedGroup[] = [];
                // 'sent' = the write was sent and may have happened, even if it reported an error.
                let put: 'none' | 'sent' = 'none';
                let reorder: 'none' | 'sent' = 'none';
                try {
                    if (changes.length) {
                        const key = oldKey ?? (needsGroups(draft) ? newRuleKey() : undefined);
                        const source = await this.materialize(draft.source, key, 'from', s.siteId, made);
                        const destination = await this.materialize(draft.destination, key, 'to', s.siteId, made);
                        const body = aclBody(draft, tagged(draft.name, key), source, destination, current.raw.syslog === true);
                        put = 'sent';
                        await this.client.networkConfig.updateGatewayAcl(aclId, staged ? { ...body, status: false } : body, s.siteId);
                        if (moves) {
                            reorder = 'sent';
                            await this.reorder(await this.sortedAcls(s.siteId), aclId, target, s.siteId);
                        }
                        if (staged) await this.client.networkConfig.updateGatewayAcl(aclId, body, s.siteId);
                    } else if (moves) {
                        reorder = 'sent';
                        await this.reorder(await this.sortedAcls(s.siteId), aclId, target, s.siteId);
                    }
                } catch (error) {
                    throw await this.undoUpdate(error, { aclId, original, originalOrder, put, reorder, made }, s.siteId);
                }
                // Only now, with everything in place: groups no rule uses any more.
                return await this.done(aclId, await this.sweepOwnedGroups(s.siteId));
            },
        };
    }

    private buildRuleDelete(ref: Ref, snap: Snapshot): Built {
        const current = this.editableRule(ref, snap, 'deleted');
        const ids = referencedIds(current.raw);
        const otherUses = new Set([...snap.acls.filter((a) => a.id !== current.raw.id), ...snap.otherAcls].flatMap(referencedIds));
        const released = [...snap.ipGroups, ...snap.ipPortGroups].filter((g) => isOwnedGroup(g) && ids.includes(String(g.groupId)) && !otherUses.has(String(g.groupId)));
        this.guardController(snap, [{ acls: snap.acls.filter((a) => a.id !== current.raw.id), world: this.ruleWorld(snap) }]);
        return {
            steps: [
                { action: 'delete', object: 'omada.gatewayAcl', name: current.rule.name },
                ...released.map((g) => ({ action: 'delete' as const, object: g.type === GROUP_TYPE.ipPort ? 'omada.ipPortGroup' : 'omada.ipGroup', name: String(g.name) })),
            ],
            effects: [`Rule '${current.rule.name}' is removed${released.length ? ', with the address group it owns' : ''}.`],
            wouldLockOut: [],
            reads: { networks: true, ssids: true, rules: true },
            execute: async (s) => {
                const warnings: string[] = [];
                try {
                    await this.client.networkConfig.deleteGatewayAcl(String(current.raw.id), s.siteId);
                } catch (error) {
                    // The delete may have happened even though it reported an error: look.
                    let gone: boolean;
                    try {
                        gone = !(await this.sortedAcls(s.siteId)).some((a) => String(a.id) === String(current.raw.id));
                    } catch {
                        throw withNote(error, `whether rule '${current.rule.name}' was deleted is unknown; check net_listRules`);
                    }
                    if (!gone) throw error;
                    warnings.push("The controller's answer was lost, but the rule is gone.");
                }
                return await this.done(undefined, [...warnings, ...(await this.sweepOwnedGroups(s.siteId))]);
            },
        };
    }

    private buildRuleMove(ref: Ref, position: number, snap: Snapshot): Built {
        const world = this.ruleWorld(snap);
        const rules = snap.acls.map((raw, i) => ({ raw, rule: toRule(raw, i + 1, world) }));
        // Moving touches only the order, so a rule the model can't otherwise express may move too.
        const found = resolve(rules.map((r) => ({ ...r, id: r.rule.id, name: r.rule.name })), ref, 'rule');
        const target = this.checkPosition(position, snap.acls.length);
        if (target === found.rule.position) throw new NetError('INVALID', `Rule '${found.rule.name}' is already at position ${target}`);
        this.guardController(snap, [{ acls: placeAt(snap.acls.filter((a) => a.id !== found.raw.id), found.raw, target), world }]);
        return {
            steps: [{ action: 'update', object: 'omada.gatewayAclOrder', name: found.rule.name, detail: `position ${target}` }],
            effects: [`'${found.rule.name}' moves from position ${found.rule.position} to ${target} of ${snap.acls.length}; rules are checked in order and the first match decides.`],
            wouldLockOut: [],
            reads: { networks: true, ssids: true, rules: true },
            execute: async (s) => {
                const originalOrder = orderOf(s.acls);
                try {
                    await this.reorder(await this.sortedAcls(s.siteId), String(found.raw.id), target, s.siteId);
                } catch (error) {
                    // The reorder may have happened even though it reported an error: put the order back.
                    throw await this.restoreOrder(error, originalOrder, s.siteId);
                }
                return await this.done(String(found.raw.id), await this.sweepOwnedGroups(s.siteId));
            },
        };
    }

    /**
     * Existing ids for an endpoint, or the id of the group created for it. The group is
     * tracked by its (unique) name before it is created, so a create whose answer or
     * read-back got lost can still be found and undone.
     */
    private async materialize(endpoint: Endpoint, key: string | undefined, side: 'from' | 'to', siteId: string, made: TrackedGroup[]): Promise<{ type: number; ids: string[] }> {
        if ('ids' in endpoint) return { type: endpoint.type, ids: endpoint.ids };
        if (!key) throw new NetError('INVALID', 'Internal: a rule that owns a group needs a tag');
        const { groupType, body } = endpoint.newGroup;
        // A name no group has yet: finding it by name afterwards (or in an undo) can only find this one.
        const existing = await this.client.networkConfig.listGroups(groupType, siteId);
        const tracked: TrackedGroup = { type: groupType, name: ownedGroupName(key, side, new Set(existing.map((g) => String(g.name)))) };
        made.push(tracked);
        await this.client.networkConfig.createGroup({ name: tracked.name, ...body }, siteId);
        const group = (await this.client.networkConfig.listGroups(groupType, siteId)).find((g) => g.name === tracked.name);
        if (!group) throw new NetError('CONFLICT', `Created group '${tracked.name}' but could not find it again`);
        tracked.id = String(group.groupId);
        return { type: endpoint.type, ids: [tracked.id] };
    }

    /**
     * Undoes a create that failed part-way and returns the error to throw. A create that
     * was sent may have happened even if it reported an error: the rule is looked up by
     * its description and removed before its groups. When that can't be confirmed, the
     * groups stay (a live rule must never point at deleted groups) and the error says so.
     */
    private async undoCreate(error: unknown, acl: 'none' | 'sent', description: string, made: TrackedGroup[], siteId: string): Promise<unknown> {
        const notes: string[] = [];
        if (acl === 'sent') {
            try {
                const found = (await this.sortedAcls(siteId)).find((a) => a.description === description);
                if (found) await this.client.networkConfig.deleteGatewayAcl(String(found.id), siteId);
            } catch {
                return withNote(error, `the rule may have been created; check net_listRules for '${description}' (its groups were kept)`);
            }
        }
        notes.push(...(await this.dropGroups(made, siteId)));
        return notes.length ? withNote(error, notes.join('; ')) : error;
    }

    /**
     * Undoes an update that failed part-way and returns the error to throw: puts the rule
     * back as it was (if the change may have been written) and removes the groups made
     * for it, unless the rule might still point at them.
     */
    private async undoUpdate(
        error: unknown,
        u: { aclId: string; original: RawRecord; originalOrder: Record<string, number>; put: 'none' | 'sent'; reorder: 'none' | 'sent'; made: TrackedGroup[] },
        siteId: string
    ): Promise<unknown> {
        if (u.reorder === 'sent') {
            try {
                // Content changed too: switch it off first, so neither version acts from the wrong place while the order goes back.
                if (u.put === 'sent') await this.client.networkConfig.updateGatewayAcl(u.aclId, { ...u.original, status: false }, siteId);
                await this.client.networkConfig.reorderGatewayAcls(u.originalOrder, siteId);
            } catch {
                return withNote(error, 'the rule order could not be put back; check it with net_listRules (the groups made for the change were kept)');
            }
        }
        if (u.put === 'sent') {
            try {
                await this.client.networkConfig.updateGatewayAcl(u.aclId, u.original, siteId);
            } catch {
                return withNote(error, 'the rule could not be put back as it was; check it with net_listRules (the groups made for the change were kept)');
            }
        }
        const notes = await this.dropGroups(u.made, siteId);
        return notes.length ? withNote(error, notes.join('; ')) : error;
    }

    /** Puts the rule order back after a move that failed (it may have happened anyway); returns the error to throw. */
    private async restoreOrder(error: unknown, originalOrder: Record<string, number>, siteId: string): Promise<unknown> {
        try {
            await this.client.networkConfig.reorderGatewayAcls(originalOrder, siteId);
            return error;
        } catch {
            return withNote(error, 'the rule order could not be put back; check it with net_listRules');
        }
    }

    /** Deletes groups made during a failed change (found by name when the id is unknown); returns what it couldn't remove. */
    private async dropGroups(made: TrackedGroup[], siteId: string): Promise<string[]> {
        const left: string[] = [];
        for (const g of made) {
            try {
                const id = g.id ?? ((await this.client.networkConfig.listGroups(g.type, siteId)).find((x) => x.name === g.name)?.groupId as string | undefined);
                if (id) await this.client.networkConfig.deleteGroup(g.type, String(id), siteId);
            } catch {
                left.push(`group '${g.name}' may be left behind`);
            }
        }
        return left;
    }

    /**
     * Deletes every group a net_ rule owned that no ACL (gateway, switch or access point)
     * references any more. Run after each successful rule change, so a cleanup that failed
     * once is finished by the next change; a failure here is a warning, not an error (the
     * change itself is done). Writes are serialized per site, so no rule is half-created
     * meanwhile.
     */
    private async sweepOwnedGroups(siteId: string): Promise<string[]> {
        try {
            const acls = [
                ...(await this.client.networkConfig.listAcls('osg-acls', siteId)),
                ...(await this.client.networkConfig.listAcls('osw-acls', siteId)),
                ...(await this.client.networkConfig.listAcls('eap-acls', siteId)),
            ];
            const used = new Set(acls.flatMap(referencedIds));
            const left: string[] = [];
            for (const type of [GROUP_TYPE.ip, GROUP_TYPE.ipPort] as const) {
                for (const g of await this.client.networkConfig.listGroups(type, siteId)) {
                    const id = String(g.groupId);
                    if (!isOwnedGroup(g) || used.has(id)) continue;
                    await this.client.networkConfig.deleteGroup(type, id, siteId).catch(() => left.push(String(g.name)));
                }
            }
            return left.length ? [`Could not remove the unused group(s) ${left.join(', ')} now; the next rule change removes them.`] : [];
        } catch {
            return ['Could not check for unused rule groups now; the next rule change removes them.'];
        }
    }

    private async sortedAcls(siteId: string): Promise<RawRecord[]> {
        return (await this.client.networkConfig.listAcls('osg-acls', siteId)).sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
    }

    /** Moves one rule to `position` (1 = first); the others keep their order. */
    private async reorder(acls: RawRecord[], aclId: string, position: number, siteId: string): Promise<void> {
        const moving = acls.find((a) => String(a.id) === aclId);
        if (!moving) throw new NetError('NOT_FOUND', 'The rule disappeared before it could be moved');
        const order = acls.filter((a) => String(a.id) !== aclId);
        order.splice(Math.min(position, acls.length) - 1, 0, moving);
        await this.client.networkConfig.reorderGatewayAcls(Object.fromEntries(order.map((a, i) => [String(a.id), i + 1])), siteId);
    }

    /**
     * The result of a change that is done: the rule as it reads back, plus warnings. A
     * failed read-back is a warning, never an error: the change is already applied.
     */
    private async done(aclId: string | undefined, warnings: string[], owned: ApplyResult['owned'] = []): Promise<ApplyResult> {
        const notes = [...warnings];
        let object: Rule | undefined;
        if (aclId) {
            try {
                const snap = await this.snapshot();
                const index = snap.acls.findIndex((a) => String(a.id) === aclId);
                if (index >= 0) object = toRule(snap.acls[index], index + 1, this.ruleWorld(snap));
            } catch {
                notes.push(`The change is applied, but reading the rule back failed; check it with net_listRules (rule id ${aclId}).`);
            }
        }
        return { applied: true, ...(object ? { object } : {}), owned, ...(notes.length ? { warnings: notes } : {}) };
    }

    // ---- networks ------------------------------------------------------------------------

    private buildNetworkCreate(value: Extract<Change, { op: 'create'; kind: 'network' }>['value'], snap: Snapshot): Built {
        const name = checkName(value.name, MAX_NETWORK_NAME, 'Network');
        if (value.purpose === 'guest') throw unsupported('a guest network type (Omada makes a Wi-Fi network a guest network instead: clientIsolation)', 'networks.guestPurpose');
        if (value.isolated) throw unsupported('a network isolation flag (make a block rule from this network to the others with net_createRule)', 'networks.isolation');
        if (value.ipv6) throw unsupported('switching IPv6 on (do it in the controller web UI)', 'networks.ipv6');
        const vlan = checkVlan(value.vlan);
        const vlanOnly = value.purpose === 'vlanOnly';
        if (vlanOnly && (value.gateway !== undefined || value.dhcp?.enabled)) {
            throw new NetError('INVALID', 'A switch-only network has no gateway and no DHCP; leave them out, or use purpose normal');
        }
        const gateway = vlanOnly ? undefined : checkGateway(value.gateway ?? '');
        const dhcp = vlanOnly || !gateway ? undefined : checkDhcp(gateway, value.dhcp ?? { enabled: false });
        checkNetworkUnique({ name, vlan, gateway }, snap.networks);

        const primary = snap.networksRaw.find((n) => n.primary === true);
        const body: RawRecord = {
            name,
            purpose: vlanOnly ? PURPOSE_VLAN : PURPOSE_INTERFACE,
            vlan,
            igmpSnoopEnable: false,
            ...(vlanOnly
                ? {}
                : {
                      // Carried on the same gateway LAN ports as the primary network.
                      interfaceIds: (primary?.interfaceIds as string[] | undefined) ?? [],
                      vlanType: 0,
                      application: 0,
                      gatewaySubnet: gateway,
                      dhcpSettingsVO: dhcpBody(dhcp),
                      mldSnoopEnable: false,
                      dhcpL2RelayEnable: false,
                      dhcpGuard: { enable: false },
                      dhcpv6Guard: { enable: false },
                      lanNetworkIpv6Config: { proto: 0, enable: 0 },
                  }),
        };
        return {
            steps: [{ action: 'create', object: 'omada.lanNetwork', name, detail: vlanOnly ? `VLAN ${vlan}, switches only` : `VLAN ${vlan}, ${gateway}` }],
            effects: [
                vlanOnly ? `New VLAN ${vlan} '${name}' on the switches (no gateway address).` : `New network '${name}': VLAN ${vlan}, gateway ${gateway}, DHCP ${dhcp?.enabled ? `${dhcp.range?.from}-${dhcp.range?.to}` : 'off'}, IPv6 off.`,
                'No device is on it yet: a Wi-Fi network or a switch port must carry this VLAN first.',
            ],
            wouldLockOut: [],
            reads: { networks: true },
            execute: async (s) => {
                await this.client.networkConfig.createLanNetwork(body, s.siteId);
                const created = (await this.client.networkConfig.listLanNetworks(s.siteId)).find((n) => n.name === name);
                if (!created) throw new NetError('NOT_FOUND', `Created network '${name}' but could not find it again`);
                return { applied: true, object: this.toNetwork(created), owned: [] };
            },
        };
    }

    private buildNetworkUpdate(ref: Ref, set: Partial<Omit<Network, 'id' | 'protected'>>, snap: Snapshot): Built {
        const current = resolve(snap.networks, ref, 'network');
        const raw = snap.networksRaw.find((n) => String(n.id) === current.id)!;
        if (set.purpose !== undefined && set.purpose !== current.purpose) throw new NetError('INVALID', 'A network\'s purpose can\'t change; create a new network instead');
        if (current.purpose === 'vlanOnly' && (set.gateway !== undefined || set.dhcp !== undefined)) {
            throw new NetError('INVALID', `'${current.name}' is switch-only: it has no gateway and no DHCP to change`);
        }
        if (set.isolated) throw unsupported('a network isolation flag (make a block rule from this network to the others with net_createRule)', 'networks.isolation');
        if (set.ipv6 === true && !current.ipv6) throw unsupported('switching IPv6 on (do it in the controller web UI)', 'networks.ipv6');
        const addressing = (set.vlan !== undefined && set.vlan !== current.vlan) || (set.gateway !== undefined && set.gateway !== current.gateway);
        if (current.protected && addressing) {
            throw new NetError('PROTECTED', `'${current.name}' carries the controller, this server or the primary network; its VLAN and gateway can't be changed here`);
        }
        const name = set.name !== undefined ? checkName(set.name, MAX_NETWORK_NAME, 'Network') : current.name;
        const vlan = set.vlan !== undefined ? checkVlan(set.vlan) : current.vlan;
        const gateway = set.gateway !== undefined ? checkGateway(set.gateway) : current.gateway;
        const others = snap.networks.filter((n) => n.id !== current.id);
        checkNetworkUnique({ name: name !== current.name ? name : undefined, vlan: vlan !== current.vlan ? vlan : undefined, gateway: gateway !== current.gateway ? gateway : undefined }, others);
        // An update names only what changes: the rest of the current DHCP settings (range, lease, DNS) stays.
        // Every address pool the network has (Omada allows several; the model shows the first).
        const pools = ((((raw.dhcpSettingsVO ?? {}) as RawRecord).ipRangePool as RawRecord[] | undefined) ?? []).map((p) => ({ from: String(p.ipaddrStart), to: String(p.ipaddrEnd) }));
        // An update names only what changes: unmentioned DHCP settings, and all pools unless a range is given, stay.
        let dhcp: Network['dhcp'] | undefined;
        if (set.dhcp !== undefined && gateway) {
            if (set.dhcp.enabled) {
                const ranges = set.dhcp.range ? [set.dhcp.range] : pools;
                if (ranges.length === 0) checkDhcp(gateway, set.dhcp); // refuses: DHCP on without a range
                for (const range of ranges) checkDhcp(gateway, { ...current.dhcp, ...set.dhcp, range });
                dhcp = set.dhcp;
            } else {
                dhcp = { enabled: false };
            }
        }
        if (set.dhcp === undefined && gateway !== current.gateway && gateway && current.dhcp?.enabled) {
            // The kept pools are sent again as they are: each must fit the new subnet.
            for (const range of pools) {
                try {
                    checkDhcp(gateway, { enabled: true, range });
                } catch {
                    throw new NetError('INVALID', `The current DHCP range ${range.from}-${range.to} doesn't fit ${gateway}; give a new range with the gateway`);
                }
            }
        }

        const body: RawRecord = { ...pick(raw, NETWORK_FIELDS), name, vlan };
        if (gateway) body.gatewaySubnet = gateway;
        const keptDhcp = pick((raw.dhcpSettingsVO ?? {}) as RawRecord, DHCP_FIELDS);
        if (gateway && current.gateway && gateway !== current.gateway && typeof keptDhcp.gateway === 'string' && keptDhcp.gateway !== '') {
            // The router address DHCP hands out: follow the interface when it was the interface, else it must fit.
            const oldIp = current.gateway.split('/')[0];
            const newIp = gateway.split('/')[0];
            if (keptDhcp.gateway === oldIp) keptDhcp.gateway = newIp;
            else if (!isIpv4(keptDhcp.gateway) || !inSubnet(ipToNumber(keptDhcp.gateway), gateway)) {
                throw new NetError('INVALID', `The DHCP gateway ${keptDhcp.gateway} is outside ${gateway}; change it in the controller web UI first`);
            }
        }
        if (dhcp?.dns !== undefined) {
            // Given DNS servers replace the kept ones (an empty list = automatic).
            delete keptDhcp.priDns;
            delete keptDhcp.sndDns;
        }
        body.dhcpSettingsVO = dhcp ? { ...keptDhcp, ...dhcpBody(dhcp, keptDhcp) } : keptDhcp;
        if (set.ipv6 === false && current.ipv6) body.lanNetworkIpv6Config = { proto: 0, enable: 0 };

        const disruptive = addressing || (dhcp !== undefined && !dhcp.enabled && current.dhcp?.enabled === true);
        // Devices relying on IPv6 lose their connection when it is switched off.
        const ipv6Off = set.ipv6 === false && current.ipv6;
        const affected = disruptive || ipv6Off ? snap.clients.filter((c) => c.online && c.network && 'id' in c.network && c.network.id === current.id) : [];
        const changes = describeNetworkChanges(current, { name, vlan, gateway, dhcp, ipv6: set.ipv6 });
        if (changes.length === 0) throw new NetError('INVALID', `Nothing to change on '${current.name}'`);
        return {
            steps: [{ action: 'update', object: 'omada.lanNetwork', name: current.name, detail: changes.join('; ') }],
            effects: [
                `'${current.name}': ${changes.join('; ')}.`,
                ...(disruptive ? ['Devices on this network lose their address until they reconnect.'] : []),
                ...(ipv6Off ? ['Devices on this network lose their IPv6 addresses; IPv4 keeps working.'] : []),
            ],
            wouldLockOut: affected,
            reads: { networks: true },
            execute: async (s) => {
                await this.client.networkConfig.updateLanNetwork(current.id, body, s.siteId);
                const after = (await this.client.networkConfig.listLanNetworks(s.siteId)).find((n) => String(n.id) === current.id);
                return { applied: true, ...(after ? { object: this.toNetwork(after) } : {}), owned: [] };
            },
        };
    }

    private async buildNetworkDelete(ref: Ref, snap: Snapshot): Promise<Built> {
        const current = resolve(snap.networks, ref, 'network');
        if (current.protected) throw new NetError('PROTECTED', `'${current.name}' carries the controller, this server or the primary network and can't be deleted`);
        const users = await this.networkUsers(current, snap);
        if (users.length) throw new NetError('IN_USE', `'${current.name}' is used by ${users.join(', ')}; change those first`, { users });
        const affected = snap.clients.filter((c) => c.online && c.network && 'id' in c.network && c.network.id === current.id);
        return {
            steps: [{ action: 'delete', object: 'omada.lanNetwork', name: current.name }],
            effects: [`Network '${current.name}' (VLAN ${current.vlan}) is removed.`],
            wouldLockOut: affected,
            reads: { networks: true },
            execute: async (s) => {
                await this.client.networkConfig.deleteLanNetwork(current.id, s.siteId);
                return { applied: true, owned: [] };
            },
        };
    }

    /** Everything that still references a network: SSIDs, port profiles, switch ports carrying it untagged, DHCP reservations, ACL rules. */
    private async networkUsers(network: Network, snap: Snapshot): Promise<string[]> {
        const users: string[] = [];
        for (const s of snap.ssids) if (this.ssidNetworkIds(s.detail, snap.networks).includes(network.id)) users.push(`Wi-Fi '${String(s.detail.name)}'`);
        for (const p of await this.client.networkConfig.listLanProfiles(snap.siteId)) {
            const ids = [p.nativeNetworkId, ...((p.tagNetworkIds as string[] | undefined) ?? []), ...((p.untagNetworkIds as string[] | undefined) ?? [])];
            if (ids.includes(network.id)) users.push(`port profile '${String(p.name)}'`);
        }
        // Devices on a port that carries it untagged would be left without a network; a switch whose
        // lists can't be read may have such a port (other devices, like the gateway, have no switch ports).
        for (const d of await this.client.networkConfig.listNetworkPorts(network.id, network.vlan, snap.siteId)) {
            if (d.type !== 'switch' && d.switchInfo === undefined) continue;
            const name = `switch '${String(d.name ?? d.mac)}'`;
            const a = affectedPortsOf(d);
            if (!a) {
                users.push(`${name} (which of its ports carry it can't be read)`);
                continue;
            }
            const nums = (...keys: string[]) => [...new Set(keys.flatMap((k) => (a[k] as unknown[]).map(Number)))].sort((x, y) => x - y);
            const ports = nums('nativePorts', 'untagPorts');
            const lags = nums('nativeLags', 'untagLags');
            const on = [...(ports.length ? [`ports ${ports.join(', ')}`] : []), ...(lags.length ? [`LAGs ${lags.join(', ')}`] : [])];
            if (on.length) users.push(`${name} ${on.join(' and ')} (untagged)`);
        }
        for (const r of await this.client.accessControl.listDhcpReservations(snap.siteId)) if (r.netId === network.id) users.push(`DHCP reservation ${formatMac(r.mac)}`);
        for (const [kind, list] of [['gateway', 'osg-acls'], ['switch', 'osw-acls'], ['access point', 'eap-acls']] as const) {
            for (const a of await this.client.networkConfig.listAcls(list, snap.siteId)) {
                const ids = [...(a.sourceType === 0 ? ((a.sourceIds as string[]) ?? []) : []), ...(a.destinationType === 0 ? ((a.destinationIds as string[]) ?? []) : [])];
                if (ids.includes(network.id)) users.push(`${kind} rule '${String(a.description)}'`);
            }
        }
        return users;
    }

    // ---- Wi-Fi -------------------------------------------------------------------------------

    private async buildWifiCreate(value: Extract<Change, { op: 'create'; kind: 'wifi' }>['value'], snap: Snapshot): Promise<Built> {
        const name = checkName(value.name, MAX_WIFI_NAME, 'Wi-Fi');
        if (snap.ssids.some((s) => String(s.detail.name).toLowerCase() === name.toLowerCase())) throw new NetError('EXISTS', `A Wi-Fi network named '${name}' already exists`);
        if (value.enabled === false) throw unsupported('creating a Wi-Fi network switched off (use omada_setSsidEnabled afterwards)', 'wifi.create');
        const network = wifiNetwork(snap.networks, value.network);
        const wlanId = snap.ssids[0]?.wlanId ?? (await this.client.networkConfig.listSsidSummaries(snap.siteId)).find((w) => w.wlanId !== PSEUDO_WLAN_ID)?.wlanId;
        if (!wlanId) throw new NetError('NOT_FOUND', 'No WLAN group to add the Wi-Fi network to');
        const macFilter = value.macFilter ? await this.macFilterBody(value.macFilter, snap) : undefined;
        const deviceType = await this.wifiDeviceType(snap);

        const body: RawRecord = {
            name,
            deviceType,
            band: bandBits(checkBands(value.bands)),
            guestNetEnable: value.clientIsolation,
            broadcast: !value.hidden,
            mloEnable: false,
            pmfMode: PMF[value.pmf],
            enable11r: value.fastRoaming,
            hidePwd: true,
            // An open network with a MAC filter is created locked (WPA2, a password nobody knows) and only
            // opened once the filter is in place, so it is never open without its filter.
            ...securityBody(value.security === 'open' && macFilter ? 'wpa2' : value.security, value.security === 'open' && !macFilter ? undefined : temporaryPassphrase()),
            ...vlanBody(network),
        };
        const openAfterFilter = value.security === 'open' && macFilter !== undefined;
        return {
            steps: [
                { action: 'create', object: 'omada.ssid', name, detail: `on '${network.name}' (VLAN ${network.vlan}), ${value.security}, bands ${value.bands.join('/')}` },
                ...(macFilter ? [{ action: 'update' as const, object: 'omada.ssidMacFilter', name, detail: macFilter.summary }] : []),
                ...(openAfterFilter ? [{ action: 'update' as const, object: 'omada.ssid', name, detail: 'security → open (after the filter is in place)' }] : []),
            ],
            effects: [
                `New Wi-Fi '${name}' on network '${network.name}'.`,
                ...(value.security === 'open'
                    ? ['It is open: anyone in range can join.']
                    : [`It gets a random temporary password nobody knows, so nobody can join yet: set the real password in the controller web UI (Network Config → WLAN → ${name}).`]),
                ...(value.clientIsolation ? ['Omada guest mode: devices on it can\'t reach each other or private networks.'] : []),
            ],
            wouldLockOut: [],
            reads: { networks: true, ssids: true, macGroups: macFilter !== undefined },
            // Which devices broadcast it: a change (an access point added, another gateway) is a CONFLICT.
            extra: { deviceType },
            execute: async (s) => {
                await this.client.networkConfig.createSsid(wlanId, body, s.siteId);
                const created = (await this.client.networkConfig.listSsidSummaries(s.siteId))
                    .filter((w) => w.wlanId !== PSEUDO_WLAN_ID)
                    .flatMap((w) => (w.ssidList ?? []).map((x) => ({ wlanId: w.wlanId, ...x })))
                    .find((x) => x.ssidName === name);
                if (!created) throw new NetError('NOT_FOUND', `Created Wi-Fi '${name}' but could not find it again`);
                if (macFilter) await this.client.networkConfig.updateSsidMacFilter(created.wlanId, created.ssidId, macFilter.body, s.siteId);
                if (openAfterFilter) {
                    const locked = await this.client.networkConfig.getSsidDetail(created.wlanId, created.ssidId, s.siteId);
                    const open: RawRecord = { ...pick(locked, SSID_FIELDS), security: SECURITY_NONE };
                    delete open.pskSetting;
                    await this.client.networkConfig.updateSsidBasic(created.wlanId, created.ssidId, open, s.siteId);
                }
                const detail = await this.client.networkConfig.getSsidDetail(created.wlanId, created.ssidId, s.siteId);
                return { applied: true, object: this.toWifi({ wlanId: created.wlanId, ssidId: created.ssidId, detail }, s.networks, await this.client.listMacGroups(s.siteId), s.alwaysProfileId), owned: [] };
            },
        };
    }

    /**
     * Which devices broadcast a new SSID (bit 0 = access points, bit 1 = the gateway): the access
     * points when the site has any, the gateway only when it reports a radio (wirelessRouter).
     * Never copied from another SSID: an SSID put on a gateway without Wi-Fi can't be saved in the
     * web UI (live, ER605, 2026-10-21). The gateway's details come with a network's port list.
     */
    private async wifiDeviceType(snap: Snapshot): Promise<number> {
        const devices = await this.client.listDevices(snap.siteId);
        const hasAccessPoints = devices.some((d) => d.type === 'ap');
        const first = snap.networks[0];
        const entries = devices.some((d) => d.type === 'gateway') && first ? await this.client.networkConfig.listNetworkPorts(first.id, first.vlan, snap.siteId) : [];
        const gatewayWifi = entries.some((e) => e.type === 'gateway' && ((e.gatewayInfo as RawRecord | undefined)?.gatewayDetail as RawRecord | undefined)?.wirelessRouter === true);
        const deviceType = (hasAccessPoints ? 1 : 0) + (gatewayWifi ? 2 : 0);
        if (deviceType === 0) {
            throw new NetError('UNSUPPORTED', 'Nothing could broadcast this Wi-Fi network: the site has no access point and the gateway has no Wi-Fi', { capability: 'wifi.create' });
        }
        return deviceType;
    }

    private async buildWifiUpdate(ref: Ref, set: Partial<Omit<Wifi, 'id'>>, passphrase: PassphraseSource | undefined, snap: Snapshot): Promise<Built> {
        const ssid = resolveSsid(snap.ssids, ref);
        const groups = snap.macGroups;
        const current = this.toWifi(ssid, snap.networks, groups, snap.alwaysProfileId);
        if (set.enabled !== undefined && set.enabled !== current.enabled) throw unsupported('switching a Wi-Fi network on or off here (use omada_setSsidEnabled)', 'wifi.enabled');
        // RADIUS and per-device keys can't be resent through the basic config without losing them.
        if ((current.security === 'enterprise' || current.security === 'ppsk') && set.security === undefined) {
            throw new NetError('INVALID', `'${current.name}' uses ${current.security} security, which these tools can't keep; change it in the controller web UI`);
        }
        const raw = ssid.detail;
        const body = pick(raw, SSID_FIELDS);
        const changes: string[] = [];
        let disconnects = false;
        let isolates = false;

        if (set.name !== undefined && set.name !== current.name) {
            const name = checkName(set.name, MAX_WIFI_NAME, 'Wi-Fi');
            if (snap.ssids.some((s) => s.ssidId !== ssid.ssidId && String(s.detail.name).toLowerCase() === name.toLowerCase())) throw new NetError('EXISTS', `A Wi-Fi network named '${name}' already exists`);
            body.name = name;
            changes.push(`name → ${name}`);
            disconnects = true;
        }
        if (set.bands !== undefined && bandBits(checkBands(set.bands)) !== Number(raw.band)) {
            body.band = bandBits(set.bands);
            changes.push(`bands → ${set.bands.join('/')}`);
            disconnects = true;
        }
        if (set.network !== undefined) {
            const network = wifiNetwork(snap.networks, set.network);
            // Compare with every network the SSID maps to: narrowing a multi-network mapping is a change too.
            const mapped = this.ssidNetworkIds(raw, snap.networks);
            if (mapped.length !== 1 || mapped[0] !== network.id) {
                Object.assign(body, vlanBody(network));
                changes.push(`network → ${network.name}`);
                disconnects = true;
            }
        }
        const rotate = passphrase?.kind === 'temporary';
        let temporaryKey = false;
        if ((set.security !== undefined && set.security !== current.security) || rotate) {
            const security = set.security ?? current.security;
            const existingKey = ((raw.pskSetting ?? {}) as RawRecord).securityKey;
            // No shared password to keep (open, Enterprise, PPSK, or none stored): a temporary one nobody knows.
            temporaryKey = security !== 'open' && (rotate || typeof existingKey !== 'string' || existingKey === '' || ['open', 'enterprise', 'ppsk'].includes(current.security));
            const key = security === 'open' ? undefined : temporaryKey ? temporaryPassphrase() : (existingKey as string);
            Object.assign(body, securityBody(security, key));
            changes.push(rotate ? 'new temporary password' : `security → ${security}`);
            disconnects = true;
        }
        const toggles: Array<['pmf' | 'clientIsolation' | 'hidden' | 'fastRoaming', string, unknown]> = [
            ['pmf', 'pmfMode', set.pmf !== undefined ? PMF[set.pmf] : undefined],
            ['clientIsolation', 'guestNetEnable', set.clientIsolation],
            ['hidden', 'broadcast', set.hidden !== undefined ? !set.hidden : undefined],
            ['fastRoaming', 'enable11r', set.fastRoaming],
        ];
        for (const [key, field, value] of toggles) {
            if (value !== undefined && value !== raw[field]) {
                body[field] = value;
                changes.push(`${key} → ${String(set[key])}`);
                // Devices without PMF support can't join a "required" SSID: treat any PMF change as disconnecting.
                if (key === 'pmf') disconnects = true;
                // Omada guest mode also cuts devices off from every private network (e.g. Home Assistant).
                if (key === 'clientIsolation' && value === true) isolates = true;
            }
        }
        const macFilter = set.macFilter !== undefined ? await this.macFilterChange(set.macFilter, current, snap) : undefined;
        if (changes.length === 0 && !macFilter) throw new NetError('INVALID', `Nothing to change on '${current.name}'`);

        const connected = snap.clients.filter((c) => c.online && c.wifi && 'name' in c.wifi && c.wifi.name === current.name);
        const lockOut = disconnects || isolates ? connected : macFilter?.lockOut(connected) ?? [];
        return {
            steps: [
                ...(changes.length ? [{ action: 'update' as const, object: 'omada.ssid', name: current.name, detail: changes.join('; ') }] : []),
                ...(macFilter ? [{ action: 'update' as const, object: 'omada.ssidMacFilter', name: current.name, detail: macFilter.summary }] : []),
            ],
            effects: [
                ...(changes.length ? [`'${current.name}': ${changes.join('; ')}.`] : []),
                ...(macFilter ? [`'${current.name}' MAC filter: ${macFilter.summary}.`] : []),
                ...(disconnects ? ['Every device on it is disconnected and must join again.'] : []),
                ...(isolates ? ['Omada guest mode: devices on it lose access to each other and to every private network (e.g. Home Assistant).'] : []),
                ...(temporaryKey
                    ? [`A random temporary password nobody knows was set: set the real password in the controller web UI (Network Config → WLAN → ${String(body.name ?? current.name)}).`]
                    : []),
            ],
            wouldLockOut: lockOut,
            reads: { networks: true, ssids: true, macGroups: macFilter !== undefined },
            execute: async (s) => {
                // Whenever the SSID ends up open (opened, or moved while open), its new filter goes in first.
                const opening = body.security === SECURITY_NONE;
                if (opening && macFilter) await this.client.networkConfig.updateSsidMacFilter(ssid.wlanId, ssid.ssidId, macFilter.body, s.siteId);
                if (changes.length) await this.client.networkConfig.updateSsidBasic(ssid.wlanId, ssid.ssidId, body, s.siteId);
                if (!opening && macFilter) await this.client.networkConfig.updateSsidMacFilter(ssid.wlanId, ssid.ssidId, macFilter.body, s.siteId);
                const detail = await this.client.networkConfig.getSsidDetail(ssid.wlanId, ssid.ssidId, s.siteId);
                return { applied: true, object: this.toWifi({ ...ssid, detail }, s.networks, await this.client.listMacGroups(s.siteId), s.alwaysProfileId), owned: [] };
            },
        };
    }

    private buildWifiDelete(ref: Ref, snap: Snapshot): Built {
        const ssid = resolveSsid(snap.ssids, ref);
        const name = String(ssid.detail.name);
        if (snap.ssids.length === 1) throw new NetError('PROTECTED', `'${name}' is the only Wi-Fi network; it can't be deleted here`);
        const connected = snap.clients.filter((c) => c.online && c.wifi && 'name' in c.wifi && c.wifi.name === name);
        return {
            steps: [{ action: 'delete', object: 'omada.ssid', name }],
            effects: [`Wi-Fi '${name}' is removed; its devices are disconnected.`],
            wouldLockOut: connected,
            reads: { ssids: true },
            execute: async (s) => {
                await this.client.networkConfig.deleteSsid(ssid.wlanId, ssid.ssidId, s.siteId);
                return { applied: true, owned: [] };
            },
        };
    }

    private async macFilterBody(filter: NonNullable<Wifi['macFilter']>, snap: Snapshot) {
        const groups = snap.macGroups;
        const group = resolve(groups.map((g) => ({ ...g, id: g.groupId })), filter.group, 'MAC group');
        return {
            body: { macFilterEnable: true, policy: filter.policy === 'allow' ? 1 : 0, macFilterId: group.groupId },
            summary: `${filter.policy} list = ${group.name}`,
            members: new Set((group.macAddressList ?? []).map((e) => normalizeMac(e.macAddress))),
            policy: filter.policy,
        };
    }

    private async macFilterChange(filter: Wifi['macFilter'], current: Wifi, snap: Snapshot) {
        if (filter === null) {
            if (!current.macFilter) return undefined;
            return { body: { macFilterEnable: false }, summary: 'off', lockOut: () => [] as Client[] };
        }
        if (!filter) return undefined;
        const built = await this.macFilterBody(filter, snap);
        return {
            body: built.body,
            summary: built.summary,
            lockOut: (connected: Client[]) =>
                connected.filter((c) => (built.policy === 'allow' ? !built.members.has(normalizeMac(c.mac)) : built.members.has(normalizeMac(c.mac)))),
        };
    }
}

interface Built {
    steps: Step[];
    effects: string[];
    wouldLockOut: Client[];
    /** Which parts of the snapshot the plan depends on (the fingerprint covers only those). */
    reads: { networks?: boolean; ssids?: boolean; macGroups?: boolean; rules?: boolean };
    /** Further reads the plan depends on (ports, mDNS rules), fingerprinted as they are. */
    extra?: unknown;
    execute: Executor;
}

// ---- helpers -----------------------------------------------------------------------------

/** A group created for a change, tracked by name from before its create is sent. */
interface TrackedGroup {
    type: 0 | 1;
    name: string;
    id?: string;
}

/**
 * Every id an ACL's source or destination references. Endpoint type numbers differ between
 * gateway, switch and access point ACLs, so ids are not filtered by type: a network id
 * never equals a group id, and over-counting only keeps a group longer.
 */
function referencedIds(acl: RawRecord): string[] {
    return [...((acl.sourceIds as string[] | undefined) ?? []), ...((acl.destinationIds as string[] | undefined) ?? [])].map(String);
}

/** A rule list with `acl` at `position` (1 = first). */
function placeAt(acls: RawRecord[], acl: RawRecord, position: number): RawRecord[] {
    const list = [...acls];
    list.splice(Math.min(Math.max(position, 1), list.length + 1) - 1, 0, acl);
    return list;
}

/** The current rule order as reorderGatewayAcls takes it. */
function orderOf(acls: RawRecord[]): Record<string, number> {
    return Object.fromEntries(acls.map((a, i) => [String(a.id), i + 1]));
}

/** What a PUT must resend to put an ACL back exactly as it was. */
function writableAcl(raw: RawRecord): RawRecord {
    const fields = ['description', 'status', 'policy', 'protocols', 'sourceType', 'sourceIds', 'destinationType', 'destinationIds', 'syslog', 'direction', 'stateMode', 'states', 'timeRangeId'];
    return Object.fromEntries(fields.filter((f) => raw[f] !== undefined && raw[f] !== null).map((f) => [f, raw[f]]));
}

/** The original error, with what the undo couldn't do appended. */
function withNote(error: unknown, note: string): unknown {
    if (error instanceof NetError) return new NetError(error.code, `${error.message} (${note})`, error.details);
    return new Error(`${error instanceof Error ? error.message : String(error)} (${note})`);
}

function needsGroups(draft: RuleDraft): boolean {
    return 'newGroup' in draft.source || 'newGroup' in draft.destination;
}

function groupSteps(draft: RuleDraft): Step[] {
    return [draft.source, draft.destination]
        .filter((e): e is Extract<Endpoint, { newGroup: unknown }> => 'newGroup' in e)
        .map((e) => ({ action: 'create' as const, object: e.newGroup.groupType === GROUP_TYPE.ipPort ? 'omada.ipPortGroup' : 'omada.ipGroup', name: e.label }));
}

function aclBody(draft: RuleDraft, description: string, source: { type: number; ids: string[] }, destination: { type: number; ids: string[] }, syslog: boolean): RawRecord {
    return {
        description,
        status: draft.enabled,
        policy: draft.policy,
        protocols: draft.protocols,
        sourceType: source.type,
        sourceIds: source.ids,
        destinationType: destination.type,
        destinationIds: destination.ids,
        syslog,
        direction: { lanToWan: draft.direction === 'lanToWan', lanToLan: draft.direction === 'lanToLan', wanInIds: [], vpnInIds: [] },
        // 0 = "Auto": replies to connections started on the other side pass (see omadaRules.ts).
        stateMode: 0,
    };
}

function describeRuleChanges(current: Rule, next: RuleFields): string[] {
    const out: string[] = [];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (next.name !== current.name) out.push(`name → ${next.name}`);
    if (next.action !== current.action) out.push(`action → ${next.action}`);
    if (!same(next.from, current.from)) out.push('source changed');
    if (!same(next.to, current.to)) out.push('destination changed');
    if (!same(next.protocol, current.protocol)) out.push(`protocol → ${typeof next.protocol === 'object' ? `ports ${next.protocol.tcpUdpPorts}` : next.protocol}`);
    if (next.enabled !== current.enabled) out.push(next.enabled ? 'switched on' : 'switched off');
    return out;
}


function notYet(what: string, release: string): NetError {
    return new NetError('UNSUPPORTED', `Changing ${what} through the net_ tools arrives in ${release}`, { capability: what });
}

function unsupported(what: string, capability: string): NetError {
    return new NetError('UNSUPPORTED', `Omada can't do ${what} through its API`, { capability });
}

/** The network a Wi-Fi network may put its devices on: one with a gateway (and so an address for them). */
function wifiNetwork(networks: Network[], ref: Ref): Network {
    const network = resolve(networks, ref, 'network');
    if (network.purpose === 'vlanOnly') throw new NetError('INVALID', `'${network.name}' is switch-only (no gateway, no DHCP); Wi-Fi clients would get no address`);
    return network;
}

function isIpv4(value: string): boolean {
    try {
        ipToNumber(value);
        return true;
    } catch {
        return false;
    }
}

function resolveSsid(ssids: SsidRaw[], ref: Ref): SsidRaw {
    return resolve(ssids.map((s) => ({ ...s, id: s.ssidId, name: String(s.detail.name) })), ref, 'Wi-Fi network');
}

function bandBits(bands: Band[]): number {
    return bands.reduce((bits, b) => bits | BAND_BITS[b], 0);
}

/** The model's name for an SSID's security (raw security + WPA-Personal version). */
function securityOf(detail: RawRecord, psk: RawRecord): WifiSecurity {
    if (detail.security === SECURITY_NONE) return 'open';
    if (detail.security === 2) return 'enterprise';
    if (detail.security === 4 || detail.security === 5) return 'ppsk';
    return ({ 1: 'wpa1', 2: 'wpa2', 3: 'wpa1wpa2', 4: 'wpa3' } as Record<number, WifiSecurity>)[Number(psk.versionPsk)] ?? 'wpa2';
}

function securityBody(security: WifiSecurity, key: string | undefined): RawRecord {
    if (security === 'open') return { security: SECURITY_NONE };
    if (security === 'wpa2wpa3') throw unsupported('WPA2/WPA3 mixed mode (choose wpa2 or wpa3)', 'wifi.security');
    if (security !== 'wpa2' && security !== 'wpa3') throw new NetError('INVALID', `${security} can't be set through the tools; choose wpa2 or wpa3`);
    if (!key) throw new NetError('INVALID', 'No password to keep for this Wi-Fi network');
    return {
        security: SECURITY_WPA_PERSONAL,
        pskSetting: { securityKey: key, versionPsk: PSK_VERSION[security], encryptionPsk: ENCRYPTION_AES, gikRekeyPskEnable: false },
    };
}

/** Untagged (primary, VLAN 1) or tagged into the network's VLAN. */
function vlanBody(network: Network): RawRecord {
    if (network.vlan === 1) return { vlanEnable: false, vlanSetting: { mode: 0, customConfig: {} } };
    return { vlanEnable: false, vlanSetting: { mode: 1, customConfig: { customMode: 0, lanNetworkVlanIds: { [network.id]: [network.vlan] } } } };
}

/**
 * DHCP fields for the model's settings. With `kept` (an update), what the request doesn't
 * mention stays as it is: the lease, the DNS mode and servers, and anything the model
 * doesn't describe (options, next server), which the caller merges underneath.
 */
function dhcpBody(dhcp: Network['dhcp'], kept?: RawRecord): RawRecord {
    if (!dhcp?.enabled) return { enable: false };
    const dns =
        dhcp.dns === undefined
            ? kept
                ? {}
                : { dhcpns: 'auto' }
            : dhcp.dns.length
              ? { dhcpns: 'manual', priDns: dhcp.dns[0], ...(dhcp.dns[1] ? { sndDns: dhcp.dns[1] } : {}) }
              : { dhcpns: 'auto' };
    return {
        enable: true,
        ...(dhcp.range ? { ipRangePool: [{ ipaddrStart: dhcp.range.from, ipaddrEnd: dhcp.range.to }] } : {}),
        ...(dhcp.leaseMinutes !== undefined ? { leasetime: dhcp.leaseMinutes } : kept ? {} : { leasetime: 120 }),
        ...dns,
    };
}

/** Whether omada_setSsidEnabled has switched this SSID off (radio off, around the clock). */
function radioOffAlways(detail: RawRecord, alwaysProfileId: string | undefined): boolean {
    const schedule = (detail.wlanSchedule ?? {}) as RawRecord;
    return Boolean(alwaysProfileId) && schedule.wlanScheduleEnable === true && schedule.action === 0 && schedule.scheduleId === alwaysProfileId;
}

/** 32 random characters a WPA password accepts; set, never returned. */
function temporaryPassphrase(): string {
    return randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, 'x');
}

function describeNetworkChanges(current: Network, next: { name: string; vlan: number; gateway?: string; dhcp?: Network['dhcp']; ipv6?: boolean }): string[] {
    const out: string[] = [];
    if (next.name !== current.name) out.push(`name → ${next.name}`);
    if (next.vlan !== current.vlan) out.push(`VLAN → ${next.vlan}`);
    if (next.gateway !== current.gateway) out.push(`gateway → ${next.gateway}`);
    if (next.dhcp && !next.dhcp.enabled) out.push('DHCP → off');
    if (next.dhcp?.enabled) {
        const parts = [
            ...(next.dhcp.range ? [`range ${next.dhcp.range.from}-${next.dhcp.range.to}`] : []),
            ...(next.dhcp.leaseMinutes !== undefined ? [`lease ${next.dhcp.leaseMinutes} min`] : []),
            ...(next.dhcp.dns !== undefined ? [`DNS ${next.dhcp.dns.join(', ') || 'automatic'}`] : []),
        ];
        out.push(`DHCP → ${parts.join(', ') || 'on'}`);
    }
    if (next.ipv6 === false && current.ipv6) out.push('IPv6 → off');
    return out;
}

/**
 * A controller record with its keys and every list sorted: the lists in port profiles and mDNS
 * rules are sets (ids of networks, services...), so the same state listed in another order
 * fingerprints the same.
 */
const UNREAD = 'The reservation change was accepted, but reading it back failed; check it with net_listReservations.';

/** Controller reservations in the model (entries without an address are left out). */
function toReservations(rows: Array<{ mac: string; ip?: unknown; netId: string; description?: unknown }>): Reservation[] {
    return rows
        .filter((r) => typeof r.ip === 'string')
        .map((r) => ({ mac: formatMac(r.mac), ip: String(r.ip), network: { id: r.netId }, ...(r.description ? { description: String(r.description) } : {}) }));
}

function canonical(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value
            .map(canonical)
            .map((item) => [JSON.stringify(item), item] as const)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, item]) => item);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canonical(v)])
        );
    }
    return value;
}

function describeClients(clients: Client[]): string {
    return clients.map((c) => `${c.name ?? '?'} (${c.mac})`).join(', ');
}

/**
 * Fingerprint of what a plan read, secrets stripped (the Wi-Fi password is never hashed:
 * a hash of a short secret leaks it to anyone who can guess).
 */
function fingerprint(snap: Snapshot, reads: Built['reads'], extra?: unknown): string {
    const material = {
        networks: reads.networks ? snap.networksRaw : undefined,
        ssids: reads.ssids ? redactSecrets(snap.ssids) : undefined,
        // A MAC filter plan resolved a group by name: a renamed or replaced group must not slip through.
        macGroups: reads.macGroups ? snap.macGroups : undefined,
        rules: reads.rules ? { acls: snap.acls, otherAcls: snap.otherAcls, ipGroups: snap.ipGroups, ipPortGroups: snap.ipPortGroups } : undefined,
        extra,
    };
    return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16);
}

