/**
 * One-call diagnosis of why a client (by MAC) cannot get onto the network,
 * across everything Omada's Open API exposes: active and known clients, block
 * state, MAC group membership and the SSID allow/deny lists using those groups,
 * the site MAC filter, IP-MAC binding, DHCP reservations and (for ADMIN callers)
 * the audit log. Read-only.
 *
 * One known blind spot motivates the audit check: a block can survive in a
 * per-device config entry (site backup: clientSetting.clientConfigs, blockEnable
 * true) after the client record is gone. No API endpoint shows it; the trace it
 * leaves is "<MAC> failed to block/unblock/delete" in the audit log.
 */

import type { KnownClient } from './client.js';
import { formatMac, normalizeMac } from './client.js';
import type { OmadaClient } from './index.js';
import type { MacGroup } from './macGroups.js';
import { OmadaApiError } from './request.js';
import { logger } from '../utils/logger.js';

export type FindingLevel = 'blocks' | 'warning' | 'info';

export interface Finding {
    level: FindingLevel;
    message: string;
}

export interface SsidFilterView {
    ssid: string;
    ssidId: string;
    wlanId: string;
    macFilterEnabled: boolean;
    policy?: 'allow' | 'deny';
    group?: string;
    groupId?: string;
    containsMac?: boolean;
}

export interface ClientDiagnosis {
    mac: string;
    active?: { name?: string; ip?: string; ssid?: string; wireless?: boolean; blocked?: boolean };
    known?: { name?: string; block?: boolean; lastSeen?: string };
    macGroups: Array<{ group: string; groupId: string; entryName: string }>;
    ssidFilters: SsidFilterView[];
    siteMacFilter?: { inAllowList: boolean; inDenyList: boolean };
    ipMacBinding: boolean;
    dhcpReservation: boolean;
    auditEntries?: string[];
    unavailable: string[];
    verdict: Finding[];
}

const ORPHAN_AUDIT = /failed to (block|unblock|delete)/i;

export async function diagnoseClient(
    client: OmadaClient,
    clientMac: string,
    options: { siteId?: string; includeAudit?: boolean } = {}
): Promise<ClientDiagnosis> {
    const mac = formatMac(clientMac);
    const hex = normalizeMac(mac);
    const same = (value: unknown): boolean => typeof value === 'string' && normalizeMac(value) === hex;
    const { siteId } = options;
    const unavailable: string[] = [];
    const attempt = async <T>(what: string, read: () => Promise<T>): Promise<T | undefined> => {
        try {
            return await read();
        } catch (error) {
            // Only the source and Omada's errorCode, in the response and in the log:
            // the error text can carry internal hostnames, tokens or auth headers.
            const errorCode = error instanceof OmadaApiError ? error.errorCode : undefined;
            logger.warn('omada_diagnoseClient: source unavailable', { source: what, errorCode, errorType: error instanceof Error ? error.name : typeof error });
            const code = errorCode !== undefined ? ` (Omada errorCode ${errorCode})` : '';
            unavailable.push(`${what}: read failed${code}`);
            return undefined;
        }
    };
    const rows = (value: unknown): Array<Record<string, unknown>> => {
        const list = Array.isArray(value) ? value : (value as { data?: unknown } | undefined)?.data;
        return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
    };
    const page = (pathTemplate: string, query?: Record<string, unknown>) =>
        client.readResource({ pathTemplate, siteId, paginated: true, page: 1, pageSize: 1000, query });

    const result: ClientDiagnosis = { mac, macGroups: [], ssidFilters: [], ipMacBinding: false, dhcpReservation: false, unavailable, verdict: [] };

    const active = (await attempt('active clients', () => client.listClients(siteId)))?.find((c) => same(c.mac)) as
        | (Record<string, unknown> & { mac: string })
        | undefined;
    if (active) {
        result.active = {
            name: active.name as string | undefined,
            ip: active.ip as string | undefined,
            ssid: active.ssid as string | undefined,
            wireless: active.wireless as boolean | undefined,
            blocked: (active.blocked ?? active.block) as boolean | undefined,
        };
    }

    const known = (await attempt('known clients', () => client.listKnownClients(siteId)))?.find((c: KnownClient) => same(c.mac));
    if (known) {
        result.known = {
            name: known.name,
            block: known.block,
            lastSeen: typeof known.lastSeen === 'number' ? new Date(known.lastSeen).toISOString() : undefined,
        };
    }

    const groups: MacGroup[] = (await attempt('MAC groups', () => client.listMacGroups(siteId))) ?? [];
    for (const group of groups) {
        const entry = (group.macAddressList ?? []).find((e) => same(e.macAddress));
        if (entry) result.macGroups.push({ group: group.name, groupId: group.groupId, entryName: entry.name });
    }

    result.ssidFilters = await listSsidMacFilters(client, groups, siteId, attempt, same);

    const allow = rows(await attempt('site MAC filter (allow)', () => page('/sites/{siteId}/mac-filters/allow')));
    const deny = rows(await attempt('site MAC filter (deny)', () => page('/sites/{siteId}/mac-filters/deny')));
    const inList = (list: Array<Record<string, unknown>>) => list.some((r) => Object.values(r).some(same));
    result.siteMacFilter = { inAllowList: inList(allow), inDenyList: inList(deny) };
    result.ipMacBinding = inList(rows(await attempt('IP-MAC binding', () => page('/sites/{siteId}/ip-mac-binds'))));
    result.dhcpReservation = inList(rows(await attempt('DHCP reservations', () => page('/sites/{siteId}/setting/service/dhcp'))));

    if (options.includeAudit) {
        const terms = [mac, ...(result.known?.name ? [result.known.name] : []), ...(result.active?.name ? [result.active.name] : [])];
        const lines = new Map<number, string>();
        for (const searchKey of [...new Set(terms)]) {
            for (const entry of rows(await attempt(`audit log (${searchKey})`, () => page('/sites/{siteId}/audit-logs', { searchKey })))) {
                if (typeof entry.time === 'number' && typeof entry.content === 'string') lines.set(entry.time, entry.content);
            }
        }
        result.auditEntries = [...lines.entries()]
            .sort((a, b) => b[0] - a[0])
            .slice(0, 20)
            .map(([time, content]) => `${new Date(time).toISOString()} ${content}`);
    }

    result.verdict = verdict(result, options.includeAudit === true);
    return result;
}

/**
 * Each SSID with its MAC filter setting (allow/deny list and the MAC group it
 * uses). With `same`, also whether that group contains a given MAC.
 */
export async function listSsidMacFilters(
    client: OmadaClient,
    groups: MacGroup[],
    siteId?: string,
    attempt: <T>(what: string, read: () => Promise<T>) => Promise<T | undefined> = async (_what, read) => await read(),
    same?: (value: unknown) => boolean
): Promise<SsidFilterView[]> {
    const rows = (value: unknown): Array<Record<string, unknown>> => {
        const list = Array.isArray(value) ? value : (value as { data?: unknown } | undefined)?.data;
        return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
    };
    const views: SsidFilterView[] = [];
    for (const wlan of rows(await attempt('WLAN groups', () => client.getWlanGroupList(siteId)))) {
        const wlanId = String(wlan.wlanId ?? '');
        if (!wlanId) continue;
        for (const ssid of rows(await attempt(`SSIDs of WLAN ${wlanId}`, () => client.getSsidList(wlanId, siteId)))) {
            const ssidId = String(ssid.ssidId ?? ssid.id ?? '');
            if (!ssidId) continue;
            const detail = (await attempt(`SSID ${String(ssid.name ?? ssidId)}`, () => client.getSsidDetail(wlanId, ssidId, siteId))) as
                | { name?: string; macFilter?: { macFilterEnable?: boolean; policy?: number; macFilterId?: string } }
                | undefined;
            const filter = detail?.macFilter;
            const view: SsidFilterView = { ssid: String(detail?.name ?? ssid.name ?? ssidId), ssidId, wlanId, macFilterEnabled: filter?.macFilterEnable === true };
            if (filter?.macFilterEnable) {
                view.policy = filter.policy === 1 ? 'allow' : 'deny';
                const group = groups.find((g) => g.groupId === filter.macFilterId);
                view.group = group?.name ?? filter.macFilterId;
                view.groupId = filter.macFilterId;
                if (same) view.containsMac = group ? (group.macAddressList ?? []).some((e) => same(e.macAddress)) : undefined;
            }
            views.push(view);
        }
    }
    return views;
}

function verdict(d: ClientDiagnosis, auditChecked: boolean): Finding[] {
    const findings: Finding[] = [];
    if (d.active?.blocked || d.known?.block) {
        findings.push({ level: 'blocks', message: 'Blocked in Omada. Use omada_unblockClient.' });
    }
    for (const s of d.ssidFilters.filter((f) => f.macFilterEnabled)) {
        if (s.policy === 'allow' && s.containsMac === false) {
            findings.push({ level: 'blocks', message: `Not on the allow list '${s.group}' of SSID ${s.ssid}: it cannot join that SSID. Add it with omada_setMacGroupEntry.` });
        } else if (s.policy === 'deny' && s.containsMac === true) {
            findings.push({ level: 'blocks', message: `On the deny list '${s.group}' of SSID ${s.ssid}. Remove it with omada_removeMacGroupEntry.` });
        } else if (s.containsMac === undefined) {
            findings.push({ level: 'warning', message: `SSID ${s.ssid} filters by MAC group ${s.group}, which could not be read.` });
        }
    }
    if (d.siteMacFilter?.inDenyList) {
        findings.push({ level: 'warning', message: 'Listed in the site MAC filter deny list (applies if the site MAC filter is enabled).' });
    }
    const orphanTrace = (d.auditEntries ?? []).some((line) => ORPHAN_AUDIT.test(line) && line.toUpperCase().includes(d.mac));
    if (!d.active && !d.known && orphanTrace) {
        findings.push({
            level: 'blocks',
            message:
                'Orphaned block suspected: Omada has no record of this client, but its audit log shows failed block/unblock/delete by MAC. ' +
                'The block lives in a per-device config entry (site backup: clientSetting.clientConfigs with blockEnable true) that no API exposes. ' +
                'Proven fix: Site Backup, remove that entry from the backup, Site Restore.',
        });
    }
    if (!d.active && !d.known && !auditChecked) {
        findings.push({ level: 'info', message: 'Omada has no record of this client. The audit log was not checked (needs ADMIN), so an orphaned block cannot be ruled out.' });
    }
    if (findings.length === 0) {
        findings.push({ level: 'info', message: d.active ? 'Connected; nothing in Omada restricts it.' : 'Nothing that Omada exposes restricts this client.' });
    }
    if (d.unavailable.length > 0) {
        findings.push({ level: 'info', message: `Some sources could not be read (${d.unavailable.length}); see "unavailable".` });
    }
    return findings;
}
