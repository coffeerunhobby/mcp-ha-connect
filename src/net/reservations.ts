/**
 * DHCP reservations, the same for every vendor (2.5.4): the checks and the plan text the
 * adapters share. A reservation ties a device (MAC) to one address in a routed network; the
 * device gets it at its next DHCP renewal, so moving an online device to another address breaks
 * its connections then (a lock-out the dry run shows), while removing a reservation changes
 * nothing until its lease runs out.
 */

import { formatMac, normalizeMac } from '../omadaClient/client.js';
import { inSubnet, ipToNumber, parseCidr } from '../utils/ipv4.js';

import { resolve } from './adapters/omadaRules.js';
import { NetError, type Client, type Network, type Reservation, type ReservationInput, type Step } from './model.js';

export const MAX_RESERVATION_DESCRIPTION = 128;

/** A checked reservation change: what to write, and what the dry run says about it. */
export interface CheckedReservation {
    /** "AA-BB-CC-DD-EE-FF". */
    mac: string;
    ip: string;
    network: Network;
    description?: string;
    /** The device's reservation before the change. */
    current?: Reservation;
    step: Step;
    effects: string[];
    /** The device itself, online at another address: it moves at its next DHCP renewal. */
    wouldLockOut: Client[];
}

/** A unicast device MAC as "AA-BB-CC-DD-EE-FF"; refuses empty, broadcast and multicast addresses. */
export function checkMac(mac: string): string {
    let formatted: string;
    try {
        formatted = formatMac(mac);
    } catch (error) {
        throw new NetError('INVALID', (error as Error).message);
    }
    // The low bit of the first byte marks a group (multicast or broadcast) address.
    if (formatted === '00-00-00-00-00-00' || parseInt(formatted.slice(0, 2), 16) % 2 === 1) {
        throw new NetError('INVALID', `${formatted} is not a device address (empty, broadcast or multicast)`);
    }
    return formatted;
}

const sameMac = (a: string, b: string) => normalizeMac(a) === normalizeMac(b);
const label = (mac: string, clients: Client[]) => {
    const name = clients.find((c) => sameMac(c.mac, mac))?.name;
    return name && !sameMac(name, mac) ? `${name} (${mac})` : mac;
};
const online = (mac: string, clients: Client[]) => clients.find((c) => c.online && sameMac(c.mac, mac));

/**
 * Checks a reservation to create or change: a device MAC, a host address inside a routed network
 * (the one given, or the one holding it), not reserved for or used by another device right now.
 * `descriptions: false` refuses a description (the vendor doesn't keep one with the reservation).
 */
export function checkReservationSet(
    input: ReservationInput,
    world: { networks: Network[]; reservations: Reservation[]; clients: Client[] },
    options: { descriptions: boolean }
): CheckedReservation {
    const mac = checkMac(input.mac);
    const ip = input.ip.trim();
    let address: number;
    try {
        address = ipToNumber(ip);
    } catch (error) {
        throw new NetError('INVALID', (error as Error).message);
    }
    let network: Network;
    if (input.network) {
        network = resolve(world.networks, input.network, 'network');
        if (!network.gateway) throw new NetError('INVALID', `'${network.name}' has no gateway (switch-only), so it hands out no addresses`);
        if (!inSubnet(address, network.gateway)) throw new NetError('INVALID', `${ip} is not in '${network.name}' (${network.gateway})`);
    } else {
        const holding = world.networks.find((n) => n.gateway && inSubnet(address, n.gateway));
        if (!holding) {
            const routed = world.networks.filter((n) => n.gateway).map((n) => `${n.name} ${n.gateway}`);
            throw new NetError('INVALID', `${ip} is in none of the networks (${routed.join(', ') || 'none'})`);
        }
        network = holding;
    }
    const subnet = parseCidr(network.gateway!);
    if (address === subnet.network || address === subnet.broadcast) throw new NetError('INVALID', `${ip} is the network or broadcast address of '${network.name}'`);
    if (address === ipToNumber(subnet.ip)) throw new NetError('INVALID', `${ip} is the gateway of '${network.name}'`);

    let description: string | undefined;
    if (input.description !== undefined) {
        if (!options.descriptions) throw new NetError('UNSUPPORTED', "This controller doesn't keep a description with a reservation; leave it out", { capability: 'reservations.description' });
        description = input.description.trim();
        if (description.length > MAX_RESERVATION_DESCRIPTION) throw new NetError('INVALID', `The description must be at most ${MAX_RESERVATION_DESCRIPTION} characters`);
    }

    const current = world.reservations.find((r) => sameMac(r.mac, mac));
    const clash = world.reservations.find((r) => r.ip === ip && !sameMac(r.mac, mac));
    if (clash) throw new NetError('EXISTS', `${ip} is already reserved for ${label(clash.mac, world.clients)}`);
    const user = world.clients.find((c) => c.online && c.ip === ip && !sameMac(c.mac, mac));
    if (user) throw new NetError('EXISTS', `${ip} is in use by ${label(user.mac, world.clients)} right now; choose a free address`);
    const kept = description ?? current?.description;
    const sameNetwork = current !== undefined && 'id' in current.network && current.network.id === network.id;
    if (current && current.ip === ip && sameNetwork && (description === undefined || description === current.description)) {
        throw new NetError('INVALID', `Nothing to change: ${label(mac, world.clients)} already has ${ip} reserved`);
    }

    const device = online(mac, world.clients);
    const moves = device?.ip !== undefined && device.ip !== ip;
    const who = label(mac, world.clients);
    return {
        mac,
        ip,
        network,
        ...(kept ? { description: kept } : {}),
        ...(current ? { current } : {}),
        step: {
            action: current ? 'update' : 'create',
            object: 'reservation',
            name: who,
            detail: current && current.ip !== ip ? `${current.ip} → ${ip}` : ip,
        },
        effects: [
            `${who} always gets ${ip} on '${network.name}'.`,
            ...(current && current.ip !== ip ? [`This replaces its reservation for ${current.ip}.`] : []),
            moves
                ? `It is online at ${device!.ip} now: at its next DHCP renewal (or when it reconnects) it moves to ${ip}, and connections to its old address break.`
                : device
                  ? 'It is online at that address already; nothing changes for it now.'
                  : 'It gets the address the next time it asks for one.',
        ],
        wouldLockOut: moves ? [device!] : [],
    };
}

/** Checks a reservation to remove: the device must have one. Nothing is cut off right away. */
export function checkReservationDelete(
    macInput: string,
    world: { reservations: Reservation[]; clients: Client[] }
): { mac: string; current: Reservation; step: Step; effects: string[] } {
    const mac = checkMac(macInput);
    const current = world.reservations.find((r) => sameMac(r.mac, mac));
    if (!current) throw new NetError('NOT_FOUND', `${label(mac, world.clients)} has no reservation`);
    const who = label(mac, world.clients);
    return {
        mac,
        current,
        step: { action: 'delete', object: 'reservation', name: who, detail: current.ip },
        effects: [
            `${who} no longer has ${current.ip} reserved.`,
            online(mac, world.clients)
                ? 'It is online: it keeps its address until its lease runs out, then it may get another one.'
                : 'The next time it connects it gets an address from the DHCP range.',
        ],
    };
}
