/**
 * Ruijie / Reyee adapter for the vendor-neutral network model (src/net/model.ts), through the
 * router's local eWeb API (src/ruijieClient). Mapped on a RG-EG105G-V3, ReyeeOS 2.324
 * (2026-10-24). It reads; the changes it makes are a firmware upgrade to the version the router
 * itself is offered (2.5.1: system getVersion / upgradeConfirm, the page's "Online Upgrade") and
 * DHCP reservations (2.5.4: devConfig add / update / del dhcp_static). Other changes are refused
 * (UNSUPPORTED) until their write phases are built and live-tested.
 *
 * What is read, and how it maps:
 * - networks: devConfig.get network, `lan[]` (one entry per LAN interface: address, netmask,
 *   VLAN id, DHCP). The default LAN carries Ruijie's internal VLAN 233, untagged on the LAN
 *   ports; the id of a network is its interface name, "vlan<id>", which rules refer to.
 * - clients: the devices the router sees on its LAN right now, from its ARP table (devSta.get
 *   arp, interfaces "br-lan*", resolved MACs only), named by their address lease (devSta.get
 *   dhcp_lease) when they have one. A lease alone is no online device (a switched-off laptop
 *   keeps it until it expires); WAN-side ARP entries are the upstream network.
 * - reservations: devConfig.get dhcp_static (`{name_uuid, macaddr, ipaddr}`, at most 300). Written
 *   like the page does: add `{list: [{macaddr, ipaddr}]}`, update `{new, old}` (the entry as read,
 *   and with its new address), del `{macaddr: [...]}`. Names live elsewhere (the page's remark list),
 *   so a reservation here has no description.
 * - ports: devSta.get port_status. The router doesn't say which device is on which port, so
 *   `seen` stays empty; the WAN port is the uplink and protected.
 * - rules: devConfig.get access_ctrl (evaluated in list order). Anything the model can't say
 *   faithfully (a source "anywhere", source ports, IPv6, user groups, schedules, a rule that
 *   matches only some connection states) is listed as `foreign` with the reason.
 * No Wi-Fi radio on this model, no switch port profiles, no mDNS repeater; groups (Ruijie's
 * user groups are address ranges and users, not the model's address groups) come later.
 */

import { createHash } from 'node:crypto';

import { formatMac, normalizeMac } from '../../omadaClient/client.js';
import { RuijieError, type RuijieClient } from '../../ruijieClient/index.js';
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
    type Reservation,
    type Rule,
    type Selector,
    type Wifi,
} from '../model.js';

type Raw = Record<string, unknown>;

/** Ruijie's name for "all the time" in a rule's time setting (the default time group). */
const ALL_TIME = new Set(['所有时段', 'everytime', 'All Time', '']);
const READ_ONLY = 'The Ruijie adapter changes only DHCP reservations and firmware in this version; rules come next, then networks.';
/** The router keeps at most this many reservations (dhcp_static_scan answers max 300). */
const MAX_RESERVATIONS = 300;
/**
 * Firmware is only installed from Ruijie's own download servers (e.g. devicecdn-eu.ruijienetworks.com),
 * at the address the router itself was offered. The router fetches it and checks it itself; the
 * address Ruijie hands out is plain http (live, 2026-10-24), exactly what the page's Online Upgrade uses.
 */
const RUIJIE_DOWNLOADS = /(^|\.)ruijienetworks\.com$/i;

/** What the router runs and what it is offered (system getVersion). */
export interface FirmwareOffer {
    current: string;
    version?: string;
    notes?: string;
    sizeBytes?: number;
    url?: string;
    md5?: string;
}

/** The getVersion answer as an offer: only a version other than the running one counts as new. */
export function toOffer(answer: Raw): FirmwareOffer {
    const current = text(answer.cur).trim();
    const offered = list((answer.new as Raw | undefined)?.firmwareList)[0];
    const version = offered ? text(offered.versionCode).trim() : '';
    if (!offered || !version || version === current) return { current };
    const size = Number(text(offered.fileSize));
    return {
        current,
        version,
        ...(text(offered.releaseNotes).trim() ? { notes: text(offered.releaseNotes).trim() } : {}),
        ...(size > 0 ? { sizeBytes: size } : {}),
        url: text(offered.downloadUrlTar),
        ...(text(offered.md5) ? { md5: text(offered.md5) } : {}),
    };
}

/** Whether a download address is on Ruijie's own servers (nothing else is ever handed to the router). */
export function isRuijieDownload(url: string | undefined): boolean {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password && RUIJIE_DOWNLOADS.test(parsed.hostname);
    } catch {
        return false;
    }
}

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
    private readonly executors = new WeakMap<Plan, () => Promise<ApplyResult>>();
    /** One change at a time. */
    private queue: Promise<unknown> = Promise.resolve();

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
            reservations: this.client.readOnly ? 'unsupported' : 'native',
            mdnsRepeater: 'unsupported',
            firmware: this.firmwareAllowed() ? 'native' : 'unsupported',
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

    /** The router's identity; a device given must be the router (by MAC, model or "router"). */
    private async router(device?: PortRef['device']): Promise<{ info: Raw; mac: string }> {
        const info = await this.client.status<Raw>('sysinfo');
        const mac = macOrUndefined(info.sys_mac) ?? 'unknown';
        if (device) {
            const wanted = 'mac' in device ? device.mac : 'id' in device ? device.id : device.name;
            const names = [mac, text(info.model), text(info.product_class), 'router'].map((v) => v.toLowerCase());
            if (normalizeMac(wanted) !== normalizeMac(mac) && !names.includes(wanted.trim().toLowerCase())) {
                throw new NetError('NOT_FOUND', `This Ruijie router (${text(info.model) || 'router'}, ${mac}) is the only device here; '${wanted}' is not it`);
            }
        }
        return { info, mac };
    }

    async listPorts(device?: PortRef['device']): Promise<Port[]> {
        const { mac } = await this.router(device);
        const status = await this.client.status<Raw>('port_status');
        return toPorts(list(status.List), mac);
    }

    private async offer(): Promise<FirmwareOffer> {
        return toOffer(await this.client.system<Raw>('getVersion', { deviceType: 'self' }));
    }

    async listFirmware(): Promise<Firmware[]> {
        const { info, mac } = await this.router();
        const offer = await this.offer();
        return [
            {
                device: { mac },
                ...(text(info.model) ? { model: text(info.product_class) || text(info.model) } : {}),
                current: offer.current || text(info.software_version) || 'unknown',
                ...(offer.version ? { available: { version: offer.version, ...(offer.notes ? { notes: offer.notes } : {}), ...(offer.sizeBytes ? { sizeBytes: offer.sizeBytes } : {}) } } : {}),
                upgradable: this.firmwareAllowed() && offer.version !== undefined && isRuijieDownload(offer.url),
            },
        ];
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

    /** Firmware upgrades are on unless this server switched changes or upgrades off. */
    private firmwareAllowed(): boolean {
        return !this.client.readOnly && this.client.firmwareUpgrade !== false;
    }

    async plan(change: Change): Promise<Plan> {
        if (this.client.readOnly) throw new NetError('UNSUPPORTED', 'Changes to the Ruijie router are switched off on this server (RUIJIE_READ_ONLY=true)', { capability: change.kind });
        if (change.kind === 'reservation') return await this.planReservation(change);
        if (change.kind !== 'firmware') throw new NetError('UNSUPPORTED', READ_ONLY, { capability: change.kind });
        if (this.client.firmwareUpgrade === false) {
            throw new NetError('UNSUPPORTED', 'Firmware upgrades on the Ruijie router are switched off on this server (RUIJIE_FIRMWARE_UPGRADE=false)', { capability: 'firmware' });
        }
        const { info, mac } = await this.router(change.device);
        // The basis names the router; without its MAC a dry run could vouch for another one.
        if (mac === 'unknown') throw new NetError('INVALID', "The router doesn't report its MAC address, so it can't be told which router a dry run was for; not upgraded");
        const offer = await this.offer();
        if (!offer.version) throw new NetError('INVALID', `The router already runs the newest firmware it is offered (${offer.current || 'unknown'})`);
        if (!isRuijieDownload(offer.url)) {
            throw new NetError('UNSUPPORTED', "The offered firmware doesn't come from Ruijie's download server; it is not installed through the tools", { capability: 'firmware' });
        }
        // Every device on the router's LAN loses its connection while it restarts.
        const clients = await this.listClients();
        const model = text(info.product_class) || text(info.model) || 'router';
        const size = offer.sizeBytes ? ` (${Math.round(offer.sizeBytes / 1e6)} MB)` : '';
        const url = offer.url!;
        const plan: Plan = {
            change,
            vendor: 'ruijie',
            steps: [{ action: 'update', object: 'ruijie.firmware', name: `${model} ${mac}`, detail: `${offer.current} → ${offer.version}` }],
            effects: [
                `The router downloads ${offer.version} from Ruijie${size} and installs it, keeping its settings.`,
                'It restarts: for several minutes every device on its LAN is offline and the router can\'t be reached.',
                ...(offer.notes ? [`Release notes: ${offer.notes.slice(0, 600)}`] : []),
            ],
            wouldLockOut: clients,
            basis: createHash('sha256')
                .update(JSON.stringify({ change, controller: this.id, router: mac, current: offer.current, version: offer.version, url, md5: offer.md5 ?? null, lockOut: clients.map((c) => c.mac).sort() }))
                .digest('hex')
                .slice(0, 16),
        };
        this.executors.set(plan, async () => {
            try {
                await this.client.system('upgradeConfirm', { path: url, isPersist: true });
            } catch (error) {
                // Sent but unanswered: it may be restarting into the upgrade, or the request may not have arrived.
                if (error instanceof RuijieError && error.kind === 'unreachable' && !error.notSent) {
                    throw new RuijieError(
                        'The router stopped answering while the upgrade request was being sent: it may be restarting into the upgrade, or the request may not have arrived. Check net_listFirmware in about five minutes before trying again.',
                        'unreachable'
                    );
                }
                throw error;
            }
            return {
                applied: true,
                object: { device: { mac }, model, current: offer.current, available: { version: offer.version! }, upgradable: true },
                owned: [],
                warnings: ['The router is downloading and installing the firmware and will restart; check net_listFirmware in about five minutes.'],
            };
        });
        return plan;
    }

    /**
     * Plans setting or removing one DHCP reservation. The basis covers the router, its networks,
     * every reservation and the devices the change moves: anything else changed since is a CONFLICT.
     */
    private async planReservation(change: Extract<Change, { kind: 'reservation' }>): Promise<Plan> {
        const { mac: routerMac } = await this.router();
        const networks = await this.listNetworks();
        const entries = list((await this.client.config<Raw>('dhcp_static')).dhcp_static);
        const clients = await this.listClients();
        const world = { networks, reservations: toReservations(entries, networks), clients };
        const entryOf = (mac: string) => entries.find((e) => normalizeMac(text(e.macaddr)) === normalizeMac(mac));
        let step: Plan['steps'][number];
        let effects: string[];
        let wouldLockOut: Client[] = [];
        let write: () => Promise<unknown>;
        let expect: (after: Reservation | undefined) => boolean;
        if (change.op === 'delete') {
            const checked = checkReservationDelete(change.mac, world);
            const entry = entryOf(checked.mac)!;
            ({ step, effects } = checked);
            // The address exactly as the router stores it.
            write = () => this.client.call('devConfig.del', 'dhcp_static', { macaddr: [text(entry.macaddr)] });
            expect = (after) => after === undefined;
        } else {
            const checked = checkReservationSet(change.value, world, { descriptions: false });
            const entry = entryOf(checked.mac);
            if (!entry && entries.length >= MAX_RESERVATIONS) throw new NetError('LIMIT', `The router keeps at most ${MAX_RESERVATIONS} reservations; remove one first`);
            ({ step, effects, wouldLockOut } = checked);
            write = entry
                ? () => this.client.call('devConfig.update', 'dhcp_static', { new: { ...entry, ipaddr: checked.ip }, old: entry })
                : () => this.client.call('devConfig.add', 'dhcp_static', { list: [{ macaddr: checked.mac.toLowerCase().replace(/-/g, ':'), ipaddr: checked.ip }] });
            expect = (after) => after?.ip === checked.ip && 'id' in after.network && after.network.id === checked.network.id;
        }
        const plan: Plan = {
            change,
            vendor: 'ruijie',
            steps: [{ ...step, object: 'ruijie.dhcp_static' }],
            effects,
            wouldLockOut,
            basis: createHash('sha256')
                .update(JSON.stringify({ change, controller: this.id, router: routerMac, networks, entries, lockOut: wouldLockOut.map((c) => c.mac).sort() }))
                .digest('hex')
                .slice(0, 16),
        };
        const mac = 'mac' in change ? change.mac : change.value.mac;
        this.executors.set(plan, async () => {
            try {
                await write();
            } catch (error) {
                // Sent but unanswered: the router may or may not have stored it.
                if (error instanceof RuijieError && error.kind === 'unreachable' && !error.notSent) {
                    throw new RuijieError('The router stopped answering while the reservation was being sent, so it may or may not be stored; check net_listReservations before trying again.', 'unreachable');
                }
                throw error;
            }
            let after: Reservation[];
            try {
                after = await this.listReservations();
            } catch {
                return { applied: true, owned: [], warnings: ['The router accepted the reservation change, but reading it back failed; check it with net_listReservations.'] };
            }
            const found = after.find((r) => normalizeMac(r.mac) === normalizeMac(mac));
            if (!expect(found)) throw new NetError('CONFLICT', 'The router accepted the reservation change but shows something else now; check it with net_listReservations.');
            return { applied: true, ...(found ? { object: found } : {}), owned: [] };
        });
        return plan;
    }

    async apply(plan: Plan, options: { allowLockout?: boolean } = {}): Promise<ApplyResult> {
        const run = this.queue.then(async () => {
            // Planned again right before writing: anything changed since is a CONFLICT.
            const fresh = await this.plan(plan.change);
            if (fresh.basis !== plan.basis) throw new NetError('CONFLICT', 'The router changed after this change was planned; nothing was written. Plan it again.');
            if (fresh.change.kind === 'reservation') {
                if (fresh.wouldLockOut.length && !options.allowLockout) {
                    throw new NetError('LOCKOUT', `This moves ${fresh.wouldLockOut.length} online device(s) to another address at their next DHCP renewal. Nothing was changed; repeat with allowLockout and the dry run's basis if that is intended.`, {
                        clients: fresh.wouldLockOut,
                    });
                }
                return await this.executors.get(fresh)!();
            }
            // The router restarts whoever is online, so an upgrade always needs allowLockout (and so the dry run's basis).
            if (!options.allowLockout) {
                const who = fresh.wouldLockOut.length ? `cut off ${fresh.wouldLockOut.length} online device(s) and ` : '';
                throw new NetError('LOCKOUT', `The upgrade would ${who}make the router unreachable while it restarts. Nothing was changed; repeat with allowLockout and the dry run's basis if that is intended.`, {
                    clients: fresh.wouldLockOut,
                });
            }
            return await this.executors.get(fresh)!();
        });
        this.queue = run.catch(() => undefined);
        return await run;
    }
}
