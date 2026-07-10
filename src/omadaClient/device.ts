import type { GetDeviceStatsOptions, OmadaApiResponse, OmadaDeviceInfo, OmadaDeviceStats, OswStackDetail } from '../types/index.js';

import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

/**
 * Device-related operations for the Omada API.
 */
export class DeviceOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string
    ) {}

    /**
     * List all devices in a site.
     */
    public async listDevices(siteId?: string): Promise<OmadaDeviceInfo[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        return await this.request.fetchPaginated<OmadaDeviceInfo>(this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/devices`));
    }

    /**
     * Get a specific device by MAC address or device ID.
     */
    public async getDevice(identifier: string, siteId?: string): Promise<OmadaDeviceInfo | undefined> {
        const devices = await this.listDevices(siteId);
        return devices.find((device) => device.mac === identifier || device.deviceId === identifier);
    }

    /**
     * Get detailed information about a switch stack.
     */
    public async getSwitchStackDetail(stackId: string, siteId?: string): Promise<OswStackDetail> {
        if (!stackId) {
            throw new Error('A stack id must be provided.');
        }

        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/stacks/${encodeURIComponent(stackId)}`);

        const response = await this.request.get<OmadaApiResponse<OswStackDetail>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Search for devices globally across all sites the user has access to.
     */
    public async searchDevices(searchKey: string): Promise<OmadaDeviceInfo[]> {
        if (!searchKey) {
            throw new Error('A search key must be provided.');
        }

        const path = this.buildPath(`/devices?searchKey=${encodeURIComponent(searchKey)}`);
        const response = await this.request.get<OmadaApiResponse<OmadaDeviceInfo[]>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Get statistics for global adopted devices with filtering and pagination.
     */
    public async listDevicesStats(options: GetDeviceStatsOptions): Promise<OmadaDeviceStats> {
        const queryParams = new URLSearchParams();
        queryParams.append('page', options.page.toString());
        queryParams.append('pageSize', options.pageSize.toString());

        if (options.searchMacs) {
            queryParams.append('searchMacs', options.searchMacs);
        }
        if (options.searchNames) {
            queryParams.append('searchNames', options.searchNames);
        }
        if (options.searchModels) {
            queryParams.append('searchModels', options.searchModels);
        }
        if (options.searchSns) {
            queryParams.append('searchSns', options.searchSns);
        }
        if (options.filterTag) {
            queryParams.append('filters.tag', options.filterTag);
        }
        if (options.filterDeviceSeriesType) {
            queryParams.append('filters.deviceSeriesType', options.filterDeviceSeriesType);
        }

        const path = this.buildPath(`/devices/stat?${queryParams.toString()}`);
        const response = await this.request.get<OmadaApiResponse<OmadaDeviceStats>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Power-cycle PoE on one or more switch ports ("PoE recovery").
     * OperationId: createSitesSwitchesMultiPortsPoeRecovery
     *
     * The switch briefly cuts and restores PoE power on the given ports —
     * a remote hard-reboot for whatever is powered by them (APs, cameras).
     * The switch itself and other ports are unaffected.
     *
     * @param switchMac - MAC address of the Omada switch
     * @param ports - Port numbers to cycle, e.g. [1, 2]
     */
    public async cyclePoePorts(switchMac: string, ports: number[], siteId?: string): Promise<void> {
        if (!switchMac) {
            throw new Error('A switchMac must be provided. Use omada_listDevices to find switch MAC addresses.');
        }
        if (!ports.length) {
            throw new Error('At least one port number must be provided, e.g. ports: [1].');
        }

        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(
            `/sites/${encodeURIComponent(resolvedSiteId)}/switches/${encodeURIComponent(switchMac)}/multi-ports/poe-recovery`
        );
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, { ports });
        this.request.ensureSuccess(response);
    }
}
