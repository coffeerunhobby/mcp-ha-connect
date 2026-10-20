/**
 * Omada switch ports, port profiles and the mDNS repeater for the vendor-neutral model:
 * pure mapping and checks, no controller calls (those are in omada.ts).
 *
 * - A port follows a port profile (`profileId`) unless it has its own settings
 *   (`profileOverrideEnable`, "custom" since controller 6.2.10). Its networks come from the
 *   profile only when the profile sets them (`vlanConfigEnable`); otherwise the port has its own
 *   (`profileVlanOverrideEnable`), and the controller refuses to put it back on the profile's
 *   (live, 6.3.0.45). No read returns a port's networks, but each network lists the ports that
 *   carry it (`switchInfo.affectedPorts`): that is what the port carries, whatever set it.
 * - Which port links the switch to the rest of the network comes from the site topology:
 *   the switch's own uplink (`upperInfo.port`) and every adopted device below it
 *   (`wiredUpLink.upLinkPort`). If that can't be told, no port of the switch is changed.
 * - mDNS: the model's repeater is one gateway rule (type 1) that repeats between the same
 *   networks in both directions; access point rules (by VLAN) or several rules are foreign.
 */

import { normalizeMac } from '../../omadaClient/client.js';
import type { RawRecord } from '../../omadaClient/networkConfig.js';
import type { Client, MdnsRepeater, Network, PortNetworks, PortProfile, Ref } from '../model.js';

/** networkTagsSetting of a port profile (v2) and of a port. */
export const TAGS = { all: 0, none: 1, custom: 2 } as const;
/** mDNS rule types: 1 = gateway, between networks; 0 = access points, by VLAN id. */
export const MDNS_GATEWAY = 1;

const ids = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
/** Profiles built here always refer to networks by id. */
const idOf = (ref: Ref | undefined): string | undefined => (ref && 'id' in ref ? ref.id : undefined);

/** A profile, with its networks only when it sets them (no `vlanConfigEnable` field: older controllers, where it always does). */
export function toPortProfile(raw: RawRecord): PortProfile {
    const native = typeof raw.nativeNetworkId === 'string' && raw.nativeNetworkId !== '' ? raw.nativeNetworkId : undefined;
    const untagged = ids(raw.untagNetworkIds).filter((id) => id !== native);
    const tagIds = ids(raw.tagNetworkIds);
    let tagged: PortNetworks['tagged'];
    if (raw.networkTagsSetting === TAGS.all) tagged = 'all';
    else if (raw.networkTagsSetting === TAGS.none) tagged = 'none';
    else tagged = tagIds.length ? tagIds.map((id) => ({ id })) : 'none';
    const networks: PortNetworks = {
        ...(native ? { native: { id: native } } : {}),
        ...(untagged.length ? { untagged: untagged.map((id) => ({ id })) } : {}),
        tagged,
    };
    return {
        id: String(raw.id),
        name: String(raw.name),
        ...(raw.vlanConfigEnable === false ? {} : { networks }),
        isolation: raw.portIsolationEnable === true,
    };
}

/**
 * What one port of a switch carries, from each network's `affectedPorts` for that switch
 * (network id -> affectedPorts; a network the switch isn't listed under reaches none of its
 * ports). Undefined when the lists contradict each other: two native networks, or a network
 * both tagged and untagged on the port.
 */
export function toPortNetworks(affected: Map<string, RawRecord>, port: number): PortNetworks | undefined {
    const on = (a: RawRecord, key: string) => Array.isArray(a[key]) && (a[key] as unknown[]).some((p) => Number(p) === port);
    const native: string[] = [];
    const untagged: string[] = [];
    const tagged: string[] = [];
    for (const [id, a] of affected) {
        if (on(a, 'nativePorts')) native.push(id);
        else if (on(a, 'untagPorts')) untagged.push(id);
        if (on(a, 'tagPorts')) tagged.push(id);
    }
    if (native.length > 1 || tagged.some((id) => native.includes(id) || untagged.includes(id))) return undefined;
    return {
        ...(native.length ? { native: { id: native[0] } } : {}),
        ...(untagged.length ? { untagged: untagged.map((id) => ({ id })) } : {}),
        tagged: tagged.length ? tagged.map((id) => ({ id })) : 'none',
    };
}

/** How a port carries a network: as the native network, as a further untagged one, tagged, or not at all. */
function carries(networks: PortNetworks, networkId: string): 'native' | 'untagged' | 'tagged' | 'none' {
    if (idOf(networks.native) === networkId) return 'native';
    if (networks.untagged?.some((r) => idOf(r) === networkId)) return 'untagged';
    if (networks.tagged === 'all') return 'tagged';
    if (networks.tagged !== 'none' && networks.tagged.some((r) => idOf(r) === networkId)) return 'tagged';
    return 'none';
}

/**
 * The online devices on a port that would lose their network when what it carries changes:
 * a device keeps working only if its network reaches it the same way (native, further
 * untagged, or tagged) before and after. A device whose network is unknown, or that its
 * network didn't reach before, counts as cut off (fail closed), and so does every device
 * when what the port carries now is unknown.
 */
export function cutOff(seen: Client[], from: PortNetworks | undefined, to: PortNetworks): Client[] {
    return seen.filter((c) => {
        const net = c.network && 'id' in c.network ? c.network.id : undefined;
        if (!net || !from) return true;
        const before = carries(from, net);
        return before === 'none' || carries(to, net) !== before;
    });
}

/** "untagged = IoT, tagged = all networks" with network names. */
export function describeNetworks(carried: PortNetworks, networks: Network[]): string {
    const name = (r: Ref) => ('id' in r ? (networks.find((n) => n.id === r.id)?.name ?? r.id) : r.name);
    const native = carried.native ? name(carried.native) : 'none';
    const tagged = carried.tagged === 'all' ? 'all networks' : carried.tagged === 'none' ? 'none' : carried.tagged.map(name).join(', ');
    return `untagged = ${[native, ...(carried.untagged ?? []).map(name)].join(', ')}, tagged = ${tagged}`;
}

const sameMac = (a: unknown, b: string) => typeof a === 'string' && normalizeMac(a) === normalizeMac(b);
const portOf = (value: unknown): number | undefined => {
    const port = Number((value as RawRecord | undefined)?.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
};

/**
 * The ports of a switch that link it to other network devices, with the reason; undefined
 * when that can't be told (a device the controller manages is missing from the topology, the
 * topology is incomplete or contradicts itself, the switch's link upwards has no port, or a
 * device below it reports a wired link without one).
 */
export function linkPorts(topology: RawRecord, switchMac: string, adopted: string[]): Map<number, string> | undefined {
    const nodes = topology.topologyNodes;
    const edges = topology.topologyEdges;
    if (!Array.isArray(nodes) || !Array.isArray(edges)) return undefined;
    // Each device once; every link between described devices; every device but the gateway linked
    // upwards exactly once. Anything else is a gap or a contradiction: a device whose port is unknown.
    const macs = (nodes as RawRecord[]).map((n) => normalizeMac(String(n.mac)));
    if (new Set(macs).size !== macs.length) return undefined;
    // An adopted device left out altogether (node and link) would leave its port unprotected.
    if (adopted.some((mac) => !macs.includes(normalizeMac(mac)))) return undefined;
    const described = (mac: unknown) => macs.includes(normalizeMac(String(mac)));
    if ((edges as RawRecord[]).some((e) => !described(e.upLinkMac) || !described(e.downLinkMac))) return undefined;
    const uplinks = (mac: unknown) => (edges as RawRecord[]).filter((e) => sameMac(e.downLinkMac, String(mac)));
    if ((nodes as RawRecord[]).some((n) => uplinks(n.mac).length !== (n.type === 'gateway' ? 0 : 1))) return undefined;
    // Every device's chain of links upwards ends at a gateway (no loops, self-links included; no islands).
    const reachesGateway = (mac: unknown): boolean => {
        let at = String(mac);
        for (let step = 0; step <= nodes.length; step++) {
            const n = (nodes as RawRecord[]).find((x) => sameMac(x.mac, at))!;
            if (n.type === 'gateway') return true;
            at = String(uplinks(at)[0].upLinkMac);
        }
        return false;
    };
    if (!(nodes as RawRecord[]).every((n) => reachesGateway(n.mac))) return undefined;
    const node = (nodes as RawRecord[]).find((n) => sameMac(n.mac, switchMac));
    if (!node) return undefined;
    // Every linked device is described (checked above).
    const label = (mac: unknown) => {
        const n = (nodes as RawRecord[]).find((x) => sameMac(x.mac, String(mac)))!;
        return `${String(n.type ?? 'device')} '${String(n.name ?? n.mac)}'`;
    };
    // Without its own uplink port (e.g. below a router the controller doesn't manage) nothing is certain.
    const uplink = portOf((node.upperInfo as RawRecord | undefined)?.port);
    if (uplink === undefined) return undefined;
    const up = (edges as RawRecord[]).find((e) => sameMac(e.downLinkMac, switchMac))!;
    const links = new Map<number, string>([[uplink, `it links the switch to ${label(up.upLinkMac)}`]]);
    for (const edge of (edges as RawRecord[]).filter((e) => sameMac(e.upLinkMac, switchMac))) {
        const below = (nodes as RawRecord[]).find((n) => sameMac(n.mac, String(edge.downLinkMac)))!;
        // The port on this switch is reported as wiredUpLink.upLinkPort (access points, controllers)
        // or upperInfo.upLinkPort (switches); two reports must agree.
        const wired = below.wiredUpLink as RawRecord | undefined;
        const upper = below.upperInfo as RawRecord | undefined;
        const reports = [wired?.upLinkPort, upper?.upLinkPort].filter((r) => r !== undefined);
        // Only a device linked purely wirelessly (a mesh access point) has no port here.
        if (!wired && reports.length === 0 && below.wirelessUpLink) continue;
        const ports = reports.map(portOf);
        const port = ports[0];
        if (port === undefined || ports.some((p) => p !== port)) return undefined;
        links.set(port, `it carries ${label(edge.downLinkMac)}`);
    }
    return links;
}

/**
 * The repeater as the model sees it, and the one gateway rule behind it. Foreign when the
 * controller has access point rules, several rules, or a rule that repeats from some
 * networks to others.
 */
export function toMdns(rules: RawRecord[]): { repeater: MdnsRepeater; rule?: RawRecord; networkIds: string[] } {
    if (rules.length === 0) return { repeater: { enabled: false, networks: [] }, networkIds: [] };
    const foreign = (reason: string, rule?: RawRecord): { repeater: MdnsRepeater; rule?: RawRecord; networkIds: string[] } => ({
        repeater: { enabled: rules.some((r) => r.status === true), networks: [], foreign: { reason } },
        ...(rule ? { rule } : {}),
        networkIds: [],
    });
    if (rules.some((r) => r.type !== MDNS_GATEWAY)) return foreign('The controller has access point mDNS rules (by VLAN id); they are managed in the controller web UI.');
    if (rules.length > 1) return foreign(`The controller has ${rules.length} gateway mDNS rules; the model has one repeater. Manage them in the controller web UI.`);
    const rule = rules[0];
    const osg = (rule.osg ?? {}) as RawRecord;
    const service = [...new Set(ids(osg.serviceNetworks))];
    const client = [...new Set(ids(osg.clientNetworks))];
    if (service.length !== client.length || service.some((id) => !client.includes(id))) {
        return foreign(`mDNS rule '${String(rule.name)}' repeats from some networks to others (one way); the model repeats between networks both ways.`, rule);
    }
    return { repeater: { enabled: rule.status === true, networks: service.map((id) => ({ id })) }, rule, networkIds: service };
}
