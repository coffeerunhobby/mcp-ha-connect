/**
 * Unit tests for the Omada resource-graph tools (omada_browse + omada_read).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmadaClient } from '../../../src/omadaClient/index.js';
import { registerOmadaGraphTools } from '../../../src/tools/omada/graph.js';
import { registerOmadaTools } from '../../../src/tools/omada/index.js';
import { Permission } from '../../../src/permissions/index.js';

function createMockServer() {
  const handlers = new Map<string, { config: unknown; handler: (...args: unknown[]) => unknown }>();
  return {
    registerTool: vi.fn((name: string, config: unknown, handler: (...args: unknown[]) => unknown) => {
      handlers.set(name, { config, handler });
    }),
    handlers,
  } as unknown as McpServer & {
    registerTool: ReturnType<typeof vi.fn>;
    handlers: Map<string, { config: unknown; handler: (...args: unknown[]) => unknown }>;
  };
}

function createMockClient() {
  return {
    listSites: vi.fn(),
    listDevices: vi.fn(),
    getDevice: vi.fn(),
    listClients: vi.fn(),
    getClient: vi.fn(),
    listMostActiveClients: vi.fn(),
    getInternetInfo: vi.fn(),
    getLanNetworkList: vi.fn(),
    getLanProfileList: vi.fn(),
    getWlanGroupList: vi.fn(),
    getFirewallSetting: vi.fn(),
    listDevicesStats: vi.fn(),
    getSwitchStackDetail: vi.fn(),
    listClientsActivity: vi.fn(),
    listClientsPastConnections: vi.fn(),
    getPortForwardingStatus: vi.fn(),
    getRateLimitProfiles: vi.fn(),
    getSsidList: vi.fn(),
    getSsidDetail: vi.fn(),
    getThreatList: vi.fn(),
    readResource: vi.fn(),
    // writes (graph mode also registers these)
    setClientRateLimit: vi.fn(),
    setClientRateLimitProfile: vi.fn(),
    disableClientRateLimit: vi.fn(),
    blockClient: vi.fn(),
    unblockClient: vi.fn(),
  } as unknown as OmadaClient;
}

// Caller with all permissions.
const adminExtra = { sessionId: 'test', authInfo: { extra: { permissions: 0xff } } };
// Caller with only QUERY (read-only).
const readonlyExtra = { sessionId: 'test', authInfo: { extra: { permissions: Permission.QUERY } } };
// Caller with NO permissions.
const noPermsExtra = { sessionId: 'test', authInfo: { extra: { permissions: 0 } } };

function parseResult(result: { content: { text: string }[]; isError?: boolean }): {
  isError?: boolean;
  data: Record<string, unknown>;
} {
  return { isError: result.isError, data: JSON.parse(result.content[0].text) };
}

describe('Omada graph tools - registration', () => {
  it('registerOmadaGraphTools registers omada_browse and omada_read', () => {
    const server = createMockServer();
    const client = createMockClient();
    const count = registerOmadaGraphTools(server, client);
    expect(count).toBe(2);
    expect(server.handlers.has('omada_browse')).toBe(true);
    expect(server.handlers.has('omada_read')).toBe(true);
  });

  it('graph mode registers browse + read + 5 typed writes, and NO typed getters', () => {
    const server = createMockServer();
    const client = createMockClient();
    const count = registerOmadaTools(server, client, 'graph');
    expect(count).toBe(7);
    const names = [...server.handlers.keys()];
    expect(names).toContain('omada_browse');
    expect(names).toContain('omada_read');
    expect(names).toContain('omada_blockClient');
    expect(names).toContain('omada_setClientRateLimit');
    // Typed read getters must NOT be present in graph mode.
    expect(names).not.toContain('omada_listSites');
    expect(names).not.toContain('omada_getFirewallSetting');
  });

  it('eager mode (default) registers the typed getters, not the graph tools', () => {
    const server = createMockServer();
    const client = createMockClient();
    registerOmadaTools(server, client);
    const names = [...server.handlers.keys()];
    expect(names).toContain('omada_listSites');
    expect(names).not.toContain('omada_browse');
    expect(names).not.toContain('omada_read');
  });
});

describe('omada_browse', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    vi.clearAllMocks();
    registerOmadaGraphTools(server, client);
  });

  function browse(args: { path?: string }, extra: unknown) {
    return server.handlers.get('omada_browse')!.handler(args, extra) as Promise<{
      content: { text: string }[];
      isError?: boolean;
    }>;
  }

  it('lists top-level resource types at root', async () => {
    const { isError, data } = parseResult(await browse({ path: '/' }, adminExtra));
    expect(isError).toBeFalsy();
    expect(data.path).toBe('/');
    const childPaths = (data.children as Array<{ path: string }>).map((c) => c.path);
    expect(childPaths).toEqual(expect.arrayContaining(['/sites', '/clients', '/gateway', '/wifi']));
  });

  it('defaults to root when no path is given', async () => {
    const { data } = parseResult(await browse({}, adminExtra));
    expect(data.path).toBe('/');
  });

  it('surfaces metadata (kind, permission, readable, pagination) for children', async () => {
    const { data } = parseResult(await browse({ path: '/events' }, adminExtra));
    expect(data.supportsPagination).toBe(true);
    expect(data.defaultPageSize).toBe(50);
  });

  it('returns an error for an unknown path', async () => {
    const { isError, data } = parseResult(await browse({ path: '/nope' }, adminExtra));
    expect(isError).toBe(true);
    expect(data.error).toBe('Unknown path');
  });

  it('is denied for callers lacking QUERY', async () => {
    const { isError, data } = parseResult(await browse({ path: '/' }, noPermsExtra));
    expect(isError).toBe(true);
    expect(data.error).toBe('Permission denied');
  });

  it('read-only callers can browse (all Tier-1 nodes are QUERY)', async () => {
    const { isError, data } = parseResult(await browse({ path: '/gateway' }, readonlyExtra));
    expect(isError).toBeFalsy();
    const childPaths = (data.children as Array<{ path: string }>).map((c) => c.path);
    expect(childPaths).toEqual(expect.arrayContaining(['/gateway/wan', '/gateway/health']));
  });

  it('advertises /security at root to ADMIN callers', async () => {
    const { data } = parseResult(await browse({ path: '/' }, adminExtra));
    const childPaths = (data.children as Array<{ path: string }>).map((c) => c.path);
    expect(childPaths).toContain('/security');
  });

  it('hides the ADMIN-only /security subtree from QUERY-only callers', async () => {
    const { data } = parseResult(await browse({ path: '/' }, readonlyExtra));
    const childPaths = (data.children as Array<{ path: string }>).map((c) => c.path);
    expect(childPaths).not.toContain('/security');
  });
});

describe('omada_read', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    vi.clearAllMocks();
    registerOmadaGraphTools(server, client);
  });

  function read(args: Record<string, unknown>, extra: unknown) {
    return server.handlers.get('omada_read')!.handler(args, extra) as Promise<{
      content: { text: string }[];
      isError?: boolean;
    }>;
  }

  it('reads a collection via the backing client method', async () => {
    (client.listSites as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 's1' }]);
    const { isError, data } = parseResult(await read({ path: '/sites' }, adminExtra));
    expect(isError).toBeFalsy();
    expect(data).toEqual([{ id: 's1' }]);
    expect(client.listSites).toHaveBeenCalled();
  });

  it('looks up a single collection member when id is provided', async () => {
    (client.getClient as ReturnType<typeof vi.fn>).mockResolvedValue({ mac: 'AA' });
    await read({ path: '/clients', id: 'AA', siteId: 'site1' }, adminExtra);
    expect(client.getClient).toHaveBeenCalledWith('AA', 'site1');
    expect(client.listClients).not.toHaveBeenCalled();
  });

  it('lists the collection when no id is provided', async () => {
    (client.listClients as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await read({ path: '/clients' }, adminExtra);
    expect(client.listClients).toHaveBeenCalled();
    expect(client.getClient).not.toHaveBeenCalled();
  });

  it('routes generic leaves through readResource with the right template', async () => {
    (client.readResource as ReturnType<typeof vi.fn>).mockResolvedValue({ wanIp: '1.2.3.4' });
    const { data } = parseResult(
      await read({ path: '/gateway/wan', params: { gatewayMac: 'AA-BB' }, siteId: 'site1' }, adminExtra)
    );
    expect(data).toEqual({ wanIp: '1.2.3.4' });
    expect(client.readResource).toHaveBeenCalledWith(
      expect.objectContaining({
        pathTemplate: '/sites/{siteId}/gateways/{gatewayMac}/wan-status',
        siteId: 'site1',
        pathParams: { gatewayMac: 'AA-BB' },
      })
    );
  });

  it('forwards pagination to paginated resources', async () => {
    (client.readResource as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });
    await read({ path: '/events', page: 2, pageSize: 25 }, adminExtra);
    expect(client.readResource).toHaveBeenCalledWith(
      expect.objectContaining({ paginated: true, page: 2, pageSize: 25 })
    );
  });

  it('reads the controller-global firmware overview without a site', async () => {
    (client.readResource as ReturnType<typeof vi.fn>).mockResolvedValue({ critical: 0 });
    await read({ path: '/firmware/critical' }, adminExtra);
    expect(client.readResource).toHaveBeenCalledWith(
      expect.objectContaining({ pathTemplate: '/upgrade/overview/critical', siteScoped: false })
    );
  });

  it('rejects missing required path parameters before calling the client', async () => {
    const { isError, data } = parseResult(await read({ path: '/gateway/wan' }, adminExtra));
    expect(isError).toBe(true);
    expect(data.error).toBe('Missing parameters');
    expect(data.missing).toEqual(['gatewayMac']);
    expect(client.readResource).not.toHaveBeenCalled();
  });

  it('returns an error for an unknown path', async () => {
    const { isError, data } = parseResult(await read({ path: '/nope' }, adminExtra));
    expect(isError).toBe(true);
    expect(data.error).toBe('Unknown path');
  });

  it('refuses to read a container node', async () => {
    const { isError, data } = parseResult(await read({ path: '/gateway' }, adminExtra));
    expect(isError).toBe(true);
    expect(data.error).toBe('Not readable');
  });

  it('defaults port-forwarding type to "User" and forwards pagination', async () => {
    (client.getPortForwardingStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });
    await read({ path: '/network/port-forwarding', siteId: 's1', page: 3, pageSize: 5 }, adminExtra);
    expect(client.getPortForwardingStatus).toHaveBeenCalledWith('User', 's1', 3, 5);
  });

  it('routes /wifi/ssids to the list (wlanId) or detail (wlanId+ssidId)', async () => {
    (client.getSsidList as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (client.getSsidDetail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'x' });

    await read({ path: '/wifi/ssids', params: { wlanId: 'w1' }, siteId: 's1' }, adminExtra);
    expect(client.getSsidList).toHaveBeenCalledWith('w1', 's1');

    await read({ path: '/wifi/ssids', params: { wlanId: 'w1', ssidId: 's9' }, siteId: 's1' }, adminExtra);
    expect(client.getSsidDetail).toHaveBeenCalledWith('w1', 's9', 's1');
  });

  it('requires wlanId for /wifi/ssids', async () => {
    const { isError, data } = parseResult(await read({ path: '/wifi/ssids' }, adminExtra));
    expect(isError).toBe(true);
    expect(data.error).toBe('Missing parameters');
    expect(data.missing).toEqual(['wlanId']);
  });

  it('enforces per-path permission (fail closed) for under-privileged callers', async () => {
    const { isError, data } = parseResult(await read({ path: '/sites' }, noPermsExtra));
    expect(isError).toBe(true);
    expect(data.error).toBe('Permission denied');
    expect(client.listSites).not.toHaveBeenCalled();
  });

  it('reads /security/threats via getThreatList, parsing the time window and filters', async () => {
    (client.getThreatList as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });
    await read(
      {
        path: '/security/threats',
        params: { startTime: '1682000000', endTime: '1682003600', archived: 'true', severity: '1', sortTime: 'desc', searchKey: 'syn' },
        page: 2,
        pageSize: 25,
      },
      adminExtra
    );
    expect(client.getThreatList).toHaveBeenCalledWith({
      siteList: undefined,
      archived: true,
      page: 2,
      pageSize: 25,
      startTime: 1682000000,
      endTime: 1682003600,
      severity: 1,
      sortTime: 'desc',
      searchKey: 'syn',
    });
  });

  it('defaults /security/threats archived=false and page/pageSize when omitted', async () => {
    (client.getThreatList as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });
    await read({ path: '/security/threats', params: { startTime: '1', endTime: '2' } }, adminExtra);
    expect(client.getThreatList).toHaveBeenCalledWith(
      expect.objectContaining({ archived: false, page: 1, pageSize: 10, severity: undefined, sortTime: undefined })
    );
  });

  it('requires the startTime/endTime window for /security/threats', async () => {
    const { isError, data } = parseResult(await read({ path: '/security/threats' }, adminExtra));
    expect(isError).toBe(true);
    expect(data.error).toBe('Missing parameters');
    expect(data.missing).toEqual(['startTime', 'endTime']);
    expect(client.getThreatList).not.toHaveBeenCalled();
  });

  it('denies /security/threats to QUERY-only callers (ADMIN required)', async () => {
    const { isError, data } = parseResult(
      await read({ path: '/security/threats', params: { startTime: '1', endTime: '2' } }, readonlyExtra)
    );
    expect(isError).toBe(true);
    expect(data.error).toBe('Permission denied');
    expect(client.getThreatList).not.toHaveBeenCalled();
  });

  it('refuses to read the /security container', async () => {
    const { isError, data } = parseResult(await read({ path: '/security' }, adminExtra));
    expect(isError).toBe(true);
    expect(data.error).toBe('Not readable');
  });
});
