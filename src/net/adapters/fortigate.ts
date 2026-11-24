/**
 * FortiGate adapter for the vendor-neutral net_* tools (FortiOS 7.x REST API). It reads everything
 * below; of the changes it makes only DHCP reservations so far (2.7.0), the rest is refused.
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
 * Changes (2.7.0): DHCP reservations, through the reserved-address child table of the network's
 * DHCP server, as the FortiGate's GUI writes them (mapped live on a FortiGate 80F, FortiOS 7.4.4):
 * POST system.dhcp/server/<id>/reserved-address {type: "mac", mac, ip, action: "reserved",
 * description}, PUT .../reserved-address/<entry> to change one, DELETE to remove it. FortiOS itself
 * refuses a MAC or address twice in one server (error -15) and an address outside the server's
 * subnet (-8); the plan refuses those first, with the reason. Moving a reservation to another
 * network adds it there before removing the old one, so the device is never without one. Every
 * change is planned again right before writing (CONFLICT if anything changed) and read back.
 * FORTIGATE_READ_ONLY=true refuses them all. Everything else is refused (UNSUPPORTED).
 */

import { createHash } from 'node:crypto';

import { formatMac, normalizeMac } from '../../omadaClient/client.js';
import { FortiGateError, type FortiGateClient } from '../../fortigateClient/index.js';
import { inSubnet, ipToNumber, parseCidr, subnetsOverlap } from '../../utils/ipv4.js';
import { checkReservationDelete, checkReservationSet } from '../reservations.js';
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

export const FORTIGATE_READ_ONLY = 'The FortiGate changes only DHCP reservations through these tools for now; make other changes in its web UI.';
export const FORTIGATE_READ_ONLY_SETTING = 'The FortiGate is read-only here (FORTIGATE_READ_ONLY=true); nothing is changed through these tools.';
/** The vendor object a reservation step writes. */
const RESERVATION_OBJECT = 'fortigate.system.dhcp/server.reserved-address';

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
    /** What each plan will write, kept for apply() (a plan is planned again there first). */
    private readonly executors = new WeakMap<Plan, () => Promise<ApplyResult>>();
    /** Changes run one at a time, each planned again against the state the last one left. */
    private queue: Promise<unknown> = Promise.resolve();

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
            reservations: this.client.readOnly ? 'unsupported' : 'native',
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
                // An option-82 entry reserves an address for a switch port (circuit/remote id), not a device.
                if (!mac || action !== 'reserved' || (text(r.type) || 'mac') !== 'mac' || !text(r.ip) || text(r.ip) === '0.0.0.0') continue;
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
        if (change.kind !== 'reservation') throw new NetError('UNSUPPORTED', FORTIGATE_READ_ONLY, { capability: change.kind });
        if (this.client.readOnly) throw new NetError('UNSUPPORTED', FORTIGATE_READ_ONLY_SETTING, { capability: 'reservations' });
        return await this.planReservation(change);
    }

    async apply(plan: Plan, options: { allowLockout?: boolean } = {}): Promise<ApplyResult> {
        const run = this.queue.then(async () => {
            // Planned again right before writing: anything changed since is a CONFLICT.
            const fresh = await this.plan(plan.change);
            if (fresh.basis !== plan.basis) throw new NetError('CONFLICT', 'The FortiGate changed after this change was planned; nothing was written. Plan it again.');
            if (fresh.wouldLockOut.length && !options.allowLockout) {
                throw new NetError('LOCKOUT', `This moves ${fresh.wouldLockOut.length} online device(s) to another address at their next DHCP renewal. Nothing was changed; repeat with allowLockout and the dry run's basis if that is intended.`, {
                    clients: fresh.wouldLockOut,
                });
            }
            return await this.executors.get(fresh)!();
        });
        this.queue = run.catch(() => undefined);
        return await run;
    }

    /**
     * Plans setting or removing one DHCP reservation. The basis covers the networks, every DHCP
     * server's subnet and reserved-address table, and the devices the change moves.
     */
    private async planReservation(change: Extract<Change, { kind: 'reservation' }>): Promise<Plan> {
        const interfaces = list((await this.client.cmdb<Raw[]>('system', 'interface')).results);
        // Not swallowed here: without the DHCP servers no reservation can be planned.
        const servers = list((await this.client.cmdb<Raw[]>('system.dhcp', 'server')).results);
        const networks = interfaces.filter((raw) => this.routed(raw)).flatMap((raw) => [this.toNetwork(raw, servers), ...this.secondaryNetworks(raw)]);
        const entries = servers.flatMap((server) => list(server['reserved-address']).map((entry) => ({ server, entry })));
        const isReservation = ({ entry }: { entry: Raw }) =>
            (text(entry.action) || 'reserved') === 'reserved' && (text(entry.type) || 'mac') === 'mac' && macOf(entry.mac) !== undefined && text(entry.ip) !== '' && text(entry.ip) !== '0.0.0.0';
        const reservations: Reservation[] = entries.filter(isReservation).map(({ server, entry }) => ({
            mac: macOf(entry.mac)!,
            ip: text(entry.ip),
            network: { id: text(server.interface) },
            ...(text(entry.description) ? { description: text(entry.description) } : {}),
        }));
        const clients = await this.listClients();
        const world = { networks, reservations, clients };
        const where = (server: Raw) => `DHCP server ${text(server.id)} (${text(server.interface)})`;
        const reservedOf = (mac: string) => entries.filter((e) => isReservation(e) && normalizeMac(text(e.entry.mac)) === normalizeMac(mac));
        const single = (mac: string) => {
            const found = reservedOf(mac);
            if (found.length > 1) throw new NetError('INVALID', `${formatMac(mac)} is reserved on several DHCP servers (${found.map((f) => where(f.server)).join(', ')}); fix that in the FortiGate's UI first`);
            return found[0];
        };

        // This server's own reservation is never moved or removed, and its address never reserved for
        // another device (as on Omada): moving it would cut this server off at its next renewal.
        const serverAt = (ip: string | undefined) => {
            try {
                return ip !== undefined && this.serverAddresses.includes(ipToNumber(ip));
            } catch {
                return false;
            }
        };
        const serverMacs = new Set(clients.filter((c) => serverAt(c.ip)).map((c) => normalizeMac(c.mac)));
        const hostNumber = (() => {
            try {
                return ipToNumber(this.client.host);
            } catch {
                return undefined;
            }
        })();
        // Without MCP_SERVER_ADDRESSES, and reaching the FortiGate from one of its LAN networks, this
        // server may be any device there: no existing reservation is moved or removed then.
        const whereUnknown = this.serverAddresses.length === 0 && hostNumber !== undefined && networks.some((n) => n.gateway && inSubnet(hostNumber, n.gateway));
        const guard = (mac: string, current: Reservation | undefined, ip?: string) => {
            if (ip !== undefined && serverAt(ip) && !serverMacs.has(normalizeMac(mac)) && current?.ip !== ip) {
                throw new NetError('PROTECTED', `${ip} is this server's address (MCP_SERVER_ADDRESSES); it is never reserved for another device`);
            }
            const touched = current !== undefined && (ip === undefined || current.ip !== ip);
            if (!touched) return;
            if (serverAt(current.ip) || serverMacs.has(normalizeMac(mac))) {
                throw new NetError('PROTECTED', "This is this server's reservation: it is never moved or removed (this server would lose its address at its next renewal)");
            }
            if (whereUnknown) {
                throw new NetError(
                    'PROTECTED',
                    'Where this server is can\'t be told (MCP_SERVER_ADDRESSES is not set, and it reaches the FortiGate from one of its LAN networks), so no existing reservation is moved or removed; set MCP_SERVER_ADDRESSES'
                );
            }
        };

        const steps: Plan['steps'] = [];
        let effects: string[];
        let wouldLockOut: Plan['wouldLockOut'] = [];
        let execute: () => Promise<ApplyResult>;
        const segmentsOf = (server: Raw, entry?: Raw) => ['system.dhcp', 'server', text(server.id), 'reserved-address', ...(entry ? [text(entry.id)] : [])];

        if (change.op === 'delete') {
            const checked = checkReservationDelete(change.mac, world);
            const old = single(checked.mac)!;
            guard(checked.mac, checked.current);
            effects = checked.effects;
            steps.push({ ...checked.step, object: RESERVATION_OBJECT, detail: `${checked.current.ip} on ${where(old.server)}` });
            execute = async () => {
                await this.send(() => this.client.cmdbWrite('DELETE', segmentsOf(old.server, old.entry)));
                return await this.readBack(checked.mac, (after) => after === undefined);
            };
        } else {
            const checked = checkReservationSet(change.value, world, { descriptions: true });
            // The network's own DHCP server hands the address out.
            const own = servers.filter((s) => text(s.interface) === checked.network.id);
            if (!own.length) throw new NetError('INVALID', `'${checked.network.name}' has no DHCP server on the FortiGate, so nothing would hand the address out`);
            if (own.length > 1) throw new NetError('INVALID', `'${checked.network.name}' has several DHCP servers (${own.map((s) => text(s.id)).join(', ')}); which one hands the address out is not clear, so it is refused`);
            const server = own[0];
            if (text(server.status) === 'disable') throw new NetError('INVALID', `The DHCP server on '${checked.network.name}' is switched off; switch it on in the FortiGate's UI first`);
            // FortiOS refuses an address outside the subnet the server hands out (error -8).
            const iface = interfaces.find((i) => text(i.name) === checked.network.id);
            const prefix = maskToPrefix(text(server.netmask));
            const base = text(server['default-gateway']) && text(server['default-gateway']) !== '0.0.0.0' ? text(server['default-gateway']) : (toCidr(iface?.ip) ?? '').split('/')[0];
            if (prefix !== undefined && base) {
                const served = parseCidr(`${base}/${prefix}`);
                const cidr = `${[24, 16, 8, 0].map((shift) => Math.floor(served.network / 2 ** shift) % 256).join('.')}/${prefix}`;
                if (!inSubnet(ipToNumber(checked.ip), cidr)) throw new NetError('INVALID', `The DHCP server on '${checked.network.name}' serves ${cidr}; ${checked.ip} is outside it`);
            }
            // A FortiOS MAC access entry for this device is the FortiGate's own rule: left alone.
            const access = entries.find(({ entry }) => (text(entry.action) || 'reserved') !== 'reserved' && normalizeMac(text(entry.mac)) === normalizeMac(checked.mac));
            if (access) {
                throw new NetError('INVALID', `${checked.mac} has a FortiOS MAC access entry (${text(access.entry.action)}) on ${where(access.server)}; change that in the FortiGate's UI, it is not a reservation`);
            }
            // Any other entry holding the address (a block entry, an option-82 reservation) makes it taken.
            const holder = entries.find(({ entry }) => text(entry.ip) === checked.ip && normalizeMac(text(entry.mac)) !== normalizeMac(checked.mac));
            if (holder) throw new NetError('EXISTS', `${checked.ip} is already held by entry ${text(holder.entry.id)} on ${where(holder.server)}`);
            const old = single(checked.mac);
            guard(checked.mac, checked.current, checked.ip);
            ({ effects, wouldLockOut } = checked);
            const mac = checked.mac.toLowerCase().replace(/-/g, ':');
            const expectAfter = (after: Reservation | undefined) =>
                after?.ip === checked.ip && 'id' in after.network && after.network.id === checked.network.id && (checked.description === undefined || after.description === checked.description);
            if (old && old.server === server) {
                steps.push({ ...checked.step, object: RESERVATION_OBJECT, detail: `${old.entry.ip === checked.ip ? checked.ip : `${text(old.entry.ip)} → ${checked.ip}`} on ${where(server)}` });
                const body = { ip: checked.ip, ...(change.value.description !== undefined ? { description: checked.description } : {}) };
                execute = async () => {
                    await this.send(() => this.client.cmdbWrite('PUT', segmentsOf(server, old.entry), body));
                    return await this.readBack(checked.mac, expectAfter);
                };
            } else {
                const body = { type: 'mac', mac, ip: checked.ip, action: 'reserved', ...(checked.description ? { description: checked.description } : {}) };
                steps.push({ ...checked.step, action: 'create', object: RESERVATION_OBJECT, detail: `${checked.ip} on ${where(server)}` });
                if (old) steps.push({ action: 'delete', object: RESERVATION_OBJECT, name: checked.step.name, detail: `${text(old.entry.ip)} on ${where(old.server)}` });
                execute = async () => {
                    await this.send(() => this.client.cmdbWrite('POST', segmentsOf(server), body));
                    const warnings: string[] = [];
                    if (old) {
                        // The new one is in place: the old one left behind is a warning, not a failure.
                        try {
                            await this.client.cmdbWrite('DELETE', segmentsOf(old.server, old.entry));
                        } catch (error) {
                            warnings.push(
                                error instanceof FortiGateError && error.maybeDone
                                    ? `The new reservation is in place; removing the old reservation of ${text(old.entry.ip)} on ${where(old.server)} got no answer, so it may still be there: check net_listReservations.`
                                    : `The new reservation is in place, but the old reservation of ${text(old.entry.ip)} on ${where(old.server)} is still there (removing it failed); remove it in the FortiGate's UI.`
                            );
                        }
                    }
                    // With the old entry left behind the device has two: the new one must be among them.
                    const result = await this.readBack(checked.mac, expectAfter, warnings.length > 0);
                    return warnings.length ? { ...result, warnings: [...(result.warnings ?? []), ...warnings] } : result;
                };
            }
        }

        const basisOf = {
            change,
            controller: this.id,
            networks,
            servers: servers.map((s) => ({
                id: s.id,
                interface: s.interface,
                status: s.status,
                netmask: s.netmask,
                gateway: s['default-gateway'],
                entries: list(s['reserved-address']).map((e) => ({ id: e.id, type: e.type, mac: e.mac, ip: e.ip, action: e.action, description: e.description })),
            })),
            lockOut: wouldLockOut.map((c) => `${c.mac}@${c.ip ?? ''}`).sort(),
        };
        const plan: Plan = {
            change,
            vendor: 'fortigate',
            steps,
            effects,
            wouldLockOut,
            basis: createHash('sha256').update(JSON.stringify(basisOf)).digest('hex').slice(0, 16),
        };
        this.executors.set(plan, execute);
        return plan;
    }

    /** One write; one sent without an answer may or may not be stored, and says so. */
    private async send(write: () => Promise<unknown>): Promise<void> {
        try {
            await write();
        } catch (error) {
            if (error instanceof FortiGateError && error.maybeDone) {
                throw new FortiGateError('The FortiGate stopped answering while the reservation was being sent, so it may or may not be stored; check net_listReservations before trying again.', 'unreachable', true);
            }
            throw error;
        }
    }

    /** Reads the device's reservation back after a write: something else stored is a CONFLICT. */
    private async readBack(mac: string, expected: (after: Reservation | undefined) => boolean, oldMayRemain = false): Promise<ApplyResult> {
        let after: Reservation[];
        try {
            after = await this.listReservations();
        } catch {
            return { applied: true, owned: [], warnings: ['The FortiGate accepted the reservation change, but reading it back failed; check it with net_listReservations.'] };
        }
        const mine = after.filter((r) => normalizeMac(r.mac) === normalizeMac(mac));
        const found = mine.find((r) => expected(r));
        // Exactly what was asked: one reservation as expected, or none after a removal. A move whose
        // old entry stayed (a warning already) may show both; the new one must be among them.
        const ok = oldMayRemain ? found !== undefined : mine.length === 0 ? expected(undefined) : mine.length === 1 && found !== undefined;
        if (!ok) {
            throw new NetError('CONFLICT', 'The FortiGate accepted the reservation change but shows something else now; check it with net_listReservations.');
        }
        return { applied: true, ...(found ? { object: found } : {}), owned: [] };
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
