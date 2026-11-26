/**
 * FortiGate firewall policies (cmdb firewall/policy) and the model's rules: how a policy reads as a
 * rule, how a rule becomes a policy, and which policies may carry this server's traffic.
 */

import { formatMac, normalizeMac } from '../../omadaClient/client.js';
import { inSubnet, ipToNumber, parseCidr, subnetsOverlap } from '../../utils/ipv4.js';
import { NetError, type Network, type Ref, type Rule, type Selector } from '../model.js';

import { resolve } from './omadaRules.js';

export type Raw = Record<string, unknown>;

export const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
export const list = (value: unknown): Raw[] => (Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Raw[]) : []);
export const names = (value: unknown): string[] => list(value).map((v) => text(v.name)).filter(Boolean);

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

export function macOf(value: unknown): string | undefined {
    const hex = normalizeMac(text(value));
    return /^[0-9A-F]{12}$/.test(hex) && hex !== '000000000000' ? formatMac(hex) : undefined;
}

/** What one firewall address object stands for, when the model can say it. */
export function addressValue(raw: Raw | undefined): { kind: 'address' | 'mac'; values: string[] } | undefined {
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
export const isOff = (value: unknown) => value === 'disable' || value === false || value === 0 || value === '' || value === null || value === undefined || (Array.isArray(value) && value.length === 0);
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

export const SERVICES: Record<string, Rule['protocol']> = { ALL: 'any', ALL_TCP: 'tcp', ALL_UDP: 'udp', ALL_ICMP: 'icmp' };

export interface RuleContext {
    networks: Map<string, Network>;
    wan: Set<string>;
    addresses: Map<string, Raw>;
    groups: Map<string, GroupInfo>;
    secondary: Set<string>;
}

export interface GroupInfo {
    complete: boolean;
    addresses: string[];
    /** Holds MAC objects. */
    macs: boolean;
}

/** Whether an address or CIDR lies wholly inside a network (its gateway form "a.b.c.d/p"). */
export function within(address: string, network: string): boolean {
    try {
        const a = parseCidr(address);
        const n = parseCidr(network);
        return a.network >= n.network && a.broadcast <= n.broadcast;
    } catch {
        return false;
    }
}

/** Whether every member of a group is an address or MAC object of one kind the model can say. */
export function groupComplete(group: Raw, addresses: Map<string, Raw>): boolean {
    // A group with exclusions matches its members minus others: not a list of entries.
    if (text(group.exclude) === 'enable' || names(group['exclude-member']).length) return false;
    const kinds = names(group.member).map((m) => addressValue(addresses.get(m))?.kind);
    return kinds.length > 0 && kinds.every((k) => k !== undefined && k === kinds[0]);
}

/** One side of a policy (interfaces + addresses) as selectors, or why it can't be. */
export function side(interfaces: string[], addrs: string[], context: RuleContext): Selector[] | string {
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

export function overlaps(address: string, network: string): boolean {
    try {
        return subnetsOverlap(address.includes('/') ? address : `${address}/32`, network);
    } catch {
        return true;
    }
}

/** The selectors for a list of address objects, with every IP address or network they stand for. */
export function addressSelectors(addrs: string[], context: RuleContext): { selectors: Selector[]; addresses: string[]; macs: boolean } | string {
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

export function toRule(raw: Raw, index: number, context: RuleContext): Rule {
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

// ---- writing policies ------------------------------------------------------------------------

/** FortiOS policy names are at most 35 characters. */
export const MAX_POLICY_NAME = 35;
/** The comment on address objects these tools create for a rule's addresses (they stay when the rule goes, and are reused). */
export const OWNED_ADDRESS_COMMENT = 'Made by mcp-ha-connect for a net_ rule';
/** The services the model's protocols become (the FortiGate's predefined ones). */
export const SERVICE_OF: Record<'any' | 'tcp' | 'udp' | 'icmp', string> = { any: 'ALL', tcp: 'ALL_TCP', udp: 'ALL_UDP', icmp: 'ALL_ICMP' };

/** Everything a policy is written against. */
export interface PolicyWorld {
    /** Every network the adapter lists (secondary subnets included, as their own networks). */
    networks: Network[];
    /** The routed LAN interfaces, by name. */
    lans: Map<string, Network>;
    /** WAN-role interfaces. */
    wan: string[];
    /** Interfaces carrying secondary subnets. */
    secondary: Set<string>;
    addresses: Map<string, Raw>;
    groups: Map<string, GroupInfo>;
    /** This server's addresses (MCP_SERVER_ADDRESSES). */
    serverAddresses: number[];
    /** The interfaces this server's traffic may enter or leave the FortiGate on; 'any' when that can't be told. */
    serverInterfaces: Set<string> | 'any';
}

/** One side of a policy as written: interfaces, address names, and address objects still to create. */
export interface PolicySide {
    intf: string[];
    addr: string[];
    create: Array<{ name: string; subnet: string }>;
    /** It is the WAN side. */
    wan: boolean;
}

function unsupported(what: string, capability: string): NetError {
    return new NetError('UNSUPPORTED', `A FortiGate rule can't use ${what} through the tools`, { capability });
}

export function checkPolicyName(name: string): string {
    const value = name.trim();
    if (value.length < 1 || value.length > MAX_POLICY_NAME) throw new NetError('INVALID', `A FortiGate policy name must be 1 to ${MAX_POLICY_NAME} characters`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f"\\]/.test(value)) throw new NetError('INVALID', 'A FortiGate policy name can\'t hold quotes, backslashes or control characters');
    // Unnamed policies are listed as "policy <id>": a name like that would be confused with one.
    if (/^policy \d+$/i.test(value)) throw new NetError('INVALID', `'${value}' looks like the label of an unnamed policy; choose another name`);
    return value;
}

const prefixMask = (prefix: number) => [24, 16, 8, 0].map((shift) => Math.floor((prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0) / 2 ** shift) % 256).join('.');
const dotted = (n: number) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');

/** "192.0.2.7" or "192.0.2.0/24" as its network: { cidr, subnet: "a.b.c.d m.m.m.m", name }. */
function canonical(value: string): { cidr: string; subnet: string; name: string } {
    let parsed;
    try {
        parsed = parseCidr(value.trim().includes('/') ? value.trim() : `${value.trim()}/32`);
    } catch (error) {
        throw new NetError('INVALID', `'${value}': ${(error as Error).message}`);
    }
    if (parsed.prefix < 1) throw new NetError('INVALID', `'${value}': use { internet: true } for everything`);
    const ip = dotted(parsed.network);
    return {
        cidr: parsed.prefix === 32 ? ip : `${ip}/${parsed.prefix}`,
        subnet: `${ip} ${prefixMask(parsed.prefix)}`,
        name: parsed.prefix === 32 ? `net-${ip}` : `net-${ip}_${parsed.prefix}`,
    };
}

/** An address object that says exactly this subnet and nothing more, or undefined. */
function existingObject(cidr: string, addresses: Map<string, Raw>): string | undefined {
    const wanted = parseCidr(cidr.includes('/') ? cidr : `${cidr}/32`);
    const matches = [...addresses.entries()].filter(([, raw]) => {
        if ((text(raw.type) || 'ipmask') !== 'ipmask' || text(raw['associated-interface'])) return false;
        const value = addressValue(raw);
        if (value?.kind !== 'address' || value.values.length !== 1) return false;
        const got = parseCidr(value.values[0].includes('/') ? value.values[0] : `${value.values[0]}/32`);
        return got.network === wanted.network && got.prefix === wanted.prefix;
    });
    return matches.map(([name]) => name).sort()[0];
}

/** Where an address or network lies: inside one LAN network (its interface), outside them all, or across. */
function placeOf(cidr: string, world: PolicyWorld): { lan: string } | 'outside' | 'across' {
    const value = cidr.includes('/') ? cidr : `${cidr}/32`;
    for (const [name, network] of world.lans) if (network.gateway && within(value, network.gateway)) return { lan: name };
    return [...world.lans.values()].some((n) => n.gateway && overlaps(value, n.gateway)) ? 'across' : 'outside';
}

/** One side of a rule as policy fields. */
export function policySide(selectors: Selector[], world: PolicyWorld, which: 'source' | 'destination'): PolicySide {
    if (!selectors.length) throw new NetError('INVALID', `A rule needs a ${which}`);
    const kindOf = (s: Selector) => Object.keys(s)[0];
    if (new Set(selectors.map(kindOf)).size > 1) throw new NetError('INVALID', `Give one kind of ${which} per rule (networks, addresses, a group or the internet); split it into several rules`);
    const first = selectors[0];
    if ('device' in first) throw unsupported('a device (MAC)', 'rules.deviceMatch');
    if ('wifi' in first) throw unsupported('a Wi-Fi network', 'rules.wifiMatch');
    if ('gateway' in first) throw unsupported("the FortiGate itself (that is its local-in policy, not a firewall policy)", 'rules.toGateway');
    const noSecondary = (intf: string[]) => {
        const hit = intf.find((i) => world.secondary.has(i));
        if (hit) throw new NetError('INVALID', `The interface '${hit}' carries secondary subnets, so a policy on it would match more than its network; use the FortiGate's UI`);
        return intf;
    };
    if ('internet' in first) {
        if (which === 'source') throw new NetError('INVALID', "A rule starts from devices on the FortiGate's networks, not from the internet");
        if (!world.wan.length) throw new NetError('INVALID', 'The FortiGate has no WAN interface, so there is no internet side');
        return { intf: [...world.wan], addr: ['all'], create: [], wan: true };
    }
    if ('network' in first) {
        const intf: string[] = [];
        for (const s of selectors) {
            const network = resolve(world.networks, (s as { network: Ref }).network, 'network');
            if (!world.lans.has(network.id)) throw new NetError('INVALID', `'${network.name}' is a secondary subnet of an interface; a policy can only name the whole interface`);
            if (!intf.includes(network.id)) intf.push(network.id);
        }
        return { intf: noSecondary(intf), addr: ['all'], create: [], wan: false };
    }
    // Addresses or groups: each lies inside one LAN network (that interface) or outside them all (the WAN).
    const addr: string[] = [];
    const create: PolicySide['create'] = [];
    const places: Array<{ lan: string } | 'outside'> = [];
    const place = (cidr: string, label: string) => {
        const where = placeOf(cidr, world);
        if (where === 'across') throw new NetError('INVALID', `${label} is partly inside one of the FortiGate's networks; split it`);
        places.push(where);
    };
    for (const s of selectors) {
        if ('group' in s) {
            const ref = s.group;
            const items = [...world.groups.keys()].map((name) => ({ id: name, name }));
            const name = resolve(items, ref, 'group').name;
            const group = world.groups.get(name)!;
            if (!group.complete || group.macs || !group.addresses.length) throw new NetError('INVALID', `The group '${name}' holds members the model can't say (MACs, FQDNs, ranges, nested groups...); use it in the FortiGate's UI`);
            for (const a of group.addresses) place(a, `The group '${name}' (${a})`);
            if (!addr.includes(name)) addr.push(name);
        } else if ('addresses' in s) {
            for (const value of s.addresses) {
                const c = canonical(value);
                place(c.cidr, c.cidr);
                const existing = existingObject(c.cidr, world.addresses);
                if (existing) {
                    if (!addr.includes(existing)) addr.push(existing);
                    continue;
                }
                if (world.addresses.has(c.name)) throw new NetError('EXISTS', `An address object named '${c.name}' already exists on the FortiGate for something else; rename or remove it first`);
                if (!create.some((x) => x.name === c.name)) create.push({ name: c.name, subnet: c.subnet });
                if (!addr.includes(c.name)) addr.push(c.name);
            }
        }
    }
    const outside = places.filter((p) => p === 'outside').length;
    if (outside && outside !== places.length) throw new NetError('INVALID', `The ${which} mixes addresses inside the FortiGate's networks with outside ones; split it into several rules`);
    if (outside) {
        if (which === 'source') throw new NetError('INVALID', "A rule starts from devices on the FortiGate's networks; these addresses are outside them");
        if (!world.wan.length) throw new NetError('INVALID', 'The FortiGate has no WAN interface for outside addresses');
        return { intf: [...world.wan], addr, create, wan: true };
    }
    const intf = [...new Set(places.map((p) => (p as { lan: string }).lan))];
    return { intf: noSecondary(intf), addr, create, wan: false };
}

/** The policy fields for a rule (a whole new policy). */
export function policyBody(value: Omit<Rule, 'id' | 'foreign' | 'position'>, world: PolicyWorld): { body: Raw; create: PolicySide['create'] } {
    if (value.schedule.kind !== 'always') throw unsupported('a schedule', 'rules.schedule');
    if (value.replies !== 'allow') throw unsupported('a rule that also stops replies (FortiGate policies are stateful)', 'rules.stateful');
    if (typeof value.protocol === 'object') throw unsupported('ports (that needs a custom service)', 'rules.ports');
    const from = policySide(value.from, world, 'source');
    const to = policySide(value.to, world, 'destination');
    const both = from.intf.find((i) => to.intf.includes(i));
    if (both) throw new NetError('INVALID', `Traffic inside '${both}' doesn't pass a FortiGate policy between interfaces; give a source and destination on different networks`);
    const create = [...from.create, ...to.create.filter((c) => !from.create.some((f) => f.name === c.name))];
    return {
        body: {
            name: checkPolicyName(value.name),
            srcintf: from.intf.map((name) => ({ name })),
            dstintf: to.intf.map((name) => ({ name })),
            srcaddr: from.addr.map((name) => ({ name })),
            dstaddr: to.addr.map((name) => ({ name })),
            service: [{ name: SERVICE_OF[value.protocol] }],
            schedule: 'always',
            action: value.action === 'allow' ? 'accept' : 'deny',
            status: value.enabled ? 'enable' : 'disable',
            // Devices reach the internet through the FortiGate's WAN address.
            nat: value.action === 'allow' && to.wan ? 'enable' : 'disable',
        },
        create,
    };
}

/**
 * Whether an enabled policy may match this server's traffic: from it (the source side may hold it), or
 * to its own address (the destination addresses may include it). Anything this check can't read (zones,
 * "any", FQDNs, negation, internet services) counts as a match. A whole network or the internet as the
 * destination doesn't: blocking IoT from Home or from the internet is what these rules are for, and
 * connections this server starts still get their replies (policies are stateful).
 */
export function mayMatchServer(raw: Raw, world: PolicyWorld): boolean {
    if (text(raw.status) === 'disable') return false;
    const covers = (cidr: string) => world.serverAddresses.some((a) => inSubnet(a, cidr.includes('/') ? cidr : `${cidr}/32`));
    /** What a side's addresses say about this server: 'all', 'unknown', or whether they cover it. */
    const addressesOf = (addrs: string[], negate: unknown): 'all' | 'unknown' | boolean => {
        if (!isOff(negate)) return 'unknown';
        if (!addrs.length) return 'unknown';
        if (addrs.includes('all')) return 'all';
        let hit = false;
        for (const name of addrs) {
            const group = world.groups.get(name);
            if (group) {
                if (!group.complete || group.macs) return 'unknown';
                hit ||= group.addresses.some(covers);
                continue;
            }
            const value = addressValue(world.addresses.get(name));
            if (!value || value.kind !== 'address') return 'unknown';
            hit ||= value.values.some(covers);
        }
        return hit;
    };
    const known = (i: string) => world.lans.has(i) || world.wan.includes(i);
    const serverSide = (i: string) => world.serverInterfaces === 'any' || world.serverInterfaces.has(i) || !known(i);
    const source = addressesOf(names(raw.srcaddr), raw['srcaddr-negate']);
    const srcIntf = names(raw.srcintf);
    if (source !== false && (!srcIntf.length || srcIntf.some(serverSide))) return true;
    // Internet services replace the destination addresses: what they match can't be told here.
    const destination = !isOff(raw['internet-service']) ? 'unknown' : addressesOf(names(raw.dstaddr), raw['dstaddr-negate']);
    return destination === 'unknown' || destination === true;
}

/** The policy's plain description for a plan. */
export function describePolicy(body: Raw): string {
    const side = (intf: unknown, addr: unknown) => {
        const a = names(addr);
        return a.length === 1 && a[0] === 'all' ? names(intf).join(', ') : `${a.join(', ')} (${names(intf).join(', ')})`;
    };
    const service = names(body.service).join(', ');
    return `${text(body.action) === 'accept' ? 'allow' : 'block'} ${side(body.srcintf, body.srcaddr)} to ${side(body.dstintf, body.dstaddr)}${service && service !== 'ALL' ? ` (${service})` : ''}`;
}
