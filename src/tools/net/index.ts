/**
 * Vendor-neutral network tools (net_*). They speak the shared model (src/net/model.ts)
 * and work through whichever adapter is configured (Omada today; UniFi and MikroTik
 * later). Every write is planned first: dryRun returns the plan, otherwise the plan is
 * applied, refused if the controller changed meanwhile or if online devices would be
 * cut off without allowLockout.
 *
 * 2.4.5: networks and Wi-Fi. 2.4.7: rules (and listing groups). 2.4.8: clients with their
 * network, switch ports and port profiles, the mDNS repeater. 2.5.0: several controllers
 * (Omada and Ruijie): every tool takes an optional `controller` (the vendor), default Omada.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { NetError, type Change, type Network, type NetworkController, type Plan, type PortNetworks, type PortRef, type Ref, type Rule, type Selector } from '../../net/model.js';
import { Permission, toToolResult, wrapToolHandler } from '../common.js';

const ref = (what: string) => z.string().min(1).describe(`${what} name or id`);
const dryRun = z.boolean().optional().describe('Only show what would change (steps, effects, devices cut off); write nothing');
const allowLockout = z.boolean().optional().describe('Apply even if online devices would be disconnected (needs the basis from the dry run)');
const basis = z
    .string()
    .min(1)
    .optional()
    .describe('The basis a dry run returned: applying is refused if the controller, or the devices the change cuts off, changed since. Required with allowLockout');
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
    basis,
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
    basis,
    allowLockout,
});
export const deleteNetworkSchema = z.object({ network: ref('Network'), dryRun, allowLockout, basis });
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
    basis,
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
    basis,
    allowLockout,
});
export const deleteWifiSchema = z.object({ wifi: ref('Wi-Fi network'), dryRun, allowLockout, basis });

const selector = z.union([
    z.object({ network: ref('Network') }).strict(),
    z.object({ group: ref('IP group') }).strict(),
    z.object({ addresses: z.array(z.string().min(1)).min(1).max(64).describe('IPv4 addresses or CIDRs, e.g. ["192.168.0.19"]') }).strict(),
    z.object({ internet: z.literal(true) }).strict(),
    z.object({ gateway: z.literal(true).describe('The router itself') }).strict(),
    z.object({ device: z.string().min(1).describe('Device MAC') }).strict(),
    z.object({ wifi: ref('Wi-Fi network') }).strict(),
]);
const selectors = (side: string) => z.array(selector).min(1).describe(`${side}: one kind per rule, e.g. [{ network: "IoT" }] or [{ addresses: ["192.168.0.19"] }] or [{ internet: true }]`);
const protocol = z
    .union([z.enum(['any', 'tcp', 'udp', 'icmp']), z.object({ tcpUdpPorts: z.string().min(1).describe('Single ports, e.g. "1883, 8123"; needs addresses as the destination') }).strict()])
    .describe('Default any');
const position = z.number().int().min(1).describe('1 = checked first; rules are checked in order and the first match decides');

export const createRuleSchema = z.object({
    name: z.string().min(1).max(496),
    action: z.enum(['allow', 'block']),
    from: selectors('Where traffic starts'),
    to: selectors('Where it goes'),
    protocol: protocol.optional(),
    enabled: z.boolean().optional().describe('Default true'),
    position: position.optional().describe('Default: last'),
    dryRun,
    basis,
});
export const updateRuleSchema = z.object({
    rule: ref('Rule'),
    name: z.string().min(1).max(496).optional(),
    action: z.enum(['allow', 'block']).optional(),
    from: selectors('Where traffic starts').optional(),
    to: selectors('Where it goes').optional(),
    protocol: protocol.optional(),
    enabled: z.boolean().optional(),
    position: position.optional(),
    dryRun,
    basis,
});
export const deleteRuleSchema = z.object({ rule: ref('Rule'), dryRun, basis });
export const moveRuleSchema = z.object({ rule: ref('Rule'), position, dryRun, basis });
export const listGroupsSchema = z.object({ kind: z.enum(['address', 'mac']).optional() });
export const listClientsSchema = z.object({ network: ref('Only devices on this network').optional() });
const switchRef = z.string().min(1).describe('Switch name or MAC');
export const listPortsSchema = z.object({ switch: switchRef.optional().describe('Only this switch (name or MAC); default all') });
export const assignPortSchema = z.object({
    switch: switchRef,
    port: z.number().int().min(1).describe('Port number'),
    network: ref('Untagged network: what a plain device on the port is on'),
    tagged: z
        .union([z.enum(['all', 'none']), z.array(ref('Network')).min(1)])
        .default('none')
        .describe('Networks the port also carries tagged (for an access point, a switch or a VLAN-aware device): "all", "none" (default) or a list'),
    dryRun,
    basis,
    allowLockout,
});
export const upgradeFirmwareSchema = z.object({
    device: z.string().min(1).optional().describe('The device (name or MAC); default: the controller\'s only upgradable device'),
    dryRun,
    basis,
    allowLockout,
});
export const setMdnsSchema = z.object({
    enabled: z.boolean(),
    networks: z.array(ref('Network')).min(1).optional().describe('Networks to repeat between (at least two when enabled); default: the current ones'),
    dryRun,
    basis,
});

const NO_PASSWORD =
    ' Passwords are never taken or shown: a new or reset Wi-Fi network gets a random temporary password, and the owner sets the real one in the controller web UI.';
const CONFIRM = ' Confirm with the user before applying (use dryRun first).';

/**
 * Plan, then apply unless dryRun. Dry run and apply are separate calls (the server keeps no
 * state between them), so the dry run hands out its basis and the apply checks it: devices are
 * cut off (allowLockout) only when they are the ones the dry run showed.
 */
async function run(controller: NetworkController, change: Change, options: { dryRun?: boolean; allowLockout?: boolean; basis?: string }) {
    if (options.allowLockout && !options.dryRun && !options.basis) {
        throw new NetError('INVALID', 'allowLockout needs the basis from a dry run of this change, so that only the devices it showed are cut off. Run it with dryRun first.');
    }
    const plan = await controller.plan(change);
    if (options.dryRun) return { dryRun: true, ...summary(plan) };
    if (options.basis !== undefined && options.basis !== plan.basis) {
        throw new NetError('CONFLICT', 'This is not the change the dry run was for, or the controller or the devices it cuts off changed since; nothing was written. Run the dry run of this change again.');
    }
    const result = await controller.apply(plan, { allowLockout: options.allowLockout });
    return {
        applied: true,
        controller: controller.id,
        steps: plan.steps,
        effects: plan.effects,
        ...(result.object ? { result: result.object } : {}),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    };
}

function summary(plan: Plan) {
    return {
        controller: plan.vendor,
        steps: plan.steps,
        effects: plan.effects,
        wouldLockOut: plan.wouldLockOut.map((c) => ({ mac: c.mac, name: c.name })),
        basis: plan.basis,
        ...(plan.wouldLockOut.length ? { note: 'Applying needs allowLockout and this basis: these online devices would be disconnected.' } : {}),
    };
}

/**
 * A controller that hands every call to the one chosen for the current tool call. The choice
 * lives in an AsyncLocalStorage, so parallel calls in one request each keep their own.
 */
function routedController(current: () => NetworkController): NetworkController {
    return {
        get vendor() {
            return current().vendor;
        },
        get id() {
            return current().id;
        },
        capabilities: () => current().capabilities(),
        protectedResources: () => current().protectedResources(),
        listNetworks: () => current().listNetworks(),
        listWifi: () => current().listWifi(),
        listPortProfiles: () => current().listPortProfiles(),
        listPorts: (device) => current().listPorts(device),
        listRules: () => current().listRules(),
        listGroups: (kind) => current().listGroups(kind),
        listReservations: () => current().listReservations(),
        listClients: () => current().listClients(),
        getMdnsRepeater: () => current().getMdnsRepeater(),
        listFirmware: () => current().listFirmware(),
        plan: (change) => current().plan(change),
        apply: (plan, options) => current().apply(plan, options),
    };
}

/**
 * Registers the net_* tools for one or more controllers (one per vendor). Each tool takes an
 * optional `controller` (the vendor name, checked by its schema); without it, Omada answers
 * when configured, else the first controller.
 */
export function registerNetTools(target: McpServer, controllers: NetworkController | NetworkController[]): number {
    // One controller per vendor: a second one of the same vendor is never chosen.
    const configured = Array.isArray(controllers) ? controllers : [controllers];
    if (!configured.length) return 0;
    const fallback = configured.find((c) => c.vendor === 'omada') ?? configured[0];
    const vendors = [...new Set(configured.map((c) => c.vendor))] as [string, ...string[]];
    const chosen = new AsyncLocalStorage<NetworkController>();
    const controller = routedController(() => chosen.getStore() ?? fallback);
    // A value the schema let through without a controller behind it refuses every call (never Omada by accident).
    const pick = (wanted: unknown): NetworkController =>
        wanted === undefined
            ? fallback
            : (configured.find((c) => c.vendor === wanted) ??
              routedController(() => {
                  throw new NetError('NOT_FOUND', `No network controller '${String(wanted)}' is configured; configured: ${vendors.join(', ')}`);
              }));
    const choice = z
        .enum(vendors)
        .optional()
        .describe(`Which network controller answers: ${vendors.join(' or ')} (default ${fallback.vendor})`);
    type Handler = (args: Record<string, unknown> | undefined, extra: unknown) => unknown;
    const server = {
        registerTool: (name: string, config: { inputSchema: z.ZodObject<z.ZodRawShape> } & Record<string, unknown>, handler: Handler) =>
            target.registerTool(name, { ...config, inputSchema: config.inputSchema.extend({ controller: choice }) } as never, ((args: Record<string, unknown> | undefined, extra: unknown) =>
                chosen.run(pick(args?.controller), () => handler(args, extra))) as never),
    } as unknown as McpServer;

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
                "Change a network: name, VLAN, gateway, DHCP, IPv6 off. Never changes the VLAN or gateway of the networks the controller and this server are on; changes that cut devices off need allowLockout." +
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
            description: 'Delete a network. Refused while a Wi-Fi network, port profile, switch port (untagged), DHCP reservation or rule uses it, and for the networks the controller and this server are on.' + CONFIRM,
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
    registerRuleTools(server, controller);
    registerPortTools(server, controller);
    registerFirmwareTools(server, controller);
    return 23;
}

const RULES =
    ' Rules are stateful: a block rule stops new connections, while replies to connections started from the other side still pass (so "block IoT → Home" lets Home still reach IoT).';

function registerRuleTools(server: McpServer, controller: NetworkController): void {
    server.registerTool(
        'net_listRules',
        { description: 'List the traffic rules in evaluation order (first match decides). Rules marked foreign are shown read-only.', inputSchema: z.object({}) },
        wrapToolHandler('net_listRules', async () => toToolResult(await controller.listRules()), Permission.QUERY)
    );
    server.registerTool(
        'net_listGroups',
        { description: 'List address groups (usable in rules) and MAC groups (Wi-Fi allow/deny lists).', inputSchema: listGroupsSchema },
        wrapToolHandler('net_listGroups', async (a: z.infer<typeof listGroupsSchema>) => toToolResult(await controller.listGroups(a.kind)), Permission.QUERY)
    );
    server.registerTool(
        'net_createRule',
        {
            description:
                'Create a traffic rule: allow or block traffic from networks, a group or addresses to networks, a group, addresses (optionally on ports) or the internet.' +
                RULES +
                ' Addresses given here become a group the rule owns (removed with it). Refused with the reason: the router itself as a destination, one device by MAC, Wi-Fi as source, schedules, and any change that would cut the controller off the internet.' +
                CONFIRM,
            inputSchema: createRuleSchema,
        },
        wrapToolHandler(
            'net_createRule',
            async (a: z.infer<typeof createRuleSchema>) =>
                toToolResult(
                    await run(
                        controller,
                        {
                            op: 'create',
                            kind: 'rule',
                            value: {
                                name: a.name,
                                action: a.action,
                                from: toSelectors(a.from),
                                to: toSelectors(a.to),
                                protocol: (a.protocol ?? 'any') as Rule['protocol'],
                                replies: 'allow',
                                schedule: { kind: 'always' },
                                enabled: a.enabled ?? true,
                                ...(a.position !== undefined ? { position: a.position } : {}),
                            },
                        },
                        a
                    )
                ),
            Permission.CONFIGURE
        )
    );
    server.registerTool(
        'net_updateRule',
        { description: 'Change a rule: name, action, source, destination, protocol/ports, on/off or position.' + RULES + CONFIRM, inputSchema: updateRuleSchema },
        wrapToolHandler(
            'net_updateRule',
            async (a: z.infer<typeof updateRuleSchema>) =>
                toToolResult(
                    await run(
                        controller,
                        {
                            op: 'update',
                            kind: 'rule',
                            value: {
                                ref: { name: a.rule },
                                set: {
                                    ...(a.name !== undefined ? { name: a.name } : {}),
                                    ...(a.action !== undefined ? { action: a.action } : {}),
                                    ...(a.from !== undefined ? { from: toSelectors(a.from) } : {}),
                                    ...(a.to !== undefined ? { to: toSelectors(a.to) } : {}),
                                    ...(a.protocol !== undefined ? { protocol: a.protocol as Rule['protocol'] } : {}),
                                    ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
                                    ...(a.position !== undefined ? { position: a.position } : {}),
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
        'net_deleteRule',
        { description: 'Delete a rule (and the address group it owns).' + CONFIRM, inputSchema: deleteRuleSchema },
        wrapToolHandler('net_deleteRule', async (a: z.infer<typeof deleteRuleSchema>) => toToolResult(await run(controller, { op: 'delete', kind: 'rule', ref: { name: a.rule } }, a)), Permission.CONFIGURE)
    );
    server.registerTool(
        'net_moveRule',
        { description: 'Move a rule to another position (1 = checked first; the first matching rule decides).' + CONFIRM, inputSchema: moveRuleSchema },
        wrapToolHandler(
            'net_moveRule',
            async (a: z.infer<typeof moveRuleSchema>) => toToolResult(await run(controller, { op: 'move', kind: 'rule', ref: { name: a.rule }, position: a.position }, a)),
            Permission.CONFIGURE
        )
    );
}

function registerPortTools(server: McpServer, controller: NetworkController): void {
    server.registerTool(
        'net_listClients',
        {
            description: 'List the online devices with the network (and VLAN) each is on, its Wi-Fi network or switch port. Answers "what is on VLAN 2?".',
            inputSchema: listClientsSchema,
        },
        wrapToolHandler(
            'net_listClients',
            async (a: z.infer<typeof listClientsSchema>) => {
                const networks = await controller.listNetworks();
                const only = a.network === undefined ? undefined : findNetwork(networks, a.network);
                const clients = (await controller.listClients()).filter((c) => !only || (c.network && 'id' in c.network && c.network.id === only.id));
                return toToolResult(
                    clients.map((c) => {
                        const network = c.network && 'id' in c.network ? networks.find((n) => n.id === (c.network as { id: string }).id) : undefined;
                        return {
                            mac: c.mac,
                            ...(c.name ? { name: c.name } : {}),
                            ...(c.ip ? { ip: c.ip } : {}),
                            network: network ? network.name : 'unknown',
                            ...(network ? { vlan: network.vlan } : {}),
                            ...(c.wifi ? { wifi: 'name' in c.wifi ? c.wifi.name : c.wifi.id } : {}),
                            ...(c.port ? { port: c.port } : {}),
                            online: c.online,
                        };
                    })
                );
            },
            Permission.QUERY
        )
    );
    server.registerTool(
        'net_listPortProfiles',
        {
            description:
                'List switch port profiles and, when a profile sets them, the networks a port following it carries (without networks: ports keep their own, see net_listPorts). Profiles are created in the controller web UI.',
            inputSchema: z.object({}),
        },
        wrapToolHandler(
            'net_listPortProfiles',
            async () => {
                const networks = await controller.listNetworks();
                return toToolResult((await controller.listPortProfiles()).map((p) => ({ ...p, ...(p.networks ? { networks: namedNetworks(p.networks, networks) } : {}) })));
            },
            Permission.QUERY
        )
    );
    server.registerTool(
        'net_listPorts',
        {
            description:
                'List switch ports: the networks each carries (untagged and tagged), its profile, the online devices on it, whether it is an uplink, and why it is protected when it is (uplinks and the ports the controller and this server are on are never changed).',
            inputSchema: listPortsSchema,
        },
        wrapToolHandler(
            'net_listPorts',
            async (a: z.infer<typeof listPortsSchema>) => {
                const profiles = await controller.listPortProfiles();
                const networks = await controller.listNetworks();
                const ports = await controller.listPorts(a.switch === undefined ? undefined : toSwitch(a.switch));
                return toToolResult(
                    ports.map((p) => ({
                        ...p,
                        ...(p.profile ? { profile: named(p.profile, profiles) } : {}),
                        ...(p.networks ? { networks: namedNetworks(p.networks, networks) } : {}),
                        seen: p.seen.map((c) => ({ mac: c.mac, ...(c.name ? { name: c.name } : {}), ...(c.ip ? { ip: c.ip } : {}) })),
                    }))
                );
            },
            Permission.QUERY
        )
    );
    server.registerTool(
        'net_assignPort',
        {
            description:
                'Set the networks a switch port carries: its untagged network (e.g. a wired IoT device\'s port on "IoT") and optionally tagged ones; its other settings keep following its profile. Never for uplinks, the ports the controller and this server are on, link aggregation ports and ports with their own settings (net_listPorts says why a port is protected); devices that would lose their network need allowLockout.' +
                CONFIRM,
            inputSchema: assignPortSchema,
        },
        wrapToolHandler(
            'net_assignPort',
            async (a: z.infer<typeof assignPortSchema>) =>
                toToolResult(
                    await run(
                        controller,
                        { op: 'assign', kind: 'port', port: { device: toSwitch(a.switch), port: a.port }, networks: { native: { name: a.network }, tagged: Array.isArray(a.tagged) ? a.tagged.map((name) => ({ name })) : (a.tagged ?? 'none') } },
                        a
                    )
                ),
            Permission.CONFIGURE
        )
    );
    server.registerTool(
        'net_getMdnsRepeater',
        { description: 'Whether mDNS (Bonjour) discovery is repeated between networks, and between which.', inputSchema: z.object({}) },
        wrapToolHandler(
            'net_getMdnsRepeater',
            async () => {
                const networks = await controller.listNetworks();
                const repeater = await controller.getMdnsRepeater();
                return toToolResult({ ...repeater, networks: repeater.networks.map((r) => named(r, networks)) });
            },
            Permission.QUERY
        )
    );
    server.registerTool(
        'net_setMdnsRepeater',
        {
            description:
                'Switch the mDNS repeater on or off, or change the networks it repeats between (e.g. Home and IoT, so Home Assistant and phones discover IoT devices). Discovery only: traffic still follows the rules.' +
                CONFIRM,
            inputSchema: setMdnsSchema,
        },
        wrapToolHandler(
            'net_setMdnsRepeater',
            async (a: z.infer<typeof setMdnsSchema>) =>
                toToolResult(await run(controller, { op: 'set', kind: 'mdnsRepeater', enabled: a.enabled, ...(a.networks ? { networks: a.networks.map((name) => ({ name })) } : {}) }, a)),
            Permission.CONFIGURE
        )
    );
}

/** A network by id or name (case-insensitive). */
function findNetwork(networks: Network[], wanted: string): Network {
    const found = networks.find((n) => n.id === wanted) ?? networks.find((n) => n.name.toLowerCase() === wanted.trim().toLowerCase());
    if (!found) throw new NetError('NOT_FOUND', `Network '${wanted}' not found. Available: ${networks.map((n) => n.name).join(', ') || '(none)'}`);
    return found;
}

/** A reference with the name added, for reading. */
function named(r: Ref, items: Array<{ id: string; name: string }>): Ref & { name?: string } {
    const item = 'id' in r ? items.find((i) => i.id === r.id) : undefined;
    return item ? { id: item.id, name: item.name } : r;
}

/** A port's or profile's networks with their names. */
function namedNetworks(carried: PortNetworks, networks: Network[]) {
    return {
        ...(carried.native ? { native: named(carried.native, networks) } : {}),
        ...(carried.untagged ? { untagged: carried.untagged.map((r) => named(r, networks)) } : {}),
        tagged: Array.isArray(carried.tagged) ? carried.tagged.map((r) => named(r, networks)) : carried.tagged,
    };
}

/** A MAC (12 hex digits, with or without separators) picks the switch by MAC, anything else by name. */
function registerFirmwareTools(server: McpServer, controller: NetworkController): void {
    server.registerTool(
        'net_listFirmware',
        {
            description: 'List the firmware of the network devices: what each runs and, when the vendor offers one, the newer version with its release notes and whether net_upgradeFirmware can install it.',
            inputSchema: z.object({}),
        },
        wrapToolHandler('net_listFirmware', async () => toToolResult(await controller.listFirmware()), Permission.QUERY)
    );
    server.registerTool(
        'net_upgradeFirmware',
        {
            description:
                'Install the firmware version the vendor offers for a device (only from the vendor\'s own download server). The device restarts and keeps its settings; everything behind it is offline meanwhile, so applying needs allowLockout and the dry run\'s basis. Needs ADMIN.' +
                CONFIRM,
            inputSchema: upgradeFirmwareSchema,
        },
        wrapToolHandler(
            'net_upgradeFirmware',
            async (a: z.infer<typeof upgradeFirmwareSchema>) => toToolResult(await run(controller, { op: 'upgrade', kind: 'firmware', ...(a.device ? { device: toSwitch(a.device) } : {}) }, a)),
            Permission.ADMIN
        )
    );
}

function toSwitch(value: string): PortRef['device'] {
    return /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^[0-9a-f]{12}$/i.test(value.trim()) ? { mac: value.trim() } : { name: value };
}

function toSelectors(list: Array<z.infer<typeof selector>>): Selector[] {
    return list.map((s): Selector => {
        if ('network' in s) return { network: { name: s.network } };
        if ('group' in s) return { group: { name: s.group } };
        if ('addresses' in s) return { addresses: s.addresses };
        if ('internet' in s) return { internet: true };
        if ('gateway' in s) return { gateway: true };
        if ('device' in s) return { device: s.device };
        return { wifi: { name: s.wifi } };
    });
}

function toDhcp(d: z.infer<typeof dhcp>) {
    return {
        enabled: d.enabled,
        ...(d.from && d.to ? { range: { from: d.from, to: d.to } } : {}),
        ...(d.leaseMinutes !== undefined ? { leaseMinutes: d.leaseMinutes } : {}),
        ...(d.dns ? { dns: d.dns } : {}),
    };
}
