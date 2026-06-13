import type { OmadaSiteSummary } from '../types/index.js';

import type { RequestHandler } from './request.js';

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
}
