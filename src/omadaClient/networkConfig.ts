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

    private async send(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, data?: unknown): Promise<unknown> {
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

    // ---- gateway ACLs and their groups (net_ rules) -----------------------------------
    // Bodies verified on the live controller (6.3.0.45, 2026-10-20): LAN→LAN rules between
    // networks (endpoint type 0) and towards an IP-port group (type 2), IP-port groups
    // {type: 1, ipList, portType: 0, portList: ["1883"]}.

    /** IP groups (type 0) or IP-port groups (type 1). */
    public async listGroups(type: 0 | 1, siteId?: string): Promise<RawRecord[]> {
        const response = await this.request.get<OmadaApiResponse<RawRecord[]>>(this.sitePath(siteId, `/profiles/groups/${type}`));
        return this.request.ensureSuccess(response) ?? [];
    }

    public async createGroup(body: RawRecord, siteId?: string): Promise<void> {
        await this.send('POST', this.sitePath(siteId, '/profiles/groups'), body);
    }

    public async deleteGroup(type: 0 | 1, groupId: string, siteId?: string): Promise<void> {
        await this.send('DELETE', this.sitePath(siteId, `/profiles/groups/${type}/${encodeURIComponent(groupId)}`));
    }

    public async createGatewayAcl(body: RawRecord, siteId?: string): Promise<void> {
        await this.send('POST', this.sitePath(siteId, '/acls/osg-acls'), body);
    }

    public async updateGatewayAcl(aclId: string, body: RawRecord, siteId?: string): Promise<void> {
        await this.send('PUT', this.sitePath(siteId, `/acls/osg-acls/${encodeURIComponent(aclId)}`), body);
    }

    public async deleteGatewayAcl(aclId: string, siteId?: string): Promise<void> {
        await this.send('DELETE', this.sitePath(siteId, `/acls/${encodeURIComponent(aclId)}`));
    }

    /** New order of the gateway ACLs: id -> position (1 = evaluated first). */
    public async reorderGatewayAcls(indexes: Record<string, number>, siteId?: string): Promise<void> {
        await this.send('POST', this.sitePath(siteId, '/acls/modifyIndex'), { type: 'gateway', indexes });
    }

    // ---- switch ports, port profiles, topology, mDNS (net_ ports and mDNS repeater) -----
    // Paths and bodies from TP-Link's Open API reference (northbound /v3/api-docs, 2026-10-20);
    // the reads were checked on the live controller (6.3.0.45). `GET /switches/{mac}/ports`
    // does not exist there (-1600): the ports come with the switch.

    /** Switch info with its `portList` (port, name, profileId, profileOverrideEnable, lagPort). OperationId: getSwitchInfo */
    public async getSwitch(switchMac: string, siteId?: string): Promise<RawRecord> {
        const response = await this.request.get<OmadaApiResponse<RawRecord>>(this.sitePath(siteId, `/switches/${encodeURIComponent(switchMac)}`));
        return this.request.ensureSuccess(response);
    }

    /** Port profiles with their VLAN mode (networkTagsSetting 0 allow all, 1 block all, 2 custom). OperationId: getOswLanProfileList (v2) */
    public async listPortProfiles(siteId?: string): Promise<RawRecord[]> {
        return await this.request.fetchPaginated<RawRecord>(this.sitePath(siteId, '/lan-profiles', 'v2'));
    }

    /**
     * A port's settings; `name` and `profileId` are required (-39855 without the name). Live (6.3.0.45):
     * `profileVlanOverrideEnable: true` + nativeNetworkId / networkTagsSetting / tagNetworkIds give the
     * port its own networks. OperationId: modifySwitchPort
     */
    public async updateSwitchPort(switchMac: string, port: number, body: RawRecord, siteId?: string): Promise<void> {
        await this.send('PATCH', this.sitePath(siteId, `/switches/${encodeURIComponent(switchMac)}/ports/${encodeURIComponent(String(port))}`), body);
    }

    /**
     * The devices whose ports carry a network; a switch has `switchInfo.affectedPorts` {nativePorts,
     * untagPorts, tagPorts, ...Lags}. OperationId: getGridVlanNetworkAffectedDevicePorts
     */
    public async listNetworkPorts(networkId: string, vlan: number, siteId?: string): Promise<RawRecord[]> {
        return await this.request.fetchPaginated<RawRecord>(this.sitePath(siteId, `/networks/${encodeURIComponent(networkId)}/vlan/${encodeURIComponent(String(vlan))}/ports`));
    }

    /** Which device links to which port (topologyNodes: upperInfo, wiredUpLink; topologyEdges). OperationId: getTopology (v2) */
    public async getTopology(siteId?: string): Promise<RawRecord> {
        const response = await this.request.get<OmadaApiResponse<RawRecord>>(this.sitePath(siteId, '/topology', 'v2'));
        return this.request.ensureSuccess(response);
    }

    /** mDNS rules: type 1 = gateway (osg.serviceNetworks / clientNetworks), type 0 = access points by VLAN. OperationId: getMdnsGrid */
    public async listMdnsRules(siteId?: string): Promise<RawRecord[]> {
        return await this.request.fetchPaginated<RawRecord>(this.sitePath(siteId, '/setting/service/mdns'));
    }

    /** Body: name, status, profileIds (all required), type, osg. OperationId: modifyMdns */
    public async updateMdnsRule(ruleId: string, body: RawRecord, siteId?: string): Promise<void> {
        await this.send('PATCH', this.sitePath(siteId, `/setting/service/mdns/${encodeURIComponent(ruleId)}`), body);
    }

    // ---- DHCP reservations (net_ reservations; the same calls as omada_setDhcpReservation) -----

    /** Body: netId, mac, ip, description, status, options. */
    public async createDhcpReservation(body: RawRecord, siteId?: string): Promise<void> {
        await this.send('POST', this.sitePath(siteId, '/setting/service/dhcp'), body);
    }

    public async updateDhcpReservation(mac: string, body: RawRecord, siteId?: string): Promise<void> {
        await this.send('PATCH', this.sitePath(siteId, `/setting/service/dhcp/${encodeURIComponent(mac)}`), body);
    }

    public async deleteDhcpReservation(mac: string, siteId?: string): Promise<void> {
        await this.send('DELETE', this.sitePath(siteId, `/setting/service/dhcp/${encodeURIComponent(mac)}`));
    }
}
