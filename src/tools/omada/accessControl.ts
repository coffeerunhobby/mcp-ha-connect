import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { DAYS } from '../../omadaClient/timeRange.js';
import { Permission, siteInputSchema, toToolResult, wrapToolHandler } from '../common.js';

const site = z.string().min(1).optional();
const mac = z.string().min(1).describe('Client MAC, e.g. 02-1A-2B-3C-4D-5E');
const quarterHour = z.string().regex(/^\d{1,2}:\d{2}$/, 'Use HH:MM');

const windowSchema = z.object({
    days: z.array(z.enum(DAYS)).min(1).describe('Days the window applies to'),
    start: quarterHour.describe('Start, HH:MM in quarter hours (e.g. 14:30)'),
    end: quarterHour.describe('End, HH:MM in quarter hours; 24:00 = end of day'),
});
const windows = z.array(windowSchema).min(1).max(50);
const invertWindows = z
    .boolean()
    .optional()
    .describe(
        'If true, the windows are the FREE times and the profile covers every other time of the week. A profile holds at most 7 windows, ' +
            'so for a curfew use two profiles: one with the free time from the start of play to 24:00 (= blocked mornings), one with 00:00 to the end of play (= blocked evenings)'
    );

const endpoint = <const T extends readonly [string, ...string[]]>(types: T) =>
    z.object({
        type: z.enum(types),
        ids: z.array(z.string().min(1)).min(1).describe('Ids or names (IP group, LAN network or SSID)'),
    });
const source = endpoint(['ipGroup', 'network', 'ssid']).describe('Who the rule matches');
const destination = endpoint(['ipGroup', 'network']).describe('Where to; default the built-in IP group IPGroup_Any (everything)');
const protocols = z.array(z.number().int()).min(1).optional().describe('Omada protocol numbers; default [256] = all');

export const createTimeRangeSchema = z.object({ name: z.string().min(1).max(64), windows, invertWindows, siteId: site });
export const updateTimeRangeSchema = z.object({
    profile: z.string().min(1).describe('Time range id or name'),
    windows,
    invertWindows,
    name: z.string().min(1).max(64).optional().describe('New name (optional)'),
    siteId: site,
});
export const deleteTimeRangeSchema = z.object({ profile: z.string().min(1), siteId: site });
export const createGroupSchema = z.object({
    name: z.string().min(1).max(64),
    type: z.enum(['ip', 'mac']),
    ips: z.array(z.string().min(1)).optional().describe('For type ip: addresses "a.b.c.d" (= /32) or "a.b.c.d/n"'),
    macs: z.array(z.object({ mac, name: z.string().min(1).max(128) })).optional().describe('For type mac: entries'),
    siteId: site,
});
export const deleteGroupSchema = z.object({ group: z.string().min(1).describe('Group id or name'), type: z.enum(['ip', 'mac']), siteId: site });
export const setDhcpReservationSchema = z.object({
    clientMac: mac,
    ip: z.string().min(7).describe('IPv4 address to reserve; it must be inside a LAN network (best outside the DHCP pool)'),
    description: z.string().min(1).max(128).optional(),
    siteId: site,
});
export const removeDhcpReservationSchema = z.object({ clientMac: mac, siteId: site });
export const createGatewayAclSchema = z.object({
    description: z.string().min(1).max(512).describe('Unique rule description'),
    policy: z.enum(['allow', 'deny']),
    source,
    destination: destination.optional(),
    protocols,
    timeRange: z.string().min(1).optional().describe('Time range id or name: the rule applies only during it; omitted = always'),
    enabled: z.boolean().optional().describe('Default true'),
    siteId: site,
});
export const updateGatewayAclSchema = z.object({
    acl: z.string().min(1).describe('Rule id or description'),
    description: z.string().min(1).max(512).optional(),
    policy: z.enum(['allow', 'deny']).optional(),
    source: source.optional(),
    destination: destination.optional(),
    protocols,
    timeRange: z.string().min(1).nullable().optional().describe('Time range id or name; null = always'),
    enabled: z.boolean().optional(),
    siteId: site,
});
export const deleteGatewayAclSchema = z.object({ acl: z.string().min(1).describe('Rule id or description'), siteId: site });
export const moveGatewayAclSchema = z.object({
    acl: z.string().min(1).describe('Rule id or description'),
    position: z.number().int().min(1).describe('1 = evaluated first'),
    siteId: site,
});
export const setSsidMacFilterSchema = z.object({
    ssid: z.string().min(1).describe('SSID name or id'),
    enabled: z.boolean(),
    policy: z.enum(['allow', 'deny']).optional().describe('allow = only group members may join; deny = group members may not'),
    group: z.string().min(1).optional().describe('MAC group id or name (default: the one already set)'),
    dryRun: z.boolean().optional().describe('Only report the change and who it would lock out'),
    allowLockout: z.boolean().optional().describe('Apply even if connected clients would be disconnected'),
    siteId: site,
});

const CONFIRM = ' Confirm with the user before applying.';

/** Controller-side access control tools: schedules, groups, reservations, gateway ACLs, SSID MAC filter. */
export function registerOmadaAccessControlTools(server: McpServer, client: OmadaClient, mode: 'eager' | 'graph' = 'eager'): number {
    const ac = client.accessControl;

    // In graph mode plain reads go through omada_read (/profiles/time-range, /profiles/ip-groups, /network/acls/gateway).
    if (mode === 'eager') {
        server.registerTool(
            'omada_listAccessControl',
            {
                description:
                    'List time-range profiles (with readable windows), IP groups and gateway ACL rules (with names instead of ids and their schedules).',
                inputSchema: siteInputSchema,
            },
            wrapToolHandler(
                'omada_listAccessControl',
                async ({ siteId }: { siteId?: string }) => {
                    const acls = await ac.listGatewayAcls(siteId);
                    return toToolResult({
                        timeRanges: (await ac.listTimeRanges(siteId)).map((p) => ({ profileId: p.profileId, name: p.name, windows: p.windows })),
                        ipGroups: (await ac.listIpGroups(siteId)).map((g) => ({
                            groupId: g.groupId,
                            name: g.name,
                            ips: (g.ipList ?? []).map((i) => `${i.ip}/${i.mask}`),
                        })),
                        gatewayAcls: await Promise.all(acls.map((a) => ac.describeAcl(a, siteId))),
                    });
                },
                Permission.QUERY
            )
        );
    }

    server.registerTool(
        'omada_createTimeRange',
        {
            description:
                'Create a time-range profile (a weekly schedule in quarter hours, at most 7 windows) for gateway ACL rules. With invertWindows the ' +
                'windows are the free times and the profile covers the rest. A schedule with two windows on several days (e.g. curfew mornings and ' +
                'evenings) needs two profiles, each with its own rule.',
            inputSchema: createTimeRangeSchema,
        },
        wrapToolHandler(
            'omada_createTimeRange',
            async ({ name, windows: w, invertWindows: invert, siteId }: z.infer<typeof createTimeRangeSchema>) =>
                toToolResult(await ac.createTimeRange(name, w, { invert, siteId })),
            Permission.CONFIGURE
        )
    );

    server.registerTool(
        'omada_updateTimeRange',
        {
            description: 'Replace the windows (and optionally the name) of a time-range profile. Every rule using it follows the new schedule at once.' + CONFIRM,
            inputSchema: updateTimeRangeSchema,
        },
        wrapToolHandler(
            'omada_updateTimeRange',
            async ({ profile, windows: w, invertWindows: invert, name, siteId }: z.infer<typeof updateTimeRangeSchema>) =>
                toToolResult(await ac.updateTimeRange(profile, w, { name, invert, siteId })),
            Permission.CONFIGURE
        )
    );

    server.registerTool(
        'omada_deleteTimeRange',
        { description: 'Delete a time-range profile. Refused while a gateway ACL uses it.' + CONFIRM, inputSchema: deleteTimeRangeSchema },
        wrapToolHandler(
            'omada_deleteTimeRange',
            async ({ profile, siteId }: z.infer<typeof deleteTimeRangeSchema>) => toToolResult(await ac.deleteTimeRange(profile, siteId)),
            Permission.CONFIGURE
        )
    );

    server.registerTool(
        'omada_createGroup',
        {
            description:
                'Create an IP group (source or destination of gateway ACL rules) or a MAC group (SSID allow/deny list). ' +
                'Edit MAC group entries with omada_setMacGroupEntry.',
            inputSchema: createGroupSchema,
        },
        wrapToolHandler(
            'omada_createGroup',
            async ({ name, type, ips, macs, siteId }: z.infer<typeof createGroupSchema>) =>
                toToolResult(await ac.createGroup(type === 'ip' ? { name, type, ips: ips ?? [] } : { name, type, macs: macs ?? [] }, siteId)),
            Permission.CONFIGURE
        )
    );

    server.registerTool(
        'omada_deleteGroup',
        {
            description: 'Delete an IP or MAC group. Refused for built-in groups and while a gateway ACL or an SSID MAC filter uses it.' + CONFIRM,
            inputSchema: deleteGroupSchema,
        },
        wrapToolHandler(
            'omada_deleteGroup',
            async ({ group, type, siteId }: z.infer<typeof deleteGroupSchema>) => toToolResult(await ac.deleteGroup(group, type, siteId)),
            Permission.CONFIGURE
        )
    );

    server.registerTool(
        'omada_setDhcpReservation',
        {
            description:
                'Reserve a fixed IP for a device (creates or changes the reservation), e.g. so a gateway ACL can match it by IP. ' +
                'The device moves to the address at its next DHCP renewal.' +
                CONFIRM,
            inputSchema: setDhcpReservationSchema,
        },
        wrapToolHandler(
            'omada_setDhcpReservation',
            async ({ clientMac, ip, description, siteId }: z.infer<typeof setDhcpReservationSchema>) =>
                toToolResult(await ac.setDhcpReservation(clientMac, ip, description, siteId)),
            Permission.CONFIGURE
        )
    );

    server.registerTool(
        'omada_removeDhcpReservation',
        { description: "Remove a device's DHCP reservation." + CONFIRM, inputSchema: removeDhcpReservationSchema },
        wrapToolHandler(
            'omada_removeDhcpReservation',
            async ({ clientMac, siteId }: z.infer<typeof removeDhcpReservationSchema>) => toToolResult(await ac.removeDhcpReservation(clientMac, siteId)),
            Permission.CONFIGURE
        )
    );

    server.registerTool(
        'omada_createGatewayAcl',
        {
            description:
                'Create a gateway (router) ACL rule for LAN to internet traffic: allow or deny a source (IP group, LAN network or SSID) ' +
                'to a destination (default everything), optionally only during a time range. Covers wired and wireless. ' +
                'Rules are evaluated in order (see omada_moveGatewayAcl).' +
                CONFIRM,
            inputSchema: createGatewayAclSchema,
        },
        wrapToolHandler(
            'omada_createGatewayAcl',
            async ({ siteId, ...input }: z.infer<typeof createGatewayAclSchema>) => toToolResult(await ac.createGatewayAcl(input, siteId)),
            Permission.CONFIGURE
        )
    );

    server.registerTool(
        'omada_updateGatewayAcl',
        {
            description:
                'Change a gateway ACL rule: enable/disable it, its policy, source, destination, protocols, description or schedule ' +
                '(timeRange null = always).' +
                CONFIRM,
            inputSchema: updateGatewayAclSchema,
        },
        wrapToolHandler(
            'omada_updateGatewayAcl',
            async ({ acl, siteId, ...changes }: z.infer<typeof updateGatewayAclSchema>) => toToolResult(await ac.updateGatewayAcl(acl, changes, siteId)),
            Permission.CONFIGURE
        )
    );

    server.registerTool(
        'omada_deleteGatewayAcl',
        { description: 'Delete a gateway ACL rule.' + CONFIRM, inputSchema: deleteGatewayAclSchema },
        wrapToolHandler(
            'omada_deleteGatewayAcl',
            async ({ acl, siteId }: z.infer<typeof deleteGatewayAclSchema>) => toToolResult(await ac.deleteGatewayAcl(acl, siteId)),
            Permission.CONFIGURE
        )
    );

    server.registerTool(
        'omada_moveGatewayAcl',
        {
            description: 'Move a gateway ACL rule to a position (1 = evaluated first); the other rules keep their order.' + CONFIRM,
            inputSchema: moveGatewayAclSchema,
        },
        wrapToolHandler(
            'omada_moveGatewayAcl',
            async ({ acl, position, siteId }: z.infer<typeof moveGatewayAclSchema>) => toToolResult(await ac.moveGatewayAcl(acl, position, siteId)),
            Permission.CONFIGURE
        )
    );

    server.registerTool(
        'omada_setSsidMacFilter',
        {
            description:
                "Turn an SSID's MAC filter on (a MAC group as allow or deny list) or off. Lists the connected clients the change would " +
                'disconnect and refuses then unless allowLockout; use dryRun first.' +
                CONFIRM,
            inputSchema: setSsidMacFilterSchema,
        },
        wrapToolHandler(
            'omada_setSsidMacFilter',
            async ({ ssid, enabled, policy, group, dryRun, allowLockout, siteId }: z.infer<typeof setSsidMacFilterSchema>) =>
                toToolResult(await ac.setSsidMacFilter(ssid, { enabled, policy, group }, { dryRun, allowLockout, siteId })),
            Permission.CONFIGURE
        )
    );

    return mode === 'eager' ? 13 : 12;
}
