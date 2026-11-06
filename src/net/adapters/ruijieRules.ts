/**
 * Ruijie / Reyee traffic rules (devConfig access_ctrl): how the model's rules become the router's
 * entries, and what no rule may cut off. Mapped from the router's own page on ReyeeOS 2.430:
 *
 * - add and update take `{list: [entry]}`, delete `{uuid: [...]}`, moving one place up or down
 *   `{uuid, opt: "up" | "down"}`. The list is checked from the top until a rule matches.
 * - A block rule is target REJECT, state "1,4" (new and invalid connections): "192.168.1.x can't
 *   reach 192.168.2.x, but 192.168.2.x can still reach 192.168.1.x". An allow rule is target
 *   ACCEPT, state "0" (every state).
 * - An address side holds one address or network; a port side one port; a name 1-28 characters. A
 *   device (by MAC) only ever applies towards the internet, for every protocol.
 */

import { inSubnet, ipToNumber, parseCidr, subnetsOverlap } from '../../utils/ipv4.js';
import { NetError, type Client, type Network, type Rule, type Selector } from '../model.js';
import { checkMac } from '../reservations.js';

import { resolve } from './omadaRules.js';

type Raw = Record<string, unknown>;

export const MAX_RULE_NAME = 28;
/** "All the time" as the router's page writes it. */
export const ALWAYS = '所有时段';
/** Ruijie's names for "all the time" in a rule's time setting (the default time group). */
export const ALL_TIME = new Set([ALWAYS, 'everytime', 'All Time', '']);
export const BLOCK_STATE = '1,4';
export const ALLOW_STATE = '0';
/** The router's page refuses these in values, which travel on to its config commands. */
const UNSAFE_NAME = /['&|;$<>`"\\\n\r]/;

/** The parts of a rule that decide its router entry. */
export type RuleFields = Omit<Rule, 'id' | 'foreign' | 'position'>;

export interface RuleWorld {
    networks: Network[];
    /** The router's management address. */
    routerHost: string;
    /** This server's addresses; 'unset' when they aren't configured or aren't plain addresses (MCP_SERVER_ADDRESSES). */
    serverAddresses: number[] | 'unset';
    clients: Client[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));

export function checkRuleName(name: string): string {
    const value = name.trim();
    if (value.length < 1 || value.length > MAX_RULE_NAME) throw new NetError('INVALID', `A rule name on this router must be 1 to ${MAX_RULE_NAME} characters`);
    if (UNSAFE_NAME.test(value)) throw new NetError('INVALID', 'A rule name on this router can\'t hold any of \' & | ; $ < > ` " \\');
    return value;
}

function unsupported(what: string, capability: string): NetError {
    return new NetError('UNSUPPORTED', `This Ruijie router can't do ${what}`, { capability });
}

function one(selectors: Selector[], side: string): Selector {
    if (selectors.length !== 1) throw new NetError('INVALID', `This router takes one ${side} per rule (got ${selectors.length}); split it into several rules`);
    return selectors[0];
}

/** One address or network, in plain dotted form. */
function checkAddress(addresses: string[], side: string): string {
    if (addresses.length !== 1) throw new NetError('INVALID', `This router takes one address or network as the ${side} of a rule (got ${addresses.length}); split it into several rules`);
    const value = addresses[0].trim();
    let parsed;
    try {
        parsed = parseCidr(value);
    } catch (error) {
        throw new NetError('INVALID', `'${value}': ${(error as Error).message}`);
    }
    if (parsed.prefix < 1) throw new NetError('INVALID', `'${value}': use { internet: true } for everything`);
    return value;
}

/** Whether an address or network lies fully inside the router's networks, fully outside them, or across. */
function placeOf(cidr: string, networks: Network[]): 'inside' | 'outside' | 'across' {
    const lans = networks.filter((n) => n.gateway).map((n) => n.gateway!);
    const range = parseCidr(cidr);
    const within = lans.some((lan) => {
        const l = parseCidr(lan);
        return range.network >= l.network && range.broadcast <= l.broadcast;
    });
    if (within) return 'inside';
    return lans.some((lan) => subnetsOverlap(cidr, lan)) ? 'across' : 'outside';
}

function checkPort(ports: string): string {
    const value = ports.trim();
    if (value.includes(',') || value.includes('-')) throw new NetError('UNSUPPORTED', 'This router takes one port per rule through the tools; make one rule per port', { capability: 'rules.ports' });
    if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new NetError('INVALID', `'${value}' is not a port (1-65535)`);
    return String(Number(value));
}

/** The router's fields for a rule's source. */
export function sourceFields(selectors: Selector[], world: RuleWorld): Raw {
    const from = one(selectors, 'source');
    if ('device' in from) return { by: 'mac', mac: checkMac(from.device).toLowerCase().replace(/-/g, ':'), src: 'lan', srcIP: '' };
    if ('network' in from) return { by: 'ip', mac: '', src: resolve(world.networks, from.network, 'network').id, srcIP: '' };
    if ('addresses' in from) {
        const address = checkAddress(from.addresses, 'source');
        if (placeOf(address, world.networks) !== 'inside') throw new NetError('INVALID', `A rule starts from devices on this router's networks; ${address} isn't inside one`);
        return { by: 'ip', mac: '', src: 'lan', srcIP: address };
    }
    if ('wifi' in from) throw unsupported('a Wi-Fi network as a rule source', 'rules.wifiMatch');
    if ('group' in from) throw unsupported('address groups in a rule', 'groups.address');
    throw new NetError('INVALID', 'A rule starts from a network, an address or a device, not from the internet or the router');
}

/** The router's fields for a rule's destination. */
export function destinationFields(selectors: Selector[], world: RuleWorld): Raw {
    const to = one(selectors, 'destination');
    if ('internet' in to) return { dest: 'wan', destIP: '' };
    if ('network' in to) return { dest: resolve(world.networks, to.network, 'network').id, destIP: '' };
    if ('addresses' in to) {
        const address = checkAddress(to.addresses, 'destination');
        const place = placeOf(address, world.networks);
        if (place === 'across') throw new NetError('INVALID', `${address} is partly inside one of this router's networks; split it into a rule for the network and one for the internet`);
        return { dest: place === 'inside' ? 'lan' : 'wan', destIP: address };
    }
    if ('gateway' in to) throw unsupported('the router itself as a rule destination', 'rules.toGateway');
    if ('group' in to) throw unsupported('address groups in a rule', 'groups.address');
    throw new NetError('INVALID', 'A rule goes to a network, an address or the internet');
}

/** The router's fields for a rule's protocol. */
export function protocolFields(protocol: Rule['protocol']): Raw {
    if (typeof protocol === 'object') return { proto: 'tcpudp', destPort: checkPort(protocol.tcpUdpPorts) };
    return { proto: protocol === 'any' ? 'all' : protocol, destPort: '' };
}

/** The router's fields for a rule's action: what its page writes. */
export function actionFields(action: Rule['action']): Raw {
    return action === 'allow' ? { target: 'ACCEPT', state: ALLOW_STATE } : { target: 'REJECT', state: BLOCK_STATE };
}

/** What the router can't hold together, whichever sides were given. */
export function checkEntry(entry: Raw): void {
    if (text(entry.by) === 'mac') {
        if (text(entry.dest) !== 'wan' || text(entry.destIP)) throw unsupported('a device (by MAC) towards anything but the whole internet', 'rules.deviceMatch');
        if (text(entry.proto) !== 'all' || text(entry.destPort)) throw unsupported('a device (by MAC) with a protocol or ports', 'rules.deviceMatch');
    }
    if (text(entry.src).startsWith('vlan') && text(entry.src) === text(entry.dest)) {
        throw new NetError('INVALID', `Traffic inside one network doesn't pass the router, so a rule from '${text(entry.src)}' to itself would do nothing`);
    }
}

/** The router's entry for a new rule. */
export function ruleEntry(value: RuleFields, world: RuleWorld): Raw {
    if (value.schedule.kind !== 'always') throw unsupported('schedules on a rule through the tools', 'rules.schedule');
    if (value.action === 'block' && value.replies !== 'allow') throw unsupported('a new block rule that also stops replies through the tools', 'rules.stateful');
    const entry: Raw = {
        ruleName: checkRuleName(value.name),
        enable: value.enabled ? '1' : '0',
        ...sourceFields(value.from, world),
        srcPort: '',
        ...destinationFields(value.to, world),
        ...protocolFields(value.protocol),
        netProto: 'ipv4',
        ...actionFields(value.action),
        tmngtName: ALWAYS,
    };
    checkEntry(entry);
    return entry;
}

/** What the entry's source may hit that must stay online: the reason, or undefined when it can't. */
function sourceHit(raw: Raw, world: RuleWorld): string | undefined {
    const protectedNets = world.networks.filter((n) => n.protected && n.gateway);
    const server = world.serverAddresses;
    const number = (ip: string) => {
        try {
            return ipToNumber(ip);
        } catch {
            return undefined;
        }
    };
    if (text(raw.by) === 'mac') {
        const mac = text(raw.mac).toLowerCase().replace(/:/g, '-');
        const at = number(world.clients.find((c) => c.mac.toLowerCase() === mac)?.ip ?? '');
        // A server that is running is online, so a device that isn't can't be it.
        if (at === undefined) return undefined;
        if (server !== 'unset') return server.includes(at) ? 'this server' : undefined;
        const hit = protectedNets.find((n) => inSubnet(at, n.gateway!));
        return hit ? `a device on '${hit.name}' (this server's address isn't configured in MCP_SERVER_ADDRESSES, so it may be this server)` : undefined;
    }
    const where = text(raw.src);
    const addresses = text(raw.srcIP);
    if (!addresses) {
        if (where === 'lan' || where === 'all') return `every network, '${protectedNets[0]?.name ?? 'LAN'}' included`;
        const network = world.networks.find((n) => n.id === where);
        // A network this check can't place may hold this server.
        if (!network?.gateway) return `the interface '${where}'`;
        if (network.protected) return `the whole network '${network.name}'`;
        return server !== 'unset' && server.some((a) => inSubnet(a, network.gateway!)) ? `the whole network '${network.name}', which holds this server` : undefined;
    }
    for (const address of addresses.split(',').map((a) => a.trim())) {
        let range;
        try {
            range = parseCidr(address);
        } catch {
            return 'a source this check cannot read';
        }
        if (server === 'unset') {
            const hit = protectedNets.find((n) => subnetsOverlap(address, n.gateway!));
            if (hit) return `devices on '${hit.name}' (${address}; this server's address isn't configured in MCP_SERVER_ADDRESSES, so it may be among them)`;
        } else if (server.some((a) => a >= range.network && a <= range.broadcast)) {
            return `this server (${address} includes its address)`;
        }
    }
    return undefined;
}

const towardsInternet = (raw: Raw) => (text(raw.dest) === 'wan' || text(raw.dest) === 'all') && !text(raw.destIP);

/**
 * An enabled allow rule that lets everything from every network out, always, on every connection
 * state, so nothing below it can cut anything off. Anything limiting it means traffic it doesn't
 * match goes on to the rules below.
 */
const shields = (raw: Raw) =>
    text(raw.target).toUpperCase() === 'ACCEPT' &&
    text(raw.by) !== 'mac' &&
    (text(raw.src) === 'lan' || text(raw.src) === 'all') &&
    !text(raw.srcIP) &&
    towardsInternet(raw) &&
    (text(raw.proto) === 'all' || text(raw.proto) === '') &&
    !text(raw.srcPort) &&
    !text(raw.destPort) &&
    (text(raw.state) === '0' || text(raw.state) === '') &&
    (text(raw.netProto) === 'ipv4' || text(raw.netProto) === '') &&
    ALL_TIME.has(text(raw.tmngtName)) &&
    !(Array.isArray(raw.user) && raw.user.length) &&
    !(Array.isArray(raw.user_group_list) && raw.user_group_list.length) &&
    !(Array.isArray(raw.userGroupList) && raw.userGroupList.length);

/**
 * The enabled block rules that can reach what must stay online on its way to the internet: this
 * server's internet is also how it is reached (at Xpress through the Nebula overlay). Each comes
 * with its reason, in the order the router checks them.
 */
export function internetRisks(entries: Raw[], world: RuleWorld): Map<string, string> {
    const risks = new Map<string, string>();
    for (const raw of entries) {
        if (text(raw.enable) !== '1') continue;
        if (shields(raw)) break;
        if (text(raw.target).toUpperCase() === 'ACCEPT' || !towardsInternet(raw)) continue;
        const hit = sourceHit(raw, world);
        if (hit) risks.set(text(raw.uuid) || text(raw.ruleName), hit);
    }
    return risks;
}

/** Refuses when a rule list the change passes through newly endangers what must stay online. */
export function guardInternet(before: Raw[], states: Raw[][], world: RuleWorld): void {
    const today = internetRisks(before, world);
    for (const state of states) {
        for (const [key, reason] of internetRisks(state, world)) {
            if (!today.has(key)) throw new NetError('PROTECTED', `This would block ${reason} from the internet, and this server has to stay reachable; refused`);
        }
    }
}

/** A block rule may not stop devices reaching the router or this server. */
export function guardDestination(entry: Raw, world: RuleWorld): void {
    if (text(entry.target).toUpperCase() === 'ACCEPT' || text(entry.enable) !== '1' || !text(entry.destIP)) return;
    let router: number | undefined;
    try {
        router = ipToNumber(world.routerHost);
    } catch {
        router = undefined;
    }
    for (const address of text(entry.destIP).split(',').map((a) => a.trim())) {
        let range;
        try {
            range = parseCidr(address);
        } catch {
            throw new NetError('PROTECTED', `The destination ${address} can't be read, so it may include the router or this server; refused`);
        }
        const covers = (a: number) => a >= range.network && a <= range.broadcast;
        if (router !== undefined && covers(router)) throw new NetError('PROTECTED', `${address} includes the router's own address; a rule may not block it`);
        if (world.serverAddresses !== 'unset' && world.serverAddresses.some(covers)) throw new NetError('PROTECTED', `${address} includes this server's address; a rule may not block it`);
    }
}

/** The rule's plain description for a plan. */
export function describeEntry(entry: Raw): string {
    const from = text(entry.by) === 'mac' ? text(entry.mac) : text(entry.srcIP) || text(entry.src);
    const to = text(entry.destIP) || (text(entry.dest) === 'wan' ? 'the internet' : text(entry.dest));
    const ports = text(entry.destPort) ? ` port ${text(entry.destPort)}` : '';
    return `${text(entry.target).toUpperCase() === 'ACCEPT' ? 'allow' : 'block'} ${from} to ${to}${ports} (${text(entry.proto) || 'all'})`;
}

/** This server's addresses as numbers; anything but plain addresses counts as not knowing them. */
export function parseServerAddresses(hosts: string[] | undefined): number[] | 'unset' {
    if (!hosts || hosts.length === 0) return 'unset';
    try {
        return hosts.map((h) => ipToNumber(h.trim()));
    } catch {
        return 'unset';
    }
}
