/**
 * Raw Omada endpoints for LAN networks (VLANs) and SSIDs, used by the vendor-neutral
 * net_* tools through the Omada adapter (src/net/adapters/omada.ts). No mapping or
 * validation here: that lives in the adapter.
 *
 * SSID detail reads return the real Wi-Fi password (pskSetting.securityKey). The
 * adapter needs it to resend an unchanged password on update; it must never put it in
 * a plan, a step, an error or a log. Tool responses are redacted on top of that.
 */

import type { OmadaApiResponse } from '../types/index.js';

import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

export type RawRecord = Record<string, unknown>;

export class NetworkConfigOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string, version?: string) => string
    ) {}

    private sitePath(siteId: string | undefined, path: string, version?: string): string {
        return this.buildPath(`/sites/${encodeURIComponent(this.site.resolveSiteId(siteId))}${path}`, version);
    }

    private async send(method: 'POST' | 'PATCH' | 'DELETE', url: string, data?: unknown): Promise<unknown> {
        return this.request.ensureSuccess(await this.request.request<OmadaApiResponse<unknown>>({ method, url, data }));
    }

    /** OperationId: getLanNetworkListV2 */
    public async listLanNetworks(siteId?: string): Promise<RawRecord[]> {
        return await this.request.fetchPaginated<RawRecord>(this.sitePath(siteId, '/lan-networks', 'v2'));
    }

    /** OperationId: createLanNetworkV2 */
    public async createLanNetwork(body: RawRecord, siteId?: string): Promise<void> {
        await this.send('POST', this.sitePath(siteId, '/lan-networks', 'v2'), body);
    }

    /** OperationId: modifyLanNetworkV2 */
    public async updateLanNetwork(networkId: string, body: RawRecord, siteId?: string): Promise<void> {
        await this.send('PATCH', this.sitePath(siteId, `/lan-networks/${encodeURIComponent(networkId)}`, 'v2'), body);
    }

    /** OperationId: deleteLanNetwork */
    public async deleteLanNetwork(networkId: string, siteId?: string): Promise<void> {
        await this.send('DELETE', this.sitePath(siteId, `/lan-networks/${encodeURIComponent(networkId)}`));
    }

    /**
     * Every rule of one ACL list (all pages). The switch list is read 50 per page, which
     * every list accepts.
     */
    public async listAcls(list: 'osg-acls' | 'osw-acls' | 'eap-acls', siteId?: string): Promise<RawRecord[]> {
        return await this.request.fetchPaginated<RawRecord>(this.sitePath(siteId, `/acls/${list}`), { pageSize: 50 });
    }

    /** OperationId: getLanProfileList */
    public async listLanProfiles(siteId?: string): Promise<RawRecord[]> {
        return await this.request.fetchPaginated<RawRecord>(this.sitePath(siteId, '/lan-profiles'));
    }

    /** WLAN groups with their SSIDs (id + name only). OperationId: listAllSsids */
    public async listSsidSummaries(siteId?: string): Promise<Array<{ wlanId: string; wlanName: string; ssidList?: Array<{ ssidId: string; ssidName: string }> }>> {
        const response = await this.request.get<OmadaApiResponse<Array<{ wlanId: string; wlanName: string; ssidList?: Array<{ ssidId: string; ssidName: string }> }>>>(
            this.sitePath(siteId, '/wireless-network/ssids')
        );
        return this.request.ensureSuccess(response) ?? [];
    }

    /** Full SSID detail, password included (see the module note). OperationId: getSsidDetail */
    public async getSsidDetail(wlanId: string, ssidId: string, siteId?: string): Promise<RawRecord> {
        const response = await this.request.get<OmadaApiResponse<RawRecord>>(
            this.sitePath(siteId, `/wireless-network/wlans/${encodeURIComponent(wlanId)}/ssids/${encodeURIComponent(ssidId)}`)
        );
        return this.request.ensureSuccess(response);
    }

    /** OperationId: createSsid */
    public async createSsid(wlanId: string, body: RawRecord, siteId?: string): Promise<void> {
        await this.send('POST', this.sitePath(siteId, `/wireless-network/wlans/${encodeURIComponent(wlanId)}/ssids`), body);
    }

    /** OperationId: updateSsidBasicConfig */
    public async updateSsidBasic(wlanId: string, ssidId: string, body: RawRecord, siteId?: string): Promise<void> {
        await this.send(
            'PATCH',
            this.sitePath(siteId, `/wireless-network/wlans/${encodeURIComponent(wlanId)}/ssids/${encodeURIComponent(ssidId)}/update-basic-config`),
            body
        );
    }

    /** OperationId: updateSsidMacFilterConfig */
    public async updateSsidMacFilter(wlanId: string, ssidId: string, body: RawRecord, siteId?: string): Promise<void> {
        await this.send(
            'PATCH',
            this.sitePath(siteId, `/wireless-network/wlans/${encodeURIComponent(wlanId)}/ssids/${encodeURIComponent(ssidId)}/update-mac-filter`),
            body
        );
    }

    /** OperationId: deleteSsid */
    public async deleteSsid(wlanId: string, ssidId: string, siteId?: string): Promise<void> {
        await this.send('DELETE', this.sitePath(siteId, `/wireless-network/wlans/${encodeURIComponent(wlanId)}/ssids/${encodeURIComponent(ssidId)}`));
    }
}
