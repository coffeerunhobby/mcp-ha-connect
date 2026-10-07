import type {
    ActiveClientInfo,
    ClientActivity,
    ClientBlockStatus,
    ClientPastConnection,
    ClientRateLimitSetting,
    GetClientActivityOptions,
    ListClientsPastConnectionsOptions,
    OmadaApiResponse,
    OmadaClientInfo,
    PaginatedResult,
    RateLimitProfile,
    UpdateClientRateLimitRequest,
} from '../types/index.js';

import { OmadaApiError, type RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

/**
 * Client-related operations for the Omada API.
 */
export class ClientOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string
    ) {}

    /**
     * List all clients in a site.
     */
    public async listClients(siteId?: string): Promise<OmadaClientInfo[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        return await this.request.fetchPaginated<OmadaClientInfo>(this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/clients`));
    }

    /**
     * Get a specific client by MAC address or client ID.
     */
    public async getClient(identifier: string, siteId?: string): Promise<OmadaClientInfo | undefined> {
        const clients = await this.listClients(siteId);
        return clients.find((client) => client.mac === identifier || client.id === identifier);
    }

    /**
     * Get most active clients in a site (dashboard endpoint).
     * Returns clients sorted by total traffic.
     *
     * @param siteId - Optional site ID, uses default from config if not provided
     * @returns Array of active client information
     */
    public async listMostActiveClients(siteId?: string): Promise<ActiveClientInfo[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const response = await this.request.get<OmadaApiResponse<ActiveClientInfo[]>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/dashboard/active-clients`)
        );
        return response.result ?? [];
    }

    /**
     * Get client activity statistics over time (dashboard endpoint).
     * Returns time-series data about new, active, and disconnected clients.
     *
     * @param options - Options including optional siteId, start, and end timestamps
     * @returns Array of client activity snapshots over time
     */
    public async listClientsActivity(options: GetClientActivityOptions = {}): Promise<ClientActivity[]> {
        const resolvedSiteId = this.site.resolveSiteId(options.siteId);
        const params: Record<string, unknown> = {};

        if (options.start !== undefined) {
            params.start = options.start;
        }
        if (options.end !== undefined) {
            params.end = options.end;
        }

        const response = await this.request.get<OmadaApiResponse<ClientActivity[]>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/dashboard/client-activity`),
            params
        );
        return response.result ?? [];
    }

    /**
     * Get client past connection list (insight endpoint).
     * Returns historical client connection data with support for pagination, filtering, and sorting.
     *
     * @param options - Options including siteId, pagination, filters, and search parameters
     * @returns Array of client past connection information
     */
    public async listClientsPastConnections(options: ListClientsPastConnectionsOptions): Promise<ClientPastConnection[]> {
        const resolvedSiteId = this.site.resolveSiteId(options.siteId);
        const params: Record<string, unknown> = {
            page: options.page,
            pageSize: options.pageSize,
        };

        // Add optional sort parameter
        if (options.sortLastSeen !== undefined) {
            params['sorts.lastSeen'] = options.sortLastSeen;
        }

        // Add optional filter parameters
        if (options.timeStart !== undefined) {
            params['filters.timeStart'] = String(options.timeStart);
        }
        if (options.timeEnd !== undefined) {
            params['filters.timeEnd'] = String(options.timeEnd);
        }
        if (options.guest !== undefined) {
            params['filters.guest'] = String(options.guest);
        }

        // Add optional search parameter
        if (options.searchKey !== undefined) {
            params.searchKey = options.searchKey;
        }

        const response = await this.request.get<OmadaApiResponse<PaginatedResult<ClientPastConnection>>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/insight/past-connection`),
            params
        );

        const result = this.request.ensureSuccess(response);
        return result.data ?? [];
    }

    /**
     * Get rate limit profile list for a site.
     * Returns available rate limit profiles that can be applied to clients.
     *
     * @param siteId - Optional site ID, uses default from config if not provided
     * @returns Array of rate limit profiles
     */
    public async getRateLimitProfiles(siteId?: string): Promise<RateLimitProfile[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const response = await this.request.get<OmadaApiResponse<RateLimitProfile[]>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/rate-limit-profiles`)
        );
        return response.result ?? [];
    }

    /**
     * Set custom rate limit for a client.
     * Configures download and upload bandwidth limits directly without using a profile.
     *
     * @param clientMac - MAC address of the client
     * @param downLimit - Download limit in Kbps
     * @param upLimit - Upload limit in Kbps
     * @param siteId - Optional site ID, uses default from config if not provided
     * @returns Updated rate limit setting
     */
    public async setClientRateLimit(clientMac: string, downLimit: number, upLimit: number, siteId?: string): Promise<ClientRateLimitSetting> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const requestBody: UpdateClientRateLimitRequest = {
            mode: 0, // 0 = custom rate limit
            customRateLimit: {
                enable: true,
                upEnable: true,
                upLimit: upLimit,
                downEnable: true,
                downLimit: downLimit,
            },
        };

        const response = await this.request.patch<OmadaApiResponse<ClientRateLimitSetting>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/clients/${encodeURIComponent(clientMac)}/ratelimit`),
            requestBody
        );
        return this.request.ensureSuccess(response);
    }

    /**
     * Set rate limit profile for a client.
     * Applies a predefined rate limit profile to the client.
     *
     * @param clientMac - MAC address of the client
     * @param profileId - Rate limit profile ID
     * @param siteId - Optional site ID, uses default from config if not provided
     * @returns Updated rate limit setting
     */
    public async setClientRateLimitProfile(clientMac: string, profileId: string, siteId?: string): Promise<ClientRateLimitSetting> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const requestBody: UpdateClientRateLimitRequest = {
            mode: 1, // 1 = use rate limit profile
            rateLimitProfileId: profileId,
        };

        const response = await this.request.patch<OmadaApiResponse<ClientRateLimitSetting>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/clients/${encodeURIComponent(clientMac)}/ratelimit`),
            requestBody
        );
        return this.request.ensureSuccess(response);
    }

    /**
     * Disable rate limit for a client.
     * Removes any rate limiting applied to the client.
     *
     * @param clientMac - MAC address of the client
     * @param siteId - Optional site ID, uses default from config if not provided
     * @returns Updated rate limit setting
     */
    public async disableClientRateLimit(clientMac: string, siteId?: string): Promise<ClientRateLimitSetting> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);

        // To disable rate limiting, use mode 0 with enable: false and minimal valid limit values
        const requestBody: UpdateClientRateLimitRequest = {
            mode: 0,
            customRateLimit: {
                enable: false,
                upEnable: false,
                upLimit: 1,
                downEnable: false,
                downLimit: 1,
            },
        };

        const response = await this.request.patch<OmadaApiResponse<ClientRateLimitSetting>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/clients/${encodeURIComponent(clientMac)}/ratelimit`),
            requestBody
        );
        return this.request.ensureSuccess(response);
    }

    /**
     * Block a client from the network.
     * The client is denied network access until it is unblocked.
     *
     * @param clientMac - MAC address of the client to block
     * @param siteId - Optional site ID, uses default from config if not provided
     * @returns Status object confirming the client was blocked
     */
    public async blockClient(clientMac: string, siteId?: string): Promise<ClientBlockStatus> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const response = await this.request.post<OmadaApiResponse<unknown>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/clients/${encodeURIComponent(clientMac)}/block`)
        );
        this.request.ensureSuccess(response);
        return { mac: clientMac, siteId: resolvedSiteId, blocked: true };
    }

    /**
     * Unblock a previously blocked client, restoring its network access.
     *
     * @param clientMac - MAC address of the client to unblock
     * @param siteId - Optional site ID, uses default from config if not provided
     * @returns Status object confirming the client was unblocked
     */
    public async unblockClient(clientMac: string, siteId?: string): Promise<ClientBlockStatus> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        try {
            const response = await this.request.post<OmadaApiResponse<unknown>>(
                this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/clients/${encodeURIComponent(clientMac)}/unblock`)
            );
            this.request.ensureSuccess(response);
            return { mac: clientMac, siteId: resolvedSiteId, blocked: false };
        } catch (error) {
            // The controller may report this with HTTP 200 or an HTTP error status.
            if (!(error instanceof OmadaApiError) || error.errorCode !== CLIENT_DOES_NOT_EXIST) {
                throw error;
            }
        }
        // The unblock endpoint only knows clients the controller still treats as
        // current; a blocked client cannot reconnect, so after a while it drops
        // out and the API can no longer unblock it. Check the known-clients list.
        const known = await this.findKnownClient(clientMac, resolvedSiteId);
        // Only an explicit block=false proves the client is unblocked; a record
        // without block state proves nothing.
        if (known?.block === false) {
            return { mac: clientMac, siteId: resolvedSiteId, blocked: false };
        }
        throw new Error(
            known
                ? `Omada's API cannot unblock ${clientMac}: the client is offline and the controller no longer treats it as current. ` +
                  'Unblock it in the Omada web UI (Insights > Known Clients), or remove its record with omada_deleteClient.'
                : `Omada has no record of ${clientMac}, but its access points may still refuse it (an orphaned block). ` +
                  'Try omada_deleteClient, or let the device reconnect by cable so the controller sees it again, then unblock it.'
        );
    }

    /**
     * Clients the controller remembers (online or not), with their block state.
     * OperationId: getKnownClients (GET /insight/clients)
     */
    public async listKnownClients(siteId?: string): Promise<KnownClient[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        return await this.request.fetchPaginated<KnownClient>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/insight/clients`)
        );
    }

    /** Known clients that are currently blocked. */
    public async listBlockedClients(siteId?: string): Promise<KnownClient[]> {
        return (await this.listKnownClients(siteId)).filter((client) => client.block === true);
    }

    /**
     * Delete the controller's record of a client: its name, history and block
     * state. Clears an orphaned block that the unblock endpoint can no longer reach.
     * OperationId: deleteClient (DELETE /clients/{clientMac})
     */
    public async deleteClient(clientMac: string, siteId?: string): Promise<{ mac: string; siteId: string; deleted: true }> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const response = await this.request.request<OmadaApiResponse<unknown>>({
            method: 'DELETE',
            url: this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/clients/${encodeURIComponent(clientMac)}`),
        });
        this.request.ensureSuccess(response);
        return { mac: clientMac, siteId: resolvedSiteId, deleted: true };
    }

    private async findKnownClient(clientMac: string, siteId: string): Promise<KnownClient | undefined> {
        const wanted = normalizeMac(clientMac);
        return (await this.listKnownClients(siteId)).find((client) => normalizeMac(client.mac) === wanted);
    }
}

/** Omada error code: "This client does not exist." */
export const CLIENT_DOES_NOT_EXIST = -41004;

/** A known client (KnownClientVO), as GET /insight/clients returns it. */
export interface KnownClient {
    mac: string;
    name?: string;
    wireless?: boolean;
    guest?: boolean;
    lastSeen?: number;
    block?: boolean;
    [field: string]: unknown;
}

/**
 * A complete MAC in Omada's format (AA-BB-CC-DD-EE-FF). Anything that is not
 * exactly 12 hex digits is refused, so a write never runs with a partial MAC.
 */
export function formatMac(mac: string): string {
    const hex = normalizeMac(mac);
    if (!/^[0-9A-F]{12}$/.test(hex)) {
        throw new Error(`'${mac}' is not a complete MAC address (expected 12 hex digits, e.g. 4C-1D-96-8D-37-C7)`);
    }
    return hex.match(/../g)!.join('-');
}

/** "4c:1d:96:8d:37:c7", "4C-1D-96-8D-37-C7" and "4c1d968d37c7" compare equal. */
export function normalizeMac(mac: string): string {
    return mac.replace(/[^0-9a-f]/gi, '').toUpperCase();
}
