/**
 * net_ rules on Omada (2.4.7): the neutral Rule <-> Omada gateway ACL.
 *
 * The gateway (ER605) routes between the VLANs, so network-to-network policy lives in
 * gateway ACLs with direction LAN→LAN; rules towards the internet are LAN→WAN.
 *
 * Verified on the live controller (6.3.0.45, ER605 v2, 2026-10-20):
 * - LAN→LAN rules between networks (endpoint type 0) and towards an IP-port group
 *   (endpoint type 2); IP-port groups {type: 1, ipList, portType: 0, portList: ["1883"]};
 * - stateMode 0 ("Auto") is stateful on the ER605: TP-Link's one-way VLAN guide (deny
 *   IoT→LAN, Auto) leaves the LAN able to reach IoT and IoT unable to reach the LAN, so a
 *   block rule does not drop replies. "Manual" connection states are not verified, so a
 *   rule that also matches replies is refused.
 * Not offered through the API, so refused: the gateway itself as a destination (gateway
 * ACLs filter traffic passing through it), one device by MAC, schedules (the omada_
 * time-range tools do those).
 *
 * Addresses given in a rule become an IP group (or IP-port group) the rule owns: its
 * name starts with the rule's tag "[net:<key>]", which also ends the ACL description, so
 * they are listed as part of the rule and removed with it.
 */

import { randomBytes } from 'node:crypto';

import type { RawRecord } from '../../omadaClient/networkConfig.js';
import { parseCidr, subnetsOverlap } from '../../utils/ipv4.js';
import { NetError, type Network, type Ref, type Rule, type Selector } from '../model.js';
import { checkName } from '../validate.js';

export const POLICY = { block: 0, allow: 1 } as const;
const PROTOCOL = { any: 256, tcp: 6, udp: 17, icmp: 1 } as const;
export const ENDPOINT = { network: 0, ipGroup: 1, ipPortGroup: 2, ssid: 4 } as const;
export const GROUP_TYPE = { ip: 0, ipPort: 1 } as const;
const PORT_TYPE_LIST = 0;
const ANY_GROUP = 'IPGroup_Any';
/** Omada's ACL description limit, minus room for the " [net:xxxxxxxx]" tag. */
export const MAX_RULE_NAME = 512 - 16;
const MAX_PORTS = 16;
const TAG = /\s*\[net:([0-9a-f]{8})\]$/;
/** The exact name of a group some rule owns (ownedGroupName); the omada_ group tools refuse the "[net:" prefix. */
const OWNED = /^\[net:[0-9a-f]{8}\] (from|to) [0-9a-f]{16}$/;

/** Everything the rule mapping reads from the controller. */
export interface RuleWorld {
    networks: Network[];
    /** Gateway ACLs in evaluation order. */
    acls: RawRecord[];
    ipGroups: RawRecord[];
    ipPortGroups: RawRecord[];
    ssids: Array<{ id: string; name: string }>;
    /** The controller's IPv4 addresses (numbers), or 'unknown' when its host name can't be resolved. */
    controllerAddresses: number[] | 'unknown';
}

type Direction = 'lanToLan' | 'lanToWan';

/** One side of a rule: existing Omada objects, or a group the rule will own. */
export type Endpoint =
    | { type: number; ids: string[]; label: string }
    | { type: number; newGroup: { groupType: 0 | 1; body: RawRecord }; label: string };

export interface RuleDraft {
    name: string;
    direction: Direction;
    policy: number;
    protocols: number[];
    source: Endpoint;
    destination: Endpoint;
    enabled: boolean;
    effects: string[];
}

export type RuleFields = Pick<Rule, 'name' | 'action' | 'from' | 'to' | 'protocol' | 'replies' | 'schedule' | 'enabled'>;

// ---- tags and names ---------------------------------------------------------------------

export function ruleKey(description: string): string | undefined {
    return TAG.exec(description)?.[1];
}

export function ruleName(description: string): string {
    return description.replace(TAG, '');
}

export function newRuleKey(): string {
    return randomBytes(4).toString('hex');
}

export function tagged(name: string, key: string | undefined): string {
    return key ? `${name} [net:${key}]` : name;
}

/** A name for a group the rule owns, not among `taken` (an update must never reuse the name of the group it replaces). */
export function ownedGroupName(key: string, side: 'from' | 'to', taken: Set<string>): string {
    for (let i = 0; i < 5; i++) {
        const name = `[net:${key}] ${side} ${randomBytes(8).toString('hex')}`;
        if (!taken.has(name)) return name;
    }
    throw new NetError('CONFLICT', 'Could not find an unused group name; try again');
}

export function ownsGroup(key: string | undefined, group: RawRecord): boolean {
    return key !== undefined && isOwnedGroup(group) && String(group.name).startsWith(`[net:${key}] `);
}

/** Whether a group belongs to some net_ rule (never shared: it goes when its last user does). */
export function isOwnedGroup(group: RawRecord): boolean {
    return OWNED.test(String(group.name));
}

/** The rule's direction as stored on the controller, when it is a plain one. */
export function rawDirection(raw: RawRecord): Direction | undefined {
    const dir = (raw.direction ?? {}) as { lanToWan?: boolean; lanToLan?: boolean; wanInIds?: unknown[]; vpnInIds?: unknown[] };
    const inbound = (dir.wanInIds?.length ?? 0) > 0 || (dir.vpnInIds?.length ?? 0) > 0;
    if (inbound) return undefined;
    if (dir.lanToLan === true && dir.lanToWan !== true) return 'lanToLan';
    if (dir.lanToWan === true && dir.lanToLan !== true) return 'lanToWan';
    return undefined;
}

// ---- references ---------------------------------------------------------------------------

/** By id, or by unique name (case-insensitive); an exact id given as a name wins. */
export function resolve<T extends { id: string; name: string }>(items: T[], ref: Ref, what: string): T {
    if ('id' in ref) {
        const byId = items.find((i) => i.id === ref.id);
        if (byId) return byId;
        throw new NetError('NOT_FOUND', `No ${what} with id '${ref.id}'`);
    }
    // Tools pass what the user typed as { name }; an exact id match wins.
    const byId = items.find((i) => i.id === ref.name);
    if (byId) return byId;
    const wanted = ref.name.trim().toLowerCase();
    const matches = items.filter((i) => i.name.toLowerCase() === wanted);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new NetError('AMBIGUOUS', `Several ${what}s are named '${ref.name}'; use the id`);
    throw new NetError('NOT_FOUND', `${what[0].toUpperCase()}${what.slice(1)} '${ref.name}' not found. Available: ${items.map((i) => i.name).join(', ') || '(none)'}`);
}

function groupItems(groups: RawRecord[]): Array<{ id: string; name: string; raw: RawRecord }> {
    return groups.map((g) => ({ id: String(g.groupId), name: String(g.name), raw: g }));
}

/**
 * By name when that name is unique and no other item has it as its id (resolve tries ids
 * first), else by id: readable, and resolving back to the same item.
 */
function refTo(items: Array<{ id: string; name: string }>, id: string): Ref {
    const item = items.find((i) => i.id === id);
    if (!item) return { id };
    const unique = items.filter((i) => i.name.toLowerCase() === item.name.toLowerCase()).length === 1;
    const shadowedById = items.some((i) => i.id === item.name && i.id !== item.id);
    return unique && !shadowedById ? { name: item.name } : { id };
}

// ---- Omada -> neutral -------------------------------------------------------------------

export function toRule(raw: RawRecord, position: number, world: RuleWorld): Rule {
    const description = String(raw.description ?? '');
    const key = ruleKey(description);
    const foreign: string[] = [];
    const dir = (raw.direction ?? {}) as { wanInIds?: unknown[]; vpnInIds?: unknown[] };
    const inbound = (dir.wanInIds?.length ?? 0) > 0 || (dir.vpnInIds?.length ?? 0) > 0;
    const direction = rawDirection(raw);
    if (!direction) foreign.push(inbound ? 'traffic coming in from the WAN or a VPN' : 'several directions in one rule');

    const networkItems = world.networks.map((n) => ({ id: n.id, name: n.name }));
    const ipGroups = groupItems(world.ipGroups);
    const ipPortGroups = groupItems(world.ipPortGroups);

    const endpoint = (type: number, ids: string[], side: 'from' | 'to'): { selectors: Selector[]; ports?: string } => {
        if (type === ENDPOINT.network) return { selectors: ids.map((id) => ({ network: refTo(networkItems, id) })) };
        if (type === ENDPOINT.ssid && side === 'from') return { selectors: ids.map((id) => ({ wifi: refTo(world.ssids, id) })) };
        if (type === ENDPOINT.ipPortGroup && side === 'from') {
            // The model has no source ports: such a rule can't be shown (or protected) faithfully.
            foreign.push('a source with ports');
            return { selectors: [] };
        }
        if (type === ENDPOINT.ipGroup || type === ENDPOINT.ipPortGroup) {
            const pool = type === ENDPOINT.ipGroup ? ipGroups : ipPortGroups;
            const selectors: Selector[] = [];
            let ports: string | undefined;
            for (const id of ids) {
                const group = pool.find((g) => g.id === id);
                if (!group) {
                    foreign.push(`an unknown group ${id}`);
                    continue;
                }
                if (type === ENDPOINT.ipPortGroup) {
                    ports = ((group.raw.portList as unknown[] | undefined) ?? []).map(String).join(',');
                    // The model writes ports only into groups it owns; one made elsewhere can't be kept or rewritten faithfully.
                    if (!ownsGroup(key, group.raw)) foreign.push(`the port group ${group.name} made elsewhere`);
                }
                if (side === 'to' && direction === 'lanToWan' && group.name === ANY_GROUP) {
                    selectors.push({ internet: true });
                    continue;
                }
                if (side === 'to' && direction && directionOf(group.raw, world) !== direction) {
                    // Editing would recompute the direction from the addresses and change what the rule applies to.
                    foreign.push(`a ${direction === 'lanToLan' ? 'LAN to LAN' : 'LAN to internet'} rule whose destination ${group.name} doesn't match that direction`);
                }
                if (ownsGroup(key, group.raw)) selectors.push({ addresses: addressesOf(group.raw) });
                else selectors.push({ group: refTo(pool, id) });
            }
            return { selectors, ...(ports !== undefined ? { ports } : {}) };
        }
        foreign.push(`a ${side === 'from' ? 'source' : 'destination'} of type ${type}`);
        return { selectors: [] };
    };

    const from = endpoint(Number(raw.sourceType), (raw.sourceIds as string[] | undefined) ?? [], 'from');
    const to = endpoint(Number(raw.destinationType), (raw.destinationIds as string[] | undefined) ?? [], 'to');
    if (direction === 'lanToWan' && Number(raw.destinationType) === ENDPOINT.network) foreign.push('a LAN network as the destination of a LAN to internet rule (it never matches)');

    const protocols = ((raw.protocols as number[] | undefined) ?? []).slice().sort((a, b) => a - b);
    let protocol: Rule['protocol'] = 'any';
    if (to.ports !== undefined) {
        if (protocols.join() === `${PROTOCOL.tcp},${PROTOCOL.udp}`) protocol = { tcpUdpPorts: to.ports };
        else foreign.push('ports on only one of TCP/UDP');
    } else {
        const named = (Object.keys(PROTOCOL) as Array<keyof typeof PROTOCOL>).find((p) => protocols.length === 1 && protocols[0] === PROTOCOL[p]);
        if (named) protocol = named;
        else foreign.push(`protocols ${protocols.join(', ')}`);
    }
    if (Number(raw.stateMode ?? 0) !== 0) foreign.push('manual connection states');
    if (raw.timeRangeId) foreign.push('a schedule (edit it with the omada_ gateway ACL tools)');

    return {
        id: String(raw.id),
        name: ruleName(description),
        action: raw.policy === POLICY.allow ? 'allow' : 'block',
        from: from.selectors,
        to: to.selectors,
        protocol,
        replies: 'allow',
        schedule: { kind: 'always' },
        enabled: raw.status === true,
        position,
        ...(foreign.length ? { foreign: { reason: `Not editable through net_: ${foreign.join('; ')}.` } } : {}),
    };
}

/** The direction a group's addresses call for, or undefined when they mix (or can't be read). */
function directionOf(group: RawRecord, world: RuleWorld): Direction | undefined {
    try {
        return classify((group.ipList as Array<{ ip: string; mask: number }> | undefined) ?? [], world, String(group.name));
    } catch {
        return undefined;
    }
}

function addressesOf(group: RawRecord): string[] {
    return ((group.ipList as Array<{ ip: string; mask: number }> | undefined) ?? []).map((e) => (Number(e.mask) === 32 ? e.ip : `${e.ip}/${e.mask}`));
}

// ---- neutral -> Omada -------------------------------------------------------------------

/**
 * Validates a rule and works out its Omada shape. `self` is the rule being changed (its
 * own name doesn't collide; on update, sides that didn't change keep their Omada objects).
 */
export function draftRule(value: RuleFields, world: RuleWorld, self?: { raw: RawRecord; rule: Rule }): RuleDraft {
    const name = checkName(value.name, MAX_RULE_NAME, 'Rule');
    // The tag marks what a rule owns; a name carrying one could pass for another rule (or for none).
    if (/\[net:/i.test(name)) throw new NetError('INVALID', "A rule name can't contain '[net:': it is reserved for the tag that ties a rule to its groups");
    // Names never carry a tag, so comparing against the untagged part of each description is enough.
    const taken = world.acls.some((a) => String(a.id) !== String(self?.raw.id) && ruleName(String(a.description)).toLowerCase() === name.toLowerCase());
    if (taken) throw new NetError('EXISTS', `A rule named '${name}' already exists`);
    if (value.replies === 'match') {
        throw unsupported("rules that also match replies (stateless). Omada's rules let replies through (Auto); its manual connection states aren't verified", 'rules.stateful');
    }
    if (value.schedule.kind !== 'always') throw unsupported('schedules on net_ rules yet (use omada_createTimeRange with omada_createGatewayAcl)', 'rules.schedule');

    const ports = typeof value.protocol === 'object' ? parsePorts(value.protocol.tcpUdpPorts) : undefined;
    const { endpoint: destination, direction } = destinationOf(value.to, world, ports, value.protocol, self);
    const source = sourceOf(value.from, world, self);
    const protocols = ports ? [PROTOCOL.tcp, PROTOCOL.udp] : [PROTOCOL[value.protocol as keyof typeof PROTOCOL]];

    if (source.type === ENDPOINT.network && destination.type === ENDPOINT.network && 'ids' in source && 'ids' in destination) {
        const same = source.ids.filter((id) => destination.ids.includes(id));
        if (same.length) throw new NetError('INVALID', "A network can't be both source and destination: traffic inside one network never passes the gateway");
    }

    const verb = value.action === 'allow' ? 'may reach' : 'can no longer start connections to';
    const what = ports ? ` on TCP/UDP ${ports.join(', ')}` : value.protocol === 'any' ? '' : ` (${String(value.protocol).toUpperCase()} only)`;
    const effects = [`${source.label} ${verb} ${destination.label}${what}.`];
    if (value.action === 'block') effects.push('Replies to connections started from the other side still pass (stateful).');
    if (!value.enabled) effects.push('The rule is created switched off.');
    return { name, direction, policy: POLICY[value.action], protocols, source, destination, enabled: value.enabled, effects };
}

function sourceOf(selectors: Selector[], world: RuleWorld, self?: { raw: RawRecord; rule: Rule }): Endpoint {
    const kind = singleKind(selectors, 'source');
    if (self && sameSelectors(selectors, self.rule.from)) {
        return { type: Number(self.raw.sourceType), ids: (self.raw.sourceIds as string[]) ?? [], label: label(selectors, world) };
    }
    switch (kind) {
        case 'network':
            return { type: ENDPOINT.network, ids: routedNetworks(selectors, world).map((n) => n.id), label: label(selectors, world) };
        case 'group':
            return { type: ENDPOINT.ipGroup, ids: selectors.map((s) => sharedGroup(world, (s as { group: Ref }).group).id), label: label(selectors, world) };
        case 'addresses': {
            const entries = selectors.flatMap((s) => (s as { addresses: string[] }).addresses).map(parseAddress);
            return { type: ENDPOINT.ipGroup, newGroup: { groupType: GROUP_TYPE.ip, body: { type: GROUP_TYPE.ip, ipList: entries } }, label: label(selectors, world) };
        }
        case 'device':
            throw unsupported('matching one device (give its address in addresses; a DHCP reservation keeps it fixed)', 'rules.deviceMatch');
        case 'wifi':
            throw unsupported('a Wi-Fi network as a net_ rule source (omada_createGatewayAcl does it for LAN to internet rules)', 'rules.wifiMatch');
        default:
            throw new NetError('INVALID', 'A rule starts from networks, a group or addresses, not from the internet or the gateway');
    }
}

function destinationOf(
    selectors: Selector[],
    world: RuleWorld,
    ports: string[] | undefined,
    protocol: Rule['protocol'],
    self?: { raw: RawRecord; rule: Rule }
): { endpoint: Endpoint; direction: Direction } {
    const kind = singleKind(selectors, 'destination');
    if (ports && kind !== 'addresses') throw new NetError('INVALID', 'Ports go with addresses as the destination (e.g. to: [{ addresses: ["192.0.2.10"] }])');
    switch (kind) {
        case 'network': {
            const keep = self && sameSelectors(selectors, self.rule.to) && Number(self.raw.destinationType) === ENDPOINT.network;
            const ids = keep ? ((self.raw.destinationIds as string[]) ?? []) : routedNetworks(selectors, world).map((n) => n.id);
            return { endpoint: { type: ENDPOINT.network, ids, label: label(selectors, world) }, direction: 'lanToLan' };
        }
        case 'internet': {
            const any = world.ipGroups.find((g) => g.name === ANY_GROUP);
            if (!any) throw new NetError('NOT_FOUND', `The built-in IP group ${ANY_GROUP} is missing on the controller`);
            return { endpoint: { type: ENDPOINT.ipGroup, ids: [String(any.groupId)], label: 'the internet' }, direction: 'lanToWan' };
        }
        case 'group': {
            const groups = selectors.map((s) => sharedGroup(world, (s as { group: Ref }).group));
            const entries = groups.flatMap((g) => (g.raw.ipList as Array<{ ip: string; mask: number }> | undefined) ?? []);
            // An existing rule whose stored direction differs from what its addresses call for is
            // foreign (toRule), so recomputing it here never flips an editable rule.
            return { endpoint: { type: ENDPOINT.ipGroup, ids: groups.map((g) => g.id), label: label(selectors, world) }, direction: classify(entries, world, label(selectors, world)) };
        }
        case 'addresses': {
            const entries = selectors.flatMap((s) => (s as { addresses: string[] }).addresses).map(parseAddress);
            // Never flips an editable rule: a stored direction that differs is foreign (toRule).
            const direction = classify(entries, world, 'These addresses');
            // Same addresses and the same protocol/ports: keep the group the rule already has.
            const sameAsBefore = self && sameSelectors(selectors, self.rule.to) && protocolKey(self.rule.protocol) === protocolKey(protocol);
            if (sameAsBefore) {
                return { endpoint: { type: Number(self.raw.destinationType), ids: (self.raw.destinationIds as string[]) ?? [], label: label(selectors, world) }, direction };
            }
            if (ports) {
                if (direction === 'lanToWan') throw unsupported('ports on a rule towards the internet through net_ yet (verified only between your networks)', 'rules.toInternet');
                return {
                    endpoint: {
                        type: ENDPOINT.ipPortGroup,
                        newGroup: { groupType: GROUP_TYPE.ipPort, body: { type: GROUP_TYPE.ipPort, ipList: entries, portType: PORT_TYPE_LIST, portList: ports } },
                        label: label(selectors, world),
                    },
                    direction,
                };
            }
            return { endpoint: { type: ENDPOINT.ipGroup, newGroup: { groupType: GROUP_TYPE.ip, body: { type: GROUP_TYPE.ip, ipList: entries } }, label: label(selectors, world) }, direction };
        }
        case 'gateway':
            throw unsupported(
                "the gateway itself as a destination: gateway rules filter traffic passing through the gateway, and the API has no option for the gateway's own addresses",
                'rules.gateway'
            );
        case 'device':
            throw unsupported('matching one device (give its address in addresses; a DHCP reservation keeps it fixed)', 'rules.deviceMatch');
        default:
            throw new NetError('INVALID', 'A Wi-Fi network is not a destination; use its network');
    }
}

/** Comparable form of a protocol ("1883, 8123" and "1883,8123" are the same ports). */
function protocolKey(protocol: Rule['protocol']): string {
    if (typeof protocol !== 'object') return protocol;
    return `ports:${protocol.tcpUdpPorts.split(',').map((p) => String(Number(p.trim()))).join(',')}`;
}

/** An IP group a rule may reference by name: not one another rule owns (those are never shared). */
function sharedGroup(world: RuleWorld, ref: Ref): { id: string; name: string; raw: RawRecord } {
    const group = resolve(groupItems(world.ipGroups), ref, 'IP group');
    if (isOwnedGroup(group.raw)) throw new NetError('INVALID', `IP group '${group.name}' belongs to another rule; give the addresses instead`);
    return group;
}

type Kind = 'network' | 'device' | 'group' | 'addresses' | 'wifi' | 'internet' | 'gateway';

function kindOf(selector: Selector): Kind {
    return Object.keys(selector)[0] as Kind;
}

/** Omada takes one kind of endpoint per side; mixing kinds needs several rules. */
function singleKind(selectors: Selector[], side: 'source' | 'destination'): Kind {
    if (selectors.length === 0) throw new NetError('INVALID', `The rule needs a ${side}`);
    const kinds = [...new Set(selectors.map(kindOf))];
    if (kinds.length > 1) throw new NetError('INVALID', `Omada takes one kind of ${side} per rule (got ${kinds.join(' and ')}); split it into several rules`);
    if ((kinds[0] === 'internet' || kinds[0] === 'gateway') && selectors.length > 1) throw new NetError('INVALID', `Give the ${kinds[0]} once`);
    return kinds[0];
}

function sameSelectors(a: Selector[], b: Selector[]): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** Networks the gateway routes (a switch-only network's traffic never reaches it). */
function routedNetworks(selectors: Selector[], world: RuleWorld): Network[] {
    return selectors.map((s) => {
        const network = resolve(world.networks, (s as { network: Ref }).network, 'network');
        if (network.purpose === 'vlanOnly' || !network.gateway) throw new NetError('INVALID', `'${network.name}' is switch-only: its traffic never passes the gateway, so a gateway rule can't apply to it`);
        return network;
    });
}

/** Whether addresses are on the site's own networks (LAN→LAN) or beyond them (LAN→WAN). */
function classify(entries: Array<{ ip: string; mask: number }>, world: RuleWorld, what: string): Direction {
    const lans = world.networks.filter((n) => n.gateway).map((n) => n.gateway!);
    let inside = 0;
    for (const e of entries) {
        const cidr = `${e.ip}/${e.mask}`;
        const range = parseCidr(cidr);
        const within = lans.some((lan) => {
            const l = parseCidr(lan);
            return range.network >= l.network && range.broadcast <= l.broadcast;
        });
        if (within) inside++;
        else if (lans.some((lan) => subnetsOverlap(cidr, lan))) {
            throw new NetError('INVALID', `${what}: ${cidr} is partly inside one of your networks; split it into a rule for your networks and one for the internet`);
        }
    }
    if (inside === entries.length) return 'lanToLan';
    if (inside === 0) return 'lanToWan';
    throw new NetError('INVALID', `${what} mix your own networks and the internet; make one rule for each`);
}

/** A rule that may apply to the controller's internet traffic; `key` changes when anything that matters about it does. */
export interface PathRule {
    key: string;
    name: string;
    allow: boolean;
}

/**
 * The rules that may apply to the controller's (and this server's) internet traffic, in
 * the order the gateway checks them: enabled, towards the internet, with a source that
 * may hold the controller (also when that can't be read or its address is unknown),
 * whatever destination, protocol or schedule they name.
 * - `active`: those that can still decide, up to and including the first complete
 *   exception (an allow of everything, all protocols, no schedule, Auto states, whose
 *   source surely holds the controller); `shadowed`: those after it, which never apply.
 * - `certain`: the first active rule is a complete block that surely holds the
 *   controller, so it is cut off today whatever else the list says.
 */
export function controllerPath(acls: RawRecord[], world: RuleWorld): { active: PathRule[]; shadowed: Set<string>; certain: boolean } {
    const any = world.ipGroups.find((g) => g.name === ANY_GROUP)?.groupId;
    const active: PathRule[] = [];
    const shadowed = new Set<string>();
    let ended = false;
    for (const a of acls) {
        if (a.status !== true) continue;
        if ((a.direction as { lanToWan?: boolean } | undefined)?.lanToWan !== true) continue;
        const source: Endpoint = { type: Number(a.sourceType), ids: ((a.sourceIds as string[] | undefined) ?? []).map(String), label: '' };
        if (protectedSourceHit(source, world) === undefined) continue;
        const description = String(a.description ?? '');
        const entry: PathRule = { key: blockerKey(a), name: ruleName(description) || description || String(a.id), allow: a.policy === POLICY.allow };
        if (ended) {
            shadowed.add(entry.key);
            continue;
        }
        active.push(entry);
        const toEverything = Number(a.destinationType) === ENDPOINT.ipGroup && ((a.destinationIds as string[] | undefined) ?? []).map(String).includes(String(any));
        const complete = toEverything && JSON.stringify(a.protocols) === JSON.stringify([PROTOCOL.any]) && !a.timeRangeId && Number(a.stateMode ?? 0) === 0 && surelyHoldsController(source, world);
        if (complete) {
            if (!entry.allow && active.length === 1) return { active, shadowed: new Set(), certain: true };
            if (entry.allow) ended = true;
        }
    }
    return { active, shadowed, certain: false };
}

/**
 * Why a change would put the controller's internet traffic at risk, or undefined if it
 * can't. Conservative: among the rules that may apply to that traffic, a change may only
 * add allows and remove blocks. A new or changed block, a removed or changed allow, or
 * a different order among them could expose some of its traffic to a block.
 */
export function controllerRisk(before: ReturnType<typeof controllerPath>, after: ReturnType<typeof controllerPath>): string | undefined {
    if (before.certain) return undefined; // already cut off: nothing left to protect
    const was = new Map(before.active.map((r) => [r.key, r]));
    const now = new Map(after.active.map((r) => [r.key, r]));
    const block = after.active.find((r) => !r.allow && !was.has(r.key));
    if (block) return `rule '${block.name}' would then be in the way of its traffic`;
    const allow = before.active.find((r) => r.allow && !now.has(r.key) && !after.shadowed.has(r.key));
    if (allow) return `rule '${allow.name}', which lets some of its traffic through, would be removed or changed`;
    const common = (list: PathRule[], other: Map<string, PathRule>) => list.filter((r) => other.has(r.key)).map((r) => r.key).join('|');
    if (common(before.active, now) !== common(after.active, was)) return 'the order of the rules that apply to its traffic would change';
    return undefined;
}

function blockerKey(a: RawRecord): string {
    const fields = ['id', 'policy', 'protocols', 'sourceType', 'sourceIds', 'destinationType', 'destinationIds', 'direction', 'stateMode', 'timeRangeId'];
    return JSON.stringify(fields.map((f) => a[f] ?? null));
}

/** Whether a source certainly includes the controller's (known) address. */
function surelyHoldsController(source: Endpoint, world: RuleWorld): boolean {
    if (world.controllerAddresses === 'unknown' || world.controllerAddresses.length === 0) return false;
    const addresses = world.controllerAddresses;
    const ranges: Array<{ network: number; broadcast: number }> = [];
    if (source.type === ENDPOINT.network && 'ids' in source) {
        for (const n of world.networks) if (source.ids.includes(n.id) && n.gateway) ranges.push(parseCidr(n.gateway));
    } else if (source.type === ENDPOINT.ipGroup && 'ids' in source) {
        for (const g of world.ipGroups) {
            if (!source.ids.includes(String(g.groupId))) continue;
            for (const e of (g.ipList as Array<{ ip: string; mask: number }> | undefined) ?? []) ranges.push(parseCidr(`${e.ip}/${e.mask}`));
        }
    }
    return addresses.every((a) => ranges.some((r) => a >= r.network && a <= r.broadcast));
}

/**
 * The ACL a draft will become, for evaluating rule lists before anything is written: a
 * group the rule will create is added to `world` under a placeholder id.
 */
export function draftAsAcl(draft: RuleDraft, id: string, world: RuleWorld, status: boolean = draft.enabled): { acl: RawRecord; world: RuleWorld } {
    const extra: RawRecord[] = [];
    const ids = (e: Endpoint, side: string): string[] => {
        if ('ids' in e) return e.ids;
        const groupId = `${id}:${side}`;
        if (e.newGroup.groupType === GROUP_TYPE.ip) extra.push({ groupId, name: `[net:00000000] ${side}`, ...e.newGroup.body });
        return [groupId];
    };
    const acl = {
        id,
        description: draft.name,
        status,
        policy: draft.policy,
        protocols: draft.protocols,
        sourceType: draft.source.type,
        sourceIds: ids(draft.source, 'from'),
        destinationType: draft.destination.type,
        destinationIds: ids(draft.destination, 'to'),
        direction: { lanToWan: draft.direction === 'lanToWan', lanToLan: draft.direction === 'lanToLan', wanInIds: [], vpnInIds: [] },
        stateMode: 0,
    };
    return { acl, world: extra.length ? { ...world, ipGroups: [...world.ipGroups, ...extra] } : world };
}

/**
 * What a block-to-internet rule would cut off that must stay reachable, if anything: a
 * whole protected network, or addresses covering the controller (this server runs next
 * to it). One device on that network may be blocked (a curfew does exactly that). When
 * the controller's address is unknown, any address on a protected network counts.
 */
function protectedSourceHit(source: Endpoint, world: RuleWorld): string | undefined {
    const protectedNets = world.networks.filter((n) => n.protected && n.gateway);
    if (source.type === ENDPOINT.network && 'ids' in source) {
        const hit = protectedNets.find((n) => source.ids.includes(n.id));
        return hit ? `'${hit.name}'` : undefined;
    }
    // Fail closed: a source whose addresses this check can't read may hold the controller.
    if (source.type !== ENDPOINT.ipGroup) return 'a source this check cannot read';
    const entries =
        'newGroup' in source
            ? (source.newGroup.body.ipList as Array<{ ip: string; mask: number }>)
            : source.ids.flatMap((id) => (world.ipGroups.find((g) => String(g.groupId) === id)?.ipList as Array<{ ip: string; mask: number }> | undefined) ?? []);
    for (const e of entries) {
        const range = parseCidr(`${e.ip}/${e.mask}`);
        if (world.controllerAddresses === 'unknown') {
            const hit = protectedNets.find((n) => subnetsOverlap(`${e.ip}/${e.mask}`, n.gateway!));
            if (hit) return `devices on '${hit.name}' (${e.ip}/${e.mask}; the controller's address is unknown, so it may be among them)`;
        } else if (world.controllerAddresses.some((a) => a >= range.network && a <= range.broadcast)) {
            return `the controller (${e.ip}/${e.mask} includes its address)`;
        }
    }
    return undefined;
}

function label(selectors: Selector[], world: RuleWorld): string {
    const names = selectors.map((s) => {
        if ('network' in s) {
            const ref = s.network;
            const n = world.networks.find((x) => ('id' in ref ? x.id === ref.id : x.id === ref.name || x.name.toLowerCase() === ref.name.trim().toLowerCase()));
            return n ? n.name : 'id' in ref ? ref.id : ref.name;
        }
        if ('group' in s) return `group ${'id' in s.group ? s.group.id : s.group.name}`;
        if ('addresses' in s) return s.addresses.join(', ');
        if ('internet' in s) return 'the internet';
        return Object.keys(s)[0];
    });
    return names.join(', ');
}

/** "a.b.c.d" (= /32) or "a.b.c.d/n", n 1-32. */
function parseAddress(value: string): { ip: string; mask: number } {
    let parsed;
    try {
        parsed = parseCidr(value);
    } catch (error) {
        throw new NetError('INVALID', `'${value}': ${(error as Error).message}`);
    }
    if (parsed.prefix < 1) throw new NetError('INVALID', `'${value}': use { internet: true } for everything`);
    return { ip: parsed.ip.trim(), mask: parsed.prefix };
}

/** "1883, 8123" -> ["1883", "8123"]: single ports only (ranges aren't verified on Omada). */
function parsePorts(value: string): string[] {
    const ports = value.split(',').map((p) => p.trim()).filter(Boolean);
    if (ports.length === 0) throw new NetError('INVALID', 'Give at least one port, e.g. "1883, 8123"');
    if (ports.length > MAX_PORTS) throw new NetError('INVALID', `At most ${MAX_PORTS} ports per rule`);
    for (const p of ports) {
        if (p.includes('-')) throw unsupported(`port ranges ('${p}') through net_ yet; list single ports`, 'rules.ports');
        if (!/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535) throw new NetError('INVALID', `'${p}' is not a port (1-65535)`);
    }
    if (new Set(ports).size !== ports.length) throw new NetError('INVALID', 'A port is listed twice');
    return ports.map((p) => String(Number(p)));
}

function unsupported(what: string, capability: string): NetError {
    return new NetError('UNSUPPORTED', `Omada can't do ${what}`, { capability });
}
