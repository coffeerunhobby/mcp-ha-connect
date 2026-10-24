/**
 * Ruijie / Reyee adapter for the vendor-neutral network model (src/net/model.ts), through the
 * router's local eWeb API (src/ruijieClient). Mapped on a RG-EG105G-V3, ReyeeOS 2.324
 * (2026-10-24). 2.5.0 READS ONLY: every change is refused (UNSUPPORTED) until the write
 * phases (reservations and rules, then networks) are built and live-tested.
 *
 * What is read, and how it maps:
 * - networks: devConfig.get network, `lan[]` (one entry per LAN interface: address, netmask,
 *   VLAN id, DHCP). The default LAN carries Ruijie's internal VLAN 233, untagged on the LAN
 *   ports; the id of a network is its interface name, "vlan<id>", which rules refer to.
 * - clients: the devices the router sees on its LAN right now, from its ARP table (devSta.get
 *   arp, interfaces "br-lan*", resolved MACs only), named by their address lease (devSta.get
 *   dhcp_lease) when they have one. A lease alone is no online device (a switched-off laptop
 *   keeps it until it expires); WAN-side ARP entries are the upstream network.
 * - reservations: devConfig.get dhcp_static.
 * - ports: devSta.get port_status. The router doesn't say which device is on which port, so
 *   `seen` stays empty; the WAN port is the uplink and protected.
 * - rules: devConfig.get access_ctrl (evaluated in list order). Anything the model can't say
 *   faithfully (a source "anywhere", source ports, IPv6, user groups, schedules, a rule that
 *   matches only some connection states) is listed as `foreign` with the reason.
 * No Wi-Fi radio on this model, no switch port profiles, no mDNS repeater; groups (Ruijie's
 * user groups are address ranges and users, not the model's address groups) come later.
 */

import { formatMac, normalizeMac } from '../../omadaClient/client.js';
import type { RuijieClient } from '../../ruijieClient/index.js';
import { inSubnet, ipToNumber, parseCidr, subnetsOverlap } from '../../utils/ipv4.js';
import {
    NetError,
    type ApplyResult,
    type Capabilities,
    type Change,
    type Client,
    type Group,
    type MdnsRepeater,
    type Network,
    type NetworkController,
    type Plan,
    type Port,
    type PortProfile,
    type PortRef,
    type ProtectedResources,
    type Reservation,
    type Rule,
    type Selector,
    type Wifi,
} from '../model.js';

type Raw = Record<string, unknown>;

/** Ruijie's name for "all the time" in a rule's time setting (the default time group). */
const ALL_TIME = new Set(['所有时段', 'everytime', 'All Time', '']);
const READ_ONLY = 'The Ruijie adapter reads only in this version; changes through it (reservations and rules first, then networks) come in a later version.';

const text = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
const list = (value: unknown): Raw[] => (Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Raw[]) : []);

/** "255.255.255.0" -> 24; undefined for a mask that isn't contiguous ones. */
export function maskToPrefix(mask: string): number | undefined {
    let n: number;
    try {
        n = ipToNumber(mask);
    } catch {
        return undefined;
    }
    let prefix = 0;
    for (let bit = 31; bit >= 0; bit--) {
        if (Math.floor(n / 2 ** bit) % 2 === 1) prefix++;
        else break;
    }
    return n === (prefix === 0 ? 0 : (2 ** 32 - 2 ** (32 - prefix))) ? prefix : undefined;
}

const numberToIp = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

/** One `lan[]` entry as a model network (undefined when its address or mask can't be read). */
export function toNetwork(raw: Raw, index: number, routerHost: string): Network | undefined {
    const ip = text(raw.ipaddr);
    const prefix = maskToPrefix(text(raw.netmask));
    try {
        ipToNumber(ip);
    } catch {
        return undefined;
    }
    if (prefix === undefined) return undefined;
    const vlan = Number(text(raw.vlanid));
    const gateway = `${ip}/${prefix}`;
    const start = text(raw.ipstart);
    const limit = Number(text(raw.limit));
    let range: { from: string; to: string } | undefined;
    try {
        if (start && Number.isInteger(limit) && limit > 0) range = { from: start, to: numberToIp(ipToNumber(start) + limit - 1) };
    } catch {
        range = undefined;
    }
    const lease = Number(text(raw.leasetime));
    let routerAddress: number | undefined;
    try {
        routerAddress = ipToNumber(routerHost);
    } catch {
        routerAddress = undefined;
    }
    return {
        id: `vlan${text(raw.vlanid)}`,
        name: text(raw.desc) || text(raw.name) || (index === 0 ? 'LAN' : `VLAN ${text(raw.vlanid)}`),
        purpose: 'normal',
        vlan: Number.isInteger(vlan) ? vlan : 0,
        gateway,
        dhcp: {
            enabled: text(raw.ignore) !== '1',
            ...(range ? { range } : {}),
            ...(Number.isInteger(lease) && lease > 0 ? { leaseMinutes: lease } : {}),
        },
        ipv6: false,
        isolated: false,
        // The first LAN is the router's own (its management address), and so is any LAN the
        // router is reached through; neither may be cut off.
        protected: index === 0 || (routerAddress !== undefined && inSubnet(routerAddress, gateway)),
    };
}

const networkOf = (ip: string, networks: Network[]): Network | undefined => {
    let n: number;
    try {
        n = ipToNumber(ip);
    } catch {
        return undefined;
    }
    return networks.find((net) => net.gateway && inSubnet(n, net.gateway));
};

const macOrUndefined = (value: unknown): string | undefined => {
    try {
        return formatMac(text(value));
    } catch {
        return undefined;
    }
};

/** The devices the router sees on its LAN (ARP), once each, named by their lease (same MAC and address) when they have one. */
export function toClients(leases: Raw[], arp: Raw[], networks: Network[]): Client[] {
    const names = new Map<string, string>();
    for (const l of leases) {
        const mac = macOrUndefined(l.mac);
        const name = text(l.hostname);
        const key = `${mac}|${text(l.ip)}`;
        if (mac && name && name !== '*' && !names.has(key)) names.set(key, name);
    }
    const clients: Client[] = [];
    const seen = new Set<string>();
    for (const a of arp) {
        if (!text(a.intf).startsWith('br-lan')) continue;
        const mac = macOrUndefined(a.hardware);
        // 00:00:00:00:00:00 = an address nobody answered for.
        if (!mac || mac === '00-00-00-00-00-00' || seen.has(mac)) continue;
        seen.add(mac);
        const ip = text(a.address);
        const network = networkOf(ip, networks);
        const name = names.get(`${mac}|${ip}`);
        clients.push({ mac, ...(name ? { name } : {}), ...(ip ? { ip } : {}), ...(network ? { network: { id: network.id } } : {}), online: true });
    }
    return clients;
}

export function toReservations(entries: Raw[], networks: Network[]): Reservation[] {
    const out: Reservation[] = [];
    for (const e of entries) {
        const mac = macOrUndefined(e.macaddr);
        const ip = text(e.ipaddr);
        if (!mac || !ip) continue;
        const network = networkOf(ip, networks);
        out.push({ mac, ip, network: network ? { id: network.id } : { name: 'outside the router\'s networks' } });
    }
    return out;
}

export function toPorts(entries: Raw[], routerMac: string): Port[] {
    return entries.map((p) => {
        const wan = text(p.name).toUpperCase() === 'WAN';
        return {
            device: { mac: routerMac },
            port: Number(text(p.portId)),
            ...(text(p.panel_name) ? { name: text(p.panel_name) } : {}),
            seen: [],
            uplink: wan,
            ...(wan ? { protected: "it is the router's internet (WAN) port" } : {}),
        };
    });
}

/**
 * A rule side (src or dest, with its addresses) as model selectors, or the reason it can't be one.
 * The model's address selector carries no interface, so addresses are kept only where they imply
 * the interface the rule names: inside the LANs (lan) or that VLAN (vlanX), outside every LAN
 * (wan), or any interface (all). Anything else would overstate or misplace what the rule matches.
 */
function side(where: string, addresses: string, networks: Network[], isSource: boolean): Selector[] | string {
    if (addresses) {
        const parts = addresses.split(',').map((a) => a.trim()).filter(Boolean);
        if (parts.some((a) => a.includes('-'))) return `an address range (${addresses})`;
        let ranges: Array<{ network: number; broadcast: number }>;
        try {
            ranges = parts.map((a) => parseCidr(a));
        } catch {
            return `an address it can't read (${addresses})`;
        }
        const inside = (nets: Network[]) => ranges.every((r) => nets.some((n) => n.gateway && r.network >= parseCidr(n.gateway).network && r.broadcast <= parseCidr(n.gateway).broadcast));
        const lans = networks.filter((n) => n.gateway);
        const implied =
            where === 'all' ||
            (where === 'lan' && inside(lans)) ||
            (where === 'wan' && parts.every((a) => !lans.some((n) => subnetsOverlap(a, n.gateway!)))) ||
            (where.startsWith('vlan') && inside(networks.filter((n) => n.id === where)));
        if (!implied) return `addresses (${addresses}) limited to the interface '${where}'`;
        return [{ addresses: parts }];
    }
    if (where === 'wan') return [{ internet: true }];
    if (where === 'lan') return networks.map((n) => ({ network: { id: n.id } }));
    if (where === 'all') return isSource ? 'traffic from anywhere, the internet included' : 'traffic to anywhere';
    const network = networks.find((n) => n.id === where);
    if (network) return [{ network: { id: network.id } }];
    return `the interface '${where}'`;
}

export function toRule(raw: Raw, index: number, networks: Network[]): Rule {
    const reasons: string[] = [];
    const target = text(raw.target).toUpperCase();
    const action: Rule['action'] = target === 'ACCEPT' ? 'allow' : 'block';
    if (!['ACCEPT', 'DROP', 'REJECT'].includes(target)) reasons.push(`an unknown action '${text(raw.target)}'`);
    let from: Selector[] = [];
    if (text(raw.by) === 'mac') {
        const mac = macOrUndefined(raw.mac);
        if (mac) from = [{ device: mac }];
        else reasons.push('a device match without a readable MAC');
        // The model's device match has no interface: only "any LAN" or "anywhere" say the same.
        const where = text(raw.src);
        if (where && where !== 'lan' && where !== 'all') reasons.push(`a device match limited to the interface '${where}'`);
    } else {
        const s = side(text(raw.src), text(raw.srcIP), networks, true);
        if (typeof s === 'string') reasons.push(s);
        else from = s;
    }
    let to: Selector[] = [];
    const d = side(text(raw.dest), text(raw.destIP), networks, false);
    if (typeof d === 'string') reasons.push(d);
    else to = d;
    const proto = text(raw.proto).toLowerCase();
    let protocol: Rule['protocol'] = 'any';
    if (proto === 'tcp' || proto === 'udp' || proto === 'icmp') protocol = proto;
    else if (proto === 'tcpudp' && !text(raw.destPort)) reasons.push('TCP and UDP together without ports');
    else if (proto !== 'all' && proto !== '' && proto !== 'tcpudp') reasons.push(`the protocol '${text(raw.proto)}'`);
    if (text(raw.destPort)) {
        // The model's ports mean TCP and UDP together; a rule for one of them only would be overstated.
        if (proto === 'tcpudp') protocol = { tcpUdpPorts: text(raw.destPort) };
        else if (proto === 'tcp' || proto === 'udp') reasons.push(`destination ports for ${proto} only (the model's ports mean TCP and UDP)`);
        else reasons.push('destination ports without TCP or UDP');
    }
    if (text(raw.srcPort)) reasons.push('source ports');
    if (text(raw.netProto) && text(raw.netProto) !== 'ipv4') reasons.push(`an ${text(raw.netProto)} rule`);
    if (list(raw.user).length || list(raw.user_group_list).length || (Array.isArray(raw.userGroupList) && raw.userGroupList.length)) reasons.push('user groups');
    if (!ALL_TIME.has(text(raw.tmngtName))) reasons.push(`a schedule ('${text(raw.tmngtName)}')`);
    // "0" = every connection state, replies included (the rule is not stateful).
    const state = text(raw.state) || '0';
    if (state !== '0') reasons.push(`only some connection states (${state})`);
    return {
        id: text(raw.uuid) || text(raw.ruleid) || `rule-${index + 1}`,
        name: text(raw.ruleName) || `rule ${index + 1}`,
        action,
        from,
        to,
        protocol,
        replies: 'match',
        schedule: { kind: 'always' },
        enabled: text(raw.enable) === '1',
        position: index + 1,
        ...(reasons.length ? { foreign: { reason: `Read-only here: it uses ${reasons.join(', ')}.` } } : {}),
    };
}

export interface RuijieAdapterOptions {
    /** An id for this router (several may be configured later). */
    id?: string;
}

export class RuijieNetworkController implements NetworkController {
    readonly vendor = 'ruijie' as const;
    readonly id: string;

    constructor(
        private readonly client: RuijieClient,
        options: RuijieAdapterOptions = {}
    ) {
        this.id = options.id ?? `ruijie:${client.host}`;
    }

    async capabilities(): Promise<Capabilities> {
        return {
            vendor: 'ruijie',
            networks: { create: 'unsupported', isolation: 'unsupported', ipv6: 'unsupported', guestPurpose: 'unsupported' },
            wifi: { create: 'unsupported', bands: [], security: [], pmf: 'unsupported', fastRoaming: 'unsupported', bandSteering: 'unsupported' },
            ports: { profiles: 'unsupported', assign: 'unsupported' },
            rules: { between: 'unsupported', toInternet: 'unsupported', deviceMatch: 'unsupported', wifiMatch: 'unsupported', stateful: 'unsupported', schedule: 'unsupported' },
            groups: { address: 'unsupported', mac: 'unsupported' },
            reservations: 'unsupported',
            mdnsRepeater: 'unsupported',
        };
    }

    async protectedResources(): Promise<ProtectedResources> {
        const networks = (await this.listNetworks()).filter((n) => n.protected);
        const ports = (await this.listPorts()).filter((p) => p.protected);
        return { networks: networks.map((n) => ({ id: n.id })), ports: ports.map((p) => ({ device: p.device, port: p.port })), devices: [] };
    }

    async listNetworks(): Promise<Network[]> {
        const config = await this.client.config<Raw>('network');
        return list(config.lan)
            .map((raw, i) => toNetwork(raw, i, this.client.host))
            .filter((n): n is Network => n !== undefined);
    }

    async listWifi(): Promise<Wifi[]> {
        return [];
    }

    async listPortProfiles(): Promise<PortProfile[]> {
        return [];
    }

    async listPorts(device?: PortRef['device']): Promise<Port[]> {
        const info = await this.client.status<Raw>('sysinfo');
        const routerMac = macOrUndefined(info.sys_mac) ?? 'unknown';
        if (device) {
            const wanted = 'mac' in device ? device.mac : 'id' in device ? device.id : device.name;
            const names = [routerMac, text(info.model), text(info.product_class), 'router'].map((v) => v.toLowerCase());
            if (normalizeMac(wanted) !== normalizeMac(routerMac) && !names.includes(wanted.trim().toLowerCase())) {
                throw new NetError('NOT_FOUND', `This Ruijie router (${text(info.model) || 'router'}, ${routerMac}) is the only device here; '${wanted}' is not it`);
            }
        }
        const status = await this.client.status<Raw>('port_status');
        return toPorts(list(status.List), routerMac);
    }

    async listRules(): Promise<Rule[]> {
        const networks = await this.listNetworks();
        const acl = await this.client.config<Raw>('access_ctrl');
        return list(acl.list).map((raw, i) => toRule(raw, i, networks));
    }

    async listGroups(): Promise<Group[]> {
        return [];
    }

    async listReservations(): Promise<Reservation[]> {
        const networks = await this.listNetworks();
        const config = await this.client.config<Raw>('dhcp_static');
        return toReservations(list(config.dhcp_static), networks);
    }

    async listClients(): Promise<Client[]> {
        const networks = await this.listNetworks();
        const leases = await this.client.status<Raw>('dhcp_lease');
        const arp = await this.client.status<Raw>('arp');
        return toClients(list(leases.List), list(arp.arpList), networks);
    }

    async getMdnsRepeater(): Promise<MdnsRepeater> {
        return { enabled: false, networks: [], foreign: { reason: 'This Ruijie router has no mDNS repeater the tools manage.' } };
    }

    async plan(change: Change): Promise<Plan> {
        throw new NetError('UNSUPPORTED', READ_ONLY, { capability: change.kind });
    }

    async apply(): Promise<ApplyResult> {
        throw new NetError('UNSUPPORTED', READ_ONLY);
    }
}
