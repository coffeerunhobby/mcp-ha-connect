/**
 * Checks that are the same for every vendor. Adapters call these before their own
 * vendor-specific checks, so a bad request is refused identically on Omada, UniFi and
 * MikroTik.
 */

import { inSubnet, ipToNumber, parseCidr, subnetsOverlap } from '../utils/ipv4.js';

import { NetError, type Network, type Wifi } from './model.js';

export const MAX_NETWORK_NAME = 128;
export const MAX_WIFI_NAME = 32;

export function checkName(name: string, max: number, what: string): string {
    const value = name.trim();
    if (value.length < 1 || value.length > max) throw new NetError('INVALID', `${what} name must be 1 to ${max} characters`);
    return value;
}

/** VLAN for a new or changed network: 2-4090 (1 is the untagged default network). */
export function checkVlan(vlan: number): number {
    if (!Number.isInteger(vlan) || vlan < 2 || vlan > 4090) throw new NetError('INVALID', `VLAN ${vlan} must be a whole number from 2 to 4090`);
    return vlan;
}

/** A gateway address with prefix, e.g. "192.168.3.1/24": a host address inside a /8 to /30. */
export function checkGateway(gateway: string): string {
    let parsed;
    try {
        parsed = parseCidr(gateway);
    } catch (error) {
        throw new NetError('INVALID', `Gateway '${gateway}': ${(error as Error).message}. Use the form 192.168.3.1/24`);
    }
    if (!gateway.includes('/')) throw new NetError('INVALID', `Gateway '${gateway}' needs a prefix, e.g. 192.168.3.1/24`);
    if (parsed.prefix < 8 || parsed.prefix > 30) throw new NetError('INVALID', `Gateway '${gateway}': the prefix must be /8 to /30`);
    const address = ipToNumber(parsed.ip);
    if (address === parsed.network || address === parsed.broadcast) {
        throw new NetError('INVALID', `Gateway '${gateway}' is the network or broadcast address; use a host address such as .1`);
    }
    return gateway.trim();
}

/** A DHCP range inside the gateway's subnet, not containing the gateway, network or broadcast address. */
export function checkDhcp(gateway: string, dhcp: NonNullable<Network['dhcp']>): NonNullable<Network['dhcp']> {
    if (!dhcp.enabled) return { enabled: false };
    if (!dhcp.range) throw new NetError('INVALID', 'DHCP is on, so give a range: { from, to }');
    const { network, broadcast, ip } = parseCidr(gateway);
    const from = ipToNumber(dhcp.range.from);
    const to = ipToNumber(dhcp.range.to);
    if (from > to) throw new NetError('INVALID', `DHCP range ${dhcp.range.from}-${dhcp.range.to} ends before it starts`);
    if (!inSubnet(from, gateway) || !inSubnet(to, gateway)) throw new NetError('INVALID', `DHCP range ${dhcp.range.from}-${dhcp.range.to} is outside ${gateway}`);
    if (from <= network || to >= broadcast) throw new NetError('INVALID', 'The DHCP range must not include the network or broadcast address');
    const gw = ipToNumber(ip);
    if (gw >= from && gw <= to) throw new NetError('INVALID', `The DHCP range must not include the gateway ${ip}`);
    if (dhcp.leaseMinutes !== undefined && (!Number.isInteger(dhcp.leaseMinutes) || dhcp.leaseMinutes < 2 || dhcp.leaseMinutes > 10080)) {
        throw new NetError('INVALID', 'The DHCP lease must be 2 to 10080 minutes');
    }
    for (const dns of dhcp.dns ?? []) ipToNumber(dns);
    if ((dhcp.dns ?? []).length > 2) throw new NetError('INVALID', 'At most two DNS servers');
    return dhcp;
}

/** Refuses a VLAN, name or subnet another network already uses. */
export function checkNetworkUnique(candidate: { name?: string; vlan?: number; gateway?: string }, others: Network[]): void {
    for (const other of others) {
        if (candidate.name && other.name.toLowerCase() === candidate.name.toLowerCase()) {
            throw new NetError('EXISTS', `A network named '${other.name}' already exists`);
        }
        if (candidate.vlan !== undefined && other.vlan === candidate.vlan) {
            throw new NetError('EXISTS', `VLAN ${candidate.vlan} is already used by network '${other.name}'`);
        }
        if (candidate.gateway && other.gateway && subnetsOverlap(candidate.gateway, other.gateway)) {
            throw new NetError('EXISTS', `${candidate.gateway} overlaps network '${other.name}' (${other.gateway})`);
        }
    }
}

export function checkBands(bands: Wifi['bands']): Wifi['bands'] {
    if (bands.length === 0) throw new NetError('INVALID', 'Give at least one band (2.4, 5 or 6)');
    return [...new Set(bands)];
}
