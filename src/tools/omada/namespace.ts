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
    estimatedSize: 'small',
    description: 'Devices discovered but not yet adopted into the site.',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/grid/devices/pending', siteId: a.siteId }),
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
    estimatedSize: 'small',
    description: 'Rogue access points detected near the site.',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/insight/rogueaps', siteId: a.siteId }),
  },
  {
    path: '/wifi/wids',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Wireless Intrusion Detection System (WIDS) events.',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/insight/wids', siteId: a.siteId }),
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

  // ---- Events / alerts (paginated) --------------------------------------
  {
    path: '/events',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'large',
    description: 'Site event log (paginated). Use page/pageSize to page through.',
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/logs/events', siteId: a.siteId, paginated: true, page: a.page, pageSize: a.pageSize }),
  },
  {
    path: '/events/alerts',
    kind: 'collection',
    permission: Q,
    paginated: true,
    defaultPageSize: 50,
    estimatedSize: 'large',
    description: 'Site alert log (paginated). Use page/pageSize to page through.',
    fetch: (c, a) =>
      c.readResource({ pathTemplate: '/sites/{siteId}/logs/alerts', siteId: a.siteId, paginated: true, page: a.page, pageSize: a.pageSize }),
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
    description: 'Devices with the highest CPU usage.',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/dashboard/top-device-cpu-usage', siteId: a.siteId }),
  },
  {
    path: '/dashboard/memory',
    kind: 'collection',
    permission: Q,
    estimatedSize: 'small',
    description: 'Devices with the highest memory usage.',
    fetch: (c, a) => c.readResource({ pathTemplate: '/sites/{siteId}/dashboard/top-device-memory-usage', siteId: a.siteId }),
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
