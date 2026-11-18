/**
 * fortigate_read: a fixed list of read-only FortiGate resources (FortiOS REST API), for what
 * the vendor-neutral net_* tools don't model (routes, VPN, sessions, logs, services...).
 *
 * Like omada_read, the tool has no static permission: each path declares its own and is
 * checked before anything is fetched (fail closed). Sessions and logs show who talks to what,
 * so they need ADMIN; everything else QUERY. Only the paths below can be read: the path is an
 * enum, never a free API path. Encrypted FortiOS values ("ENC ...") and secret-looking fields
 * are redacted from every answer.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import { FortiGateError, type FortiGateClient } from '../../fortigateClient/index.js';
import { hasPermission, getPermissionNames } from '../../permissions/index.js';
import { REDACTED } from '../../utils/redact.js';
import { toToolResult, wrapToolHandler, getCallerPermissions, setToolVisibilityRule, Permission, type ToolExtra } from '../common.js';

type Query = Record<string, string | number | boolean>;

interface Resource {
    description: string;
    permission: number;
    /** Takes `limit` (rows). */
    limited?: boolean;
    fetch: (client: FortiGateClient, limit: number) => Promise<unknown>;
}

const MAX_ROWS = 200;
const DEFAULT_ROWS = 50;

const monitor = (path: string, name: string, action?: string, query?: Query) => async (client: FortiGateClient) => (await client.monitor(path, name, action, query)).results;
const cmdb = (path: string, name: string) => async (client: FortiGateClient) => (await client.cmdb(path, name)).results;

export const FORTIGATE_RESOURCES: Record<string, Resource> = {
    '/system/status': {
        description: 'Model, serial, hostname and FortiOS version',
        permission: Permission.QUERY,
        fetch: async (client) => {
            const status = await client.monitor('system', 'status');
            return { ...((status.results as object) ?? {}), serial: status.serial, version: status.version, build: status.build };
        },
    },
    '/system/resources': { description: 'CPU, memory, sessions and disk usage now', permission: Permission.QUERY, fetch: monitor('system', 'resource', 'usage') },
    '/system/firmware': { description: 'The running FortiOS version and the versions FortiGuard offers', permission: Permission.QUERY, fetch: monitor('system', 'firmware') },
    '/system/license': { description: 'FortiGuard licenses and contracts', permission: Permission.QUERY, fetch: monitor('license', 'status') },
    '/system/interfaces': { description: 'Every interface now: link, speed, address, traffic counters', permission: Permission.QUERY, fetch: monitor('system', 'interface', undefined, { include_vlan: true }) },
    '/config/interfaces': { description: 'Interface settings: type, role, address, allowed admin access, VLAN, members', permission: Permission.QUERY, fetch: cmdb('system', 'interface') },
    '/config/dhcp-servers': { description: 'DHCP servers: range, lease time, DNS, reserved addresses', permission: Permission.QUERY, fetch: cmdb('system.dhcp', 'server') },
    '/network/dhcp-leases': { description: 'Current DHCP leases (address, MAC, host name, expiry)', permission: Permission.QUERY, fetch: monitor('system', 'dhcp') },
    '/network/arp': { description: 'The ARP table: devices seen on each interface', permission: Permission.QUERY, fetch: monitor('network', 'arp') },
    '/network/routes': { description: 'The IPv4 routing table in use', permission: Permission.QUERY, fetch: monitor('router', 'ipv4') },
    '/firewall/policies': { description: 'Firewall policies in evaluation order', permission: Permission.QUERY, fetch: cmdb('firewall', 'policy') },
    '/firewall/addresses': { description: 'Firewall address objects', permission: Permission.QUERY, fetch: cmdb('firewall', 'address') },
    '/firewall/address-groups': { description: 'Firewall address groups', permission: Permission.QUERY, fetch: cmdb('firewall', 'addrgrp') },
    '/firewall/services': { description: 'Custom firewall services (protocols and ports)', permission: Permission.QUERY, fetch: cmdb('firewall.service', 'custom') },
    '/firewall/service-groups': { description: 'Firewall service groups', permission: Permission.QUERY, fetch: cmdb('firewall.service', 'group') },
    '/firewall/sessions': {
        description: 'Active sessions (who talks to what), newest first; limit = rows (default 50, max 200)',
        permission: Permission.ADMIN,
        limited: true,
        fetch: async (client, limit) => (await client.monitor('firewall', 'session', undefined, { count: limit, start: 0 })).results,
    },
    '/vpn/ipsec': { description: 'IPsec tunnels and whether they are up', permission: Permission.QUERY, fetch: monitor('vpn', 'ipsec') },
    '/vpn/ssl': { description: 'SSL-VPN users connected now', permission: Permission.ADMIN, fetch: monitor('vpn', 'ssl') },
    '/log/events': {
        description: 'Recent system event log (memory log): admin logins, configuration changes, link changes; limit = rows',
        permission: Permission.ADMIN,
        limited: true,
        fetch: async (client, limit) => (await client.log(['memory', 'event', 'system'], { rows: limit })).results,
    },
};

const PATHS = Object.keys(FORTIGATE_RESOURCES) as [string, ...string[]];

export const fortigateReadSchema = z.object({
    path: z.enum(PATHS).describe(`What to read: ${PATHS.map((p) => `${p} (${FORTIGATE_RESOURCES[p].description})`).join('; ')}`),
    limit: z.number().int().min(1).max(MAX_ROWS).optional().describe(`Rows for /firewall/sessions and /log/events (default ${DEFAULT_ROWS}, max ${MAX_ROWS})`),
});

/** FortiOS returns stored secrets encrypted ("ENC <base64>"): never passed on, whatever the field is called. */
export function redactEncrypted(value: unknown): unknown {
    if (typeof value === 'string') return /^ENC\s/.test(value) ? REDACTED : value;
    if (Array.isArray(value)) return value.map(redactEncrypted);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactEncrypted(v)]));
    return value;
}

export function canReadAnyFortiGateResource(callerPermissions: number): boolean {
    return Object.values(FORTIGATE_RESOURCES).some((r) => hasPermission(callerPermissions, r.permission));
}

export function registerFortiGateTools(server: McpServer, client: FortiGateClient): number {
    setToolVisibilityRule('fortigate_read', canReadAnyFortiGateResource);
    server.registerTool(
        'fortigate_read',
        {
            description:
                'Read one FortiGate resource the net_* tools don\'t cover (system status, firmware, licenses, interfaces, DHCP, ARP, routes, ' +
                'firewall policies, addresses and services, sessions, VPN, the event log). Read-only. Networks, ports, rules, reservations, ' +
                'clients and firmware are also in the net_* tools with controller "fortigate". Authorization is enforced per path.',
            inputSchema: fortigateReadSchema,
        },
        // No static permission: each path declares its own, checked below before any call.
        wrapToolHandler('fortigate_read', async (args: z.infer<typeof fortigateReadSchema>, extra: ToolExtra) => {
            const resource = FORTIGATE_RESOURCES[args.path];
            const mask = getCallerPermissions(extra);
            if (!hasPermission(mask, resource.permission)) {
                const required = getPermissionNames(resource.permission);
                return toToolResult({ error: 'Permission denied', message: `Reading '${args.path}' requires permission: ${required.join(', ')}`, required, has: getPermissionNames(mask) }, true);
            }
            try {
                const data = await resource.fetch(client, resource.limited ? (args.limit ?? DEFAULT_ROWS) : DEFAULT_ROWS);
                return toToolResult({ path: args.path, data: redactEncrypted(data) });
            } catch (error) {
                // FortiGateError messages carry only statuses and codes, never the token or the answer's text.
                if (error instanceof FortiGateError) return toToolResult({ error: error.kind, message: error.message }, true);
                throw error;
            }
        })
    );
    return 1;
}
