/**
 * FortiGate adapter for the vendor-neutral net_* tools, READ-ONLY (FortiOS 7.x REST API).
 *
 * What it reads (src/fortigateClient):
 * - networks: cmdb system/interface (routed LAN interfaces: physical, hardware switch, VLAN,
 *   aggregate) with cmdb system.dhcp/server for DHCP. WAN-role interfaces, tunnels, loopbacks
 *   and interfaces without an address are left out.
 * - ports: monitor system/interface (link, speed) for the physical ports, with the networks each
 *   carries (its own, the hardware switch it is a member of, VLANs on it).
 * - rules: cmdb firewall/policy, in evaluation order. A policy maps when its sources and
 *   destinations are interfaces of listed networks or the WAN, with "all" or plain addresses,
 *   one of ALL / ALL_TCP / ALL_UDP / ALL_ICMP / PING as service and the "always" schedule;
 *   anything else (zones, named schedules, internet services, users, negation, custom services)
 *   is listed as foreign, read-only.
 * - groups: cmdb firewall/addrgrp with the members resolved through firewall/address.
 * - reservations: the DHCP servers' reserved addresses; clients: DHCP leases + the ARP table.
 * - firmware: monitor system/firmware (running and offered versions).
 *
 * Every change is refused (UNSUPPORTED): writes come only once the owner decides on them.
 */

import { formatMac, normalizeMac } from '../../omadaClient/client.js';
import { FortiGateError, type FortiGateClient } from '../../fortigateClient/index.js';
import { inSubnet, ipToNumber, parseCidr, subnetsOverlap } from '../../utils/ipv4.js';
import {
    NetError,
    type ApplyResult,
    type Capabilities,
    type Change,
    type Client,
    type Firmware,
    type Group,
    type MdnsRepeater,
    type Network,
    type NetworkController,
    type Plan,
    type Port,
    type PortProfile,
    type PortRef,
    type ProtectedResources,
    type Ref,
    type Reservation,
    type Rule,
    type Selector,
    type Wifi,
} from '../model.js';

type Raw = Record<string, unknown>;

export const FORTIGATE_READ_ONLY = 'The FortiGate is read-only through these tools for now; make changes in its web UI.';

export interface FortiGateAdapterOptions {
    /** Defaults to "fortigate:<host>". */
    id?: string;
    /** This server's LAN addresses (MCP_SERVER_ADDRESSES): the network holding one is protected. */
    serverHosts?: string[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const list = (value: unknown): Raw[] => (Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Raw[]) : []);
const names = (value: unknown): string[] => list(value).map((v) => text(v.name)).filter(Boolean);

/** "255.255.255.0" -> 24; undefined for a mask that isn't contiguous. */
export function maskToPrefix(mask: string): number | undefined {
    let n: number;
    try {
        n = ipToNumber(mask);
    } catch {
        return undefined;
    }
    const bits = n.toString(2).padStart(32, '0');
    if (!/^1*0*$/.test(bits)) return undefined;
    return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
}

/** FortiOS "a.b.c.d m.m.m.m" -> "a.b.c.d/p"; undefined for 0.0.0.0 or anything unreadable. */
export function toCidr(value: unknown): string | undefined {
    const [ip, mask] = text(value).trim().split(/\s+/);
    if (!ip || !mask || ip === '0.0.0.0') return undefined;
    const prefix = mask.includes('.') ? maskToPrefix(mask) : Number(mask);
    if (prefix === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return undefined;
    try {
        ipToNumber(ip);
    } catch {
        return undefined;
    }
    return `${ip}/${prefix}`;
}

function macOf(value: unknown): string | undefined {
    const hex = normalizeMac(text(value));
    return /^[0-9A-F]{12}$/.test(hex) && hex !== '000000000000' ? formatMac(hex) : undefined;
}

const ROUTED_TYPES = new Set(['physical', 'hard-switch', 'vlan', 'aggregate', 'redundant', 'switch', 'emac-vlan']);

interface Snapshot {
    interfaces: Raw[];
    dhcpServers: Raw[];
}

export class FortiGateNetworkController implements NetworkController {
    readonly vendor = 'fortigate' as const;
    readonly id: string;
    private readonly serverAddresses: number[];

    constructor(
        private readonly client: FortiGateClient,
        options: FortiGateAdapterOptions = {}
    ) {
        this.id = options.id ?? `fortigate:${client.host}`;
        this.serverAddresses = (options.serverHosts ?? []).flatMap((host) => {
            try {
                return [ipToNumber(host)];
            } catch {
                return [];
            }
        });
    }

    async capabilities(): Promise<Capabilities> {
        return {
            vendor: 'fortigate',
            networks: { create: 'unsupported', isolation: 'unsupported', ipv6: 'unsupported', guestPurpose: 'unsupported' },
            wifi: { create: 'unsupported', bands: [], security: [], pmf: 'unsupported', fastRoaming: 'unsupported', bandSteering: 'unsupported' },
            ports: { profiles: 'unsupported', assign: 'unsupported' },
            rules: { between: 'unsupported', toInternet: 'unsupported', deviceMatch: 'unsupported', wifiMatch: 'unsupported', stateful: 'unsupported', schedule: 'unsupported' },
            groups: { address: 'unsupported', mac: 'unsupported' },
            reservations: 'unsupported',
            mdnsRepeater: 'unsupported',
            firmware: 'unsupported',
        };
    }

    async protectedResources(): Promise<ProtectedResources> {
        const networks = (await this.listNetworks()).filter((n) => n.protected);
        const ports = (await this.listPorts()).filter((p) => p.protected);
        return { networks: networks.map((n) => ({ id: n.id })), ports: ports.map((p) => ({ device: p.device, port: p.port })), devices: [] };
    }

    private async snapshot(): Promise<Snapshot> {
        const interfaces = (await this.client.cmdb<Raw[]>('system', 'interface')).results;
        let dhcpServers: Raw[] = [];
        try {
            dhcpServers = list((await this.client.cmdb<Raw[]>('system.dhcp', 'server')).results);
        } catch (error) {
            // A profile without DHCP read access still lists the networks, without their DHCP.
            if (!(error instanceof FortiGateError && (error.kind === 'forbidden' || error.kind === 'notFound'))) throw error;
        }
        return { interfaces: list(interfaces), dhcpServers };
    }

    /** Whether an interface is a routed LAN-side network the model lists. */
    private routed(raw: Raw): boolean {
        return ROUTED_TYPES.has(text(raw.type)) && text(raw.role) !== 'wan' && toCidr(raw.ip) !== undefined;
    }

    async listNetworks(): Promise<Network[]> {
        const { interfaces, dhcpServers } = await this.snapshot();
        return interfaces.filter((raw) => this.routed(raw)).flatMap((raw) => [this.toNetwork(raw, dhcpServers), ...this.secondaryNetworks(raw)]);
    }

    /** An interface's secondary subnets, each as a network of its own ("<interface>:secondary:<id>"), without DHCP. */
    private secondaryNetworks(raw: Raw): Network[] {
        const name = text(raw.name);
        return list(raw.secondaryip).flatMap((sec) => {
            const gateway = toCidr(sec.ip);
            if (!gateway) return [];
            const primary = this.toNetwork({ ...raw, ip: sec.ip }, []);
            return [{ ...primary, id: `${name}:secondary:${text(sec.id)}`, name: `${text(raw.alias) || name} (secondary ${text(sec.id)})`, gateway, dhcp: { enabled: false } }];
        });
    }

    private toNetwork(raw: Raw, dhcpServers: Raw[]): Network {
        const name = text(raw.name);
        const gateway = toCidr(raw.ip)!;
        const server = dhcpServers.find((s) => text(s.interface) === name);
        const range = list(server?.['ip-range'])[0];
        const lease = Number(server?.['lease-time']);
        const dns = server && text(server['dns-service']) === 'specify' ? [server['dns-server1'], server['dns-server2'], server['dns-server3']].map(text).filter((v) => v && v !== '0.0.0.0') : [];
        const vlan = text(raw.type) === 'vlan' ? Number(raw.vlanid) : 1;
        const host = ((): number | undefined => {
            try {
                return ipToNumber(this.client.host);
            } catch {
                return undefined;
            }
        })();
        const holds = (address: number) => inSubnet(address, gateway);
        return {
            id: name,
            name: text(raw.alias) || name,
            purpose: 'normal',
            vlan: Number.isInteger(vlan) && vlan >= 1 && vlan <= 4094 ? vlan : 1,
            gateway,
            ...(server
                ? {
                      dhcp: {
                          enabled: text(server.status) !== 'disable',
                          ...(range ? { range: { from: text(range['start-ip']), to: text(range['end-ip']) } } : {}),
                          ...(Number.isFinite(lease) && lease > 0 ? { leaseMinutes: Math.round(lease / 60) } : {}),
                          ...(dns.length ? { dns } : {}),
                      },
                  }
                : { dhcp: { enabled: false } }),
            ipv6: false,
            isolated: false,
            // The network this server or the address it reaches the FortiGate on lives in.
            protected: this.serverAddresses.some(holds) || (host !== undefined && holds(host)),
        };
    }

    async listWifi(): Promise<Wifi[]> {
        return [];
    }

    async listPortProfiles(): Promise<PortProfile[]> {
        return [];
    }

    /** The FortiGate's identity; a device given must be it (by serial, hostname, model or "fortigate"). */
    private async device(device?: PortRef['device']): Promise<{ serial: string; hostname: string; model: string; version: string }> {
        const status = await this.client.monitor<Raw>('system', 'status');
        const r = status.results ?? {};
        const serial = status.serial ?? 'unknown';
        const hostname = text(r.hostname);
        const model = [text(r.model_name), text(r.model_number)].filter(Boolean).join(' ') || text(r.model) || 'FortiGate';
        if (device) {
            const wanted = ('mac' in device ? device.mac : 'id' in device ? device.id : device.name).trim().toLowerCase();
            const known = [serial, hostname, model, text(r.model), 'fortigate'].map((v) => v.toLowerCase());
            if (!known.includes(wanted)) throw new NetError('NOT_FOUND', `This FortiGate (${hostname || model}, ${serial}) is the only device here; '${wanted}' is not it`);
        }
        return { serial, hostname, model, version: status.version ?? 'unknown' };
    }

    async listPorts(device?: PortRef['device']): Promise<Port[]> {
        const { serial } = await this.device(device);
        const { interfaces } = await this.snapshot();
        // FortiOS 7.4 answers an object keyed by interface name; accept a list of records too.
        const answer = (await this.client.monitor<Record<string, Raw> | Raw[]>('system', 'interface', undefined, { include_vlan: false })).results ?? {};
        const live: Record<string, Raw> = Array.isArray(answer) ? Object.fromEntries(list(answer).map((r) => [text(r.name), r])) : answer;
        let switches: Raw[] = [];
        try {
            switches = list((await this.client.cmdb<Raw[]>('system', 'virtual-switch')).results);
        } catch (error) {
            if (!(error instanceof FortiGateError && (error.kind === 'notFound' || error.kind === 'forbidden'))) throw error;
        }
        const routed = new Set(interfaces.filter((raw) => this.routed(raw)).map((raw) => text(raw.name)));
        const memberOf = new Map<string, string>();
        for (const sw of switches) for (const port of names(sw.port)) memberOf.set(port, text(sw.name));
        for (const raw of interfaces) if (text(raw.type) === 'hard-switch') for (const port of names(raw.member)) memberOf.set(port, text(raw.name));
        const clients = await this.listClients();
        const physical = interfaces.filter((raw) => text(raw.type) === 'physical').sort((a, b) => text(a.name).localeCompare(text(b.name), undefined, { numeric: true }));
        return physical.map((raw, i): Port => {
            const name = text(raw.name);
            const own = memberOf.get(name) ?? name;
            const tagged = interfaces.filter((v) => text(v.type) === 'vlan' && text(v.interface) === own && routed.has(text(v.name))).map((v): Ref => ({ id: text(v.name) }));
            const wan = text(raw.role) === 'wan';
            const reachesUs = toCidr(raw.ip)?.split('/')[0] === this.client.host;
            return {
                device: { id: serial },
                port: i + 1,
                name: live[name] && live[name].link === false ? `${name} (down)` : name,
                networks: { ...(routed.has(own) ? { native: { id: own } } : {}), tagged: tagged.length ? tagged : 'none' },
                seen: clients.filter((c) => c.online && c.network && 'id' in c.network && c.network.id === name),
                uplink: wan,
                ...(reachesUs ? { protected: 'This server reaches the FortiGate through this port' } : wan ? { protected: 'WAN port' } : {}),
            };
        });
    }

    async listRules(): Promise<Rule[]> {
        const { interfaces, dhcpServers } = await this.snapshot();
        const networks = new Map(interfaces.filter((raw) => this.routed(raw)).map((raw) => [text(raw.name), this.toNetwork(raw, dhcpServers)]));
        const wan = new Set(interfaces.filter((raw) => text(raw.role) === 'wan').map((raw) => text(raw.name)));
        const policies = list((await this.client.cmdb<Raw[]>('firewall', 'policy')).results);
        const addresses = new Map(list((await this.client.cmdb<Raw[]>('firewall', 'address')).results).map((a) => [text(a.name), a]));
        // Each group: whether its listed entries say all it holds (no FQDN, range or nested group), and its addresses.
        let groups = new Map<string, GroupInfo>();
        try {
            groups = new Map(
                list((await this.client.cmdb<Raw[]>('firewall', 'addrgrp')).results).map((g) => [
                    text(g.name),
                    {
                        complete: groupComplete(g, addresses),
                        addresses: names(g.member).flatMap((m) => (addressValue(addresses.get(m))?.kind === 'address' ? addressValue(addresses.get(m))!.values : [])),
                        macs: names(g.member).some((m) => addressValue(addresses.get(m))?.kind === 'mac'),
                    },
                ])
            );
        } catch (error) {
            if (!(error instanceof FortiGateError && (error.kind === 'forbidden' || error.kind === 'notFound'))) throw error;
        }
        // Interfaces carrying further subnets than the primary one their network shows.
        const secondary = new Set(interfaces.filter((raw) => text(raw['secondary-IP']) === 'enable' || list(raw.secondaryip).length > 0).map((raw) => text(raw.name)));
        return policies.map((raw, i) => toRule(raw, i, { networks, wan, addresses, groups, secondary }));
    }

    async listGroups(kind?: Group['kind']): Promise<Group[]> {
        const addresses = new Map(list((await this.client.cmdb<Raw[]>('firewall', 'address')).results).map((a) => [text(a.name), a]));
        const groups = list((await this.client.cmdb<Raw[]>('firewall', 'addrgrp')).results);
        const out: Group[] = [];
        for (const g of groups) {
            // A group the model can't say in full (FQDN, range, nested or excluded members) is left out:
            // its entries would understate what it matches. fortigate_read shows every group.
            if (!groupComplete(g, addresses)) continue;
            const entries: Group['entries'] = [];
            let groupKind: Group['kind'] | undefined;
            for (const member of names(g.member)) {
                const value = addressValue(addresses.get(member));
                if (!value) continue;
                groupKind ??= value.kind;
                if (value.kind !== groupKind) continue;
                for (const v of value.values) entries.push({ value: v, name: member });
            }
            const k = groupKind ?? 'address';
            if (!kind || kind === k) out.push({ id: text(g.name), name: text(g.name), kind: k, entries });
        }
        return out;
    }

    async listReservations(): Promise<Reservation[]> {
        const { dhcpServers } = await this.snapshot();
        const out: Reservation[] = [];
        for (const server of dhcpServers) {
            for (const r of list(server['reserved-address'])) {
                const mac = macOf(r.mac);
                // "reserved" (the default) fixes the address; "assign" and "block" are MAC access rules.
                const action = text(r.action) || 'reserved';
                if (!mac || action !== 'reserved' || !text(r.ip) || text(r.ip) === '0.0.0.0') continue;
                out.push({ mac, ip: text(r.ip), network: { id: text(server.interface) }, ...(text(r.description) ? { description: text(r.description) } : {}) });
            }
        }
        return out;
    }

    async listClients(): Promise<Client[]> {
        const leases = list((await this.client.monitor<Raw[]>('system', 'dhcp')).results);
        const arp = list((await this.client.monitor<Raw[]>('network', 'arp')).results);
        const byMac = new Map<string, Client>();
        for (const lease of leases) {
            const mac = macOf(lease.mac);
            if (!mac) continue;
            byMac.set(mac, { mac, ...(text(lease.hostname) ? { name: text(lease.hostname) } : {}), ...(text(lease.ip) ? { ip: text(lease.ip) } : {}), ...(text(lease.interface) ? { network: { id: text(lease.interface) } } : {}), online: false });
        }
        for (const entry of arp) {
            const mac = macOf(entry.mac);
            if (!mac) continue;
            const known = byMac.get(mac);
            byMac.set(mac, { ...(known ?? { mac }), ...(text(entry.ip) ? { ip: text(entry.ip) } : {}), ...(text(entry.interface) ? { network: { id: text(entry.interface) } } : {}), online: true });
        }
        return [...byMac.values()];
    }

    async getMdnsRepeater(): Promise<MdnsRepeater> {
        return { enabled: false, networks: [], foreign: { reason: 'The FortiGate is read-only through these tools; its multicast settings are not read.' } };
    }

    async listFirmware(): Promise<Firmware[]> {
        const { serial, hostname, model, version } = await this.device();
        let current = version;
        let available: Firmware['available'];
        try {
            const fw = ((await this.client.monitor<Raw>('system', 'firmware')).results ?? {}) as Raw;
            const cur = (fw.current ?? {}) as Raw;
            current = text(cur.version) || current;
            const newer = list(fw.available)
                .filter((o) => text(o.version) && compareVersions(text(o.version), current) > 0)
                .sort((a, b) => compareVersions(text(b.version), text(a.version)));
            // The newest on the running branch (7.4.x for 7.4.4) is the usual upgrade; newer branches are named.
            const branchOf = (v: string) => (v.match(/\d+/g) ?? []).slice(0, 2).join('.');
            const branch = branchOf(current);
            const sameBranch = newer.find((o) => branchOf(text(o.version)) === branch);
            // Otherwise the newest Mature release, else the newest.
            const best = sameBranch ?? newer.find((o) => text(o.maturity) === 'M') ?? newer[0];
            if (best) {
                const others: string[] = [];
                for (const o of newer) {
                    const b = branchOf(text(o.version));
                    if (b !== branch && !others.some((x) => branchOf(x) === b)) others.push(text(o.version));
                }
                const kind = (o: Raw) => (text(o.maturity) === 'M' ? 'Mature' : text(o.maturity) === 'F' ? 'Feature' : '');
                const label = (v: string) => {
                    const k = kind(newer.find((o) => text(o.version) === v) ?? {});
                    return k ? `${v} (${k})` : v;
                };
                const where = sameBranch ? `the newest on the running ${branch} branch` : `on a newer branch (${branchOf(text(best.version))})`;
                const also = sameBranch && others.length ? ` Newer branches offered: ${others.map(label).join(', ')}.` : '';
                const k = kind(best);
                available = { version: text(best.version), notes: `${k ? `${k} release, ` : ''}${where}.${also}` };
            }
        } catch (error) {
            // Without FortiGuard access (or the permission) only the running version is known.
            if (!(error instanceof FortiGateError && (error.kind === 'forbidden' || error.kind === 'notFound' || error.kind === 'device'))) throw error;
        }
        return [{ device: { id: serial }, ...(hostname ? { name: hostname } : {}), model, current, ...(available ? { available } : {}), upgradable: false }];
    }

    async plan(change: Change): Promise<Plan> {
        throw new NetError('UNSUPPORTED', FORTIGATE_READ_ONLY, { capability: change.kind });
    }

    async apply(): Promise<ApplyResult> {
        throw new NetError('UNSUPPORTED', FORTIGATE_READ_ONLY);
    }
}

/** "v7.4.4" vs "v7.2.10": positive when a is newer. */
export function compareVersions(a: string, b: string): number {
    const parse = (v: string) => (v.match(/\d+/g) ?? []).map(Number);
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d) return d;
    }
    return 0;
}

/** What one firewall address object stands for, when the model can say it. */
function addressValue(raw: Raw | undefined): { kind: 'address' | 'mac'; values: string[] } | undefined {
    if (!raw) return undefined;
    const type = text(raw.type) || 'ipmask';
    if (type === 'ipmask') {
        const cidr = toCidr(raw.subnet);
        if (!cidr) return text(raw.subnet).startsWith('0.0.0.0 0.0.0.0') ? undefined : undefined;
        return { kind: 'address', values: [cidr.endsWith('/32') ? cidr.slice(0, -3) : cidr] };
    }
    if (type === 'mac') {
        const macs = list(raw.macaddr).map((m) => macOf(m.macaddr)).filter((m): m is string => !!m);
        return macs.length ? { kind: 'mac', values: macs } : undefined;
    }
    return undefined;
}

// PING (echo requests only) is narrower than the model's icmp, so it isn't here.
const isOff = (value: unknown) => value === 'disable' || value === false || value === 0 || value === '' || value === null || value === undefined || (Array.isArray(value) && value.length === 0);
const zeroTos = (value: unknown) => isOff(value) || /^0x0+$/i.test(text(value));

/** Policy fields (FortiOS 7.4) that narrow its match, each with what its default looks like. */
const NARROWING: Array<[string, (value: unknown) => boolean]> = [
    ['ztna-status', isOff],
    ['ztna-device-ownership', isOff],
    ['ztna-ems-tag', isOff],
    ['ztna-ems-tag-secondary', isOff],
    ['ztna-geo-tag', isOff],
    ['network-service-dynamic', isOff],
    ['network-service-src-dynamic', isOff],
    ['reputation-minimum', isOff],
    ['reputation-minimum6', isOff],
    ['src-vendor-mac', isOff],
    ['tos-mask', zeroTos],
    ['sgt-check', isOff],
    ['sgt', isOff],
    ['fsso-groups', isOff],
    ['vlan-filter', isOff],
];

const SERVICES: Record<string, Rule['protocol']> = { ALL: 'any', ALL_TCP: 'tcp', ALL_UDP: 'udp', ALL_ICMP: 'icmp' };

interface RuleContext {
    networks: Map<string, Network>;
    wan: Set<string>;
    addresses: Map<string, Raw>;
    groups: Map<string, GroupInfo>;
    secondary: Set<string>;
}

interface GroupInfo {
    complete: boolean;
    addresses: string[];
    /** Holds MAC objects. */
    macs: boolean;
}

/** Whether an address or CIDR lies wholly inside a network (its gateway form "a.b.c.d/p"). */
function within(address: string, network: string): boolean {
    try {
        const a = parseCidr(address);
        const n = parseCidr(network);
        return a.network >= n.network && a.broadcast <= n.broadcast;
    } catch {
        return false;
    }
}

/** Whether every member of a group is an address or MAC object of one kind the model can say. */
function groupComplete(group: Raw, addresses: Map<string, Raw>): boolean {
    // A group with exclusions matches its members minus others: not a list of entries.
    if (text(group.exclude) === 'enable' || names(group['exclude-member']).length) return false;
    const kinds = names(group.member).map((m) => addressValue(addresses.get(m))?.kind);
    return kinds.length > 0 && kinds.every((k) => k !== undefined && k === kinds[0]);
}

/** One side of a policy (interfaces + addresses) as selectors, or why it can't be. */
function side(interfaces: string[], addrs: string[], context: RuleContext): Selector[] | string {
    const all = addrs.length === 1 && addrs[0] === 'all';
    if (!interfaces.length) return 'names no interface';
    if (interfaces.some((i) => i === 'any')) return 'matches any interface';
    if (interfaces.some((i) => context.wan.has(i)) && !interfaces.every((i) => context.wan.has(i))) return 'mixes WAN and LAN interfaces';
    if (interfaces.every((i) => context.wan.has(i))) {
        if (all) return [{ internet: true }];
        const sel = addressSelectors(addrs, context);
        if (typeof sel === 'string') return sel;
        // Outside addresses reach the WAN by routing; one inside a LAN network would not be what the WAN side says.
        const lans = [...context.networks.values()].map((n) => n.gateway!).filter(Boolean);
        if (sel.addresses.some((a) => lans.some((n) => overlaps(a, n)))) return 'uses addresses inside a LAN network on its WAN side';
        return sel.selectors;
    }
    if (!interfaces.every((i) => context.networks.has(i))) return `uses interfaces or zones the model doesn't list (${interfaces.join(', ')})`;
    if (interfaces.some((i) => context.secondary.has(i))) return 'uses an interface with secondary addresses (its network shows only the primary subnet)';
    if (all) return interfaces.map((i): Selector => ({ network: { id: i } }));
    // Addresses on LAN interfaces: the addresses say who, as long as they lie inside those networks
    // (then the interface limit adds nothing). MACs are only seen on their own segment.
    const sel = addressSelectors(addrs, context);
    if (typeof sel === 'string') return sel;
    const own = interfaces.map((i) => context.networks.get(i)!.gateway!).filter(Boolean);
    if (!sel.addresses.every((a) => own.some((n) => within(a, n)))) return 'uses addresses outside the networks of its interfaces';
    // A device (MAC) matches wherever it is in the model; here only on these interfaces.
    if (sel.macs && ![...context.networks.keys()].every((n) => interfaces.includes(n))) return 'matches a device by MAC only on some networks (the model\'s device rule holds on every network)';
    return sel.selectors;
}

function overlaps(address: string, network: string): boolean {
    try {
        return subnetsOverlap(address.includes('/') ? address : `${address}/32`, network);
    } catch {
        return true;
    }
}

/** The selectors for a list of address objects, with every IP address or network they stand for. */
function addressSelectors(addrs: string[], context: RuleContext): { selectors: Selector[]; addresses: string[]; macs: boolean } | string {
    const out: Selector[] = [];
    const plain: string[] = [];
    const covered: string[] = [];
    let macs = false;
    for (const name of addrs) {
        if (name === 'all') return 'mixes "all" with other addresses';
        const group = context.groups.get(name);
        if (group) {
            if (!group.complete) return `uses the group '${name}', which holds members the model can't express (FQDN, range, nested group...)`;
            out.push({ group: { name } });
            covered.push(...group.addresses);
            macs ||= group.macs;
            continue;
        }
        const value = addressValue(context.addresses.get(name));
        if (!value) return `uses the address object '${name}' (FQDN, range, geography or other), which the model can't express`;
        if (value.kind === 'mac') {
            if (value.values.length !== 1) return `uses a MAC address object with several MACs ('${name}')`;
            out.push({ device: value.values[0] });
            macs = true;
        } else {
            plain.push(...value.values);
        }
    }
    if (plain.length) out.push({ addresses: plain });
    return { selectors: out, addresses: [...covered, ...plain], macs };
}

function toRule(raw: Raw, index: number, context: RuleContext): Rule {
    const id = text(raw.policyid) || String(index + 1);
    const services = names(raw.service);
    const reasons: string[] = [];
    const from = side(names(raw.srcintf), names(raw.srcaddr), context);
    const to = side(names(raw.dstintf), names(raw.dstaddr), context);
    if (typeof from === 'string') reasons.push(`source ${from}`);
    if (typeof to === 'string') reasons.push(`destination ${to}`);
    const protocol = services.length === 1 ? SERVICES[services[0]] : undefined;
    if (!protocol) reasons.push(`service ${services.join(', ') || '(none)'} isn't one the model names`);
    const schedule = text(raw.schedule) || 'always';
    if (schedule !== 'always') reasons.push(`runs on the schedule '${schedule}'`);
    const action = text(raw.action);
    if (action !== 'accept' && action !== 'deny') reasons.push(`action '${action}'`);
    // Every FortiOS "...-negate" switch inverts a match; every "internet-service..." switch adds one.
    // Anything but an explicit "off" counts as on, so an unexpected value format can't hide a negation.
    const off = isOff;
    const on = (pattern: RegExp) => Object.entries(raw).some(([key, value]) => pattern.test(key) && !off(value));
    if (on(/-negate$/)) reasons.push('negates its addresses or services');
    if (on(/^internet-service/)) reasons.push('matches internet services');
    // A deny with match-vip off lets port-forwarded (VIP) traffic through; match-vip-only matches only that.
    if ((action === 'deny' && off(raw['match-vip'] ?? 'enable')) || !off(raw['match-vip-only'])) reasons.push('treats traffic to virtual IPs (port forwards) differently');
    // Fields that narrow what a FortiOS 7.4 policy matches beyond interfaces, addresses and services.
    const narrowed = NARROWING.filter(([key, isDefault]) => key in raw && !isDefault(raw[key])).map(([key]) => key);
    if (narrowed.length) reasons.push(`narrows its match with ${narrowed.join(', ')}`);
    // A consolidated policy (FortiOS 6.4+) also matches IPv6 through srcaddr6 / dstaddr6.
    if (names(raw.srcaddr6).length || names(raw.dstaddr6).length) reasons.push('also matches IPv6 addresses');
    if (names(raw.users).length || names(raw.groups).length) reasons.push('matches users or user groups');
    return {
        id,
        name: text(raw.name) || `policy ${id}`,
        action: action === 'deny' ? 'block' : 'allow',
        from: typeof from === 'string' ? [] : from,
        to: typeof to === 'string' ? [] : to,
        protocol: protocol ?? 'any',
        // FortiGate policies are stateful: replies to an allowed connection pass.
        replies: 'allow',
        schedule: { kind: 'always' },
        enabled: text(raw.status) !== 'disable',
        position: index + 1,
        ...(reasons.length ? { foreign: { reason: `FortiGate policy ${id} ${reasons.join('; ')}` } } : {}),
    };
}
