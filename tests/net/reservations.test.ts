/**
 * DHCP reservation checks every vendor shares (2.5.4): a device MAC, a free host address inside a
 * routed network, nothing to change refused, and an online device moved to another address counted
 * as cut off (it moves at its next DHCP renewal).
 */

import { describe, it, expect } from 'vitest';

import { NetError, type Client, type Network, type Reservation } from '../../src/net/model.js';
import { checkMac, checkReservationDelete, checkReservationSet } from '../../src/net/reservations.js';

const NETWORKS: Network[] = [
    { id: 'n-home', name: 'Home', purpose: 'normal', vlan: 1, gateway: '10.0.0.1/24', ipv6: false, isolated: false, protected: true },
    { id: 'n-iot', name: 'IoT', purpose: 'normal', vlan: 2, gateway: '10.0.1.1/24', ipv6: false, isolated: false, protected: false },
    { id: 'n-sw', name: 'Switches', purpose: 'vlanOnly', vlan: 9, ipv6: false, isolated: false, protected: false },
];
const RESERVATIONS: Reservation[] = [{ mac: '02-00-00-00-00-01', ip: '10.0.0.50', network: { id: 'n-home' }, description: 'phone' }];
const CLIENTS: Client[] = [
    { mac: '02-00-00-00-00-01', name: 'phone', ip: '10.0.0.50', network: { id: 'n-home' }, online: true },
    { mac: '02-00-00-00-00-02', name: 'plug', ip: '10.0.1.20', network: { id: 'n-iot' }, online: true },
    { mac: '02-00-00-00-00-03', name: 'laptop', ip: '10.0.0.60', online: false },
];
const world = { networks: NETWORKS, reservations: RESERVATIONS, clients: CLIENTS };
const set = (input: Parameters<typeof checkReservationSet>[0], descriptions = true) => checkReservationSet(input, world, { descriptions });
const fail = (f: () => unknown) => {
    try {
        f();
    } catch (error) {
        if (error instanceof NetError) return `${error.code}: ${error.message}`;
        throw error;
    }
    return 'ok';
};

describe('device MAC', () => {
    it('takes any separator and refuses empty, broadcast, multicast and incomplete addresses', () => {
        expect(checkMac('02:aa:bb:cc:dd:ee')).toBe('02-AA-BB-CC-DD-EE');
        expect(checkMac('02aabbccddee')).toBe('02-AA-BB-CC-DD-EE');
        expect(fail(() => checkMac('00:00:00:00:00:00'))).toMatch(/^INVALID: .*not a device address/);
        expect(fail(() => checkMac('ff:ff:ff:ff:ff:ff'))).toMatch(/^INVALID: .*not a device address/);
        expect(fail(() => checkMac('01:00:5e:00:00:fb'))).toMatch(/^INVALID: .*not a device address/);
        expect(fail(() => checkMac('02:aa:bb'))).toMatch(/^INVALID: .*not a complete MAC address/);
    });
});

describe('setting a reservation', () => {
    it('creates one in the network holding the address; an offline device gets it when it next asks', () => {
        const checked = set({ mac: '02:00:00:00:00:03', ip: ' 10.0.0.61 ' });

        expect(checked).toMatchObject({ mac: '02-00-00-00-00-03', ip: '10.0.0.61', network: { id: 'n-home' }, wouldLockOut: [] });
        expect(checked.current).toBeUndefined();
        expect(checked.step).toEqual({ action: 'create', object: 'reservation', name: 'laptop (02-00-00-00-00-03)', detail: '10.0.0.61' });
        expect(checked.effects).toEqual(["laptop (02-00-00-00-00-03) always gets 10.0.0.61 on 'Home'.", 'It gets the address the next time it asks for one.']);
    });

    it('pins an online device to the address it has without cutting it off', () => {
        const checked = set({ mac: '02-00-00-00-00-02', ip: '10.0.1.20', network: { name: 'iot' } });

        expect(checked.wouldLockOut).toEqual([]);
        expect(checked.effects[1]).toBe('It is online at that address already; nothing changes for it now.');
    });

    it('moving an online device counts it as cut off, and says which reservation it replaces', () => {
        const checked = set({ mac: '02-00-00-00-00-01', ip: '10.0.0.51' });

        expect(checked.step).toEqual({ action: 'update', object: 'reservation', name: 'phone (02-00-00-00-00-01)', detail: '10.0.0.50 → 10.0.0.51' });
        expect(checked.wouldLockOut.map((c) => c.mac)).toEqual(['02-00-00-00-00-01']);
        expect(checked.effects).toEqual([
            "phone (02-00-00-00-00-01) always gets 10.0.0.51 on 'Home'.",
            'This replaces its reservation for 10.0.0.50.',
            'It is online at 10.0.0.50 now: at its next DHCP renewal (or when it reconnects) it moves to 10.0.0.51, and connections to its old address break.',
        ]);
        // The description it had is kept unless a new one is given.
        expect(checked.description).toBe('phone');
        expect(set({ mac: '02-00-00-00-00-01', ip: '10.0.0.51', description: ' kitchen ' }).description).toBe('kitchen');
    });

    it('a device without a reservation, online elsewhere, also moves', () => {
        expect(set({ mac: '02-00-00-00-00-02', ip: '10.0.1.21' }).wouldLockOut.map((c) => c.name)).toEqual(['plug']);
    });

    it('refuses an address outside the routed networks, outside the network given, or on a switch-only one', () => {
        expect(fail(() => set({ mac: '02-00-00-00-00-03', ip: '10.0.5.5' }))).toBe('INVALID: 10.0.5.5 is in none of the networks (Home 10.0.0.1/24, IoT 10.0.1.1/24)');
        expect(fail(() => set({ mac: '02-00-00-00-00-03', ip: '10.0.0.70', network: { name: 'IoT' } }))).toBe("INVALID: 10.0.0.70 is not in 'IoT' (10.0.1.1/24)");
        expect(fail(() => set({ mac: '02-00-00-00-00-03', ip: '10.0.0.70', network: { name: 'Switches' } }))).toMatch(/^INVALID: 'Switches' has no gateway/);
        expect(fail(() => set({ mac: '02-00-00-00-00-03', ip: '10.0.0.70', network: { name: 'Nope' } }))).toMatch(/^NOT_FOUND: /);
        expect(fail(() => set({ mac: '02-00-00-00-00-03', ip: '10.0.0' }))).toMatch(/^INVALID: '10.0.0' is not an IPv4 address/);
    });

    it('refuses an address that several networks hold (overlapping subnets), even with the network given', () => {
        const overlapping = [...NETWORKS, { id: 'n-wide', name: 'Wide', purpose: 'normal' as const, vlan: 5, gateway: '10.0.0.129/25', ipv6: false, isolated: false, protected: false }];
        const check = (network?: string) => checkReservationSet({ mac: '02-00-00-00-00-03', ip: '10.0.0.200', ...(network ? { network: { name: network } } : {}) }, { ...world, networks: overlapping }, { descriptions: true });
        expect(fail(() => check())).toBe('INVALID: 10.0.0.200 is in several networks (Home 10.0.0.1/24, Wide 10.0.0.129/25); their subnets overlap, so it is refused');
        expect(fail(() => check('Wide'))).toMatch(/^INVALID: 10.0.0.200 is in several networks/);
        // An address only one of them holds is fine.
        expect(fail(() => checkReservationSet({ mac: '02-00-00-00-00-03', ip: '10.0.0.20' }, { ...world, networks: overlapping }, { descriptions: true }))).toBe('ok');
    });

    it('refuses the gateway, network and broadcast addresses', () => {
        expect(fail(() => set({ mac: '02-00-00-00-00-03', ip: '10.0.0.1' }))).toBe("INVALID: 10.0.0.1 is the gateway of 'Home'");
        expect(fail(() => set({ mac: '02-00-00-00-00-03', ip: '10.0.0.0' }))).toBe("INVALID: 10.0.0.0 is the network or broadcast address of 'Home'");
        expect(fail(() => set({ mac: '02-00-00-00-00-03', ip: '10.0.0.255' }))).toBe("INVALID: 10.0.0.255 is the network or broadcast address of 'Home'");
    });

    it('refuses an address reserved for or used right now by another device', () => {
        expect(fail(() => set({ mac: '02-00-00-00-00-03', ip: '10.0.0.50' }))).toBe('EXISTS: 10.0.0.50 is already reserved for phone (02-00-00-00-00-01)');
        expect(fail(() => set({ mac: '02-00-00-00-00-03', ip: '10.0.1.20' }))).toBe('EXISTS: 10.0.1.20 is in use by plug (02-00-00-00-00-02) right now; choose a free address');
        // An offline device's last address is free.
        expect(fail(() => set({ mac: '02-00-00-00-00-04', ip: '10.0.0.60' }))).toBe('ok');
    });

    it('refuses nothing to change, but a new description is a change', () => {
        expect(fail(() => set({ mac: '02:00:00:00:00:01', ip: '10.0.0.50' }))).toBe('INVALID: Nothing to change: phone (02-00-00-00-00-01) already has 10.0.0.50 reserved');
        expect(fail(() => set({ mac: '02:00:00:00:00:01', ip: '10.0.0.50', description: 'phone' }))).toMatch(/^INVALID: Nothing to change/);
        expect(set({ mac: '02:00:00:00:00:01', ip: '10.0.0.50', description: 'work phone' }).step.action).toBe('update');
        // The same address in another network (by id) is a change too.
        const moved = checkReservationSet({ mac: '02:00:00:00:00:01', ip: '10.0.0.50' }, { ...world, reservations: [{ ...RESERVATIONS[0], network: { id: 'n-old' } }] }, { descriptions: true });
        expect(moved.step.action).toBe('update');
    });

    it('checks the description: refused where the vendor keeps none, at most 128 characters', () => {
        expect(fail(() => set({ mac: '02-00-00-00-00-03', ip: '10.0.0.61', description: 'x' }, false))).toMatch(/^UNSUPPORTED: This controller doesn't keep a description/);
        expect(fail(() => set({ mac: '02-00-00-00-00-03', ip: '10.0.0.61', description: 'x'.repeat(129) }))).toBe('INVALID: The description must be at most 128 characters');
        expect(set({ mac: '02-00-00-00-00-03', ip: '10.0.0.61', description: 'x'.repeat(128) }).description).toHaveLength(128);
    });
});

describe('removing a reservation', () => {
    it('removes the device\'s reservation; an online device keeps its address until the lease ends', () => {
        const checked = checkReservationDelete('02:00:00:00:00:01', world);

        expect(checked.current).toEqual(RESERVATIONS[0]);
        expect(checked.step).toEqual({ action: 'delete', object: 'reservation', name: 'phone (02-00-00-00-00-01)', detail: '10.0.0.50' });
        expect(checked.effects).toEqual(['phone (02-00-00-00-00-01) no longer has 10.0.0.50 reserved.', 'It is online: it keeps its address until its lease runs out, then it may get another one.']);
        const offline = checkReservationDelete('02:00:00:00:00:01', { ...world, clients: [] });
        expect(offline.step.name).toBe('02-00-00-00-00-01');
        expect(offline.effects[1]).toBe('The next time it connects it gets an address from the DHCP range.');
    });

    it('refuses a device without a reservation', () => {
        expect(fail(() => checkReservationDelete('02-00-00-00-00-03', world))).toBe('NOT_FOUND: laptop (02-00-00-00-00-03) has no reservation');
    });
});
