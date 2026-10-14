/**
 * Omada adapter for the vendor-neutral network model (src/net/model.ts).
 *
 * 2.4.5 covers networks (LAN networks / VLANs) and Wi-Fi (SSIDs). Rules, groups, switch
 * ports and mDNS arrive with 2.4.6 and 2.4.7; until then those calls fail with
 * NetError UNSUPPORTED.
 *
 * Omada specifics handled here:
 * - networks have no "guest" purpose and no isolation flag in the API (guest is per
 *   SSID), so both are reported unsupported; IPv6 can be switched off but not on;
 * - WPA2/WPA3 mixed mode is not in the API (WPA, WPA2, WPA/WPA2 or WPA3 only);
 * - updating an SSID requires resending its password: the current one is read and sent
 *   back internally and never appears in a plan, step, error or log;
 * - Omada lists every SSID again under a pseudo WLAN group "gateway" without detail.
 */

import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';

import type { OmadaClient } from '../../omadaClient/index.js';
import { formatMac, normalizeMac } from '../../omadaClient/client.js';
import { ALWAYS_PROFILE_NAME } from '../../omadaClient/network.js';
import type { MacGroup } from '../../omadaClient/macGroups.js';
import type { RawRecord } from '../../omadaClient/networkConfig.js';
import { accessControlLockKey, serialize } from '../../omadaClient/serialize.js';
import { inSubnet, ipToNumber } from '../../utils/ipv4.js';
import { redactSecrets } from '../../utils/redact.js';
import {
    NetError,
    type ApplyResult,
    type Band,
    type Capabilities,
    type Change,
    type Client,
    type Network,
    type NetworkController,
    type PassphraseSource,
    type Plan,
    type ProtectedResources,
    type Ref,
    type Reservation,
    type Step,
    type Wifi,
    type WifiSecurity,
} from '../model.js';
import { MAX_NETWORK_NAME, MAX_WIFI_NAME, checkBands, checkDhcp, checkGateway, checkName, checkNetworkUnique, checkVlan } from '../validate.js';

const PSEUDO_WLAN_ID = 'gateway';
/** Omada LAN network purpose: 0 = VLAN only (switches), 1 = interface (routed by the gateway). */
const PURPOSE_VLAN = 0;
const PURPOSE_INTERFACE = 1;
const BAND_BITS: Record<Band, number> = { '2.4': 1, '5': 2, '6': 4 };
/** Listing order (Object.keys would put '5' and '6' before '2.4'). */
const BANDS: Band[] = ['2.4', '5', '6'];
const PMF = { required: 1, optional: 2, off: 3 } as const;
/** WPA-Personal versions (pskSetting.versionPsk); 3 = WPA/WPA2 is not offered by the model. */
const PSK_VERSION = { wpa2: 2, wpa3: 4 } as const;
const SECURITY_NONE = 0;
const SECURITY_WPA_PERSONAL = 3;
const ENCRYPTION_AES = 3;
/** Writable fields of a LAN network (v2 create/modify body). */
const NETWORK_FIELDS = [
    'name', 'purpose', 'interfaceIds', 'vlanType', 'vlans', 'vlan', 'application', 'gatewaySubnet', 'dhcpSettingsVO', 'domain',
    'igmpSnoopEnable', 'mldSnoopEnable', 'dhcpL2RelayEnable', 'dhcpGuard', 'dhcpv6Guard', 'lanNetworkIpv6Config', 'allLan', 'qosQueueEnable', 'queueId',
];
const DHCP_FIELDS = ['enable', 'ipRangePool', 'dhcpns', 'priDns', 'sndDns', 'leasetime', 'gateway', 'dhcpNextServer', 'options'];
/** Writable fields of an SSID's basic config (update-basic-config body). */
const SSID_FIELDS = [
    'name', 'band', 'guestNetEnable', 'security', 'oweEnable', 'broadcast', 'vlanEnable', 'vlanId', 'pskSetting', 'mloEnable', 'pmfMode',
    'enable11r', 'hidePwd', 'greEnable', 'vlanSetting', 'prohibitWifiShare',
];

interface SsidRaw {
    wlanId: string;
    ssidId: string;
    detail: RawRecord;
}

interface Snapshot {
    siteId: string;
    networksRaw: RawRecord[];
    networks: Network[];
    ssids: SsidRaw[];
    clients: Client[];
    macGroups: MacGroup[];
    /** The 24/7 time range omada_setSsidEnabled switches SSIDs off with (absent until first used). */
    alwaysProfileId?: string;
}

/** What plan() hands to apply(): the steps as closures (never serialized, never returned). */
type Executor = (snapshot: Snapshot) => Promise<ApplyResult>;

const pick = (raw: RawRecord, fields: string[]): RawRecord =>
    Object.fromEntries(fields.filter((f) => raw[f] !== undefined).map((f) => [f, raw[f]]));

export interface OmadaAdapterOptions {
    siteId?: string;
    /** The controller's host name or address (host of OMADA_BASE_URL): its network is protected. */
    controllerHost?: string;
    /** Resolves a host name to IPv4 addresses (default: the system resolver). */
    resolveHost?: (host: string) => Promise<string[]>;
}

export class OmadaNetworkController implements NetworkController {
    readonly vendor = 'omada' as const;
    readonly id: string;
    private readonly executors = new WeakMap<Plan, Executor>();
    /** The controller's IPv4 addresses; 'unknown' when its host name can't be resolved (then every routed network is protected). */
    private controllerAddresses: number[] | 'unknown' = [];

    constructor(
        private readonly client: OmadaClient,
        private readonly options: OmadaAdapterOptions = {}
    ) {
        this.id = `omada:${options.siteId ?? 'default'}`;
    }

    async capabilities(): Promise<Capabilities> {
        return {
            vendor: 'omada',
            networks: { create: 'native', isolation: 'unsupported', ipv6: 'unsupported', guestPurpose: 'unsupported' },
            wifi: { create: 'native', bands: ['2.4', '5', '6'], security: ['open', 'wpa2', 'wpa3'], pmf: 'native', fastRoaming: 'native', bandSteering: 'unsupported' },
            ports: { profiles: 'unsupported', assign: 'unsupported' },
            rules: { between: 'unsupported', toInternet: 'unsupported', deviceMatch: 'unsupported', wifiMatch: 'unsupported', stateful: 'unsupported', schedule: 'unsupported' },
            groups: { address: 'unsupported', mac: 'unsupported' },
            reservations: 'native',
            mdnsRepeater: 'unsupported',
        };
    }

    // ---- reads -----------------------------------------------------------------------

    private async resolveController(): Promise<void> {
        const host = this.options.controllerHost;
        if (!host) {
            this.controllerAddresses = [];
            return;
        }
        try {
            this.controllerAddresses = [ipToNumber(host)];
            return;
        } catch {
            // a host name
        }
        try {
            const resolve = this.options.resolveHost ?? (async (name: string) => (await lookup(name, { all: true, family: 4 })).map((a) => a.address));
            const addresses = await resolve(host);
            this.controllerAddresses = addresses.length ? addresses.map(ipToNumber) : 'unknown';
        } catch {
            this.controllerAddresses = 'unknown';
        }
    }

    private async snapshot(): Promise<Snapshot> {
        await this.resolveController();
        const siteId = this.client.resolveSiteId(this.options.siteId);
        const networksRaw = await this.client.networkConfig.listLanNetworks(siteId);
        const networks = networksRaw.map((raw) => this.toNetwork(raw));
        const ssids: SsidRaw[] = [];
        const seen = new Set<string>();
        for (const wlan of await this.client.networkConfig.listSsidSummaries(siteId)) {
            if (wlan.wlanId === PSEUDO_WLAN_ID) continue;
            for (const s of wlan.ssidList ?? []) {
                if (seen.has(s.ssidId)) continue;
                seen.add(s.ssidId);
                ssids.push({ wlanId: wlan.wlanId, ssidId: s.ssidId, detail: await this.client.networkConfig.getSsidDetail(wlan.wlanId, s.ssidId, siteId) });
            }
        }
        const clients = (await this.client.listClients(siteId)).map((c) => this.toClient(c as RawRecord, networks));
        const alwaysProfileId = (await this.client.accessControl.listTimeRanges(siteId)).find((p) => p.name === ALWAYS_PROFILE_NAME)?.profileId;
        const macGroups = await this.client.listMacGroups(siteId);
        return { siteId, networksRaw, networks, ssids, clients, macGroups, ...(alwaysProfileId ? { alwaysProfileId } : {}) };
    }

    private toNetwork(raw: RawRecord): Network {
        const dhcp = (raw.dhcpSettingsVO ?? {}) as RawRecord;
        const pool = ((dhcp.ipRangePool as RawRecord[] | undefined) ?? [])[0];
        const purpose = raw.purpose === PURPOSE_VLAN ? 'vlanOnly' : 'normal';
        const gateway = typeof raw.gatewaySubnet === 'string' ? raw.gatewaySubnet : undefined;
        return {
            id: String(raw.id),
            name: String(raw.name),
            purpose,
            vlan: Number(raw.vlan ?? 1),
            ...(gateway ? { gateway } : {}),
            ...(purpose === 'normal'
                ? {
                      dhcp: {
                          enabled: dhcp.enable === true,
                          ...(pool ? { range: { from: String(pool.ipaddrStart), to: String(pool.ipaddrEnd) } } : {}),
                          ...(typeof dhcp.leasetime === 'number' ? { leaseMinutes: dhcp.leasetime } : {}),
                          ...(dhcp.dhcpns === 'manual' ? { dns: [dhcp.priDns, dhcp.sndDns].filter((d): d is string => typeof d === 'string' && d !== '') } : {}),
                      },
                  }
                : {}),
            ipv6: (raw.lanNetworkIpv6Config as RawRecord | undefined)?.enable === 1,
            isolated: false,
            protected: this.isProtected(raw),
        };
    }

    private isProtected(raw: RawRecord): boolean {
        if (raw.primary === true) return true;
        if (typeof raw.gatewaySubnet !== 'string') return false;
        // Fail closed: if the controller's address is unknown, any routed network could be its own.
        if (this.controllerAddresses === 'unknown') return true;
        const subnet = raw.gatewaySubnet;
        return this.controllerAddresses.some((address) => inSubnet(address, subnet));
    }

    private toClient(raw: RawRecord, networks: Network[]): Client {
        // A device still waiting for DHCP reports no (or an empty) address.
        const ip = typeof raw.ip === 'string' && isIpv4(raw.ip) ? raw.ip : undefined;
        let network: Network | undefined;
        if (typeof raw.vid === 'number') network = networks.find((n) => n.vlan === raw.vid);
        if (!network && ip) network = networks.find((n) => n.gateway && inSubnet(ipToNumber(ip), n.gateway));
        return {
            mac: formatMac(String(raw.mac)),
            ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
            ...(ip ? { ip } : {}),
            ...(network ? { network: { id: network.id } } : {}),
            ...(typeof raw.ssid === 'string' && raw.ssid ? { wifi: { name: raw.ssid } } : {}),
            online: raw.active !== false,
        };
    }

    private toWifi(ssid: SsidRaw, networks: Network[], macGroups: Array<{ groupId: string; name: string }>, alwaysProfileId?: string): Wifi {
        const d = ssid.detail;
        const psk = (d.pskSetting ?? {}) as RawRecord;
        const security = securityOf(d, psk);
        const band = Number(d.band ?? 0);
        const filter = (d.macFilter ?? {}) as RawRecord;
        const group = macGroups.find((g) => g.groupId === filter.macFilterId);
        return {
            id: ssid.ssidId,
            name: String(d.name),
            network: { id: this.ssidNetwork(d, networks)?.id ?? '' },
            bands: BANDS.filter((b) => (band & BAND_BITS[b]) !== 0),
            security,
            pmf: d.pmfMode === PMF.required ? 'required' : d.pmfMode === PMF.off ? 'off' : 'optional',
            clientIsolation: d.guestNetEnable === true,
            hidden: d.broadcast === false,
            fastRoaming: d.enable11r === true,
            macFilter: filter.macFilterEnable ? { policy: filter.policy === 1 ? 'allow' : 'deny', group: group ? { id: group.groupId } : { id: String(filter.macFilterId) } } : null,
            // Omada has no on/off flag: omada_setSsidEnabled switches an SSID off with a radio-off WLAN schedule on the 24/7 profile.
            enabled: d.ssidEnable !== false && !radioOffAlways(d, alwaysProfileId),
        };
    }

    /** The network an SSID puts its clients on: its custom VLAN mapping, else the untagged primary network. */
    private ssidNetwork(detail: RawRecord, networks: Network[]): Network | undefined {
        const setting = (detail.vlanSetting ?? {}) as RawRecord;
        const mapped = (setting.customConfig as RawRecord | undefined)?.lanNetworkVlanIds as Record<string, unknown> | undefined;
        if (setting.mode === 1 && mapped) {
            const id = Object.keys(mapped)[0];
            const found = networks.find((n) => n.id === id);
            if (found) return found;
        }
        if (detail.vlanEnable === true && typeof detail.vlanId === 'number') return networks.find((n) => n.vlan === detail.vlanId);
        return networks.find((n) => n.vlan === 1) ?? networks.find((n) => n.protected);
    }

    /** Every network an SSID puts devices on (Omada can map one SSID to several). */
    private ssidNetworkIds(detail: RawRecord, networks: Network[]): string[] {
        const setting = (detail.vlanSetting ?? {}) as RawRecord;
        const mapped = (setting.customConfig as RawRecord | undefined)?.lanNetworkVlanIds as Record<string, unknown> | undefined;
        const ids = setting.mode === 1 && mapped ? Object.keys(mapped) : [];
        const single = this.ssidNetwork(detail, networks)?.id;
        return [...new Set([...ids, ...(single ? [single] : [])])];
    }

    async protectedResources(): Promise<ProtectedResources> {
        const networks = (await this.snapshot()).networks.filter((n) => n.protected);
        return { networks: networks.map((n) => ({ id: n.id })), ports: [], devices: [] };
    }

    async listNetworks(): Promise<Network[]> {
        return (await this.snapshot()).networks;
    }

    async listWifi(): Promise<Wifi[]> {
        const snap = await this.snapshot();
        const groups = snap.macGroups;
        return snap.ssids.map((s) => this.toWifi(s, snap.networks, groups, snap.alwaysProfileId));
    }

    async listClients(): Promise<Client[]> {
        return (await this.snapshot()).clients;
    }

    async listReservations(): Promise<Reservation[]> {
        const rows = await this.client.accessControl.listDhcpReservations(this.options.siteId);
        return rows
            .filter((r) => typeof r.ip === 'string')
            .map((r) => ({ mac: formatMac(r.mac), ip: String(r.ip), network: { id: r.netId }, ...(r.description ? { description: String(r.description) } : {}) }));
    }

    async listPortProfiles(): Promise<never> {
        throw notYet('switch port profiles', '2.4.7');
    }
    async listPorts(): Promise<never> {
        throw notYet('switch ports', '2.4.7');
    }
    async listRules(): Promise<never> {
        throw notYet('rules', '2.4.6');
    }
    async listGroups(): Promise<never> {
        throw notYet('groups', '2.4.6');
    }
    async getMdnsRepeater(): Promise<never> {
        throw notYet('the mDNS repeater', '2.4.7');
    }

    // ---- plan / apply ------------------------------------------------------------------

    async plan(change: Change): Promise<Plan> {
        return await this.planWith(change, await this.snapshot());
    }

    async apply(plan: Plan, options: { allowLockout?: boolean } = {}): Promise<ApplyResult> {
        const siteId = this.client.resolveSiteId(this.options.siteId);
        // One write at a time per site, shared with the Omada access control tools.
        return await serialize(accessControlLockKey(siteId), async () => {
            const snap = await this.snapshot();
            const fresh = await this.planWith(plan.change, snap);
            if (fresh.basis !== plan.basis) {
                throw new NetError('CONFLICT', 'The controller changed after this change was planned; nothing was written. Plan it again.');
            }
            if (fresh.wouldLockOut.length > 0 && !options.allowLockout) {
                throw new NetError('LOCKOUT', `This would cut off ${fresh.wouldLockOut.length} online device(s): ${describeClients(fresh.wouldLockOut)}. Nothing was changed; repeat with allowLockout if that is intended.`, {
                    clients: fresh.wouldLockOut,
                });
            }
            const execute = this.executors.get(fresh);
            if (!execute) throw new NetError('INVALID', 'Nothing to apply');
            return await execute(snap);
        });
    }

    private async planWith(change: Change, snap: Snapshot): Promise<Plan> {
        const built = await this.build(change, snap);
        const plan: Plan = {
            change: redactSecrets(change),
            vendor: 'omada',
            steps: built.steps,
            effects: built.effects,
            wouldLockOut: built.wouldLockOut,
            basis: fingerprint(snap, built.reads),
        };
        this.executors.set(plan, built.execute);
        return plan;
    }

    private async build(change: Change, snap: Snapshot): Promise<Built> {
        switch (change.kind) {
            case 'network':
                if (change.op === 'create') return this.buildNetworkCreate(change.value, snap);
                if (change.op === 'update') return this.buildNetworkUpdate(change.value.ref, change.value.set, snap);
                if (change.op === 'delete') return await this.buildNetworkDelete(change.ref, snap);
                break;
            case 'wifi':
                if (change.op === 'create') return await this.buildWifiCreate(change.value, snap);
                if (change.op === 'update') return await this.buildWifiUpdate(change.value.ref, change.value.set, change.passphrase, snap);
                if (change.op === 'delete') return this.buildWifiDelete(change.ref, snap);
                break;
            default:
                throw notYet(`${change.kind} changes`, change.kind === 'rule' || change.kind === 'group' ? '2.4.6' : change.kind === 'reservation' ? 'a later release (use omada_setDhcpReservation)' : '2.4.7');
        }
        throw new NetError('INVALID', 'This change is not supported');
    }

    // ---- networks ------------------------------------------------------------------------

    private buildNetworkCreate(value: Extract<Change, { op: 'create'; kind: 'network' }>['value'], snap: Snapshot): Built {
        const name = checkName(value.name, MAX_NETWORK_NAME, 'Network');
        if (value.purpose === 'guest') throw unsupported('a guest network type (Omada makes a Wi-Fi network a guest network instead: clientIsolation)', 'networks.guestPurpose');
        if (value.isolated) throw unsupported('network isolation (it comes as rules in 2.4.6)', 'networks.isolation');
        if (value.ipv6) throw unsupported('switching IPv6 on (do it in the controller web UI)', 'networks.ipv6');
        const vlan = checkVlan(value.vlan);
        const vlanOnly = value.purpose === 'vlanOnly';
        if (vlanOnly && (value.gateway !== undefined || value.dhcp?.enabled)) {
            throw new NetError('INVALID', 'A switch-only network has no gateway and no DHCP; leave them out, or use purpose normal');
        }
        const gateway = vlanOnly ? undefined : checkGateway(value.gateway ?? '');
        const dhcp = vlanOnly || !gateway ? undefined : checkDhcp(gateway, value.dhcp ?? { enabled: false });
        checkNetworkUnique({ name, vlan, gateway }, snap.networks);

        const primary = snap.networksRaw.find((n) => n.primary === true);
        const body: RawRecord = {
            name,
            purpose: vlanOnly ? PURPOSE_VLAN : PURPOSE_INTERFACE,
            vlan,
            igmpSnoopEnable: false,
            ...(vlanOnly
                ? {}
                : {
                      // Carried on the same gateway LAN ports as the primary network.
                      interfaceIds: (primary?.interfaceIds as string[] | undefined) ?? [],
                      vlanType: 0,
                      application: 0,
                      gatewaySubnet: gateway,
                      dhcpSettingsVO: dhcpBody(dhcp),
                      mldSnoopEnable: false,
                      dhcpL2RelayEnable: false,
                      dhcpGuard: { enable: false },
                      dhcpv6Guard: { enable: false },
                      lanNetworkIpv6Config: { proto: 0, enable: 0 },
                  }),
        };
        return {
            steps: [{ action: 'create', object: 'omada.lanNetwork', name, detail: vlanOnly ? `VLAN ${vlan}, switches only` : `VLAN ${vlan}, ${gateway}` }],
            effects: [
                vlanOnly ? `New VLAN ${vlan} '${name}' on the switches (no gateway address).` : `New network '${name}': VLAN ${vlan}, gateway ${gateway}, DHCP ${dhcp?.enabled ? `${dhcp.range?.from}-${dhcp.range?.to}` : 'off'}, IPv6 off.`,
                'No device is on it yet: a Wi-Fi network or a switch port must carry this VLAN first.',
            ],
            wouldLockOut: [],
            reads: { networks: true },
            execute: async (s) => {
                await this.client.networkConfig.createLanNetwork(body, s.siteId);
                const created = (await this.client.networkConfig.listLanNetworks(s.siteId)).find((n) => n.name === name);
                if (!created) throw new NetError('NOT_FOUND', `Created network '${name}' but could not find it again`);
                return { applied: true, object: this.toNetwork(created), owned: [] };
            },
        };
    }

    private buildNetworkUpdate(ref: Ref, set: Partial<Omit<Network, 'id' | 'protected'>>, snap: Snapshot): Built {
        const current = resolve(snap.networks, ref, 'network');
        const raw = snap.networksRaw.find((n) => String(n.id) === current.id)!;
        if (set.purpose !== undefined && set.purpose !== current.purpose) throw new NetError('INVALID', 'A network\'s purpose can\'t change; create a new network instead');
        if (current.purpose === 'vlanOnly' && (set.gateway !== undefined || set.dhcp !== undefined)) {
            throw new NetError('INVALID', `'${current.name}' is switch-only: it has no gateway and no DHCP to change`);
        }
        if (set.isolated) throw unsupported('network isolation (it comes as rules in 2.4.6)', 'networks.isolation');
        if (set.ipv6 === true && !current.ipv6) throw unsupported('switching IPv6 on (do it in the controller web UI)', 'networks.ipv6');
        const addressing = (set.vlan !== undefined && set.vlan !== current.vlan) || (set.gateway !== undefined && set.gateway !== current.gateway);
        if (current.protected && addressing) {
            throw new NetError('PROTECTED', `'${current.name}' carries the controller or the primary network; its VLAN and gateway can't be changed here`);
        }
        const name = set.name !== undefined ? checkName(set.name, MAX_NETWORK_NAME, 'Network') : current.name;
        const vlan = set.vlan !== undefined ? checkVlan(set.vlan) : current.vlan;
        const gateway = set.gateway !== undefined ? checkGateway(set.gateway) : current.gateway;
        const others = snap.networks.filter((n) => n.id !== current.id);
        checkNetworkUnique({ name: name !== current.name ? name : undefined, vlan: vlan !== current.vlan ? vlan : undefined, gateway: gateway !== current.gateway ? gateway : undefined }, others);
        // An update names only what changes: the rest of the current DHCP settings (range, lease, DNS) stays.
        // Every address pool the network has (Omada allows several; the model shows the first).
        const pools = ((((raw.dhcpSettingsVO ?? {}) as RawRecord).ipRangePool as RawRecord[] | undefined) ?? []).map((p) => ({ from: String(p.ipaddrStart), to: String(p.ipaddrEnd) }));
        // An update names only what changes: unmentioned DHCP settings, and all pools unless a range is given, stay.
        let dhcp: Network['dhcp'] | undefined;
        if (set.dhcp !== undefined && gateway) {
            if (set.dhcp.enabled) {
                const ranges = set.dhcp.range ? [set.dhcp.range] : pools;
                if (ranges.length === 0) checkDhcp(gateway, set.dhcp); // refuses: DHCP on without a range
                for (const range of ranges) checkDhcp(gateway, { ...current.dhcp, ...set.dhcp, range });
                dhcp = set.dhcp;
            } else {
                dhcp = { enabled: false };
            }
        }
        if (set.dhcp === undefined && gateway !== current.gateway && gateway && current.dhcp?.enabled) {
            // The kept pools are sent again as they are: each must fit the new subnet.
            for (const range of pools) {
                try {
                    checkDhcp(gateway, { enabled: true, range });
                } catch {
                    throw new NetError('INVALID', `The current DHCP range ${range.from}-${range.to} doesn't fit ${gateway}; give a new range with the gateway`);
                }
            }
        }

        const body: RawRecord = { ...pick(raw, NETWORK_FIELDS), name, vlan };
        if (gateway) body.gatewaySubnet = gateway;
        const keptDhcp = pick((raw.dhcpSettingsVO ?? {}) as RawRecord, DHCP_FIELDS);
        if (gateway && current.gateway && gateway !== current.gateway && typeof keptDhcp.gateway === 'string' && keptDhcp.gateway !== '') {
            // The router address DHCP hands out: follow the interface when it was the interface, else it must fit.
            const oldIp = current.gateway.split('/')[0];
            const newIp = gateway.split('/')[0];
            if (keptDhcp.gateway === oldIp) keptDhcp.gateway = newIp;
            else if (!isIpv4(keptDhcp.gateway) || !inSubnet(ipToNumber(keptDhcp.gateway), gateway)) {
                throw new NetError('INVALID', `The DHCP gateway ${keptDhcp.gateway} is outside ${gateway}; change it in the controller web UI first`);
            }
        }
        if (dhcp?.dns !== undefined) {
            // Given DNS servers replace the kept ones (an empty list = automatic).
            delete keptDhcp.priDns;
            delete keptDhcp.sndDns;
        }
        body.dhcpSettingsVO = dhcp ? { ...keptDhcp, ...dhcpBody(dhcp, keptDhcp) } : keptDhcp;
        if (set.ipv6 === false && current.ipv6) body.lanNetworkIpv6Config = { proto: 0, enable: 0 };

        const disruptive = addressing || (dhcp !== undefined && !dhcp.enabled && current.dhcp?.enabled === true);
        // Devices relying on IPv6 lose their connection when it is switched off.
        const ipv6Off = set.ipv6 === false && current.ipv6;
        const affected = disruptive || ipv6Off ? snap.clients.filter((c) => c.online && c.network && 'id' in c.network && c.network.id === current.id) : [];
        const changes = describeNetworkChanges(current, { name, vlan, gateway, dhcp, ipv6: set.ipv6 });
        if (changes.length === 0) throw new NetError('INVALID', `Nothing to change on '${current.name}'`);
        return {
            steps: [{ action: 'update', object: 'omada.lanNetwork', name: current.name, detail: changes.join('; ') }],
            effects: [
                `'${current.name}': ${changes.join('; ')}.`,
                ...(disruptive ? ['Devices on this network lose their address until they reconnect.'] : []),
                ...(ipv6Off ? ['Devices on this network lose their IPv6 addresses; IPv4 keeps working.'] : []),
            ],
            wouldLockOut: affected,
            reads: { networks: true },
            execute: async (s) => {
                await this.client.networkConfig.updateLanNetwork(current.id, body, s.siteId);
                const after = (await this.client.networkConfig.listLanNetworks(s.siteId)).find((n) => String(n.id) === current.id);
                return { applied: true, ...(after ? { object: this.toNetwork(after) } : {}), owned: [] };
            },
        };
    }

    private async buildNetworkDelete(ref: Ref, snap: Snapshot): Promise<Built> {
        const current = resolve(snap.networks, ref, 'network');
        if (current.protected) throw new NetError('PROTECTED', `'${current.name}' carries the controller or the primary network and can't be deleted`);
        const users = await this.networkUsers(current, snap);
        if (users.length) throw new NetError('IN_USE', `'${current.name}' is used by ${users.join(', ')}; change those first`, { users });
        const affected = snap.clients.filter((c) => c.online && c.network && 'id' in c.network && c.network.id === current.id);
        return {
            steps: [{ action: 'delete', object: 'omada.lanNetwork', name: current.name }],
            effects: [`Network '${current.name}' (VLAN ${current.vlan}) is removed.`],
            wouldLockOut: affected,
            reads: { networks: true },
            execute: async (s) => {
                await this.client.networkConfig.deleteLanNetwork(current.id, s.siteId);
                return { applied: true, owned: [] };
            },
        };
    }

    /** Everything that still references a network: SSIDs, port profiles, DHCP reservations, ACL rules. */
    private async networkUsers(network: Network, snap: Snapshot): Promise<string[]> {
        const users: string[] = [];
        for (const s of snap.ssids) if (this.ssidNetworkIds(s.detail, snap.networks).includes(network.id)) users.push(`Wi-Fi '${String(s.detail.name)}'`);
        for (const p of await this.client.networkConfig.listLanProfiles(snap.siteId)) {
            const ids = [p.nativeNetworkId, ...((p.tagNetworkIds as string[] | undefined) ?? []), ...((p.untagNetworkIds as string[] | undefined) ?? [])];
            if (ids.includes(network.id)) users.push(`port profile '${String(p.name)}'`);
        }
        for (const r of await this.client.accessControl.listDhcpReservations(snap.siteId)) if (r.netId === network.id) users.push(`DHCP reservation ${formatMac(r.mac)}`);
        for (const [kind, list] of [['gateway', 'osg-acls'], ['switch', 'osw-acls'], ['access point', 'eap-acls']] as const) {
            for (const a of await this.client.networkConfig.listAcls(list, snap.siteId)) {
                const ids = [...(a.sourceType === 0 ? ((a.sourceIds as string[]) ?? []) : []), ...(a.destinationType === 0 ? ((a.destinationIds as string[]) ?? []) : [])];
                if (ids.includes(network.id)) users.push(`${kind} rule '${String(a.description)}'`);
            }
        }
        return users;
    }

    // ---- Wi-Fi -------------------------------------------------------------------------------

    private async buildWifiCreate(value: Extract<Change, { op: 'create'; kind: 'wifi' }>['value'], snap: Snapshot): Promise<Built> {
        const name = checkName(value.name, MAX_WIFI_NAME, 'Wi-Fi');
        if (snap.ssids.some((s) => String(s.detail.name).toLowerCase() === name.toLowerCase())) throw new NetError('EXISTS', `A Wi-Fi network named '${name}' already exists`);
        if (value.enabled === false) throw unsupported('creating a Wi-Fi network switched off (use omada_setSsidEnabled afterwards)', 'wifi.create');
        const network = wifiNetwork(snap.networks, value.network);
        const wlanId = snap.ssids[0]?.wlanId ?? (await this.client.networkConfig.listSsidSummaries(snap.siteId)).find((w) => w.wlanId !== PSEUDO_WLAN_ID)?.wlanId;
        if (!wlanId) throw new NetError('NOT_FOUND', 'No WLAN group to add the Wi-Fi network to');
        const template = snap.ssids[0]?.detail;
        const macFilter = value.macFilter ? await this.macFilterBody(value.macFilter, snap) : undefined;

        const body: RawRecord = {
            name,
            deviceType: typeof template?.deviceType === 'number' ? template.deviceType : 1,
            band: bandBits(checkBands(value.bands)),
            guestNetEnable: value.clientIsolation,
            broadcast: !value.hidden,
            mloEnable: false,
            pmfMode: PMF[value.pmf],
            enable11r: value.fastRoaming,
            hidePwd: true,
            // An open network with a MAC filter is created locked (WPA2, a password nobody knows) and only
            // opened once the filter is in place, so it is never open without its filter.
            ...securityBody(value.security === 'open' && macFilter ? 'wpa2' : value.security, value.security === 'open' && !macFilter ? undefined : temporaryPassphrase()),
            ...vlanBody(network),
        };
        const openAfterFilter = value.security === 'open' && macFilter !== undefined;
        return {
            steps: [
                { action: 'create', object: 'omada.ssid', name, detail: `on '${network.name}' (VLAN ${network.vlan}), ${value.security}, bands ${value.bands.join('/')}` },
                ...(macFilter ? [{ action: 'update' as const, object: 'omada.ssidMacFilter', name, detail: macFilter.summary }] : []),
                ...(openAfterFilter ? [{ action: 'update' as const, object: 'omada.ssid', name, detail: 'security → open (after the filter is in place)' }] : []),
            ],
            effects: [
                `New Wi-Fi '${name}' on network '${network.name}'.`,
                ...(value.security === 'open'
                    ? ['It is open: anyone in range can join.']
                    : [`It gets a random temporary password nobody knows, so nobody can join yet: set the real password in the controller web UI (Network Config → WLAN → ${name}).`]),
                ...(value.clientIsolation ? ['Omada guest mode: devices on it can\'t reach each other or private networks.'] : []),
            ],
            wouldLockOut: [],
            reads: { networks: true, ssids: true, macGroups: macFilter !== undefined },
            execute: async (s) => {
                await this.client.networkConfig.createSsid(wlanId, body, s.siteId);
                const created = (await this.client.networkConfig.listSsidSummaries(s.siteId))
                    .filter((w) => w.wlanId !== PSEUDO_WLAN_ID)
                    .flatMap((w) => (w.ssidList ?? []).map((x) => ({ wlanId: w.wlanId, ...x })))
                    .find((x) => x.ssidName === name);
                if (!created) throw new NetError('NOT_FOUND', `Created Wi-Fi '${name}' but could not find it again`);
                if (macFilter) await this.client.networkConfig.updateSsidMacFilter(created.wlanId, created.ssidId, macFilter.body, s.siteId);
                if (openAfterFilter) {
                    const locked = await this.client.networkConfig.getSsidDetail(created.wlanId, created.ssidId, s.siteId);
                    const open: RawRecord = { ...pick(locked, SSID_FIELDS), security: SECURITY_NONE };
                    delete open.pskSetting;
                    await this.client.networkConfig.updateSsidBasic(created.wlanId, created.ssidId, open, s.siteId);
                }
                const detail = await this.client.networkConfig.getSsidDetail(created.wlanId, created.ssidId, s.siteId);
                return { applied: true, object: this.toWifi({ wlanId: created.wlanId, ssidId: created.ssidId, detail }, s.networks, await this.client.listMacGroups(s.siteId), s.alwaysProfileId), owned: [] };
            },
        };
    }

    private async buildWifiUpdate(ref: Ref, set: Partial<Omit<Wifi, 'id'>>, passphrase: PassphraseSource | undefined, snap: Snapshot): Promise<Built> {
        const ssid = resolveSsid(snap.ssids, ref);
        const groups = snap.macGroups;
        const current = this.toWifi(ssid, snap.networks, groups, snap.alwaysProfileId);
        if (set.enabled !== undefined && set.enabled !== current.enabled) throw unsupported('switching a Wi-Fi network on or off here (use omada_setSsidEnabled)', 'wifi.enabled');
        // RADIUS and per-device keys can't be resent through the basic config without losing them.
        if ((current.security === 'enterprise' || current.security === 'ppsk') && set.security === undefined) {
            throw new NetError('INVALID', `'${current.name}' uses ${current.security} security, which these tools can't keep; change it in the controller web UI`);
        }
        const raw = ssid.detail;
        const body = pick(raw, SSID_FIELDS);
        const changes: string[] = [];
        let disconnects = false;
        let isolates = false;

        if (set.name !== undefined && set.name !== current.name) {
            const name = checkName(set.name, MAX_WIFI_NAME, 'Wi-Fi');
            if (snap.ssids.some((s) => s.ssidId !== ssid.ssidId && String(s.detail.name).toLowerCase() === name.toLowerCase())) throw new NetError('EXISTS', `A Wi-Fi network named '${name}' already exists`);
            body.name = name;
            changes.push(`name → ${name}`);
            disconnects = true;
        }
        if (set.bands !== undefined && bandBits(checkBands(set.bands)) !== Number(raw.band)) {
            body.band = bandBits(set.bands);
            changes.push(`bands → ${set.bands.join('/')}`);
            disconnects = true;
        }
        if (set.network !== undefined) {
            const network = wifiNetwork(snap.networks, set.network);
            // Compare with every network the SSID maps to: narrowing a multi-network mapping is a change too.
            const mapped = this.ssidNetworkIds(raw, snap.networks);
            if (mapped.length !== 1 || mapped[0] !== network.id) {
                Object.assign(body, vlanBody(network));
                changes.push(`network → ${network.name}`);
                disconnects = true;
            }
        }
        const rotate = passphrase?.kind === 'temporary';
        let temporaryKey = false;
        if ((set.security !== undefined && set.security !== current.security) || rotate) {
            const security = set.security ?? current.security;
            const existingKey = ((raw.pskSetting ?? {}) as RawRecord).securityKey;
            // No shared password to keep (open, Enterprise, PPSK, or none stored): a temporary one nobody knows.
            temporaryKey = security !== 'open' && (rotate || typeof existingKey !== 'string' || existingKey === '' || ['open', 'enterprise', 'ppsk'].includes(current.security));
            const key = security === 'open' ? undefined : temporaryKey ? temporaryPassphrase() : (existingKey as string);
            Object.assign(body, securityBody(security, key));
            changes.push(rotate ? 'new temporary password' : `security → ${security}`);
            disconnects = true;
        }
        const toggles: Array<['pmf' | 'clientIsolation' | 'hidden' | 'fastRoaming', string, unknown]> = [
            ['pmf', 'pmfMode', set.pmf !== undefined ? PMF[set.pmf] : undefined],
            ['clientIsolation', 'guestNetEnable', set.clientIsolation],
            ['hidden', 'broadcast', set.hidden !== undefined ? !set.hidden : undefined],
            ['fastRoaming', 'enable11r', set.fastRoaming],
        ];
        for (const [key, field, value] of toggles) {
            if (value !== undefined && value !== raw[field]) {
                body[field] = value;
                changes.push(`${key} → ${String(set[key])}`);
                // Devices without PMF support can't join a "required" SSID: treat any PMF change as disconnecting.
                if (key === 'pmf') disconnects = true;
                // Omada guest mode also cuts devices off from every private network (e.g. Home Assistant).
                if (key === 'clientIsolation' && value === true) isolates = true;
            }
        }
        const macFilter = set.macFilter !== undefined ? await this.macFilterChange(set.macFilter, current, snap) : undefined;
        if (changes.length === 0 && !macFilter) throw new NetError('INVALID', `Nothing to change on '${current.name}'`);

        const connected = snap.clients.filter((c) => c.online && c.wifi && 'name' in c.wifi && c.wifi.name === current.name);
        const lockOut = disconnects || isolates ? connected : macFilter?.lockOut(connected) ?? [];
        return {
            steps: [
                ...(changes.length ? [{ action: 'update' as const, object: 'omada.ssid', name: current.name, detail: changes.join('; ') }] : []),
                ...(macFilter ? [{ action: 'update' as const, object: 'omada.ssidMacFilter', name: current.name, detail: macFilter.summary }] : []),
            ],
            effects: [
                ...(changes.length ? [`'${current.name}': ${changes.join('; ')}.`] : []),
                ...(macFilter ? [`'${current.name}' MAC filter: ${macFilter.summary}.`] : []),
                ...(disconnects ? ['Every device on it is disconnected and must join again.'] : []),
                ...(isolates ? ['Omada guest mode: devices on it lose access to each other and to every private network (e.g. Home Assistant).'] : []),
                ...(temporaryKey
                    ? [`A random temporary password nobody knows was set: set the real password in the controller web UI (Network Config → WLAN → ${String(body.name ?? current.name)}).`]
                    : []),
            ],
            wouldLockOut: lockOut,
            reads: { networks: true, ssids: true, macGroups: macFilter !== undefined },
            execute: async (s) => {
                // Whenever the SSID ends up open (opened, or moved while open), its new filter goes in first.
                const opening = body.security === SECURITY_NONE;
                if (opening && macFilter) await this.client.networkConfig.updateSsidMacFilter(ssid.wlanId, ssid.ssidId, macFilter.body, s.siteId);
                if (changes.length) await this.client.networkConfig.updateSsidBasic(ssid.wlanId, ssid.ssidId, body, s.siteId);
                if (!opening && macFilter) await this.client.networkConfig.updateSsidMacFilter(ssid.wlanId, ssid.ssidId, macFilter.body, s.siteId);
                const detail = await this.client.networkConfig.getSsidDetail(ssid.wlanId, ssid.ssidId, s.siteId);
                return { applied: true, object: this.toWifi({ ...ssid, detail }, s.networks, await this.client.listMacGroups(s.siteId), s.alwaysProfileId), owned: [] };
            },
        };
    }

    private buildWifiDelete(ref: Ref, snap: Snapshot): Built {
        const ssid = resolveSsid(snap.ssids, ref);
        const name = String(ssid.detail.name);
        if (snap.ssids.length === 1) throw new NetError('PROTECTED', `'${name}' is the only Wi-Fi network; it can't be deleted here`);
        const connected = snap.clients.filter((c) => c.online && c.wifi && 'name' in c.wifi && c.wifi.name === name);
        return {
            steps: [{ action: 'delete', object: 'omada.ssid', name }],
            effects: [`Wi-Fi '${name}' is removed; its devices are disconnected.`],
            wouldLockOut: connected,
            reads: { ssids: true },
            execute: async (s) => {
                await this.client.networkConfig.deleteSsid(ssid.wlanId, ssid.ssidId, s.siteId);
                return { applied: true, owned: [] };
            },
        };
    }

    private async macFilterBody(filter: NonNullable<Wifi['macFilter']>, snap: Snapshot) {
        const groups = snap.macGroups;
        const group = resolve(groups.map((g) => ({ ...g, id: g.groupId })), filter.group, 'MAC group');
        return {
            body: { macFilterEnable: true, policy: filter.policy === 'allow' ? 1 : 0, macFilterId: group.groupId },
            summary: `${filter.policy} list = ${group.name}`,
            members: new Set((group.macAddressList ?? []).map((e) => normalizeMac(e.macAddress))),
            policy: filter.policy,
        };
    }

    private async macFilterChange(filter: Wifi['macFilter'], current: Wifi, snap: Snapshot) {
        if (filter === null) {
            if (!current.macFilter) return undefined;
            return { body: { macFilterEnable: false }, summary: 'off', lockOut: () => [] as Client[] };
        }
        if (!filter) return undefined;
        const built = await this.macFilterBody(filter, snap);
        return {
            body: built.body,
            summary: built.summary,
            lockOut: (connected: Client[]) =>
                connected.filter((c) => (built.policy === 'allow' ? !built.members.has(normalizeMac(c.mac)) : built.members.has(normalizeMac(c.mac)))),
        };
    }
}

interface Built {
    steps: Step[];
    effects: string[];
    wouldLockOut: Client[];
    /** Which parts of the snapshot the plan depends on (the fingerprint covers only those). */
    reads: { networks?: boolean; ssids?: boolean; macGroups?: boolean };
    execute: Executor;
}

// ---- helpers -----------------------------------------------------------------------------

function notYet(what: string, release: string): NetError {
    return new NetError('UNSUPPORTED', `Changing ${what} through the net_ tools arrives in ${release}`, { capability: what });
}

function unsupported(what: string, capability: string): NetError {
    return new NetError('UNSUPPORTED', `Omada can't do ${what} through its API`, { capability });
}

function resolve<T extends { id: string; name: string }>(items: T[], ref: Ref, what: string): T {
    if ('id' in ref) {
        const byId = items.find((i) => i.id === ref.id);
        if (byId) return byId;
        throw new NetError('NOT_FOUND', `No ${what} with id '${ref.id}'`);
    }
    // Tools pass what the user typed as { name }; an exact id match wins.
    const byId = items.find((i) => i.id === ref.name);
    if (byId) return byId;
    const wanted = ref.name.trim().toLowerCase();
    const matches = items.filter((i) => i.name.toLowerCase() === wanted);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new NetError('AMBIGUOUS', `Several ${what}s are named '${ref.name}'; use the id`);
    throw new NetError('NOT_FOUND', `${what[0].toUpperCase()}${what.slice(1)} '${ref.name}' not found. Available: ${items.map((i) => i.name).join(', ') || '(none)'}`);
}

/** The network a Wi-Fi network may put its devices on: one with a gateway (and so an address for them). */
function wifiNetwork(networks: Network[], ref: Ref): Network {
    const network = resolve(networks, ref, 'network');
    if (network.purpose === 'vlanOnly') throw new NetError('INVALID', `'${network.name}' is switch-only (no gateway, no DHCP); Wi-Fi clients would get no address`);
    return network;
}

function isIpv4(value: string): boolean {
    try {
        ipToNumber(value);
        return true;
    } catch {
        return false;
    }
}

function resolveSsid(ssids: SsidRaw[], ref: Ref): SsidRaw {
    return resolve(ssids.map((s) => ({ ...s, id: s.ssidId, name: String(s.detail.name) })), ref, 'Wi-Fi network');
}

function bandBits(bands: Band[]): number {
    return bands.reduce((bits, b) => bits | BAND_BITS[b], 0);
}

/** The model's name for an SSID's security (raw security + WPA-Personal version). */
function securityOf(detail: RawRecord, psk: RawRecord): WifiSecurity {
    if (detail.security === SECURITY_NONE) return 'open';
    if (detail.security === 2) return 'enterprise';
    if (detail.security === 4 || detail.security === 5) return 'ppsk';
    return ({ 1: 'wpa1', 2: 'wpa2', 3: 'wpa1wpa2', 4: 'wpa3' } as Record<number, WifiSecurity>)[Number(psk.versionPsk)] ?? 'wpa2';
}

function securityBody(security: WifiSecurity, key: string | undefined): RawRecord {
    if (security === 'open') return { security: SECURITY_NONE };
    if (security === 'wpa2wpa3') throw unsupported('WPA2/WPA3 mixed mode (choose wpa2 or wpa3)', 'wifi.security');
    if (security !== 'wpa2' && security !== 'wpa3') throw new NetError('INVALID', `${security} can't be set through the tools; choose wpa2 or wpa3`);
    if (!key) throw new NetError('INVALID', 'No password to keep for this Wi-Fi network');
    return {
        security: SECURITY_WPA_PERSONAL,
        pskSetting: { securityKey: key, versionPsk: PSK_VERSION[security], encryptionPsk: ENCRYPTION_AES, gikRekeyPskEnable: false },
    };
}

/** Untagged (primary, VLAN 1) or tagged into the network's VLAN. */
function vlanBody(network: Network): RawRecord {
    if (network.vlan === 1) return { vlanEnable: false, vlanSetting: { mode: 0, customConfig: {} } };
    return { vlanEnable: false, vlanSetting: { mode: 1, customConfig: { customMode: 0, lanNetworkVlanIds: { [network.id]: [network.vlan] } } } };
}

/**
 * DHCP fields for the model's settings. With `kept` (an update), what the request doesn't
 * mention stays as it is: the lease, the DNS mode and servers, and anything the model
 * doesn't describe (options, next server), which the caller merges underneath.
 */
function dhcpBody(dhcp: Network['dhcp'], kept?: RawRecord): RawRecord {
    if (!dhcp?.enabled) return { enable: false };
    const dns =
        dhcp.dns === undefined
            ? kept
                ? {}
                : { dhcpns: 'auto' }
            : dhcp.dns.length
              ? { dhcpns: 'manual', priDns: dhcp.dns[0], ...(dhcp.dns[1] ? { sndDns: dhcp.dns[1] } : {}) }
              : { dhcpns: 'auto' };
    return {
        enable: true,
        ...(dhcp.range ? { ipRangePool: [{ ipaddrStart: dhcp.range.from, ipaddrEnd: dhcp.range.to }] } : {}),
        ...(dhcp.leaseMinutes !== undefined ? { leasetime: dhcp.leaseMinutes } : kept ? {} : { leasetime: 120 }),
        ...dns,
    };
}

/** Whether omada_setSsidEnabled has switched this SSID off (radio off, around the clock). */
function radioOffAlways(detail: RawRecord, alwaysProfileId: string | undefined): boolean {
    const schedule = (detail.wlanSchedule ?? {}) as RawRecord;
    return Boolean(alwaysProfileId) && schedule.wlanScheduleEnable === true && schedule.action === 0 && schedule.scheduleId === alwaysProfileId;
}

/** 32 random characters a WPA password accepts; set, never returned. */
function temporaryPassphrase(): string {
    return randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, 'x');
}

function describeNetworkChanges(current: Network, next: { name: string; vlan: number; gateway?: string; dhcp?: Network['dhcp']; ipv6?: boolean }): string[] {
    const out: string[] = [];
    if (next.name !== current.name) out.push(`name → ${next.name}`);
    if (next.vlan !== current.vlan) out.push(`VLAN → ${next.vlan}`);
    if (next.gateway !== current.gateway) out.push(`gateway → ${next.gateway}`);
    if (next.dhcp && !next.dhcp.enabled) out.push('DHCP → off');
    if (next.dhcp?.enabled) {
        const parts = [
            ...(next.dhcp.range ? [`range ${next.dhcp.range.from}-${next.dhcp.range.to}`] : []),
            ...(next.dhcp.leaseMinutes !== undefined ? [`lease ${next.dhcp.leaseMinutes} min`] : []),
            ...(next.dhcp.dns !== undefined ? [`DNS ${next.dhcp.dns.join(', ') || 'automatic'}`] : []),
        ];
        out.push(`DHCP → ${parts.join(', ') || 'on'}`);
    }
    if (next.ipv6 === false && current.ipv6) out.push('IPv6 → off');
    return out;
}

function describeClients(clients: Client[]): string {
    return clients.map((c) => `${c.name ?? '?'} (${c.mac})`).join(', ');
}

/**
 * Fingerprint of what a plan read, secrets stripped (the Wi-Fi password is never hashed:
 * a hash of a short secret leaks it to anyone who can guess).
 */
function fingerprint(snap: Snapshot, reads: Built['reads']): string {
    const material = {
        networks: reads.networks ? snap.networksRaw : undefined,
        ssids: reads.ssids ? redactSecrets(snap.ssids) : undefined,
        // A MAC filter plan resolved a group by name: a renamed or replaced group must not slip through.
        macGroups: reads.macGroups ? snap.macGroups : undefined,
    };
    return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16);
}

