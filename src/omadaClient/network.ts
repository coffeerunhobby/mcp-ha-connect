import type { OmadaApiResponse, PaginatedResult } from '../types/index.js';

import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

/**
 * Network-related operations for the Omada API.
 * Covers internet, LAN, WLAN, firewall, and port forwarding configurations.
 */
export class NetworkOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string, version?: string) => string
    ) {}

    /**
     * Get internet configuration info for a site.
     * OperationId: getInternet
     */
    public async getInternetInfo(siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/internet`);
        const response = await this.request.get<OmadaApiResponse<unknown>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Get port forwarding status for a specific type (User or UPnP).
     * OperationId: getPortForwardStatus
     *
     * @param type - Port forwarding type: 'User' or 'UPnP'
     * @param siteId - Optional site ID (uses default if not provided)
     * @param page - Page number (required by API, default: 1)
     * @param pageSize - Page size (required by API, range: 1-1000, default: 10)
     */
    public async getPortForwardingStatus(type: 'User' | 'UPnP', siteId?: string, page = 1, pageSize = 10): Promise<PaginatedResult<unknown>> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/insight/port-forwarding/${encodeURIComponent(type)}`);

        const response = await this.request.get<OmadaApiResponse<PaginatedResult<unknown>>>(path, {
            page,
            pageSize,
        });

        return this.request.ensureSuccess(response);
    }

    /**
     * Get LAN network list (v2 API) with pagination.
     * OperationId: getLanNetworkListV2
     */
    public async getLanNetworkList(siteId?: string): Promise<unknown[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/lan-networks`, 'v2');
        return await this.request.fetchPaginated<unknown>(path);
    }

    /**
     * Get LAN profile list with pagination.
     * OperationId: getLanProfileList
     */
    public async getLanProfileList(siteId?: string): Promise<unknown[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/lan-profiles`);
        return await this.request.fetchPaginated<unknown>(path);
    }

    /**
     * Get WLAN group list.
     * OperationId: getWlanGroupList
     */
    public async getWlanGroupList(siteId?: string): Promise<unknown[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/wireless-network/wlans`);
        const response = await this.request.get<OmadaApiResponse<unknown[]>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Get SSID list for a specific WLAN group.
     * OperationId: getSsidList
     *
     * @param wlanId - WLAN group ID (can be obtained from getWlanGroupList)
     */
    public async getSsidList(wlanId: string, siteId?: string): Promise<unknown[]> {
        if (!wlanId) {
            throw new Error('A wlanId must be provided. Use omada_read at path /wifi/groups to get available WLAN group IDs.');
        }

        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/wireless-network/wlans/${encodeURIComponent(wlanId)}/ssids`);
        return await this.request.fetchPaginated<unknown>(path);
    }

    /**
     * Get detailed information for a specific SSID.
     * OperationId: getSsidDetail
     *
     * @param wlanId - WLAN group ID (can be obtained from getWlanGroupList)
     * @param ssidId - SSID ID (can be obtained from getSsidList)
     */
    public async getSsidDetail(wlanId: string, ssidId: string, siteId?: string): Promise<unknown> {
        if (!wlanId) {
            throw new Error('A wlanId must be provided. Use omada_read at path /wifi/groups to get available WLAN group IDs.');
        }
        if (!ssidId) {
            throw new Error('An ssidId must be provided. Use omada_read at path /wifi/ssids to get available SSID IDs.');
        }

        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(
            `/sites/${encodeURIComponent(resolvedSiteId)}/wireless-network/wlans/${encodeURIComponent(wlanId)}/ssids/${encodeURIComponent(ssidId)}`
        );
        const response = await this.request.get<OmadaApiResponse<unknown>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Get firewall settings for a site.
     * OperationId: getFirewallSetting
     */
    public async getFirewallSetting(siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/firewall`);
        const response = await this.request.get<OmadaApiResponse<unknown>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * List every SSID on the site, flattened across WLAN groups.
     * OperationId: listAllSsids — returns [{wlanId, wlanName, ssidList:[{ssidId, ssidName}]}].
     */
    public async listAllSsids(siteId?: string): Promise<WlanSimpleInfo[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/wireless-network/ssids`);
        const response = await this.request.get<OmadaApiResponse<WlanSimpleInfo[]>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * List time-range profiles for the site.
     * OperationId: listTimeRangeProfiles — returns [{profileId, name, dayMode, ...}].
     */
    public async listTimeRangeProfiles(siteId?: string): Promise<TimeRangeProfileInfo[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/time-range-profiles`);
        const response = await this.request.get<OmadaApiResponse<TimeRangeProfileInfo[]>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Create a time-range profile. The API returns no profileId — callers must
     * re-list and match by name to obtain the created profile's id.
     * OperationId: createSitesTimeRangeProfiles
     */
    public async createTimeRangeProfile(profile: CreateTimeRangeProfile, siteId?: string): Promise<void> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/time-range-profiles`);
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, profile);
        this.request.ensureSuccess(response);
    }

    /**
     * Update the WLAN-schedule config of a single SSID.
     * OperationId: updateSitesWirelessNetworkWlansSsidsUpdateWlanSchedule
     * Omada has no direct SSID on/off — the WLAN schedule (action 0 = radio off
     * during the scheduled period) is the controller's sanctioned mechanism.
     */
    public async updateSsidWlanSchedule(
        wlanId: string,
        ssidId: string,
        schedule: { wlanScheduleEnable: boolean; action?: number; scheduleId?: string },
        siteId?: string
    ): Promise<void> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(
            `/sites/${encodeURIComponent(resolvedSiteId)}/wireless-network/wlans/${encodeURIComponent(wlanId)}/ssids/${encodeURIComponent(ssidId)}/update-wlan-schedule`
        );
        const response = await this.request.patch<OmadaApiResponse<unknown>>(path, schedule);
        this.request.ensureSuccess(response);
    }

    /**
     * Enable or disable an SSID (e.g. the guest network) by name or ssidId.
     *
     * Omada 6.x exposes no direct enable flag on an SSID; the sanctioned lever is
     * the per-SSID WLAN schedule. Disabling applies an always-on "radio off"
     * schedule (a 24/7 time-range profile is created once and reused); enabling
     * simply turns the schedule off again. Fully reversible, and unlike a MAC
     * filter it actually stops the SSID from broadcasting.
     */
    public async setSsidEnabled(ssid: string, enabled: boolean, siteId?: string): Promise<SsidEnableResult> {
        const wlans = await this.listAllSsids(siteId);
        const needle = ssid.trim().toLowerCase();
        let match: { wlanId: string; ssidId: string; ssidName: string } | undefined;
        for (const wlan of wlans) {
            for (const s of wlan.ssidList ?? []) {
                if (s.ssidId === ssid || s.ssidName.toLowerCase() === needle) {
                    match = { wlanId: wlan.wlanId, ssidId: s.ssidId, ssidName: s.ssidName };
                    break;
                }
            }
            if (match) break;
        }
        if (!match) {
            const available = wlans.flatMap((w) => (w.ssidList ?? []).map((s) => s.ssidName)).join(', ');
            throw new Error(`SSID '${ssid}' not found. Available SSIDs: ${available || '(none)'}`);
        }

        if (enabled) {
            await this.updateSsidWlanSchedule(match.wlanId, match.ssidId, { wlanScheduleEnable: false }, siteId);
            return { ...match, enabled: true, method: 'wlan-schedule disabled' };
        }

        const scheduleId = await this.ensureAlwaysProfile(siteId);
        await this.updateSsidWlanSchedule(
            match.wlanId,
            match.ssidId,
            { wlanScheduleEnable: true, action: 0, scheduleId },
            siteId
        );
        return { ...match, enabled: false, method: 'wlan-schedule radio-off 24/7', scheduleId };
    }

    /**
     * Find-or-create the 24/7 time-range profile used to switch SSIDs off.
     * Created once per site under a fixed name, then reused forever.
     */
    private async ensureAlwaysProfile(siteId?: string): Promise<string> {
        const existing = await this.listTimeRangeProfiles(siteId);
        const found = existing.find((p) => p.name === ALWAYS_PROFILE_NAME);
        if (found) {
            return found.profileId;
        }

        await this.createTimeRangeProfile(
            {
                name: ALWAYS_PROFILE_NAME,
                dayMode: 0, // Every Day
                timeList: [{ dayType: 1, startTimeH: 0, startTimeM: 0, endTimeH: 24, endTimeM: 0 }],
            },
            siteId
        );

        // The create endpoint returns no id — re-list and match by name.
        const after = await this.listTimeRangeProfiles(siteId);
        const created = after.find((p) => p.name === ALWAYS_PROFILE_NAME);
        if (!created) {
            throw new Error(`Time-range profile '${ALWAYS_PROFILE_NAME}' was created but not found on re-list`);
        }
        return created.profileId;
    }
}

/** Fixed name of the reusable 24/7 profile that backs omada_setSsidEnabled(false). */
export const ALWAYS_PROFILE_NAME = 'mcp-always (24/7, used by omada_setSsidEnabled)';

export interface WlanSimpleInfo {
    wlanId: string;
    wlanName: string;
    ssidList?: Array<{ ssidId: string; ssidName: string }>;
}

export interface TimeRangeProfileInfo {
    profileId: string;
    name: string;
    dayMode?: number;
}

export interface CreateTimeRangeProfile {
    name: string;
    dayMode: number;
    timeList: Array<{ dayType: number; startTimeH: number; startTimeM: number; endTimeH: number; endTimeM: number }>;
}

export interface SsidEnableResult {
    wlanId: string;
    ssidId: string;
    ssidName: string;
    enabled: boolean;
    method: string;
    scheduleId?: string;
}
