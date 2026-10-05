import type { OmadaApiResponse, OmadaSiteSummary } from '../types/index.js';

import type { RequestHandler } from './request.js';

/** Omada caps a site's NTP server list at 5 entries. */
export const MAX_NTP_SERVERS = 5;

/**
 * The controller's own pattern for an NTP server address (`ntp server` schema in
 * the Open API spec): 3-64 chars, dot-separated labels. It accepts hostnames and
 * dotted IPv4 alike.
 */
const NTP_ADDRESS_PATTERN = /^(?=.{3,64}$)[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+$/;

const IPV4_LIKE = /^[0-9.]+$/;

/**
 * Validate one NTP server address before it reaches the controller. Anything that
 * looks numeric must be a real IPv4 address (the controller's pattern alone would
 * accept `999.1.1.1`).
 * @returns an error message, or null if the address is acceptable
 */
export function ntpAddressError(address: string): string | null {
    if (!NTP_ADDRESS_PATTERN.test(address)) {
        return `'${address}' is not a valid NTP server address (expected a hostname or IPv4 address)`;
    }
    if (IPV4_LIKE.test(address)) {
        const octets = address.split('.');
        if (octets.length !== 4 || octets.some((o) => o === '' || Number(o) > 255 || (o.length > 1 && o.startsWith('0')))) {
            return `'${address}' is not a valid IPv4 address`;
        }
    }
    return null;
}

/** Daylight-saving start/end point, identical in the site GET and PUT shapes. */
export interface DstTime {
    month: number;
    serial: number;
    day: number;
    hour: number;
    minute: number;
}

/** `GET /sites/{siteId}` result (OperationId: getSiteEntity). */
export interface OmadaSiteInfo {
    siteId?: string;
    name?: string;
    type?: number;
    tagIds?: string[];
    region: string;
    timeZone: string;
    scenario: string;
    ntpEnable?: boolean;
    ntpServers?: string[];
    dst?: {
        enable?: boolean;
        mode?: number;
        start?: DstTime;
        end?: DstTime;
        offset?: number;
        // Read-only fields the PUT does not accept: status, startTime, endTime, nextStart, ...
        [readOnly: string]: unknown;
    };
    longitude?: number;
    latitude?: number;
    address?: string;
    supportES?: boolean;
    supportL2?: boolean;
}

/** `PUT /sites/{siteId}` body (UpdateSiteEntity). */
export interface SiteUpdateBody {
    name?: string;
    region: string;
    timeZone: string;
    scenario: string;
    tagIds?: string[];
    ntpEnable: boolean;
    ntpServers: Array<{ address: string }>;
    dst?: { enable?: boolean; mode?: number; start?: DstTime; end?: DstTime; offset?: number };
    longitude?: number;
    latitude?: number;
    address?: string;
    supportES?: boolean;
    supportL2?: boolean;
}

export interface SiteNtpChangeResult {
    siteId: string;
    siteName?: string;
    applied: boolean;
    before: { ntpEnable?: boolean; ntpServers: string[] };
    after: { ntpEnable: boolean; ntpServers: string[] };
    /** The exact body sent (or, on a dry run, that would be sent) to PUT /sites/{siteId}. */
    request: SiteUpdateBody;
}

/**
 * Build the full-replacement `PUT /sites/{siteId}` body from the site's current
 * settings, changing only the NTP fields.
 *
 * The PUT replaces the site's settings as a whole (region, timeZone and scenario
 * are required), so every writable field is carried over from the GET. The GET
 * and PUT shapes differ: NTP servers are plain strings on read but
 * `{ address }` objects on write, and the read-only DST fields (status,
 * timestamps) must be dropped.
 */
export function buildSiteUpdateBody(site: OmadaSiteInfo, ntpServers: string[], ntpEnable: boolean): SiteUpdateBody {
    for (const field of ['region', 'timeZone', 'scenario'] as const) {
        if (typeof site[field] !== 'string' || site[field] === '') {
            throw new Error(`Site info is missing '${field}', which the controller requires to update the site; refusing to write`);
        }
    }

    const body: SiteUpdateBody = {
        region: site.region,
        timeZone: site.timeZone,
        scenario: site.scenario,
        ntpEnable,
        ntpServers: ntpServers.map((address) => ({ address })),
    };
    if (site.name !== undefined) body.name = site.name;
    if (site.tagIds !== undefined) body.tagIds = site.tagIds;
    if (site.longitude !== undefined) body.longitude = site.longitude;
    if (site.latitude !== undefined) body.latitude = site.latitude;
    if (site.address !== undefined) body.address = site.address;
    if (site.supportES !== undefined) body.supportES = site.supportES;
    if (site.supportL2 !== undefined) body.supportL2 = site.supportL2;
    if (site.dst) {
        const { enable, mode, start, end, offset } = site.dst;
        const dst: NonNullable<SiteUpdateBody['dst']> = {};
        if (enable !== undefined) dst.enable = enable;
        if (mode !== undefined) dst.mode = mode;
        if (start !== undefined) dst.start = start;
        if (end !== undefined) dst.end = end;
        if (offset !== undefined) dst.offset = offset;
        body.dst = dst;
    }
    return body;
}

/**
 * Validate a configured default site (`OMADA_SITE_ID`) against the controller's
 * live site list.
 *
 * The Omada controller is the source of truth; `OMADA_SITE_ID` is only a
 * selector/filter against it. A value that isn't on the controller is a
 * deployment/configuration bug (e.g. the site id drifted after a controller
 * migration, exactly like `OMADA_OMADAC_ID` does) — not a transient outage. If
 * left unvalidated it silently scopes every site-scoped read to a dead site and
 * surfaces later as a mysterious "user does not have permissions to access this
 * site" error.
 *
 * @returns an actionable error message if `OMADA_SITE_ID` is set but absent from
 *   `sites`; `null` if it is unset (no default) or valid.
 */
export function checkConfiguredSite(
    configuredSiteId: string | undefined,
    sites: OmadaSiteSummary[]
): string | null {
    if (!configuredSiteId) {
        return null;
    }
    if (sites.some((s) => s.siteId === configuredSiteId)) {
        return null;
    }
    const available = sites.map((s) => `${s.name} (${s.siteId})`).join(', ') || '(controller returned no sites)';
    return `OMADA_SITE_ID="${configuredSiteId}" was not found on the controller. Set OMADA_SITE_ID to one of: ${available}.`;
}

/**
 * Site-related operations for the Omada API.
 */
export class SiteOperations {
    /** Tail of the queued site-settings writes, per site (see withSiteLock). */
    private readonly siteWriteQueues = new Map<string, Promise<void>>();

    constructor(
        private readonly request: RequestHandler,
        private readonly buildPath: (path: string) => string,
        private readonly defaultSiteId?: string
    ) {}

    /**
     * List all sites accessible to the authenticated user.
     */
    public async listSites(): Promise<OmadaSiteSummary[]> {
        return await this.request.fetchPaginated<OmadaSiteSummary>(this.buildPath('/sites'));
    }

    /**
     * Resolve a site ID from the parameter or default configuration.
     * @throws {Error} If no site ID is available
     */
    public resolveSiteId(siteId?: string): string {
        if (siteId) {
            return siteId;
        }

        if (this.defaultSiteId) {
            return this.defaultSiteId;
        }

        throw new Error('A site id must be provided either in the environment or as a parameter. Use omada_browse at path / to discover available sites and their IDs.');
    }

    /**
     * Get a site's full settings.
     * OperationId: getSiteEntity
     */
    public async getSiteInfo(siteId?: string): Promise<OmadaSiteInfo> {
        const resolvedSiteId = this.resolveSiteId(siteId);
        const response = await this.request.get<OmadaApiResponse<OmadaSiteInfo>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}`)
        );
        return this.request.ensureSuccess(response);
    }

    /**
     * Get a site's NTP server status and configuration.
     * OperationId: getNtpStatus
     */
    public async getSiteNtpStatus(siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.resolveSiteId(siteId);
        const response = await this.request.get<OmadaApiResponse<unknown>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/setting/ntp`)
        );
        return this.request.ensureSuccess(response);
    }

    /**
     * Run site-settings writes for one site one at a time, so two read-modify-write
     * calls from this server never interleave (the second reads after the first
     * has written).
     */
    private async withSiteLock<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.siteWriteQueues.get(siteId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => current);
        this.siteWriteQueues.set(siteId, tail);
        await previous;
        try {
            return await fn();
        } finally {
            release();
            if (this.siteWriteQueues.get(siteId) === tail) {
                this.siteWriteQueues.delete(siteId);
            }
        }
    }

    /**
     * Set a site's NTP servers (and NTP on/off) by read-modify-write of the site
     * settings: Omada has no NTP-only write, NTP lives on `PUT /sites/{siteId}`.
     * With `dryRun`, returns the exact body without writing.
     *
     * The controller offers no conditional update (no version field or If-Match),
     * so a change made elsewhere between our read and our write would be undone.
     * Writes are serialized per site within this server, and the site is re-read
     * just before the PUT: if anything other than NTP changed since the first
     * read, the write is refused. Only the moment between that re-read and the
     * PUT remains unprotected.
     * OperationId: modifySite
     */
    public async setSiteNtpServers(
        servers: string[],
        options: { enabled?: boolean; siteId?: string; dryRun?: boolean } = {}
    ): Promise<SiteNtpChangeResult> {
        const enabled = options.enabled ?? true;
        if (enabled && servers.length === 0) {
            throw new Error('At least one NTP server is required to enable NTP');
        }
        if (servers.length > MAX_NTP_SERVERS) {
            throw new Error(`Omada allows at most ${MAX_NTP_SERVERS} NTP servers per site (got ${servers.length})`);
        }
        const errors = servers.map(ntpAddressError).filter((e): e is string => e !== null);
        if (errors.length > 0) {
            throw new Error(errors.join('; '));
        }
        if (new Set(servers).size !== servers.length) {
            throw new Error('NTP server list contains duplicates');
        }

        const resolvedSiteId = this.resolveSiteId(options.siteId);
        if (options.dryRun) {
            return this.planNtpChange(resolvedSiteId, await this.getSiteInfo(resolvedSiteId), servers, enabled);
        }

        return await this.withSiteLock(resolvedSiteId, async () => {
            const site = await this.getSiteInfo(resolvedSiteId);
            const result = this.planNtpChange(resolvedSiteId, site, servers, enabled);

            // Re-read right before writing; refuse if a non-NTP setting moved.
            const latest = await this.getSiteInfo(resolvedSiteId);
            if (JSON.stringify(buildSiteUpdateBody(latest, servers, enabled)) !== JSON.stringify(result.request)) {
                throw new Error(
                    'Site settings changed while preparing the NTP update (another change is in progress); nothing was written. Try again.'
                );
            }

            const response = await this.request.put<OmadaApiResponse<unknown>>(
                this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}`),
                result.request
            );
            this.request.ensureSuccess(response);

            // Report what the controller now holds, not what we asked for.
            const updated = await this.getSiteInfo(resolvedSiteId);
            result.applied = true;
            result.after = { ntpEnable: updated.ntpEnable ?? enabled, ntpServers: updated.ntpServers ?? [] };
            return result;
        });
    }

    private planNtpChange(siteId: string, site: OmadaSiteInfo, servers: string[], enabled: boolean): SiteNtpChangeResult {
        return {
            siteId,
            siteName: site.name,
            applied: false,
            before: { ntpEnable: site.ntpEnable, ntpServers: site.ntpServers ?? [] },
            after: { ntpEnable: enabled, ntpServers: servers },
            request: buildSiteUpdateBody(site, servers, enabled),
        };
    }
}
