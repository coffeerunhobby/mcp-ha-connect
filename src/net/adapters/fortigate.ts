/**
 * FortiGate adapter for the vendor-neutral net_* tools (FortiOS 7.x REST API). It reads everything
 * below; of the changes it makes DHCP reservations (2.7.0) and firewall policies (2.8.0), the rest is refused.
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
 * network adds it there before removing the old one, so the device is never without one.
 *
 * Changes (2.8.0): firewall policies (mapped live on a FortiGate 80F, FortiOS 7.4.13): POST
 * firewall/policy adds one at the bottom, PUT firewall/policy/<id>?action=move&before|after=<id>
 * moves it in one call, PUT changes it, DELETE removes it; FortiOS refuses a name twice (-651) and
 * an address object in use (-23). See planRule and fortigateRules.ts.
 *
 * Every change is planned again right before writing (CONFLICT if anything changed) and read back.
 * FORTIGATE_READ_ONLY=true refuses them all. Everything else is refused (UNSUPPORTED).
 */

import { createHash } from 'node:crypto';

import { formatMac, normalizeMac } from '../../omadaClient/client.js';
import { FortiGateError, type FortiGateClient } from '../../fortigateClient/index.js';
import { inSubnet, ipToNumber, parseCidr } from '../../utils/ipv4.js';
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
    type Wifi,
} from '../model.js';

import {
    addressValue,
    checkPolicyName,
    describePolicy,
    groupComplete,
    list,
    macOf,
    maskToPrefix,
    mayMatchServer,
    names,
    OWNED_ADDRESS_COMMENT,
    policyBody,
    policySide,
    SERVICE_OF,
    text,
    toCidr,
    toRule,
    type GroupInfo,
    type PolicySide,
    type PolicyWorld,
    type Raw,
    type RuleContext,
} from './fortigateRules.js';
import { resolve } from './omadaRules.js';

export { maskToPrefix, toCidr } from './fortigateRules.js';

export const FORTIGATE_READ_ONLY = 'The FortiGate changes only DHCP reservations and firewall policies through these tools for now; make other changes in its web UI.';
export const FORTIGATE_READ_ONLY_SETTING = 'The FortiGate is read-only here (FORTIGATE_READ_ONLY=true); nothing is changed through these tools.';
/** The vendor object a reservation step writes. */
const RESERVATION_OBJECT = 'fortigate.system.dhcp/server.reserved-address';
/** The vendor objects a rule step writes. */
const POLICY_OBJECT = 'fortigate.firewall/policy';
const ADDRESS_OBJECT = 'fortigate.firewall/address';

export interface FortiGateAdapterOptions {
    /** Defaults to "fortigate:<host>". */
    id?: string;
    /** This server's LAN addresses (MCP_SERVER_ADDRESSES): the network holding one is protected. */
    serverHosts?: string[];
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
        const writes = this.client.readOnly ? 'unsupported' : 'native';
        return {
            vendor: 'fortigate',
            networks: { create: 'unsupported', isolation: 'unsupported', ipv6: 'unsupported', guestPurpose: 'unsupported' },
            wifi: { create: 'unsupported', bands: [], security: [], pmf: 'unsupported', fastRoaming: 'unsupported', bandSteering: 'unsupported' },
            ports: { profiles: 'unsupported', assign: 'unsupported' },
            rules: { between: writes, toInternet: writes, deviceMatch: 'unsupported', wifiMatch: 'unsupported', stateful: writes, schedule: 'unsupported' },
            groups: { address: 'unsupported', mac: 'unsupported' },
            reservations: writes,
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
        const { policies, context } = await this.policyState();
        return policies.map((raw, i) => toRule(raw, i, context));
    }

    /** The policies and everything they are read against, in one read. */
    private async policyState(): Promise<{ interfaces: Raw[]; networks: Network[]; policies: Raw[]; groupsRaw: Raw[]; context: RuleContext }> {
        const { interfaces, dhcpServers } = await this.snapshot();
        const routed = interfaces.filter((raw) => this.routed(raw));
        const lans = new Map(routed.map((raw) => [text(raw.name), this.toNetwork(raw, dhcpServers)]));
        const wan = new Set(interfaces.filter((raw) => text(raw.role) === 'wan').map((raw) => text(raw.name)));
        const policies = list((await this.client.cmdb<Raw[]>('firewall', 'policy')).results);
        const addresses = new Map(list((await this.client.cmdb<Raw[]>('firewall', 'address')).results).map((a) => [text(a.name), a]));
        // Each group: whether its listed entries say all it holds (no FQDN, range or nested group), and its addresses.
        let groupsRaw: Raw[] = [];
        try {
            groupsRaw = list((await this.client.cmdb<Raw[]>('firewall', 'addrgrp')).results);
        } catch (error) {
            if (!(error instanceof FortiGateError && (error.kind === 'forbidden' || error.kind === 'notFound'))) throw error;
        }
        const groups = new Map<string, GroupInfo>(
            groupsRaw.map((g) => [
                text(g.name),
                {
                    complete: groupComplete(g, addresses),
                    addresses: names(g.member).flatMap((m) => (addressValue(addresses.get(m))?.kind === 'address' ? addressValue(addresses.get(m))!.values : [])),
                    macs: names(g.member).some((m) => addressValue(addresses.get(m))?.kind === 'mac'),
                },
            ])
        );
        // Interfaces carrying further subnets than the primary one their network shows.
        const secondary = new Set(interfaces.filter((raw) => text(raw['secondary-IP']) === 'enable' || list(raw.secondaryip).length > 0).map((raw) => text(raw.name)));
        const networks = routed.flatMap((raw) => [lans.get(text(raw.name))!, ...this.secondaryNetworks(raw)]);
        return { interfaces, networks, policies, groupsRaw, context: { networks: lans, wan, addresses, groups, secondary } };
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
        if (change.kind !== 'reservation' && change.kind !== 'rule') throw new NetError('UNSUPPORTED', FORTIGATE_READ_ONLY, { capability: change.kind });
        if (this.client.readOnly) throw new NetError('UNSUPPORTED', FORTIGATE_READ_ONLY_SETTING, { capability: change.kind === 'rule' ? 'rules' : 'reservations' });
        return change.kind === 'rule' ? await this.planRule(change) : await this.planReservation(change);
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

    /**
     * Plans one firewall policy change. The basis covers the interfaces, every policy, address object
     * and group, and this server's addresses: anything else changed since is a CONFLICT.
     *
     * What must stay reachable is this server: no change may newly stop traffic from it, or to its own
     * address (mayMatchServer). A policy that can't match that traffic can be changed freely; one that
     * can may only change in ways that let more through: a new allow, a block removed or moved down, an
     * allow moved up. FortiGate policies are checked from the top, and traffic none allows is dropped.
     *
     * A new policy is written switched off at the bottom, moved into place and then switched on, so it
     * never acts from the wrong position; one that can't be finished is removed again.
     */
    private async planRule(change: Extract<Change, { kind: 'rule' }>): Promise<Plan> {
        if (!this.serverAddresses.length) {
            throw new NetError('PROTECTED', "Where this server is isn't configured (MCP_SERVER_ADDRESSES), so no firewall policy is changed: one could cut it off. Set MCP_SERVER_ADDRESSES.");
        }
        const { interfaces, networks, policies, groupsRaw, context } = await this.policyState();
        // The interfaces this server's traffic passes: its LAN network's, else the WAN when it reaches the
        // FortiGate on a WAN address; anywhere when that can't be told.
        const serverInterfaces = new Set<string>();
        let anywhere = false;
        for (const address of this.serverAddresses) {
            const network = networks.find((n) => n.gateway && inSubnet(address, n.gateway));
            if (network) {
                serverInterfaces.add(network.id.split(':secondary:')[0]);
                continue;
            }
            const reached = interfaces.find((raw) => toCidr(raw.ip)?.split('/')[0] === this.client.host);
            if (reached && text(reached.role) === 'wan') for (const w of context.wan) serverInterfaces.add(w);
            else anywhere = true;
        }
        const world: PolicyWorld = {
            networks,
            lans: context.networks,
            wan: [...context.wan],
            secondary: context.secondary,
            addresses: context.addresses,
            groups: context.groups,
            serverAddresses: this.serverAddresses,
            serverInterfaces: anywhere ? 'any' : serverInterfaces,
        };
        const rules = policies.map((raw, i) => ({ raw, rule: toRule(raw, i, context) }));
        const editable = (ref: Ref, what: string) => {
            const found = resolve(
                rules.map((r) => ({ ...r, id: r.rule.id, name: r.rule.name })),
                ref,
                'rule'
            );
            if (found.rule.foreign) throw new NetError('UNSUPPORTED', `Rule '${found.rule.name}' can't be ${what} through net_: ${found.rule.foreign.reason}`, { capability: 'rule' });
            return found;
        };
        const checkPosition = (position: number, count: number) => {
            if (!Number.isInteger(position) || position < 1 || position > count) throw new NetError('INVALID', `Position ${position} must be from 1 to ${count}`);
            return position;
        };
        const nameTaken = (name: string, except?: string) => {
            if (rules.some((r) => r.rule.id !== except && r.rule.name.toLowerCase() === name.toLowerCase())) {
                throw new NetError('EXISTS', `A policy named '${name}' already exists`);
            }
        };
        const cutsOff = (what: string) =>
            new NetError('PROTECTED', `${what} may stop traffic from this server or to its address, and this server has to stay reachable; refused. Change it in the FortiGate's UI if that is intended.`);
        /** Where to move a policy so it ends up at `to` among the others: before the one there, else after the last. */
        const moveTo = (others: Raw[], to: number): Record<string, string> => (to <= others.length ? { action: 'move', before: text(others[to - 1].policyid) } : { action: 'move', after: text(others[others.length - 1].policyid) });
        /** The context with the address objects a change creates. */
        const withObjects = (create: PolicySide['create']): RuleContext => ({
            ...context,
            addresses: new Map([...context.addresses, ...create.map((c): [string, Raw] => [c.name, { name: c.name, type: 'ipmask', subnet: c.subnet, comment: OWNED_ADDRESS_COMMENT }])]),
        });
        /** The world with the address objects a change creates (for the server check). */
        const worldWith = (create: PolicySide['create']): PolicyWorld => ({ ...world, addresses: withObjects(create).addresses });
        /** Whether a rule read back says what the policy written says, at that position. */
        const same = (written: Raw, at: number, ctx: RuleContext) => (found: Rule | undefined) => {
            const expected = toRule(written, at - 1, ctx);
            return found !== undefined && found.position === at && !found.foreign && (['name', 'action', 'from', 'to', 'protocol', 'replies', 'enabled'] as const).every((key) => JSON.stringify(found[key]) === JSON.stringify(expected[key]));
        };
        /** Address objects these tools made that no policy (but `except`) or group uses any more. */
        const unused = (addrs: string[], except: Raw) =>
            [...new Set(addrs)].filter(
                (name) =>
                    text(context.addresses.get(name)?.comment) === OWNED_ADDRESS_COMMENT &&
                    !policies.some((p) => p !== except && [...names(p.srcaddr), ...names(p.dstaddr)].includes(name)) &&
                    !groupsRaw.some((g) => names(g.member).includes(name))
            );
        const objectSteps = (create: PolicySide['create']): Plan['steps'] => create.map((c) => ({ action: 'create', object: ADDRESS_OBJECT, name: c.name, detail: c.subnet.replace(' ', ' mask ') }));
        const dropSteps = (drop: string[]): Plan['steps'] => drop.map((name) => ({ action: 'delete', object: ADDRESS_OBJECT, name, detail: 'no rule uses it any more' }));
        const objectEffects = (create: PolicySide['create'], drop: string[]) => [
            ...(create.length ? [`Address object(s) ${create.map((c) => c.name).join(', ')} are created for the addresses; they are removed with the last rule using them.`] : []),
            ...(drop.length ? [`Address object(s) ${drop.join(', ')}, made for an earlier rule, are removed: nothing uses them any more.`] : []),
        ];
        const IMPLICIT_DENY = 'Policies are checked from the top and the first match decides; traffic no policy allows is dropped.';

        let steps: Plan['steps'];
        let effects: string[];
        let execute: () => Promise<ApplyResult>;

        if (change.op === 'create') {
            const { body, create } = policyBody(change.value, world);
            nameTaken(text(body.name));
            const at = change.value.position === undefined ? policies.length + 1 : checkPosition(change.value.position, policies.length + 1);
            if (body.action === 'deny') {
                body['match-vip'] = 'enable';
                if (mayMatchServer(body, worldWith(create))) throw cutsOff(`A new block '${text(body.name)}'`);
            }
            const name = text(body.name);
            steps = [...objectSteps(create), { action: 'create', object: POLICY_OBJECT, name, detail: `${describePolicy(body)}, position ${at}` }];
            effects = [
                `${describePolicy(body)}${body.status === 'enable' ? '' : ' (switched off)'}.`,
                ...(body.action === 'deny' ? ['New connections are stopped; replies to connections started from the other side still pass.'] : []),
                ...(body.nat === 'enable' ? ["NAT is on: the devices reach the internet through the FortiGate's WAN address."] : []),
                `It is policy ${at} of ${policies.length + 1}. ${IMPLICIT_DENY}`,
                ...objectEffects(create, []),
            ];
            execute = async () => {
                const made: string[] = [];
                let id: string | undefined;
                // Whether the new policy may be stored: only then is it looked for, and only this one is removed.
                let posted = false;
                // Without its id: only a policy that wasn't there and says exactly what was written is this one.
                const known = new Set(policies.map((p) => text(p.policyid)));
                const written: Raw = { ...body, status: 'disable' };
                const findOurs = async () => {
                    const mine = list((await this.client.cmdb<Raw[]>('firewall', 'policy')).results).filter(
                        (p) => !known.has(text(p.policyid)) && (['name', 'action', 'schedule'] as const).every((k) => text(p[k]) === text(written[k])) && (['srcintf', 'dstintf', 'srcaddr', 'dstaddr', 'service'] as const).every((k) => JSON.stringify(names(p[k])) === JSON.stringify(names(written[k])))
                    );
                    if (mine.length > 1) throw new NetError('CONFLICT', `Several new policies named '${name}' say what was written; which one is this can't be told.`);
                    return mine.length ? text(mine[0].policyid) : undefined;
                };
                try {
                    for (const c of create) {
                        await this.send(() => this.client.cmdbWrite('POST', ['firewall', 'address'], { name: c.name, type: 'ipmask', subnet: c.subnet, comment: OWNED_ADDRESS_COMMENT }), 'an address object', 'net_listRules');
                        made.push(c.name);
                    }
                    let answer: { mkey?: string };
                    try {
                        answer = await this.send(() => this.client.cmdbWrite('POST', ['firewall', 'policy'], written), 'the new policy', 'net_listRules');
                    } catch (error) {
                        posted = error instanceof FortiGateError && error.maybeDone;
                        throw error;
                    }
                    posted = true;
                    id = answer.mkey ?? (await findOurs());
                    if (!id) throw new NetError('CONFLICT', `The FortiGate accepted policy '${name}' but didn't say its id, and it couldn't be found again.`);
                    if (at <= policies.length) await this.send(() => this.client.cmdbWrite('PUT', ['firewall', 'policy', id!], undefined, moveTo(policies, at)), 'the move of the new policy', 'net_listRules');
                    if (body.status === 'enable') await this.send(() => this.client.cmdbWrite('PUT', ['firewall', 'policy', id!], { status: 'enable' }), 'switching the new policy on', 'net_listRules');
                } catch (error) {
                    if (!(await this.undoCreate(posted ? (id ?? findOurs) : undefined, made))) {
                        throw new NetError('CONFLICT', `Creating policy '${name}' failed halfway and what it made couldn't all be removed again: the policy may still be stored (switched off or on), and address objects may be left. Check net_listRules.`);
                    }
                    throw error;
                }
                return await this.ruleReadBack(id, same({ ...body, policyid: id }, at, withObjects(create)));
            };
        } else if (change.op === 'delete') {
            const { raw, rule } = editable(change.ref, 'deleted');
            if (text(raw.action) === 'accept' && mayMatchServer(raw, world)) throw cutsOff(`Removing the allow '${rule.name}'`);
            const id = text(raw.policyid);
            const drop = unused([...names(raw.srcaddr), ...names(raw.dstaddr)], raw);
            steps = [{ action: 'delete', object: POLICY_OBJECT, name: rule.name }, ...dropSteps(drop)];
            effects = [
                `Policy '${rule.name}' is removed${rule.enabled ? `; the traffic it matched follows the policies below it${text(raw.action) === 'accept' ? ', and is dropped if none allows it' : ''}` : ' (it was switched off)'}.`,
                ...objectEffects([], drop),
            ];
            execute = async () => {
                await this.send(() => this.client.cmdbWrite('DELETE', ['firewall', 'policy', id]), 'the delete of the policy', 'net_listRules');
                const warnings = await this.dropAddresses(drop);
                const result = await this.ruleReadBack(id, (r) => r === undefined);
                return warnings.length ? { ...result, warnings: [...(result.warnings ?? []), ...warnings] } : result;
            };
        } else if (change.op === 'move') {
            const { raw, rule } = editable(change.ref, 'moved');
            const to = checkPosition(change.position, policies.length);
            if (to === rule.position) throw new NetError('INVALID', `Rule '${rule.name}' is already at position ${to}`);
            // Only an allow moving up or a block moving down can't stop more of this server's traffic.
            if (mayMatchServer(raw, world) && (text(raw.action) === 'accept' ? to > rule.position : to < rule.position)) throw cutsOff(`Moving '${rule.name}' ${to > rule.position ? 'down' : 'up'}`);
            const id = text(raw.policyid);
            steps = [{ action: 'update', object: POLICY_OBJECT, name: rule.name, detail: `position ${to}` }];
            effects = [`Policy '${rule.name}' moves from position ${rule.position} to ${to}. ${IMPLICIT_DENY}`];
            execute = async () => {
                await this.send(() => this.client.cmdbWrite('PUT', ['firewall', 'policy', id], undefined, moveTo(policies.filter((p) => p !== raw), to)), 'the move of the policy', 'net_listRules');
                return await this.ruleReadBack(id, same(raw, to, context));
            };
        } else {
            const { raw, rule } = editable(change.value.ref, 'changed');
            const id = text(raw.policyid);
            const { position, ...fields } = change.value.set;
            if (fields.schedule !== undefined && fields.schedule.kind !== 'always') throw new NetError('UNSUPPORTED', "A FortiGate rule can't use a schedule through the tools", { capability: 'rules.schedule' });
            if (fields.replies !== undefined && fields.replies !== 'allow') throw new NetError('UNSUPPORTED', 'FortiGate policies are stateful: replies always pass', { capability: 'rules.stateful' });
            if (typeof fields.protocol === 'object') throw new NetError('UNSUPPORTED', "A FortiGate rule can't use ports through the tools (that needs a custom service)", { capability: 'rules.ports' });
            const patch: Raw = {};
            const create: PolicySide['create'] = [];
            if (fields.name !== undefined) {
                patch.name = checkPolicyName(fields.name);
                nameTaken(text(patch.name), rule.id);
            }
            if (fields.enabled !== undefined) patch.status = fields.enabled ? 'enable' : 'disable';
            if (fields.action !== undefined) patch.action = fields.action === 'allow' ? 'accept' : 'deny';
            if (fields.from !== undefined) {
                const from = policySide(fields.from, world, 'source');
                Object.assign(patch, { srcintf: from.intf.map((name) => ({ name })), srcaddr: from.addr.map((name) => ({ name })) });
                create.push(...from.create);
            }
            if (fields.to !== undefined) {
                const to = policySide(fields.to, world, 'destination');
                Object.assign(patch, { dstintf: to.intf.map((name) => ({ name })), dstaddr: to.addr.map((name) => ({ name })) });
                create.push(...to.create.filter((c) => !create.some((x) => x.name === c.name)));
            }
            if (fields.protocol !== undefined) patch.service = [{ name: SERVICE_OF[fields.protocol] }];
            // Only what differs is written.
            for (const key of Object.keys(patch)) if (JSON.stringify(Array.isArray(patch[key]) ? names(patch[key]) : patch[key]) === JSON.stringify(Array.isArray(raw[key]) ? names(raw[key]) : raw[key])) delete patch[key];
            const merged: Raw = { ...raw, ...patch };
            if ('action' in patch || 'dstintf' in patch) {
                // NAT follows the action and the destination, as for a new rule; a block matches port-forwarded traffic too.
                const dst = names(merged.dstintf);
                const nat = text(merged.action) === 'accept' && dst.length > 0 && dst.every((i) => world.wan.includes(i)) ? 'enable' : 'disable';
                if (nat !== text(raw.nat)) patch.nat = nat;
                if (text(merged.action) === 'deny' && text(raw['match-vip']) !== 'enable') patch['match-vip'] = 'enable';
                Object.assign(merged, patch);
            }
            const both = names(merged.srcintf).find((i) => names(merged.dstintf).includes(i));
            if (both) throw new NetError('INVALID', `Traffic inside '${both}' doesn't pass a FortiGate policy between interfaces; give a source and destination on different networks`);
            const to = position === undefined ? rule.position : checkPosition(position, policies.length);
            const moves = to !== rule.position;
            if (!Object.keys(patch).length && !moves) throw new NetError('INVALID', `Nothing to change on rule '${rule.name}'`);
            // The policy moves first (with its old settings), then changes in place.
            if (moves && mayMatchServer(raw, world) && (text(raw.action) === 'accept' ? to > rule.position : to < rule.position)) throw cutsOff(`Moving '${rule.name}' ${to > rule.position ? 'down' : 'up'}`);
            if (Object.keys(patch).some((key) => key !== 'name')) {
                if (text(raw.action) === 'accept' && mayMatchServer(raw, world)) throw cutsOff(`Changing the allow '${rule.name}'`);
                if (text(merged.action) === 'deny' && mayMatchServer(merged, worldWith(create))) throw cutsOff(`The block '${rule.name}' as changed`);
            }
            const created = create.filter((c) => [...names(merged.srcaddr), ...names(merged.dstaddr)].includes(c.name));
            const drop = unused([...names(raw.srcaddr), ...names(raw.dstaddr)].filter((n) => ![...names(merged.srcaddr), ...names(merged.dstaddr)].includes(n)), raw);
            steps = [
                ...objectSteps(created),
                { action: 'update', object: POLICY_OBJECT, name: rule.name, detail: [Object.keys(patch).length ? describePolicy(merged) : '', moves ? `position ${to}` : ''].filter(Boolean).join('; ') },
                ...dropSteps(drop),
            ];
            effects = [
                `Policy '${rule.name}' becomes: ${describePolicy(merged)}${text(merged.status) === 'disable' ? ' (switched off)' : ''}, at position ${to}.`,
                ...(patch.nat !== undefined ? [patch.nat === 'enable' ? "NAT is switched on: the devices reach the internet through the FortiGate's WAN address." : 'NAT is switched off.'] : []),
                ...(moves ? [IMPLICIT_DENY] : []),
                ...objectEffects(created, drop),
            ];
            const others = policies.filter((p) => p !== raw);
            execute = async () => {
                const made: string[] = [];
                let moved = false;
                try {
                    for (const c of created) {
                        await this.send(() => this.client.cmdbWrite('POST', ['firewall', 'address'], { name: c.name, type: 'ipmask', subnet: c.subnet, comment: OWNED_ADDRESS_COMMENT }), 'an address object', 'net_listRules');
                        made.push(c.name);
                    }
                    if (moves) {
                        await this.send(() => this.client.cmdbWrite('PUT', ['firewall', 'policy', id], undefined, moveTo(others, to)), 'the move of the policy', 'net_listRules');
                        moved = true;
                    }
                    if (Object.keys(patch).length) await this.send(() => this.client.cmdbWrite('PUT', ['firewall', 'policy', id], patch), 'the policy change', 'net_listRules');
                } catch (error) {
                    // A change that may have been stored is left as it is: undoing it could undo someone else's.
                    const sure = !(error instanceof FortiGateError && error.maybeDone);
                    let back = !moved;
                    if (moved && sure) {
                        try {
                            await this.client.cmdbWrite('PUT', ['firewall', 'policy', id], undefined, moveTo(others, rule.position));
                            back = true;
                        } catch {
                            back = false;
                        }
                    }
                    const dropped = sure ? (await this.dropAddresses(made)).length === 0 : made.length === 0;
                    if (back && dropped) throw error;
                    throw new NetError(
                        'CONFLICT',
                        `Changing policy '${rule.name}' failed halfway${moved && !back ? `: it is at position ${to} (it was at ${rule.position}) with its old settings` : ''}${dropped ? '' : ', and address objects made for it may be left'}. Check net_listRules.`
                    );
                }
                const warnings = await this.dropAddresses(drop);
                const result = await this.ruleReadBack(id, same(merged, to, withObjects(created)));
                return warnings.length ? { ...result, warnings: [...(result.warnings ?? []), ...warnings] } : result;
            };
        }

        const basisOf = {
            change,
            controller: this.id,
            interfaces: interfaces.map((raw) => [raw.name, raw.type, raw.role, raw.ip, raw.status, raw.vlanid, raw.interface, raw['secondary-IP'], raw.secondaryip]),
            policies,
            addresses: [...context.addresses.values()],
            groups: groupsRaw,
            server: this.serverAddresses,
        };
        const plan: Plan = {
            change,
            vendor: 'fortigate',
            steps,
            effects,
            wouldLockOut: [],
            basis: createHash('sha256').update(JSON.stringify(basisOf)).digest('hex').slice(0, 16),
        };
        this.executors.set(plan, execute);
        return plan;
    }

    /**
     * Removes a policy that couldn't be finished and the address objects made for it; true when all is
     * gone. The policy is this attempt's own: its id, or the one `find` tells (undefined when it was
     * surely never stored); never another one by its name.
     */
    private async undoCreate(policy: string | (() => Promise<string | undefined>) | undefined, made: string[]): Promise<boolean> {
        try {
            const id = typeof policy === 'function' ? await policy() : policy;
            if (id !== undefined) {
                await this.client.cmdbWrite('DELETE', ['firewall', 'policy', id]);
                if (list((await this.client.cmdb<Raw[]>('firewall', 'policy')).results).some((p) => text(p.policyid) === id)) return false;
            }
            return (await this.dropAddresses(made)).length === 0;
        } catch {
            return false;
        }
    }

    /** Removes address objects these tools made; each one that stays is a warning. */
    private async dropAddresses(objects: string[]): Promise<string[]> {
        const warnings: string[] = [];
        for (const name of [...objects].reverse()) {
            try {
                await this.client.cmdbWrite('DELETE', ['firewall', 'address', name]);
            } catch {
                warnings.push(`The address object '${name}' made for a rule couldn't be removed (something else may use it); remove it in the FortiGate's UI if nothing does.`);
            }
        }
        return warnings;
    }

    /** Reads a policy back after a write: something else stored is a CONFLICT. */
    private async ruleReadBack(id: string, check: (rule: Rule | undefined) => boolean): Promise<ApplyResult> {
        let after: Rule[];
        try {
            after = await this.listRules();
        } catch {
            return { applied: true, owned: [], warnings: ['The FortiGate accepted the policy change, but reading it back failed; check it with net_listRules.'] };
        }
        const found = after.find((r) => r.id === id);
        if (!check(found)) throw new NetError('CONFLICT', 'The FortiGate accepted the policy change but shows something else now; check it with net_listRules.');
        return { applied: true, ...(found ? { object: found } : {}), owned: [] };
    }

    /** One write; one sent without an answer may or may not be stored, and says so. */
    private async send<T>(write: () => Promise<T>, what = 'the reservation', check = 'net_listReservations'): Promise<T> {
        try {
            return await write();
        } catch (error) {
            if (error instanceof FortiGateError && error.maybeDone) {
                throw new FortiGateError(`The FortiGate stopped answering while ${what} was being sent, so it may or may not be stored; check ${check} before trying again.`, 'unreachable', true);
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

