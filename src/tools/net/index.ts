/**
 * Vendor-neutral network tools (net_*). They speak the shared model (src/net/model.ts)
 * and work through whichever adapter is configured (Omada today; UniFi and MikroTik
 * later). Every write is planned first: dryRun returns the plan, otherwise the plan is
 * applied, refused if the controller changed meanwhile or if online devices would be
 * cut off without allowLockout.
 *
 * 2.4.5: networks and Wi-Fi. Rules arrive in 2.4.7, switch ports and mDNS in 2.4.8.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { type Change, type NetworkController, type Plan } from '../../net/model.js';
import { Permission, toToolResult, wrapToolHandler } from '../common.js';

const ref = (what: string) => z.string().min(1).describe(`${what} name or id`);
const dryRun = z.boolean().optional().describe('Only show what would change (steps, effects, devices cut off); write nothing');
const allowLockout = z.boolean().optional().describe('Apply even if online devices would be disconnected');
const band = z.enum(['2.4', '5', '6']);
const dhcp = z.object({
    enabled: z.boolean(),
    from: z.string().optional().describe('First address of the DHCP range'),
    to: z.string().optional().describe('Last address of the DHCP range'),
    leaseMinutes: z.number().int().optional().describe('2-10080, default 120'),
    dns: z.array(z.string()).max(2).optional().describe('DNS servers handed out; default: the gateway'),
}).refine((d) => (d.from === undefined) === (d.to === undefined), { message: 'Give both ends of the DHCP range (from and to), or neither' });
const macFilter = z.object({ policy: z.enum(['allow', 'deny']), group: ref('MAC group') });

export const createNetworkSchema = z.object({
    name: z.string().min(1).max(128),
    vlan: z.number().int().describe('2-4090'),
    gateway: z.string().optional().describe('Gateway address with prefix, e.g. "192.168.3.1/24" (not for vlanOnly)'),
    purpose: z.enum(['normal', 'guest', 'vlanOnly']).optional().describe('normal (default): routed with DHCP; vlanOnly: switches only'),
    dhcp: dhcp.optional(),
    ipv6: z.boolean().optional().describe('Default off'),
    isolated: z.boolean().optional().describe("Devices can't start connections to other networks"),
    dryRun,
});
export const updateNetworkSchema = z.object({
    network: ref('Network'),
    name: z.string().min(1).max(128).optional(),
    vlan: z.number().int().optional(),
    gateway: z.string().optional(),
    dhcp: dhcp.optional(),
    ipv6: z.boolean().optional(),
    isolated: z.boolean().optional(),
    dryRun,
    allowLockout,
});
export const deleteNetworkSchema = z.object({ network: ref('Network'), dryRun, allowLockout });
export const createWifiSchema = z.object({
    name: z.string().min(1).max(32),
    network: ref('Network the Wi-Fi puts its devices on'),
    bands: z.array(band).min(1).optional().describe('Default ["2.4", "5"]'),
    security: z.enum(['open', 'wpa2', 'wpa3', 'wpa2wpa3']).optional().describe('Default wpa2'),
    pmf: z.enum(['off', 'optional', 'required']).optional().describe('Protected management frames, default optional'),
    clientIsolation: z.boolean().optional().describe("Devices can't reach each other"),
    hidden: z.boolean().optional(),
    fastRoaming: z.boolean().optional().describe('802.11r, default off'),
    macFilter: macFilter.optional().describe('Only (allow) or never (deny) the devices in a MAC group'),
    dryRun,
});
export const updateWifiSchema = z.object({
    wifi: ref('Wi-Fi network'),
    name: z.string().min(1).max(32).optional(),
    network: ref('Network').optional(),
    bands: z.array(band).min(1).optional(),
    security: z.enum(['open', 'wpa2', 'wpa3', 'wpa2wpa3']).optional(),
    pmf: z.enum(['off', 'optional', 'required']).optional(),
    clientIsolation: z.boolean().optional(),
    hidden: z.boolean().optional(),
    fastRoaming: z.boolean().optional(),
    macFilter: macFilter.nullable().optional().describe('null switches the MAC filter off'),
    newTemporaryPassword: z.boolean().optional().describe('Replace the password with a random one nobody knows (set the real one in the controller web UI)'),
    dryRun,
    allowLockout,
});
export const deleteWifiSchema = z.object({ wifi: ref('Wi-Fi network'), dryRun, allowLockout });

const NO_PASSWORD =
    ' Passwords are never taken or shown: a new or reset Wi-Fi network gets a random temporary password, and the owner sets the real one in the controller web UI.';
const CONFIRM = ' Confirm with the user before applying (use dryRun first).';

/** Plan, then apply unless dryRun. */
async function run(controller: NetworkController, change: Change, options: { dryRun?: boolean; allowLockout?: boolean }) {
    const plan = await controller.plan(change);
    if (options.dryRun) return { dryRun: true, ...summary(plan) };
    const result = await controller.apply(plan, { allowLockout: options.allowLockout });
    return { applied: true, controller: controller.id, steps: plan.steps, effects: plan.effects, ...(result.object ? { result: result.object } : {}) };
}

function summary(plan: Plan) {
    return {
        controller: plan.vendor,
        steps: plan.steps,
        effects: plan.effects,
        wouldLockOut: plan.wouldLockOut.map((c) => ({ mac: c.mac, name: c.name })),
        ...(plan.wouldLockOut.length ? { note: 'Applying needs allowLockout: these online devices would be disconnected.' } : {}),
    };
}

export function registerNetTools(server: McpServer, controller: NetworkController): number {
    server.registerTool(
        'net_capabilities',
        { description: 'What the network controller can do: per feature native, emulated (built from several objects) or unsupported.', inputSchema: z.object({}) },
        wrapToolHandler('net_capabilities', async () => toToolResult({ controller: controller.id, ...(await controller.capabilities()) }), Permission.QUERY)
    );
    server.registerTool(
        'net_listNetworks',
        { description: 'List networks (VLANs): VLAN, gateway, DHCP, IPv6, and whether it is protected (carries the controller).', inputSchema: z.object({}) },
        wrapToolHandler('net_listNetworks', async () => toToolResult(await controller.listNetworks()), Permission.QUERY)
    );
    server.registerTool(
        'net_listWifi',
        { description: 'List Wi-Fi networks: the network they put devices on, bands, security, isolation, MAC filter. Passwords are never shown.', inputSchema: z.object({}) },
        wrapToolHandler('net_listWifi', async () => toToolResult(await controller.listWifi()), Permission.QUERY)
    );

    server.registerTool(
        'net_createNetwork',
        {
            description:
                'Create a network (VLAN) on the gateway: VLAN id, gateway address with prefix, DHCP range. Refuses a VLAN, name or subnet already in use.' +
                CONFIRM,
            inputSchema: createNetworkSchema,
        },
        wrapToolHandler(
            'net_createNetwork',
            async (a: z.infer<typeof createNetworkSchema>) =>
                toToolResult(
                    await run(
                        controller,
                        {
                            op: 'create',
                            kind: 'network',
                            value: {
                                name: a.name,
                                purpose: a.purpose ?? 'normal',
                                vlan: a.vlan,
                                ...(a.gateway ? { gateway: a.gateway } : {}),
                                ...(a.dhcp ? { dhcp: toDhcp(a.dhcp) } : {}),
                                ipv6: a.ipv6 ?? false,
                                isolated: a.isolated ?? false,
                            },
                        },
                        a
                    )
                ),
            Permission.CONFIGURE
        )
    );
    server.registerTool(
        'net_updateNetwork',
        {
            description:
                "Change a network: name, VLAN, gateway, DHCP, IPv6 off. Never changes the VLAN or gateway of the network the controller is on; changes that cut devices off need allowLockout." +
                CONFIRM,
            inputSchema: updateNetworkSchema,
        },
        wrapToolHandler(
            'net_updateNetwork',
            async (a: z.infer<typeof updateNetworkSchema>) =>
                toToolResult(
                    await run(
                        controller,
                        {
                            op: 'update',
                            kind: 'network',
                            value: {
                                ref: { name: a.network },
                                set: {
                                    ...(a.name !== undefined ? { name: a.name } : {}),
                                    ...(a.vlan !== undefined ? { vlan: a.vlan } : {}),
                                    ...(a.gateway !== undefined ? { gateway: a.gateway } : {}),
                                    ...(a.dhcp !== undefined ? { dhcp: toDhcp(a.dhcp) } : {}),
                                    ...(a.ipv6 !== undefined ? { ipv6: a.ipv6 } : {}),
                                    ...(a.isolated !== undefined ? { isolated: a.isolated } : {}),
                                },
                            },
                        },
                        a
                    )
                ),
            Permission.CONFIGURE
        )
    );
    server.registerTool(
        'net_deleteNetwork',
        {
            description: 'Delete a network. Refused while a Wi-Fi network, port profile, DHCP reservation or rule uses it, and for the network the controller is on.' + CONFIRM,
            inputSchema: deleteNetworkSchema,
        },
        wrapToolHandler(
            'net_deleteNetwork',
            async (a: z.infer<typeof deleteNetworkSchema>) => toToolResult(await run(controller, { op: 'delete', kind: 'network', ref: { name: a.network } }, a)),
            Permission.CONFIGURE
        )
    );

    server.registerTool(
        'net_createWifi',
        {
            description: 'Create a Wi-Fi network (SSID) that puts its devices on a given network (VLAN).' + NO_PASSWORD + CONFIRM,
            inputSchema: createWifiSchema,
        },
        wrapToolHandler(
            'net_createWifi',
            async (a: z.infer<typeof createWifiSchema>) =>
                toToolResult(
                    await run(
                        controller,
                        {
                            op: 'create',
                            kind: 'wifi',
                            value: {
                                name: a.name,
                                network: { name: a.network },
                                bands: a.bands ?? ['2.4', '5'],
                                security: a.security ?? 'wpa2',
                                pmf: a.pmf ?? 'optional',
                                clientIsolation: a.clientIsolation ?? false,
                                hidden: a.hidden ?? false,
                                fastRoaming: a.fastRoaming ?? false,
                                macFilter: a.macFilter ? { policy: a.macFilter.policy, group: { name: a.macFilter.group } } : null,
                                enabled: true,
                            },
                            passphrase: { kind: 'temporary' },
                        },
                        a
                    )
                ),
            Permission.CONFIGURE
        )
    );
    server.registerTool(
        'net_updateWifi',
        {
            description:
                'Change a Wi-Fi network: name, network (VLAN), bands, security, PMF, isolation, hidden, 802.11r, MAC filter, or reset its password to a random one.' +
                ' Changes that disconnect devices need allowLockout.' +
                NO_PASSWORD +
                CONFIRM,
            inputSchema: updateWifiSchema,
        },
        wrapToolHandler(
            'net_updateWifi',
            async (a: z.infer<typeof updateWifiSchema>) =>
                toToolResult(
                    await run(
                        controller,
                        {
                            op: 'update',
                            kind: 'wifi',
                            value: {
                                ref: { name: a.wifi },
                                set: {
                                    ...(a.name !== undefined ? { name: a.name } : {}),
                                    ...(a.network !== undefined ? { network: { name: a.network } } : {}),
                                    ...(a.bands !== undefined ? { bands: a.bands } : {}),
                                    ...(a.security !== undefined ? { security: a.security } : {}),
                                    ...(a.pmf !== undefined ? { pmf: a.pmf } : {}),
                                    ...(a.clientIsolation !== undefined ? { clientIsolation: a.clientIsolation } : {}),
                                    ...(a.hidden !== undefined ? { hidden: a.hidden } : {}),
                                    ...(a.fastRoaming !== undefined ? { fastRoaming: a.fastRoaming } : {}),
                                    ...(a.macFilter !== undefined ? { macFilter: a.macFilter ? { policy: a.macFilter.policy, group: { name: a.macFilter.group } } : null } : {}),
                                },
                            },
                            passphrase: a.newTemporaryPassword ? { kind: 'temporary' } : { kind: 'unchanged' },
                        },
                        a
                    )
                ),
            Permission.CONFIGURE
        )
    );
    server.registerTool(
        'net_deleteWifi',
        { description: 'Delete a Wi-Fi network; its connected devices are disconnected (needs allowLockout then).' + CONFIRM, inputSchema: deleteWifiSchema },
        wrapToolHandler(
            'net_deleteWifi',
            async (a: z.infer<typeof deleteWifiSchema>) => toToolResult(await run(controller, { op: 'delete', kind: 'wifi', ref: { name: a.wifi } }, a)),
            Permission.CONFIGURE
        )
    );
    return 9;
}

function toDhcp(d: z.infer<typeof dhcp>) {
    return {
        enabled: d.enabled,
        ...(d.from && d.to ? { range: { from: d.from, to: d.to } } : {}),
        ...(d.leaseMinutes !== undefined ? { leaseMinutes: d.leaseMinutes } : {}),
        ...(d.dns ? { dns: d.dns } : {}),
    };
}
