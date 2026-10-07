import type { OmadaApiResponse } from '../types/index.js';

import { formatMac, normalizeMac } from './client.js';
import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

/** Omada group profile type for MAC groups (0 IP, 1 IP-port, 2 MAC, 3 IPv6, 4 IPv6-port). */
export const MAC_GROUP_TYPE = 2;

export interface MacGroupEntry {
    ruleId?: number;
    name: string;
    macAddress: string;
}

/** A MAC group profile (Settings > Profiles > Groups > MAC Group), usable as an SSID allow or deny list. */
export interface MacGroup {
    groupId: string;
    name: string;
    type: number;
    count?: number;
    buildIn?: boolean;
    macAddressList?: MacGroupEntry[];
    [field: string]: unknown;
}

export interface MacGroupChange {
    group: { groupId: string; name: string };
    mac: string;
    action: 'added' | 'renamed' | 'unchanged' | 'removed' | 'not-present';
    entries: { before: number; after: number };
}

/**
 * MAC group profiles. Omada modifies a group as a whole (PATCH replaces the entry
 * list), so adding, renaming or removing one entry is a read-modify-write. The
 * group is re-read just before the write and the change is refused if anything
 * else in it moved in the meantime (an outside writer, e.g. the web UI). Changes
 * made through this server are serialized per site and group, so two concurrent
 * calls cannot both pass that check and overwrite each other.
 *
 * Accepted limit: Omada offers no conditional update, so an outside edit to the
 * same group landing between that last read and the PATCH is overwritten.
 */
export class MacGroupOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string
    ) {}

    /** OperationId: getGroupProfileListByType (type 2 = MAC group) */
    public async listMacGroups(siteId?: string): Promise<MacGroup[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const response = await this.request.get<OmadaApiResponse<MacGroup[]>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/profiles/groups/${MAC_GROUP_TYPE}`)
        );
        return this.request.ensureSuccess(response) ?? [];
    }

    /** Add an entry, or rename it if the MAC is already in the group. */
    public async setMacGroupEntry(group: string, clientMac: string, name: string, siteId?: string): Promise<MacGroupChange> {
        const mac = formatMac(clientMac);
        const entryName = name.trim();
        if (entryName.length < 1 || entryName.length > 128) {
            throw new Error('Entry name must be 1 to 128 characters');
        }
        return await this.modify(group, siteId, mac, (entries) => {
            const index = entries.findIndex((e) => normalizeMac(e.macAddress) === normalizeMac(mac));
            if (index < 0) return { entries: [...entries, { name: entryName, macAddress: mac }], action: 'added' };
            if (entries[index].name === entryName) return { entries, action: 'unchanged' };
            const next = [...entries];
            next[index] = { ...entries[index], name: entryName };
            return { entries: next, action: 'renamed' };
        });
    }

    /** Remove the entry for a MAC from the group. */
    public async removeMacGroupEntry(group: string, clientMac: string, siteId?: string): Promise<MacGroupChange> {
        const mac = formatMac(clientMac);
        return await this.modify(group, siteId, mac, (entries) => {
            const next = entries.filter((e) => normalizeMac(e.macAddress) !== normalizeMac(mac));
            return next.length === entries.length ? { entries, action: 'not-present' } : { entries: next, action: 'removed' };
        });
    }

    /** Find a MAC group by id or (case-insensitive) name. */
    public resolveGroup(groups: MacGroup[], group: string): MacGroup {
        const byId = groups.find((g) => g.groupId === group);
        if (byId) return byId;
        const wanted = group.trim().toLowerCase();
        const byName = groups.filter((g) => g.name.toLowerCase() === wanted);
        if (byName.length === 1) return byName[0];
        if (byName.length > 1) throw new Error(`Several MAC groups are named '${group}'; use its groupId`);
        throw new Error(`MAC group '${group}' not found. Available: ${groups.map((g) => `${g.name} (${g.groupId})`).join(', ') || '(none)'}`);
    }

    private async modify(
        group: string,
        siteId: string | undefined,
        mac: string,
        change: (entries: MacGroupEntry[]) => { entries: MacGroupEntry[]; action: MacGroupChange['action'] }
    ): Promise<MacGroupChange> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        // Resolve once to find the lock key; everything after runs under the lock.
        const groupId = this.resolveGroup(await this.listMacGroups(resolvedSiteId), group).groupId;
        return await serialize(`${resolvedSiteId}/${groupId}`, () => this.modifyLocked(resolvedSiteId, groupId, mac, change));
    }

    private async modifyLocked(
        resolvedSiteId: string,
        groupId: string,
        mac: string,
        change: (entries: MacGroupEntry[]) => { entries: MacGroupEntry[]; action: MacGroupChange['action'] }
    ): Promise<MacGroupChange> {
        const target = this.resolveGroup(await this.listMacGroups(resolvedSiteId), groupId);
        if (target.buildIn) {
            throw new Error(`MAC group '${target.name}' is built in and cannot be modified`);
        }
        const before = target.macAddressList ?? [];
        const { entries, action } = change(before);
        const result: MacGroupChange = {
            group: { groupId: target.groupId, name: target.name },
            mac,
            action,
            entries: { before: before.length, after: entries.length },
        };
        if (action === 'unchanged' || action === 'not-present') {
            return result;
        }

        // Re-read right before writing; refuse if the group changed in between.
        const latest = this.resolveGroup(await this.listMacGroups(resolvedSiteId), target.groupId);
        if (latest.name !== target.name || JSON.stringify(entryKey(latest.macAddressList ?? [])) !== JSON.stringify(entryKey(before))) {
            throw new Error(`MAC group '${target.name}' changed while preparing the update; nothing was written. Try again.`);
        }

        const response = await this.request.patch<OmadaApiResponse<unknown>>(
            this.buildPath(
                `/sites/${encodeURIComponent(resolvedSiteId)}/profiles/groups/${MAC_GROUP_TYPE}/${encodeURIComponent(target.groupId)}`
            ),
            {
                name: target.name,
                type: MAC_GROUP_TYPE,
                macAddressList: entries.map((e) => ({ name: e.name, macAddress: formatMac(e.macAddress) })),
            }
        );
        this.request.ensureSuccess(response);
        return result;
    }
}

const locks = new Map<string, Promise<unknown>>();

/** Run `task` after every earlier task with the same key has settled. */
async function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
        () => undefined,
        () => undefined
    );
    locks.set(key, settled);
    try {
        return await run;
    } finally {
        if (locks.get(key) === settled) locks.delete(key);
    }
}

/** Comparable form of an entry list (order, names and normalized MACs). */
function entryKey(entries: MacGroupEntry[]): Array<[string, string]> {
    return entries.map((e) => [normalizeMac(e.macAddress), e.name]);
}
