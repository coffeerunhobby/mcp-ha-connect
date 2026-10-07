import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { diagnoseClient, listSsidMacFilters } from '../../omadaClient/diagnose.js';
import type { OmadaClient } from '../../omadaClient/index.js';
import { Permission, hasPermission } from '../../permissions/index.js';
import { getCallerPermissions, siteInputSchema, toToolResult, wrapToolHandler, type ToolExtra } from '../common.js';

const macSchema = z.string().min(1, 'clientMac (MAC address) is required').describe('Client MAC, e.g. 02-1A-2B-3C-4D-5E');
const groupSchema = z.string().min(1).describe('MAC group name or groupId (see omada_listMacGroups)');

export const diagnoseClientSchema = z.object({ clientMac: macSchema, siteId: z.string().min(1).optional() });
export const setMacGroupEntrySchema = z.object({
    group: groupSchema,
    clientMac: macSchema,
    name: z.string().min(1).max(128).describe('Entry name shown in Omada (1-128 characters)'),
    siteId: z.string().min(1).optional(),
});
export const removeMacGroupEntrySchema = z.object({ group: groupSchema, clientMac: macSchema, siteId: z.string().min(1).optional() });

export function registerOmadaClientDiagnosticTools(server: McpServer, client: OmadaClient, mode: 'eager' | 'graph' = 'eager'): number {
    server.registerTool(
        'omada_diagnoseClient',
        {
            description:
                'Explain why a device (by MAC) cannot get onto the network: active/known client and block state, MAC group membership and the SSID ' +
                'allow/deny lists using those groups, site MAC filter, IP-MAC binding, DHCP reservation, and (for ADMIN callers) the audit log, ' +
                'with a verdict. Detects an orphaned block that Omada no longer lists. Read-only.',
            inputSchema: diagnoseClientSchema,
        },
        wrapToolHandler(
            'omada_diagnoseClient',
            async ({ clientMac, siteId }: z.infer<typeof diagnoseClientSchema>, extra: ToolExtra) =>
                toToolResult(
                    await diagnoseClient(client, clientMac, {
                        siteId,
                        // The audit log is ADMIN-only in this server's RBAC.
                        includeAudit: hasPermission(getCallerPermissions(extra), Permission.ADMIN),
                    })
                ),
            Permission.QUERY
        )
    );

    // In graph mode plain reads go through omada_read (/profiles/mac-groups).
    if (mode === 'eager') {
        server.registerTool(
            'omada_listMacGroups',
            {
                description: 'List MAC group profiles (usable as SSID allow or deny lists) with their entries, and which SSIDs use each group and how.',
                inputSchema: siteInputSchema,
            },
            wrapToolHandler(
                'omada_listMacGroups',
                async ({ siteId }: { siteId?: string }) => {
                    const groups = await client.listMacGroups(siteId);
                    const filters = await listSsidMacFilters(client, groups, siteId);
                    return toToolResult(
                        groups.map((g) => ({
                            groupId: g.groupId,
                            name: g.name,
                            builtIn: g.buildIn === true,
                            entries: (g.macAddressList ?? []).map((e) => ({ name: e.name, mac: e.macAddress })),
                            usedBy: filters
                                .filter((f) => f.groupId === g.groupId)
                                .map((f) => ({ ssid: f.ssid, policy: f.policy, enabled: f.macFilterEnabled })),
                        }))
                    );
                },
                Permission.QUERY
            )
        );
    }

    server.registerTool(
        'omada_setMacGroupEntry',
        {
            description:
                'Add a MAC to a MAC group, or rename its entry if it is already there. If the group is an SSID allow list, the device can join that ' +
                'SSID afterwards; if it is a deny list, the device is shut out. Omada rewrites the whole group, so do not run this while someone edits ' +
                'the same group in the web UI. Confirm with the user before applying.',
            inputSchema: setMacGroupEntrySchema,
        },
        wrapToolHandler(
            'omada_setMacGroupEntry',
            async ({ group, clientMac, name, siteId }: z.infer<typeof setMacGroupEntrySchema>) =>
                toToolResult(await withUsage(client, await client.setMacGroupEntry(group, clientMac, name, siteId), siteId)),
            Permission.CONFIGURE
        )
    );

    server.registerTool(
        'omada_removeMacGroupEntry',
        {
            description:
                'Remove a MAC from a MAC group. If the group is the active allow list of an SSID, that device can no longer join it. ' +
                'Omada rewrites the whole group, so do not run this while someone edits the same group in the web UI. Confirm with the user before applying.',
            inputSchema: removeMacGroupEntrySchema,
        },
        wrapToolHandler(
            'omada_removeMacGroupEntry',
            async ({ group, clientMac, siteId }: z.infer<typeof removeMacGroupEntrySchema>) =>
                toToolResult(await withUsage(client, await client.removeMacGroupEntry(group, clientMac, siteId), siteId)),
            Permission.CONFIGURE
        )
    );

    return mode === 'eager' ? 4 : 3;
}

/** Add what the change means for each SSID using that group as a filter. */
async function withUsage<T extends { group: { groupId: string }; action: string }>(client: OmadaClient, change: T, siteId?: string) {
    try {
        const filters = (await listSsidMacFilters(client, await client.listMacGroups(siteId), siteId)).filter(
            (f) => f.groupId === change.group.groupId && f.macFilterEnabled
        );
        // Effects follow membership after the change: 'not-present' means the MAC was never in the group.
        const member = change.action !== 'removed' && change.action !== 'not-present';
        const removed = change.action === 'removed';
        const effects = filters.map((f) => {
            if (f.policy === 'allow') {
                return `${f.ssid}: allow list, so the device ${member ? 'can join' : removed ? 'can no longer join' : 'is not on it and cannot join'}`;
            }
            return `${f.ssid}: deny list, so the device ${member ? 'is shut out' : removed ? 'is no longer shut out' : 'is not on it and is not shut out by it'}`;
        });
        return { ...change, effects: effects.length ? effects : ['No SSID currently filters by this group.'] };
    } catch {
        return { ...change, effects: ['Could not read which SSIDs use this group.'] };
    }
}
