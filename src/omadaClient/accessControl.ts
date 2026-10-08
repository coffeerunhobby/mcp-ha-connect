/**
 * Controller-side access control: time-range profiles, IP/MAC group profiles,
 * DHCP reservations, gateway ACL rules and the SSID MAC filter. These let a
 * schedule (e.g. a curfew) be enforced by the controller itself instead of a
 * daily block/unblock loop.
 *
 * Omada's create endpoints return no id, so new objects are found again by
 * their (required unique) name or description. Deletes refuse objects that are
 * still in use, and the SSID MAC filter refuses to lock out connected clients
 * unless told to.
 */

import type { OmadaApiResponse, OmadaClientInfo } from '../types/index.js';

import type { ClientOperations } from './client.js';
import { formatMac, normalizeMac } from './client.js';
import type { MacGroup, MacGroupOperations } from './macGroups.js';
import { MAC_GROUP_TYPE } from './macGroups.js';
import type { NetworkOperations } from './network.js';
import { ALWAYS_PROFILE_NAME } from './network.js';
import type { RequestHandler } from './request.js';
import { accessControlLockKey, serialize } from './serialize.js';
import type { SiteOperations } from './site.js';
import { buildTimeRange, describeTimeRange, type TimeRangeEntry, type TimeWindow } from './timeRange.js';

export const IP_GROUP_TYPE = 0;
const SWITCH_ACL_PAGE_SIZE = 50;
/** WLAN group id under which Omada lists every SSID a second time (no SSID detail there). */
const PSEUDO_WLAN_ID = 'gateway';
/** All protocols, in Omada's ACL protocol numbering. */
export const ALL_PROTOCOLS = 256;

const SOURCE_TYPES = { network: 0, ipGroup: 1, ssid: 4 } as const;
const DESTINATION_TYPES = { network: 0, ipGroup: 1 } as const;
export type AclSourceType = keyof typeof SOURCE_TYPES;
export type AclDestinationType = keyof typeof DESTINATION_TYPES;

export interface TimeRangeProfile {
    profileId: string;
    name: string;
    dayMode?: number;
    timeList?: TimeRangeEntry[];
    [field: string]: unknown;
}

export interface IpGroup {
    groupId: string;
    name: string;
    buildIn?: boolean;
    ipList?: Array<{ ip: string; mask: number; description?: string }>;
    [field: string]: unknown;
}

export interface DhcpReservation {
    netId: string;
    mac: string;
    ip?: string;
    description?: string;
    status?: boolean;
    options?: unknown[];
    [field: string]: unknown;
}

export interface GatewayAcl {
    id: string;
    index?: number;
    description: string;
    status: boolean;
    policy: number;
    protocols: number[];
    sourceType: number;
    sourceIds: string[];
    destinationType: number;
    destinationIds?: string[];
    syslog?: boolean;
    direction?: { lanToWan: boolean; lanToLan: boolean; wanInIds: string[]; vpnInIds: string[] };
    stateMode?: number;
    states?: unknown;
    timeRangeId?: string;
    [field: string]: unknown;
}

export interface GatewayAclInput {
    description: string;
    policy: 'allow' | 'deny';
    source: { type: AclSourceType; ids: string[] };
    /** Default: the built-in IP group IPGroup_Any (everything). */
    destination?: { type: AclDestinationType; ids: string[] };
    protocols?: number[];
    /** Time-range profile (id or name) during which the rule applies; omitted = always. */
    timeRange?: string;
    enabled?: boolean;
}

export interface GatewayAclChanges {
    description?: string;
    policy?: 'allow' | 'deny';
    source?: { type: AclSourceType; ids: string[] };
    destination?: { type: AclDestinationType; ids: string[] };
    protocols?: number[];
    /** Profile id or name; null removes the schedule (rule always applies). */
    timeRange?: string | null;
    enabled?: boolean;
}

export interface SsidMacFilterChange {
    ssid: string;
    ssidId: string;
    before: { enabled: boolean; policy?: 'allow' | 'deny'; group?: string };
    after: { enabled: boolean; policy?: 'allow' | 'deny'; group?: string };
    /** Currently connected clients of this SSID the new setting would cut off. */
    wouldLockOut: Array<{ mac: string; name?: string }>;
    applied: boolean;
}

export class AccessControlOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string,
        private readonly network: NetworkOperations,
        private readonly macGroups: MacGroupOperations,
        private readonly clients: ClientOperations
    ) {}

    // Writes are serialized per site, together with MAC group edits: Omada replaces
    // whole objects, and objects reference each other (a rule its time range and
    // groups, an SSID filter its MAC group), so no two changes may interleave.

    public createTimeRange(...a: Parameters<AccessControlOperations['createTimeRangeUnlocked']>) {
        return this.locked(a[2]?.siteId, () => this.createTimeRangeUnlocked(...a));
    }
    public updateTimeRange(...a: Parameters<AccessControlOperations['updateTimeRangeUnlocked']>) {
        return this.locked(a[2]?.siteId, () => this.updateTimeRangeUnlocked(...a));
    }
    public deleteTimeRange(...a: Parameters<AccessControlOperations['deleteTimeRangeUnlocked']>) {
        return this.locked(a[1], () => this.deleteTimeRangeUnlocked(...a));
    }
    public createGroup(...a: Parameters<AccessControlOperations['createGroupUnlocked']>) {
        return this.locked(a[1], () => this.createGroupUnlocked(...a));
    }
    public deleteGroup(...a: Parameters<AccessControlOperations['deleteGroupUnlocked']>) {
        return this.locked(a[2], () => this.deleteGroupUnlocked(...a));
    }
    public setDhcpReservation(...a: Parameters<AccessControlOperations['setDhcpReservationUnlocked']>) {
        return this.locked(a[3], () => this.setDhcpReservationUnlocked(...a));
    }
    public removeDhcpReservation(...a: Parameters<AccessControlOperations['removeDhcpReservationUnlocked']>) {
        return this.locked(a[1], () => this.removeDhcpReservationUnlocked(...a));
    }
    public createGatewayAcl(...a: Parameters<AccessControlOperations['createGatewayAclUnlocked']>) {
        return this.locked(a[1], () => this.createGatewayAclUnlocked(...a));
    }
    public updateGatewayAcl(...a: Parameters<AccessControlOperations['updateGatewayAclUnlocked']>) {
        return this.locked(a[2], () => this.updateGatewayAclUnlocked(...a));
    }
    public deleteGatewayAcl(...a: Parameters<AccessControlOperations['deleteGatewayAclUnlocked']>) {
        return this.locked(a[1], () => this.deleteGatewayAclUnlocked(...a));
    }
    public moveGatewayAcl(...a: Parameters<AccessControlOperations['moveGatewayAclUnlocked']>) {
        return this.locked(a[2], () => this.moveGatewayAclUnlocked(...a));
    }
    public setSsidMacFilter(...a: Parameters<AccessControlOperations['setSsidMacFilterUnlocked']>) {
        return this.locked(a[2]?.siteId, () => this.setSsidMacFilterUnlocked(...a));
    }

    private locked<T>(siteId: string | undefined, task: () => Promise<T>): Promise<T> {
        return serialize(accessControlLockKey(this.site.resolveSiteId(siteId)), task);
    }

    private sitePath(siteId: string, path: string): string {
        return this.buildPath(`/sites/${encodeURIComponent(siteId)}${path}`);
    }

    private async send(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, data?: unknown): Promise<void> {
        this.request.ensureSuccess(await this.request.request<OmadaApiResponse<unknown>>({ method, url, data }));
    }

    // ---- time-range profiles ------------------------------------------------

    public async listTimeRanges(siteId?: string): Promise<Array<TimeRangeProfile & { windows: string[] }>> {
        const resolved = this.site.resolveSiteId(siteId);
        const profiles = this.request.ensureSuccess(
            await this.request.get<OmadaApiResponse<TimeRangeProfile[]>>(this.sitePath(resolved, '/time-range-profiles'))
        );
        return (profiles ?? []).map((p) => ({ ...p, windows: describeTimeRange(p) }));
    }

    private async createTimeRangeUnlocked(name: string, windows: TimeWindow[], options: { invert?: boolean; siteId?: string } = {}) {
        const resolved = this.site.resolveSiteId(options.siteId);
        const body = buildTimeRange(checkTimeRangeName(name), windows, options.invert);
        if ((await this.listTimeRanges(resolved)).some((p) => p.name === body.name)) {
            throw new Error(`A time range named '${body.name}' already exists; update it or pick another name`);
        }
        await this.send('POST', this.sitePath(resolved, '/time-range-profiles'), body);
        const created = (await this.listTimeRanges(resolved)).find((p) => p.name === body.name);
        if (!created) throw new Error(`Created time range '${body.name}' but could not find it again`);
        return { profileId: created.profileId, name: created.name, windows: created.windows };
    }

    private async updateTimeRangeUnlocked(profile: string, windows: TimeWindow[], options: { name?: string; invert?: boolean; siteId?: string } = {}) {
        const resolved = this.site.resolveSiteId(options.siteId);
        const current = this.resolveTimeRange(await this.listTimeRanges(resolved), profile);
        const name = options.name !== undefined ? checkTimeRangeName(options.name) : current.name;
        const body = buildTimeRange(name, windows, options.invert);
        await this.send('PUT', this.sitePath(resolved, `/time-range-profile/${encodeURIComponent(current.profileId)}`), body);
        return { profileId: current.profileId, name, before: current.windows, after: describeTimeRange(body) };
    }

    private async deleteTimeRangeUnlocked(profile: string, siteId?: string) {
        const resolved = this.site.resolveSiteId(siteId);
        const current = this.resolveTimeRange(await this.listTimeRanges(resolved), profile);
        const users = await this.timeRangeUsers(current.profileId, resolved);
        if (users.length) throw new Error(`Time range '${current.name}' is used by ${users.join(', ')}; change or delete those first`);
        await this.send('DELETE', this.sitePath(resolved, `/time-range-profile/${encodeURIComponent(current.profileId)}`));
        return { profileId: current.profileId, name: current.name, deleted: true };
    }

    /** What references a time range: gateway and switch ACL rules, SSID WLAN schedules. */
    private async timeRangeUsers(profileId: string, siteId: string): Promise<string[]> {
        const users = (await this.listGatewayAcls(siteId)).filter((a) => a.timeRangeId === profileId).map((a) => `gateway ACL '${a.description}'`);
        const switchAcls = await this.request.fetchPaginated<GatewayAcl>(this.sitePath(siteId, '/acls/osw-acls'), { pageSize: SWITCH_ACL_PAGE_SIZE });
        users.push(...switchAcls.filter((a) => a.timeRangeId === profileId).map((a) => `switch ACL '${a.description}'`));
        for (const ssid of await this.listSsids(siteId)) {
            const detail = (await this.network.getSsidDetail(ssid.wlanId, ssid.ssidId, siteId)) as { wlanSchedule?: { scheduleId?: string } };
            if (detail?.wlanSchedule?.scheduleId === profileId) users.push(`the Wi-Fi schedule of SSID ${ssid.ssidName}`);
        }
        return users;
    }

    private resolveTimeRange<T extends TimeRangeProfile>(profiles: T[], profile: string): T {
        const found = resolveByIdOrName(profiles, profile, (p) => p.profileId, (p) => p.name, 'time range');
        if (found.name === ALWAYS_PROFILE_NAME) {
            throw new Error(`Time range '${found.name}' belongs to omada_setSsidEnabled and cannot be changed here`);
        }
        return found;
    }

    // ---- group profiles -------------------------------------------------------

    public async listIpGroups(siteId?: string): Promise<IpGroup[]> {
        const resolved = this.site.resolveSiteId(siteId);
        const groups = this.request.ensureSuccess(
            await this.request.get<OmadaApiResponse<IpGroup[]>>(this.sitePath(resolved, `/profiles/groups/${IP_GROUP_TYPE}`))
        );
        return groups ?? [];
    }

    /** Create an IP group (addresses as "a.b.c.d" or "a.b.c.d/n") or a MAC group. */
    private async createGroupUnlocked(
        input: { name: string; type: 'ip'; ips: string[] } | { name: string; type: 'mac'; macs: Array<{ mac: string; name: string }> },
        siteId?: string
    ) {
        const resolved = this.site.resolveSiteId(siteId);
        const name = input.name.trim();
        if (name.length < 1 || name.length > 64) throw new Error('Group name must be 1 to 64 characters');
        const existing = input.type === 'ip' ? await this.listIpGroups(resolved) : await this.macGroups.listMacGroups(resolved);
        if (existing.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
            throw new Error(`A ${input.type.toUpperCase()} group named '${name}' already exists`);
        }
        const body =
            input.type === 'ip'
                ? { name, type: IP_GROUP_TYPE, ipList: input.ips.map(parseCidr) }
                : { name, type: MAC_GROUP_TYPE, macAddressList: input.macs.map((m) => ({ name: m.name, macAddress: formatMac(m.mac) })) };
        if ((input.type === 'ip' ? input.ips : input.macs).length === 0) throw new Error('A group needs at least one entry');
        await this.send('POST', this.sitePath(resolved, '/profiles/groups'), body);
        const after = input.type === 'ip' ? await this.listIpGroups(resolved) : await this.macGroups.listMacGroups(resolved);
        const created = after.find((g) => g.name === name);
        if (!created) throw new Error(`Created group '${name}' but could not find it again`);
        return { groupId: created.groupId, name, type: input.type, entries: input.type === 'ip' ? body.ipList : body.macAddressList };
    }

    private async deleteGroupUnlocked(group: string, type: 'ip' | 'mac', siteId?: string) {
        const resolved = this.site.resolveSiteId(siteId);
        const groups: Array<IpGroup | MacGroup> = type === 'ip' ? await this.listIpGroups(resolved) : await this.macGroups.listMacGroups(resolved);
        const target = resolveByIdOrName(groups, group, (g) => g.groupId, (g) => g.name, `${type.toUpperCase()} group`);
        if (target.buildIn || target.name === 'IPGroup_Any') throw new Error(`Group '${target.name}' is built in and cannot be deleted`);

        const users: string[] = [];
        for (const acl of await this.listGatewayAcls(resolved)) {
            const asSource = acl.sourceType === SOURCE_TYPES.ipGroup && acl.sourceIds.includes(target.groupId);
            const asDestination = acl.destinationType === DESTINATION_TYPES.ipGroup && (acl.destinationIds ?? []).includes(target.groupId);
            if (asSource || asDestination) users.push(`gateway ACL '${acl.description}'`);
        }
        if (type === 'mac') {
            for (const s of await this.listSsidFilters(resolved)) {
                if (s.filter.macFilterId === target.groupId) users.push(`the MAC filter of SSID ${s.ssidName}`);
            }
        }
        if (users.length) throw new Error(`Group '${target.name}' is used by ${users.join(', ')}; change those first`);

        const groupType = type === 'ip' ? IP_GROUP_TYPE : MAC_GROUP_TYPE;
        await this.send('DELETE', this.sitePath(resolved, `/profiles/groups/${groupType}/${encodeURIComponent(target.groupId)}`));
        return { groupId: target.groupId, name: target.name, type, deleted: true };
    }

    // ---- DHCP reservations -----------------------------------------------------

    public async listDhcpReservations(siteId?: string): Promise<DhcpReservation[]> {
        const resolved = this.site.resolveSiteId(siteId);
        return await this.request.fetchPaginated<DhcpReservation>(this.sitePath(resolved, '/setting/service/dhcp'));
    }

    /** Reserve `ip` for a MAC (create or change). The LAN network is the one whose subnet holds the IP. */
    private async setDhcpReservationUnlocked(clientMac: string, ip: string, description: string | undefined, siteId?: string) {
        const resolved = this.site.resolveSiteId(siteId);
        const mac = formatMac(clientMac);
        const address = ipToNumber(ip);
        const networks = (await this.network.getLanNetworkList(resolved)) as Array<{ id: string; name: string; gatewaySubnet?: string }>;
        const net = networks.find((n) => n.gatewaySubnet && inSubnet(address, n.gatewaySubnet));
        if (!net) {
            throw new Error(`${ip} is in no LAN network (${networks.map((n) => `${n.name} ${n.gatewaySubnet ?? '?'}`).join(', ') || 'none'})`);
        }
        const reservations = await this.listDhcpReservations(resolved);
        const clash = reservations.find((r) => r.ip === ip && normalizeMac(r.mac) !== normalizeMac(mac));
        if (clash) throw new Error(`${ip} is already reserved for ${clash.mac}${clash.description ? ` (${clash.description})` : ''}`);
        const current = reservations.find((r) => normalizeMac(r.mac) === normalizeMac(mac));
        const text = description?.trim() || current?.description;
        if (text !== undefined && text.length > 128) throw new Error('Description must be at most 128 characters');

        if (current && current.ip === ip && current.netId === net.id && current.status !== false && current.description === text) {
            return { mac, ip, network: net.name, action: 'unchanged' as const };
        }
        const body = { netId: net.id, mac, ip, description: text || undefined, status: true, options: current?.options ?? [] };
        if (current) {
            await this.send('PATCH', this.sitePath(resolved, `/setting/service/dhcp/${encodeURIComponent(mac)}`), body);
        } else {
            await this.send('POST', this.sitePath(resolved, '/setting/service/dhcp'), body);
        }
        return {
            mac,
            ip,
            network: net.name,
            action: current ? ('updated' as const) : ('created' as const),
            ...(current ? { previousIp: current.ip } : {}),
            note: 'The device gets the reserved address at its next DHCP renewal (reconnect it to apply now).',
        };
    }

    private async removeDhcpReservationUnlocked(clientMac: string, siteId?: string) {
        const resolved = this.site.resolveSiteId(siteId);
        const mac = formatMac(clientMac);
        const current = (await this.listDhcpReservations(resolved)).find((r) => normalizeMac(r.mac) === normalizeMac(mac));
        if (!current) return { mac, action: 'not-present' as const };
        await this.send('DELETE', this.sitePath(resolved, `/setting/service/dhcp/${encodeURIComponent(formatMac(current.mac))}`));
        return { mac, ip: current.ip, action: 'removed' as const };
    }

    // ---- gateway ACL -------------------------------------------------------------

    public async listGatewayAcls(siteId?: string): Promise<GatewayAcl[]> {
        const resolved = this.site.resolveSiteId(siteId);
        const acls = await this.request.fetchPaginated<GatewayAcl>(this.sitePath(resolved, '/acls/osg-acls'));
        return [...acls].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    }

    private async createGatewayAclUnlocked(input: GatewayAclInput, siteId?: string) {
        const resolved = this.site.resolveSiteId(siteId);
        const description = checkDescription(input.description);
        const existing = await this.listGatewayAcls(resolved);
        if (existing.some((a) => a.description === description)) {
            throw new Error(`A gateway ACL described '${description}' already exists; descriptions must be unique`);
        }
        const body: Record<string, unknown> = {
            description,
            status: input.enabled ?? true,
            policy: input.policy === 'allow' ? 1 : 0,
            protocols: input.protocols?.length ? input.protocols : [ALL_PROTOCOLS],
            ...(await this.resolveEndpoints(input.source, input.destination, resolved)),
            syslog: false,
            direction: { lanToWan: true, lanToLan: false, wanInIds: [], vpnInIds: [] },
            stateMode: 0,
        };
        if (input.timeRange) body.timeRangeId = await this.timeRangeId(input.timeRange, resolved);
        await this.send('POST', this.sitePath(resolved, '/acls/osg-acls'), body);
        const created = (await this.listGatewayAcls(resolved)).find((a) => a.description === description);
        if (!created) throw new Error(`Created gateway ACL '${description}' but could not find it again`);
        return await this.describeAcl(created, resolved);
    }

    private async updateGatewayAclUnlocked(acl: string, changes: GatewayAclChanges, siteId?: string) {
        const resolved = this.site.resolveSiteId(siteId);
        const acls = await this.listGatewayAcls(resolved);
        const current = resolveByIdOrName(acls, acl, (a) => a.id, (a) => a.description, 'gateway ACL');
        const description = changes.description !== undefined ? checkDescription(changes.description) : current.description;
        if (description !== current.description && acls.some((a) => a.description === description)) {
            throw new Error(`A gateway ACL described '${description}' already exists`);
        }
        const body: Record<string, unknown> = {
            description,
            status: changes.enabled ?? current.status,
            policy: changes.policy ? (changes.policy === 'allow' ? 1 : 0) : current.policy,
            protocols: changes.protocols?.length ? changes.protocols : current.protocols,
            sourceType: current.sourceType,
            sourceIds: current.sourceIds,
            destinationType: current.destinationType,
            destinationIds: current.destinationIds ?? [],
            syslog: current.syslog ?? false,
            direction: current.direction ?? { lanToWan: true, lanToLan: false, wanInIds: [], vpnInIds: [] },
            stateMode: current.stateMode ?? 0,
            ...(current.states ? { states: current.states } : {}),
        };
        if (changes.source || changes.destination) {
            const endpoints = await this.resolveEndpoints(
                changes.source ?? { type: typeName(SOURCE_TYPES, current.sourceType), ids: current.sourceIds },
                changes.destination ?? { type: typeName(DESTINATION_TYPES, current.destinationType), ids: current.destinationIds ?? [] },
                resolved
            );
            Object.assign(body, endpoints);
        }
        const timeRangeId = changes.timeRange === undefined ? current.timeRangeId : changes.timeRange === null ? undefined : await this.timeRangeId(changes.timeRange, resolved);
        if (timeRangeId) body.timeRangeId = timeRangeId;

        // Re-read right before writing; refuse if the rule changed in between (e.g. in the web UI).
        const latest = (await this.listGatewayAcls(resolved)).find((a) => a.id === current.id);
        if (!latest || JSON.stringify(latest) !== JSON.stringify(current)) {
            throw new Error(`Gateway ACL '${current.description}' changed while preparing the update; nothing was written. Try again.`);
        }
        await this.send('PUT', this.sitePath(resolved, `/acls/osg-acls/${encodeURIComponent(current.id)}`), body);
        const updated = (await this.listGatewayAcls(resolved)).find((a) => a.id === current.id) ?? { ...current, ...body };
        return await this.describeAcl(updated as GatewayAcl, resolved);
    }

    private async deleteGatewayAclUnlocked(acl: string, siteId?: string) {
        const resolved = this.site.resolveSiteId(siteId);
        const current = resolveByIdOrName(await this.listGatewayAcls(resolved), acl, (a) => a.id, (a) => a.description, 'gateway ACL');
        await this.send('DELETE', this.sitePath(resolved, `/acls/${encodeURIComponent(current.id)}`));
        return { id: current.id, description: current.description, deleted: true };
    }

    /** Move a rule to `position` (1 = evaluated first); the others keep their order. */
    private async moveGatewayAclUnlocked(acl: string, position: number, siteId?: string) {
        const resolved = this.site.resolveSiteId(siteId);
        const acls = await this.listGatewayAcls(resolved);
        const current = resolveByIdOrName(acls, acl, (a) => a.id, (a) => a.description, 'gateway ACL');
        if (!Number.isInteger(position) || position < 1 || position > acls.length) {
            throw new Error(`Position must be 1 to ${acls.length}`);
        }
        const order = acls.filter((a) => a.id !== current.id);
        order.splice(position - 1, 0, current);
        const indexes = Object.fromEntries(order.map((a, i) => [a.id, i + 1]));
        await this.send('POST', this.sitePath(resolved, '/acls/modifyIndex'), { type: 'gateway', indexes });
        return { order: order.map((a, i) => `${i + 1}. ${a.description}`) };
    }

    /** A rule with names instead of ids, for responses. */
    public async describeAcl(acl: GatewayAcl, siteId?: string) {
        const resolved = this.site.resolveSiteId(siteId);
        const names = await this.endpointNames(resolved);
        // Display only: a type these tools do not edit (e.g. an IP-port group) is shown by its number.
        const label = (type: number, ids: string[] | undefined, table: Record<string, number>) =>
            `${Object.keys(table).find((key) => table[key] === type) ?? `type ${type}`}: ${(ids ?? []).map((id) => names.get(id) ?? id).join(', ') || '(none)'}`;
        const ranges = await this.listTimeRanges(resolved);
        const range = acl.timeRangeId ? ranges.find((p) => p.profileId === acl.timeRangeId) : undefined;
        return {
            id: acl.id,
            position: acl.index,
            description: acl.description,
            enabled: acl.status,
            policy: acl.policy === 1 ? 'allow' : 'deny',
            source: label(acl.sourceType, acl.sourceIds, SOURCE_TYPES),
            destination: label(acl.destinationType, acl.destinationIds, DESTINATION_TYPES),
            schedule: acl.timeRangeId ? { profileId: acl.timeRangeId, name: range?.name, windows: range?.windows } : 'always',
        };
    }

    private async resolveEndpoints(
        source: { type: AclSourceType; ids: string[] },
        destination: { type: AclDestinationType; ids: string[] } | undefined,
        siteId: string
    ) {
        if (!(source.type in SOURCE_TYPES)) throw new Error(`Source type must be one of ${Object.keys(SOURCE_TYPES).join(', ')}`);
        if (source.ids.length === 0) throw new Error('The rule needs at least one source');
        const dest = destination ?? { type: 'ipGroup' as const, ids: ['IPGroup_Any'] };
        if (!(dest.type in DESTINATION_TYPES)) throw new Error(`Destination type must be one of ${Object.keys(DESTINATION_TYPES).join(', ')}`);
        if (dest.ids.length === 0) throw new Error('The rule needs at least one destination');
        return {
            sourceType: SOURCE_TYPES[source.type],
            sourceIds: await this.resolveIds(source.type, source.ids, siteId),
            destinationType: DESTINATION_TYPES[dest.type],
            destinationIds: await this.resolveIds(dest.type, dest.ids, siteId),
        };
    }

    /** Ids or names of IP groups, LAN networks or SSIDs -> ids. */
    private async resolveIds(type: AclSourceType, values: string[], siteId: string): Promise<string[]> {
        const candidates: Array<{ id: string; name: string }> =
            type === 'ipGroup'
                ? (await this.listIpGroups(siteId)).map((g) => ({ id: g.groupId, name: g.name }))
                : type === 'network'
                  ? ((await this.network.getLanNetworkList(siteId)) as Array<{ id: string; name: string }>).map((n) => ({ id: n.id, name: n.name }))
                  : (await this.listSsids(siteId)).map((s) => ({ id: s.ssidId, name: s.ssidName }));
        return values.map((v) => resolveByIdOrName(candidates, v, (c) => c.id, (c) => c.name, typeLabel(type)).id);
    }

    private async endpointNames(siteId: string): Promise<Map<string, string>> {
        const names = new Map<string, string>();
        const safe = async <T>(read: () => Promise<T[]>): Promise<T[]> => await read().catch(() => []);
        for (const g of await safe(() => this.listIpGroups(siteId))) names.set(g.groupId, g.name);
        for (const n of await safe(() => this.network.getLanNetworkList(siteId) as Promise<Array<{ id: string; name: string }>>)) names.set(n.id, n.name);
        for (const w of await safe(() => this.network.listAllSsids(siteId))) for (const s of w.ssidList ?? []) names.set(s.ssidId, s.ssidName);
        return names;
    }

    private async timeRangeId(profile: string, siteId: string): Promise<string> {
        return resolveByIdOrName(await this.listTimeRanges(siteId), profile, (p) => p.profileId, (p) => p.name, 'time range').profileId;
    }

    // ---- SSID MAC filter -----------------------------------------------------------

    private async listSsidFilters(siteId: string) {
        const result: Array<{ wlanId: string; ssidId: string; ssidName: string; filter: { macFilterEnable?: boolean; policy?: number; macFilterId?: string } }> = [];
        for (const s of await this.listSsids(siteId)) {
            const detail = (await this.network.getSsidDetail(s.wlanId, s.ssidId, siteId)) as { macFilter?: Record<string, unknown> };
            result.push({ ...s, filter: (detail?.macFilter ?? {}) as never });
        }
        return result;
    }

    /**
     * Each SSID once, with its real WLAN group. Omada also lists every SSID under a
     * pseudo WLAN group 'gateway', which has no SSID detail (errorCode -1001).
     */
    private async listSsids(siteId: string): Promise<Array<{ wlanId: string; ssidId: string; ssidName: string }>> {
        const seen = new Map<string, { wlanId: string; ssidId: string; ssidName: string }>();
        for (const wlan of await this.network.listAllSsids(siteId)) {
            if (wlan.wlanId === PSEUDO_WLAN_ID) continue;
            for (const s of wlan.ssidList ?? []) {
                if (!seen.has(s.ssidId)) seen.set(s.ssidId, { wlanId: wlan.wlanId, ssidId: s.ssidId, ssidName: s.ssidName });
            }
        }
        return [...seen.values()];
    }

    /**
     * Turn an SSID's MAC filter on (allow or deny list = a MAC group) or off.
     * Reports which connected clients of that SSID the new setting would cut off,
     * and refuses to apply then unless `allowLockout` is set. dryRun only reports.
     */
    private async setSsidMacFilterUnlocked(
        ssid: string,
        setting: { enabled: boolean; policy?: 'allow' | 'deny'; group?: string },
        options: { dryRun?: boolean; allowLockout?: boolean; siteId?: string } = {}
    ): Promise<SsidMacFilterChange> {
        const resolved = this.site.resolveSiteId(options.siteId);
        const filters = await this.listSsidFilters(resolved);
        const target = resolveByIdOrName(filters, ssid, (f) => f.ssidId, (f) => f.ssidName, 'SSID');
        const groups = await this.macGroups.listMacGroups(resolved);
        const groupName = (id?: string) => groups.find((g) => g.groupId === id)?.name ?? id;
        const policyName = (p?: number) => (p === undefined ? undefined : p === 1 ? ('allow' as const) : ('deny' as const));

        const before = { enabled: target.filter.macFilterEnable === true, policy: policyName(target.filter.policy), group: groupName(target.filter.macFilterId) };
        let after: SsidMacFilterChange['after'] = { enabled: false, policy: before.policy, group: before.group };
        let body: Record<string, unknown> = { macFilterEnable: false };
        let wouldLockOut: SsidMacFilterChange['wouldLockOut'] = [];

        if (setting.enabled) {
            const policy = setting.policy ?? before.policy;
            if (!policy) throw new Error('Say whether the group is an allow list or a deny list (policy)');
            const groupKey = setting.group ?? target.filter.macFilterId;
            if (!groupKey) throw new Error('Name the MAC group to filter by (group)');
            const group = this.macGroups.resolveGroup(groups, groupKey);
            const members = new Set((group.macAddressList ?? []).map((e) => normalizeMac(e.macAddress)));
            const connected = (await this.clients.listClients(resolved)).filter((c: OmadaClientInfo) => (c as { ssid?: string }).ssid === target.ssidName);
            wouldLockOut = connected
                .filter((c) => (policy === 'allow' ? !members.has(normalizeMac(c.mac)) : members.has(normalizeMac(c.mac))))
                .map((c) => ({ mac: formatMac(c.mac), name: (c as { name?: string }).name }));
            after = { enabled: true, policy, group: group.name };
            body = { macFilterEnable: true, policy: policy === 'allow' ? 1 : 0, macFilterId: group.groupId };
        }

        const change: SsidMacFilterChange = { ssid: target.ssidName, ssidId: target.ssidId, before, after, wouldLockOut, applied: false };
        if (options.dryRun) return change;
        if (wouldLockOut.length && !options.allowLockout) {
            throw new Error(
                `This would disconnect ${wouldLockOut.length} connected client(s) of ${target.ssidName}: ` +
                    `${wouldLockOut.map((c) => `${c.name ?? '?'} (${c.mac})`).join(', ')}. ` +
                    'Add them to the group first, or repeat with allowLockout if that is intended. Nothing was changed.'
            );
        }
        await this.send(
            'PATCH',
            this.sitePath(resolved, `/wireless-network/wlans/${encodeURIComponent(target.wlanId)}/ssids/${encodeURIComponent(target.ssidId)}/update-mac-filter`),
            body
        );
        return { ...change, applied: true };
    }
}

/** A user profile must not take the reserved name omada_setSsidEnabled finds its 24/7 profile by. */
function checkTimeRangeName(value: string): string {
    const name = value.trim();
    if (name.length < 1 || name.length > 64) throw new Error('Time range name must be 1 to 64 characters');
    if (name === ALWAYS_PROFILE_NAME) throw new Error(`The name '${ALWAYS_PROFILE_NAME}' is reserved for omada_setSsidEnabled`);
    return name;
}

function resolveByIdOrName<T>(items: T[], wanted: string, id: (item: T) => string, name: (item: T) => string, what: string): T {
    const byId = items.find((item) => id(item) === wanted);
    if (byId) return byId;
    const needle = wanted.trim().toLowerCase();
    const byName = items.filter((item) => name(item).toLowerCase() === needle);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`Several ${what}s are named '${wanted}'; use the id`);
    const available = items.map((item) => `${name(item)} (${id(item)})`).join(', ');
    throw new Error(`${what[0].toUpperCase()}${what.slice(1)} '${wanted}' not found. Available: ${available || '(none)'}`);
}

function typeName<K extends string>(table: Record<K, number>, value: number): K {
    const found = (Object.keys(table) as K[]).find((key) => table[key] === value);
    if (!found) throw new Error(`This rule uses an endpoint type (${value}) these tools do not handle; edit it in the Omada web UI`);
    return found;
}

function typeLabel(type: AclSourceType): string {
    return type === 'ipGroup' ? 'IP group' : type === 'network' ? 'LAN network' : 'SSID';
}

function checkDescription(value: string): string {
    const text = value.trim();
    if (text.length < 1 || text.length > 512) throw new Error('Description must be 1 to 512 characters');
    return text;
}

function ipToNumber(ip: string): number {
    const parts = ip.trim().split('.');
    if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
        throw new Error(`'${ip}' is not an IPv4 address`);
    }
    return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

function inSubnet(address: number, cidr: string): boolean {
    const [base, bits] = cidr.split('/');
    const mask = Number(bits);
    if (!base || !Number.isInteger(mask) || mask < 0 || mask > 32) return false;
    const size = 2 ** (32 - mask);
    return Math.floor(address / size) === Math.floor(ipToNumber(base) / size);
}

function parseCidr(value: string): { ip: string; mask: number } {
    const [ip, bits] = value.trim().split('/');
    ipToNumber(ip);
    const mask = bits === undefined ? 32 : Number(bits);
    if (!Number.isInteger(mask) || mask < 1 || mask > 32) throw new Error(`'${value}': the mask must be 1 to 32`);
    return { ip, mask };
}
