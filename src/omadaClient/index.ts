import type {
    ActiveClientInfo,
    ClientActivity,
    ClientBlockStatus,
    ClientPastConnection,
    ClientRateLimitSetting,
    GetClientActivityOptions,
    GetDeviceStatsOptions,
    GetThreatListOptions,
    ListClientsPastConnectionsOptions,
    OmadaClientInfo,
    OmadaApiResponse,
    OmadaDeviceInfo,
    OmadaDeviceStats,
    OmadaSiteSummary,
    OswStackDetail,
    PaginatedResult,
    RateLimitProfile,
    ThreatInfo,
} from '../types/index.js';

import { AuthManager } from './auth.js';
import { ClientOperations } from './client.js';
import { DeviceOperations } from './device.js';
import { NetworkOperations } from './network.js';
import { RequestHandler, type RequestOptions } from './request.js';
import { SecurityOperations } from './security.js';
import { SiteOperations } from './site.js';

export interface OmadaClientOptions {
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    omadacId: string;
    siteId?: string;
    strictSsl: boolean;
    requestTimeout?: number;
}

/**
 * Main client for interacting with the TP-Link Omada API.
 * Organized by API tag with dedicated operation classes for each domain.
 */
export class OmadaClient {
    private readonly auth: AuthManager;

    private readonly request: RequestHandler;

    private readonly siteOps: SiteOperations;

    private readonly deviceOps: DeviceOperations;

    private readonly clientOps: ClientOperations;

    private readonly securityOps: SecurityOperations;

    private readonly networkOps: NetworkOperations;

    private readonly omadacId: string;

    constructor(options: OmadaClientOptions) {
        this.omadacId = options.omadacId;

        const timeout = options.requestTimeout ?? 30000;

        // Initialize operation modules
        this.auth = new AuthManager({
            baseUrl: options.baseUrl,
            clientId: options.clientId,
            clientSecret: options.clientSecret,
            omadacId: options.omadacId,
            timeout,
            strictSsl: options.strictSsl,
        });

        this.request = new RequestHandler(
            {
                baseUrl: options.baseUrl,
                timeout,
                strictSsl: options.strictSsl,
            },
            this.auth
        );

        this.siteOps = new SiteOperations(this.request, this.buildOmadaPath.bind(this), options.siteId);
        this.deviceOps = new DeviceOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.clientOps = new ClientOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.securityOps = new SecurityOperations(this.request, this.buildOmadaPath.bind(this));
        this.networkOps = new NetworkOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
    }

    // Site operations
    public async listSites(): Promise<OmadaSiteSummary[]> {
        return await this.siteOps.listSites();
    }

    // Device operations
    public async listDevices(siteId?: string): Promise<OmadaDeviceInfo[]> {
        return await this.deviceOps.listDevices(siteId);
    }

    public async getDevice(identifier: string, siteId?: string): Promise<OmadaDeviceInfo | undefined> {
        return await this.deviceOps.getDevice(identifier, siteId);
    }

    public async getSwitchStackDetail(stackId: string, siteId?: string): Promise<OswStackDetail> {
        return await this.deviceOps.getSwitchStackDetail(stackId, siteId);
    }

    public async searchDevices(searchKey: string): Promise<OmadaDeviceInfo[]> {
        return await this.deviceOps.searchDevices(searchKey);
    }

    public async listDevicesStats(options: GetDeviceStatsOptions): Promise<OmadaDeviceStats> {
        return await this.deviceOps.listDevicesStats(options);
    }

    // Client operations
    public async listClients(siteId?: string): Promise<OmadaClientInfo[]> {
        return await this.clientOps.listClients(siteId);
    }

    public async getClient(identifier: string, siteId?: string): Promise<OmadaClientInfo | undefined> {
        return await this.clientOps.getClient(identifier, siteId);
    }

    public async listMostActiveClients(siteId?: string): Promise<ActiveClientInfo[]> {
        return await this.clientOps.listMostActiveClients(siteId);
    }

    public async listClientsActivity(options?: GetClientActivityOptions): Promise<ClientActivity[]> {
        return await this.clientOps.listClientsActivity(options);
    }

    public async listClientsPastConnections(options: ListClientsPastConnectionsOptions): Promise<ClientPastConnection[]> {
        return await this.clientOps.listClientsPastConnections(options);
    }

    // Rate limit operations
    public async getRateLimitProfiles(siteId?: string): Promise<RateLimitProfile[]> {
        return await this.clientOps.getRateLimitProfiles(siteId);
    }

    public async setClientRateLimit(clientMac: string, downLimit: number, upLimit: number, siteId?: string): Promise<ClientRateLimitSetting> {
        return await this.clientOps.setClientRateLimit(clientMac, downLimit, upLimit, siteId);
    }

    public async setClientRateLimitProfile(clientMac: string, profileId: string, siteId?: string): Promise<ClientRateLimitSetting> {
        return await this.clientOps.setClientRateLimitProfile(clientMac, profileId, siteId);
    }

    public async disableClientRateLimit(clientMac: string, siteId?: string): Promise<ClientRateLimitSetting> {
        return await this.clientOps.disableClientRateLimit(clientMac, siteId);
    }

    // Client block operations
    public async blockClient(clientMac: string, siteId?: string): Promise<ClientBlockStatus> {
        return await this.clientOps.blockClient(clientMac, siteId);
    }

    public async unblockClient(clientMac: string, siteId?: string): Promise<ClientBlockStatus> {
        return await this.clientOps.unblockClient(clientMac, siteId);
    }

    // Security operations
    public async getThreatList(options: GetThreatListOptions): Promise<PaginatedResult<ThreatInfo>> {
        return await this.securityOps.getThreatList(options);
    }

    // Network operations
    public async getInternetInfo(siteId?: string): Promise<unknown> {
        return await this.networkOps.getInternetInfo(siteId);
    }

    public async getPortForwardingStatus(type: 'User' | 'UPnP', siteId?: string, page = 1, pageSize = 10): Promise<PaginatedResult<unknown>> {
        return await this.networkOps.getPortForwardingStatus(type, siteId, page, pageSize);
    }

    public async getLanNetworkList(siteId?: string): Promise<unknown[]> {
        return await this.networkOps.getLanNetworkList(siteId);
    }

    public async getLanProfileList(siteId?: string): Promise<unknown[]> {
        return await this.networkOps.getLanProfileList(siteId);
    }

    public async getWlanGroupList(siteId?: string): Promise<unknown[]> {
        return await this.networkOps.getWlanGroupList(siteId);
    }

    public async getSsidList(wlanId: string, siteId?: string): Promise<unknown[]> {
        return await this.networkOps.getSsidList(wlanId, siteId);
    }

    public async getSsidDetail(wlanId: string, ssidId: string, siteId?: string): Promise<unknown> {
        return await this.networkOps.getSsidDetail(wlanId, ssidId, siteId);
    }

    public async getFirewallSetting(siteId?: string): Promise<unknown> {
        return await this.networkOps.getFirewallSetting(siteId);
    }

    // Generic API call
    public async callApi<T = unknown>(config: RequestOptions): Promise<T> {
        return await this.request.request<T>(config);
    }

    /**
     * Read an arbitrary Omada resource described by a path template.
     *
     * This is the single client primitive behind the resource-graph `omada_read`
     * tool: "many endpoints, zero new client methods". A path template may contain
     * `{placeholder}` segments (each substituted from `siteId`/`pathParams` and
     * URL-encoded), and may be site-scoped (the common case) or controller-global.
     *
     * Pagination is deliberately SINGLE-page: for paginated resources it forwards
     * one page/pageSize to a single GET rather than walking every page (no giant
     * payloads). It returns the unwrapped `result` (errorCode !== 0 throws via
     * `ensureSuccess`).
     *
     * @param options.pathTemplate  e.g. '/sites/{siteId}/gateways/{gatewayMac}/wan-status'
     * @param options.siteScoped    when true (default) `{siteId}` is resolved from siteId/default
     * @param options.paginated     when true, page/pageSize are sent as query params
     * @param options.pathParams    values for non-site `{placeholder}` segments
     * @param options.query         extra query parameters
     */
    public async readResource(options: {
        pathTemplate: string;
        siteScoped?: boolean;
        paginated?: boolean;
        siteId?: string;
        pathParams?: Record<string, string>;
        query?: Record<string, unknown>;
        page?: number;
        pageSize?: number;
    }): Promise<unknown> {
        const {
            pathTemplate,
            siteScoped = true,
            paginated = false,
            siteId,
            pathParams = {},
            query = {},
            page,
            pageSize,
        } = options;

        const substitutions: Record<string, string> = { ...pathParams };
        if (siteScoped || pathTemplate.includes('{siteId}')) {
            substitutions.siteId = this.siteOps.resolveSiteId(siteId);
        }

        const relativePath = pathTemplate.replace(/\{(\w+)\}/g, (_match, key: string) => {
            const value = substitutions[key];
            if (value === undefined || value === '') {
                throw new Error(`Missing required path parameter '${key}' for resource '${pathTemplate}'`);
            }
            return encodeURIComponent(value);
        });

        const effectiveQuery: Record<string, unknown> = { ...query };
        if (paginated) {
            effectiveQuery.page = page ?? 1;
            effectiveQuery.pageSize = pageSize ?? 50;
        }

        const fullPath = this.buildOmadaPath(relativePath);
        const response = await this.request.get<OmadaApiResponse<unknown>>(fullPath, effectiveQuery);
        return this.request.ensureSuccess(response);
    }

    /**
     * Build a full Omada API path from a relative path.
     * @param relativePath - The relative path to append to the base API path
     * @param version - The API version to use (default: 'v1')
     */
    private buildOmadaPath(relativePath: string, version = 'v1'): string {
        const normalized = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
        return `/openapi/${version}/${encodeURIComponent(this.omadacId)}${normalized}`;
    }
}
