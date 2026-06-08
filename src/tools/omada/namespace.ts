/**
 * Omada resource-graph namespace.
 *
 * Instead of registering one MCP tool per Omada endpoint (which explodes the
 * tool-schema budget for small models), graph mode exposes a single discoverable
 * namespace via `omada_browse` (navigate) + `omada_read` (fetch). This manifest is
 * the source of truth mapping graph paths → fetch logic + per-path RBAC.
 *
 * Design (see the "resource graph with lazy expansion" discussion):
 *  - `browse` returns resource *types/metadata*, never instances — no enumeration,
 *    no controller calls, zero payload explosion.
 *  - `read` is where data is fetched: single leaves, collections (optionally a
 *    single member via `id`), or paginated logs (single page via page/pageSize).
 *  - Authorization is per-path: each node declares the Permission bit it needs.
 *    Most nodes are QUERY; the security subtree (`/security/threats`) requires
 *    ADMIN, demonstrating that sensitive subtrees can require a higher bit without
 *    touching the tools.
 *
 * `graph` mode is a complete superset of `eager` reads: every eager read getter
 * has a corresponding graph node here, including the ADMIN-gated IDS/IPS
 * threat-management log (`/security/threats`), which maps its mandatory epoch
 * time-window onto the required `params.startTime`/`params.endTime` validated by
 * `omada_read` before any controller call.
 */

import type { OmadaClient } from '../../omadaClient/index.js';
import { Permission } from '../../permissions/index.js';

/** Arguments passed from `omada_read` to a node's fetch function. */
export interface ReadArgs {
  siteId?: string;
  /** Look up a single member of a collection by id/MAC. */
  id?: string;
  /** Path parameters some resources require (e.g. gatewayMac, apMac, deviceMac). */
  params?: Record<string, string>;
  page?: number;
  pageSize?: number;
}

/** A declared parameter for a resource (surfaced by browse, validated by read). */
export interface ResourceParam {
  name: string;
  required: boolean;
  description: string;
}

export type ResourceKind = 'container' | 'collection' | 'leaf';

export interface ResourceNode {
  /** Graph path, e.g. '/gateway/wan'. Always normalized (leading slash, no trailing). */
  path: string;
  kind: ResourceKind;
  /** Permission bit required to browse-to / read this node. */
  permission: number;
  description: string;
  estimatedSize?: 'small' | 'medium' | 'large';
  paginated?: boolean;
  defaultPageSize?: number;
  params?: ResourceParam[];
  /** Undefined for pure containers (browse-only — no data of their own). */
  fetch?: (client: OmadaClient, args: ReadArgs) => Promise<unknown>;
}

const Q = Permission.QUERY;
const A = Permission.ADMIN;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Resolve an epoch-MILLISECONDS time window for the event/alert log endpoints
 * (`/sites/{siteId}/logs/{events,alerts}`), which require `filters.timeStart` and
 * `filters.timeEnd`. Explicit `params.startTime`/`params.endTime` win; otherwise
 * default to the last 7 days so a bare `omada_read('/events')` "just works".
 * Exported for unit testing (inject `now` to keep tests deterministic).
 */
export function resolveLogWindowMs(
  params: Record<string, string> | undefined,
  now = Date.now()
): { timeStart: number; timeEnd: number } {
  const timeEnd = params?.endTime ? Number(params.endTime) : now;
  const timeStart = params?.startTime ? Number(params.startTime) : timeEnd - 7 * 24 * HOUR_MS;
  return { timeStart, timeEnd };
}

/**
 * Resolve an epoch-SECONDS time window for the dashboard top-usage endpoints
 * (`top-device-cpu-usage` / `top-device-memory-usage`), which require `start` and
 * `end`. Explicit `params.startTime`/`params.endTime` (seconds) win; otherwise
 * default to the last 24 hours. Exported for unit testing.
 */
export function resolveUsageWindowSec(
  params: Record<string, string> | undefined,
  now = Date.now()
): { start: number; end: number } {
  const end = params?.endTime ? Number(params.endTime) : Math.floor(now / 1000);
  const start = params?.startTime ? Number(params.startTime) : end - 24 * 60 * 60;
  return { start, end };
}

/**
 * Build the optional query filters for the audit-log endpoints from caller params.
 * `startTime`/`endTime` are epoch MILLISECONDS, forwarded as the controller's
 * `filters.startTime`/`filters.endTime`; `searchKey` is fuzzy text. Absent params
 * are omitted so a bare read returns the most recent page unfiltered. Exported for
 * unit testing.
 */
export function auditFilters(params: Record<string, string> | undefined): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  if (params?.startTime !== undefined) {
    query['filters.startTime'] = Number(params.startTime);
  }
  if (params?.endTime !== undefined) {
    query['filters.endTime'] = Number(params.endTime);
  }
  if (params?.searchKey) {
    query.searchKey = params.searchKey;
  }
  return query;
}

/**
 * The Omada resource graph. Containers have no `fetch` (browse-only); collections
 * and leaves fetch data. Existing client methods back the well-trodden reads;
 * the generic `client.readResource(...)` backs newly-added endpoints with zero
 * new client code.
 */
export const OMADA_RESOURCES: ResourceNode[] = [
  {
    path: '/',
    kind: 'container',
    permission: Q,
    description: 'Root of the Omada network resource graph. Browse children to discover resources.',
  },

  // ---- Sites -------------------------------------------------------------
  {
    path: '/sites',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'All sites on the controller. Most resources are scoped to a site via the optional siteId argument.',
    fetch: (c) => c.listSites(),
  },

  // ---- Devices (infrastructure) -----------------------------------------
  {
    path: '/devices',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'medium',
    description: 'Network infrastructure (APs, switches, gateways). Pass id=<MAC> to look up a single device.',
    params: [{ name: 'id', required: false, description: 'Device MAC to fetch a single device' }],
    fetch: (c, a) => (a.id ? c.getDevice(a.id, a.siteId) : c.listDevices(a.siteId)),
  },
  {
    path: '/devices/pending',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'Devices discovered but not yet adopted into the site (paginated). Use page/pageSize.',
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/grid/devices/pending',
        siteId: a.siteId,
        paginated: true,
        page: a.page,
        pageSize: a.pageSize,
      }),
  },
  {
    path: '/devices/stats',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'medium',
    description: 'Per-device statistics (CPU, memory, traffic). Paginated — use page/pageSize.',
    fetch: (c, a) => c.listDevicesStats({ page: a.page ?? 1, pageSize: a.pageSize ?? 50 }),
  },
  {
    path: '/devices/stack',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'Switch-stack detail. Requires stackId.',
    params: [{ name: 'stackId', required: true, description: 'Switch stack identifier' }],
    fetch: (c, a) => c.getSwitchStackDetail(a.params?.stackId ?? '', a.siteId),
  },
  {
    path: '/devices/search',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Search infrastructure devices across all sites by name/MAC/model. Requires searchKey.',
    params: [{ name: 'searchKey', required: true, description: 'Text to match against device name, MAC, or model' }],
    fetch: (c, a) => c.searchDevices(a.params?.searchKey ?? ''),
  },

  // ---- Cable test (switch port diagnostics) -----------------------------
  {
    path: '/devices/cable-test',
    kind: 'container',
    permission: Q,
    description: 'Switch-port cable diagnostics. Children require a switchMac (find via /devices).',
  },
  {
    path: '/devices/cable-test/ports',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Ports available for cable testing on a switch. Requires switchMac.',
    params: [{ name: 'switchMac', required: true, description: 'Switch MAC address' }],
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/cable-test/switches/{switchMac}/ports',
        siteId: a.siteId,
        pathParams: { switchMac: a.params?.switchMac ?? '' },
      }),
  },
  {
    path: '/devices/cable-test/results',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'Full cable-test results (pair status, length, fault distance) for a switch. Requires switchMac.',
    params: [{ name: 'switchMac', required: true, description: 'Switch MAC address' }],
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/cable-test/switches/{switchMac}/full-results',
        siteId: a.siteId,
        pathParams: { switchMac: a.params?.switchMac ?? '' },
      }),
  },
  {
    path: '/devices/cable-test/logs',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Cable-test run history for a switch. Requires switchMac.',
    params: [{ name: 'switchMac', required: true, description: 'Switch MAC address' }],
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/cable-test/switches/{switchMac}/logs',
        siteId: a.siteId,
        pathParams: { switchMac: a.params?.switchMac ?? '' },
      }),
  },
  {
    path: '/devices/poe',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'Per-port PoE status across switches (which ports deliver power, to what, and how much). Paginated.',
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/switches/ports/poe-info',
        siteId: a.siteId,
        paginated: true,
        page: a.page,
        pageSize: a.pageSize,
      }),
  },
  {
    path: '/devices/lldp',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Site-wide LLDP neighbor information (physical link/topology discovery between devices).',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/lldp', siteId: a.siteId }),
  },

  // ---- Clients (connected users) ----------------------------------------
  {
    path: '/clients',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'large',
    description: 'Connected clients (phones, laptops, IoT). Pass id=<MAC> to look up a single client.',
    params: [{ name: 'id', required: false, description: 'Client MAC to fetch a single client' }],
    fetch: (c, a) => (a.id ? c.getClient(a.id, a.siteId) : c.listClients(a.siteId)),
  },
  {
    path: '/clients/active',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Most active clients by traffic.',
    fetch: (c, a) => c.listMostActiveClients(a.siteId),
  },
  {
    path: '/clients/activity',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'medium',
    description: 'Per-client activity (traffic over time). Optional time window via params.start/params.end (epoch seconds).',
    params: [
      { name: 'start', required: false, description: 'Start timestamp, epoch seconds' },
      { name: 'end', required: false, description: 'End timestamp, epoch seconds' },
    ],
    fetch: (c, a) =>
      c.listClientsActivity({
        siteId: a.siteId,
        start: a.params?.start !== undefined ? Number(a.params.start) : undefined,
        end: a.params?.end !== undefined ? Number(a.params.end) : undefined,
      }),
  },
  {
    path: '/clients/past-connections',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'large',
    description: 'Historical client connections (paginated). Use page/pageSize.',
    fetch: (c, a) => c.listClientsPastConnections({ siteId: a.siteId, page: a.page ?? 1, pageSize: a.pageSize ?? 50 }),
  },

  // ---- Gateway -----------------------------------------------------------
  { path: '/gateway', kind: 'container', permission: Q, description: 'Gateway/router status and connectivity.' },
  {
    path: '/gateway/wan',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'WAN port status for a gateway: WAN IP, DNS, uptime, link speed, TX/RX. Requires gatewayMac (find via /devices).',
    params: [{ name: 'gatewayMac', required: true, description: 'Gateway MAC address' }],
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/gateways/{gatewayMac}/wan-status',
        siteId: a.siteId,
        pathParams: { gatewayMac: a.params?.gatewayMac ?? '' },
      }),
  },
  {
    path: '/gateway/health',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'Detailed per-WAN health for a gateway. Requires gatewayMac (find via /devices).',
    params: [{ name: 'gatewayMac', required: true, description: 'Gateway MAC address' }],
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/health/gateways/{gatewayMac}/wans/details',
        siteId: a.siteId,
        pathParams: { gatewayMac: a.params?.gatewayMac ?? '' },
      }),
  },

  // ---- Network config ----------------------------------------------------
  { path: '/network', kind: 'container', permission: Q, description: 'Network configuration: internet, LANs, WLAN groups, firewall.' },
  {
    path: '/network/internet',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'Internet/WAN connection information for the site.',
    fetch: (c, a) => c.getInternetInfo(a.siteId),
  },
  {
    path: '/network/lan-networks',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Configured LAN networks / VLANs.',
    fetch: (c, a) => c.getLanNetworkList(a.siteId),
  },
  {
    path: '/network/lan-profiles',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'LAN profiles.',
    fetch: (c, a) => c.getLanProfileList(a.siteId),
  },
  {
    path: '/network/wlan-groups',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'WLAN groups.',
    fetch: (c, a) => c.getWlanGroupList(a.siteId),
  },
  {
    path: '/network/firewall',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'Gateway firewall settings for the site.',
    fetch: (c, a) => c.getFirewallSetting(a.siteId),
  },
  {
    path: '/network/port-forwarding',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 10,
    estimatedSize: 'small',
    description: "Port-forwarding status (paginated). params.type is 'User' (default) or 'UPnP'.",
    params: [{ name: 'type', required: false, description: "'User' (default) or 'UPnP'" }],
    fetch: (c, a) =>
      c.getPortForwardingStatus(a.params?.type === 'UPnP' ? 'UPnP' : 'User', a.siteId, a.page ?? 1, a.pageSize ?? 10),
  },
  {
    path: '/network/port-forwarding/rules',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'Configured NAT port-forwarding rules (the full rule list, not just status). Paginated — use page/pageSize.',
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/nat/port-forwardings',
        siteId: a.siteId,
        paginated: true,
        page: a.page,
        pageSize: a.pageSize,
      }),
  },
  {
    path: '/network/dhcp-leases',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'medium',
    description: 'Active DHCP leases across all DHCP servers on the site (paginated). Use page/pageSize. See /network/dhcp-reservations for static reservations.',
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/setting/service/dhcp/user-list',
        siteId: a.siteId,
        paginated: true,
        page: a.page,
        pageSize: a.pageSize,
      }),
  },
  {
    path: '/network/load-balance',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'Multi-WAN load-balance status for the gateway (which WANs are up / in the balancing pool).',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/internet/load-balance/status', siteId: a.siteId }),
  },
  {
    path: '/network/dhcp-reservations',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'Static DHCP reservations (each maps a client MAC to a fixed IP). Paginated. See /network/dhcp-leases for active leases.',
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/setting/service/dhcp',
        siteId: a.siteId,
        paginated: true,
        page: a.page,
        pageSize: a.pageSize,
      }),
  },
  {
    path: '/network/static-routes',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'Configured static routes for the gateway (destination → next-hop). Paginated.',
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/routing/static-routings',
        siteId: a.siteId,
        paginated: true,
        page: a.page,
        pageSize: a.pageSize,
      }),
  },
  {
    path: '/network/ip-mac-binding',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'IP↔MAC binding entries (ARP-spoofing protection: which MACs are pinned to which IPs). Paginated.',
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/ip-mac-binds',
        siteId: a.siteId,
        paginated: true,
        page: a.page,
        pageSize: a.pageSize,
      }),
  },
  {
    path: '/network/attack-defense',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'Gateway attack-defense settings (flood/scan/spoof protection toggles and thresholds).',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/attack-defense', siteId: a.siteId }),
  },

  // ---- Access-control lists (read-only policy visibility) ---------------
  { path: '/network/acls', kind: 'container', permission: Q, description: 'Access-control lists by enforcement point (gateway, switch, EAP/AP).' },
  {
    path: '/network/acls/gateway',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'Gateway ACL rules (osg-acls). Paginated.',
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/acls/osg-acls', siteId: a.siteId, paginated: true, page: a.page, pageSize: a.pageSize }),
  },
  {
    path: '/network/acls/switch',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'Switch ACL rules (osw-acls). Paginated.',
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/acls/osw-acls', siteId: a.siteId, paginated: true, page: a.page, pageSize: a.pageSize }),
  },
  {
    path: '/network/acls/eap',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'EAP/AP ACL rules (eap-acls). Paginated.',
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/acls/eap-acls', siteId: a.siteId, paginated: true, page: a.page, pageSize: a.pageSize }),
  },

  // ---- URL filtering (content controls) ---------------------------------
  { path: '/network/url-filters', kind: 'container', permission: Q, description: 'URL-filtering rules (content/parental controls) by enforcement point.' },
  {
    path: '/network/url-filters/gateway',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'Gateway URL-filter rules. Paginated.',
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/url-filters/gateway', siteId: a.siteId, paginated: true, page: a.page, pageSize: a.pageSize }),
  },
  {
    path: '/network/url-filters/eap',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'EAP/AP URL-filter rules. Paginated.',
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/url-filters/eap', siteId: a.siteId, paginated: true, page: a.page, pageSize: a.pageSize }),
  },

  // ---- MAC filtering -----------------------------------------------------
  { path: '/network/mac-filters', kind: 'container', permission: Q, description: 'Wireless MAC allow/deny filtering lists.' },
  {
    path: '/network/mac-filters/allow',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'MAC addresses on the allow list. Paginated.',
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/mac-filters/allow', siteId: a.siteId, paginated: true, page: a.page, pageSize: a.pageSize }),
  },
  {
    path: '/network/mac-filters/deny',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'MAC addresses on the deny list. Paginated.',
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/mac-filters/deny', siteId: a.siteId, paginated: true, page: a.page, pageSize: a.pageSize }),
  },
  {
    path: '/network/rate-limit-profiles',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Configured client rate-limit profiles (input for the rate-limit write tools).',
    fetch: (c, a) => c.getRateLimitProfiles(a.siteId),
  },

  // ---- WiFi / wireless security -----------------------------------------
  { path: '/wifi', kind: 'container', permission: Q, description: 'Wireless: SSIDs, speed tests, rogue-AP and intrusion detection.' },
  {
    path: '/wifi/speedtest',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'Latest speed-test result for an access point. Requires apMac (find via /devices).',
    params: [{ name: 'apMac', required: true, description: 'Access point MAC address' }],
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/aps/{apMac}/speed-test-result',
        siteId: a.siteId,
        pathParams: { apMac: a.params?.apMac ?? '' },
      }),
  },
  {
    path: '/wifi/rogue',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'Rogue access points detected near the site (paginated). Use page/pageSize.',
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/insight/rogueaps',
        siteId: a.siteId,
        paginated: true,
        page: a.page,
        pageSize: a.pageSize,
      }),
  },
  {
    path: '/wifi/wids',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description:
      'Wireless Intrusion Detection System (WIDS) entries (paginated). Use page/pageSize. ' +
      'Note: the controller restricts this endpoint to Omada Pro controllers/sites; on a ' +
      'standard controller it returns a "Pro only" message rather than data.',
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/insight/wids',
        siteId: a.siteId,
        paginated: true,
        page: a.page,
        pageSize: a.pageSize,
      }),
  },
  {
    path: '/wifi/ssids',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'SSIDs in a WLAN group. Requires wlanId; pass params.ssidId too to fetch a single SSID detail.',
    params: [
      { name: 'wlanId', required: true, description: 'WLAN group id (find via /network/wlan-groups)' },
      { name: 'ssidId', required: false, description: 'SSID id — when set, returns that SSID detail instead of the list' },
    ],
    fetch: (c, a) =>
      a.params?.ssidId
        ? c.getSsidDetail(a.params.wlanId ?? '', a.params.ssidId, a.siteId)
        : c.getSsidList(a.params?.wlanId ?? '', a.siteId),
  },
  {
    path: '/wifi/band-steering',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'Band-steering settings for the site (steering clients between 2.4/5/6 GHz radios).',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/band-steering', siteId: a.siteId }),
  },

  // ---- Events / alerts (paginated) --------------------------------------
  {
    path: '/events',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'large',
    description:
      'Site event log (paginated). Use page/pageSize. The controller requires a time window: by default this ' +
      'returns the last 7 days. Override with params.startTime / params.endTime (epoch MILLISECONDS, e.g. ' +
      '1679297710438). Optional params.module filters by source module.',
    params: [
      { name: 'startTime', required: false, description: 'Window start, epoch ms (default: 7 days ago)' },
      { name: 'endTime', required: false, description: 'Window end, epoch ms (default: now)' },
      { name: 'module', required: false, description: 'Filter by module (e.g. "Device", "Client", "User")' },
    ],
    fetch: (c, a) => {
      const { timeStart, timeEnd } = resolveLogWindowMs(a.params);
      const query: Record<string, unknown> = { 'filters.timeStart': timeStart, 'filters.timeEnd': timeEnd };
      if (a.params?.module) {
        query['filters.module'] = a.params.module;
      }
      return c.readResource({ pathTemplate: '/sites/{siteId}/logs/events', siteId: a.siteId, paginated: true, page: a.page, pageSize: a.pageSize, query });
    },
  },
  {
    path: '/events/alerts',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'large',
    description:
      'Site alert log (paginated). Use page/pageSize. The controller requires a time window: by default this ' +
      'returns the last 7 days. Override with params.startTime / params.endTime (epoch MILLISECONDS). Optional ' +
      'params.module filters by source module; params.resolved ("true"/"false") filters by resolution state.',
    params: [
      { name: 'startTime', required: false, description: 'Window start, epoch ms (default: 7 days ago)' },
      { name: 'endTime', required: false, description: 'Window end, epoch ms (default: now)' },
      { name: 'module', required: false, description: 'Filter by module (e.g. "Device", "Client", "User")' },
      { name: 'resolved', required: false, description: '"true" or "false" to filter by resolution state' },
    ],
    fetch: (c, a) => {
      const { timeStart, timeEnd } = resolveLogWindowMs(a.params);
      const query: Record<string, unknown> = { 'filters.timeStart': timeStart, 'filters.timeEnd': timeEnd };
      if (a.params?.module) {
        query['filters.module'] = a.params.module;
      }
      if (a.params?.resolved === 'true' || a.params?.resolved === 'false') {
        query['filters.resolved'] = a.params.resolved;
      }
      return c.readResource({ pathTemplate: '/sites/{siteId}/logs/alerts', siteId: a.siteId, paginated: true, page: a.page, pageSize: a.pageSize, query });
    },
  },

  // ---- Dashboard ---------------------------------------------------------
  {
    path: '/dashboard',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'medium',
    description: 'Site dashboard overview diagram (topology + summary).',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/dashboard/overview-diagram', siteId: a.siteId }),
  },
  {
    path: '/dashboard/cpu',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description:
      'Devices with the highest CPU usage over a time window (default: last 24h). Override with params.startTime / ' +
      'params.endTime (epoch SECONDS, e.g. 1682000000).',
    params: [
      { name: 'startTime', required: false, description: 'Window start, epoch seconds (default: 24h ago)' },
      { name: 'endTime', required: false, description: 'Window end, epoch seconds (default: now)' },
    ],
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/dashboard/top-device-cpu-usage', siteId: a.siteId, query: resolveUsageWindowSec(a.params) }),
  },
  {
    path: '/dashboard/memory',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description:
      'Devices with the highest memory usage over a time window (default: last 24h). Override with params.startTime / ' +
      'params.endTime (epoch SECONDS, e.g. 1682000000).',
    params: [
      { name: 'startTime', required: false, description: 'Window start, epoch seconds (default: 24h ago)' },
      { name: 'endTime', required: false, description: 'Window end, epoch seconds (default: now)' },
    ],
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/dashboard/top-device-memory-usage', siteId: a.siteId, query: resolveUsageWindowSec(a.params) }),
  },
  {
    path: '/dashboard/client-distribution',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'Breakdown of connected clients by category (wired/wireless, band, SSID). No time window required.',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/dashboard/client-distribution', siteId: a.siteId }),
  },
  {
    path: '/dashboard/traffic-distribution',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description:
      'Traffic distribution across the site over a time window (default: last 24h). Override with params.startTime / ' +
      'params.endTime (epoch SECONDS).',
    params: [
      { name: 'startTime', required: false, description: 'Window start, epoch seconds (default: 24h ago)' },
      { name: 'endTime', required: false, description: 'Window end, epoch seconds (default: now)' },
    ],
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/dashboard/traffic-distribution', siteId: a.siteId, query: resolveUsageWindowSec(a.params) }),
  },
  {
    path: '/dashboard/traffic-activities',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'medium',
    description:
      'Traffic activity over time (a time-series for charting) for the site (default window: last 24h). Override with ' +
      'params.startTime / params.endTime (epoch SECONDS).',
    params: [
      { name: 'startTime', required: false, description: 'Window start, epoch seconds (default: 24h ago)' },
      { name: 'endTime', required: false, description: 'Window end, epoch seconds (default: now)' },
    ],
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/dashboard/traffic-activities', siteId: a.siteId, query: resolveUsageWindowSec(a.params) }),
  },

  // ---- Firmware ----------------------------------------------------------
  {
    path: '/firmware',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'Latest available firmware info for a device. Requires deviceMac (find via /devices).',
    params: [{ name: 'deviceMac', required: true, description: 'Device MAC address' }],
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/devices/{deviceMac}/latest-firmware-info',
        siteId: a.siteId,
        pathParams: { deviceMac: a.params?.deviceMac ?? '' },
      }),
  },
  {
    path: '/firmware/critical',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'Controller-wide overview of critical firmware upgrades (not site-scoped).',
    fetch: (c) => c.readResource({ pathTemplate: '/upgrade/overview/critical', siteScoped: false }),
  },

  // ---- VPN (status & tunnels) -------------------------------------------
  {
    path: '/vpn',
    kind: 'container',
    permission: Q,
    description: 'VPN status: site-to-site, client-to-site, WireGuard, and IPsec tunnel stats.',
  },
  {
    path: '/vpn/site-to-site',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Site-to-site VPN tunnels. Pass id=<vpnId> to fetch a single tunnel.',
    params: [{ name: 'id', required: false, description: 'VPN id to fetch a single site-to-site tunnel' }],
    fetch: (c, a) =>
      a.id
        ? c.readResource({
            pathTemplate: '/sites/{siteId}/vpn/site-to-site-vpns/{vpnId}',
            siteId: a.siteId,
            pathParams: { vpnId: a.id },
          })
        : c.readResource({ pathTemplate: '/sites/{siteId}/vpn/site-to-site-vpns', siteId: a.siteId }),
  },
  {
    path: '/vpn/client-to-site',
    kind: 'container',
    permission: Q,
    description: 'Client-to-site (remote-access) VPN: configured servers and connected clients.',
  },
  {
    path: '/vpn/client-to-site/servers',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Configured client-to-site VPN servers (L2TP/OpenVPN/etc.).',
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/vpn/client-to-site-vpn-servers', siteId: a.siteId }),
  },
  {
    path: '/vpn/client-to-site/clients',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Currently connected client-to-site (remote-access) VPN clients.',
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/vpn/client-to-site-vpn-clients', siteId: a.siteId }),
  },
  {
    path: '/vpn/wireguard',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Configured WireGuard VPN interfaces on the gateway.',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/vpn/wireguards', siteId: a.siteId }),
  },
  {
    path: '/vpn/ipsec-stats',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'small',
    description: 'IPsec VPN tunnel statistics (paginated — use page/pageSize).',
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/setting/vpn/stats/ipsec',
        siteId: a.siteId,
        paginated: true,
        page: a.page,
        pageSize: a.pageSize,
      }),
  },

  // ---- Profiles (reusable network profiles) -----------------------------
  {
    path: '/profiles',
    kind: 'container',
    permission: Q,
    description: 'Reusable network profiles: per-device Wi-Fi keys (PPSK) and time-range schedules.',
  },
  {
    path: '/profiles/ppsk',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description:
      'PPSK (Private Pre-Shared Key) profiles — unique per-user/per-device Wi-Fi passwords on a shared SSID. ' +
      'REQUIRES params.type: 0 = PPSK without RADIUS, 1 = PPSK with RADIUS.',
    params: [{ name: 'type', required: true, description: '0 = PPSK without RADIUS, 1 = PPSK with RADIUS' }],
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/ppsk-profiles',
        siteId: a.siteId,
        query: { type: Number(a.params?.type) },
      }),
  },
  {
    path: '/profiles/time-range',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Time-range profiles — reusable schedules referenced by ACLs, Wi-Fi, and PoE rules.',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/time-range-profiles', siteId: a.siteId }),
  },

  // ---- Schedules (PoE / port / firmware-upgrade) ------------------------
  {
    path: '/schedules',
    kind: 'container',
    permission: Q,
    description:
      'Device schedules: PoE power, switch-port on/off, and firmware-upgrade windows. ' +
      '(Reboot schedules are site-template-scoped enterprise config and are intentionally not exposed here.)',
  },
  {
    path: '/schedules/poe',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'PoE schedules — when switch ports deliver power to PoE devices.',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/poe-schedules', siteId: a.siteId }),
  },
  {
    path: '/schedules/port',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Port schedules — when switch ports are administratively up/down.',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/port-schedules', siteId: a.siteId }),
  },
  {
    path: '/schedules/upgrade',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Firmware-upgrade schedules — planned maintenance windows for device upgrades.',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/upgrade-schedules', siteId: a.siteId }),
  },

  // ---- Backup (controller/site backup status) ---------------------------
  {
    path: '/backup',
    kind: 'container',
    permission: Q,
    description: 'Site backup status: available backup files and the most recent backup result.',
  },
  {
    path: '/backup/files',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'List of available site backup files.',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/maintenance/backup/files', siteId: a.siteId }),
  },
  {
    path: '/backup/result',
    kind: 'leaf',
    permission: Q,
    estimatedSize: 'small',
    description: 'Result of the most recent site backup operation.',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/backup/result', siteId: a.siteId }),
  },

  // ---- Audit logs (administrative operation history) — ADMIN only -------
  {
    path: '/audit',
    kind: 'container',
    permission: A,
    description:
      'Administrative audit logs — who did what on the controller. ADMIN only (reveals full admin activity).',
  },
  {
    path: '/audit/site',
    kind: 'collection',
    permission: A,
    paginated: true,
    defaultPageSize: 10,
    estimatedSize: 'large',
    description:
      'Site-scoped administrative audit log (paginated, ADMIN). Optional params: startTime/endTime ' +
      '(epoch MILLISECONDS) to bound the window, and searchKey (fuzzy text).',
    params: [
      { name: 'startTime', required: false, description: 'Window start, epoch milliseconds' },
      { name: 'endTime', required: false, description: 'Window end, epoch milliseconds' },
      { name: 'searchKey', required: false, description: 'Fuzzy search on the log text' },
    ],
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/sites/{siteId}/audit-logs',
        siteId: a.siteId,
        paginated: true,
        page: a.page,
        pageSize: a.pageSize,
        query: auditFilters(a.params),
      }),
  },
  {
    path: '/audit/global',
    kind: 'collection',
    permission: A,
    paginated: true,
    defaultPageSize: 10,
    estimatedSize: 'large',
    description:
      'Controller-wide administrative audit log across all sites (paginated, ADMIN). Optional params: ' +
      'startTime/endTime (epoch MILLISECONDS) and searchKey (fuzzy text).',
    params: [
      { name: 'startTime', required: false, description: 'Window start, epoch milliseconds' },
      { name: 'endTime', required: false, description: 'Window end, epoch milliseconds' },
      { name: 'searchKey', required: false, description: 'Fuzzy search on the log text' },
    ],
    fetch: (c, a) =>
      c.readResource({
        pathTemplate: '/audit-logs',
        siteScoped: false,
        paginated: true,
        page: a.page,
        pageSize: a.pageSize,
        query: auditFilters(a.params),
      }),
  },

  // ---- Security (IDS/IPS) — ADMIN only -----------------------------------
  {
    path: '/security',
    kind: 'container',
    permission: A,
    description: 'Security: IDS/IPS threat-management log. ADMIN only.',
  },
  {
    path: '/security/threats',
    kind: 'collection',
    permission: A,
    paginated: true,
    defaultPageSize: 10,
    estimatedSize: 'large',
    description:
      'IDS/IPS threat-management log (paginated, ADMIN). REQUIRES a time window: params.startTime and params.endTime ' +
      '(epoch SECONDS, e.g. 1682000000). Optional params: archived ("true"/"false", default false), severity ' +
      '(0=Critical,1=Major,2=Concerning,3=Minor), sortTime ("asc"/"desc"), searchKey (fuzzy text), siteList ' +
      '(comma-separated site IDs; default all sites).',
    params: [
      { name: 'startTime', required: true, description: 'Window start, epoch seconds (e.g. 1682000000)' },
      { name: 'endTime', required: true, description: 'Window end, epoch seconds (e.g. 1682003600)' },
      { name: 'archived', required: false, description: '"true" or "false" (default false)' },
      { name: 'severity', required: false, description: '0=Critical, 1=Major, 2=Concerning, 3=Minor' },
      { name: 'sortTime', required: false, description: 'Sort by time: "asc" or "desc"' },
      { name: 'searchKey', required: false, description: 'Fuzzy search on description/classification' },
      { name: 'siteList', required: false, description: 'Comma-separated site IDs (default: all sites)' },
    ],
    fetch: (c, a) =>
      c.getThreatList({
        siteList: a.params?.siteList,
        archived: a.params?.archived === 'true',
        page: a.page ?? 1,
        pageSize: a.pageSize ?? 10,
        startTime: Number(a.params?.startTime),
        endTime: Number(a.params?.endTime),
        severity: a.params?.severity !== undefined ? Number(a.params.severity) : undefined,
        sortTime: a.params?.sortTime === 'asc' ? 'asc' : a.params?.sortTime === 'desc' ? 'desc' : undefined,
        searchKey: a.params?.searchKey,
      }),
  },
];

const byPath = new Map<string, ResourceNode>(OMADA_RESOURCES.map((n) => [n.path, n]));

/** Normalize a user-supplied path: leading slash, no trailing slash, '/' for root. */
export function normalizePath(path: string): string {
  if (!path || path === '/') {
    return '/';
  }
  let p = path.trim();
  if (!p.startsWith('/')) {
    p = `/${p}`;
  }
  if (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }
  return p;
}

/** The immediate parent path, or null for the root. */
function parentPath(path: string): string | null {
  if (path === '/') {
    return null;
  }
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

export function getResourceNode(path: string): ResourceNode | undefined {
  return byPath.get(normalizePath(path));
}

/** Direct children (one segment deeper) of the given path. */
export function childrenOf(path: string): ResourceNode[] {
  const norm = normalizePath(path);
  return OMADA_RESOURCES.filter((n) => parentPath(n.path) === norm);
}
