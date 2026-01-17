/**
 * Unit tests for Omada tool handlers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmadaClient } from '../../../src/omadaClient/index.js';

// Import all registration functions
import { registerListSitesTool } from '../../../src/tools/omada/listSites.js';
import { registerListDevicesTool } from '../../../src/tools/omada/listDevices.js';
import { registerGetDeviceTool } from '../../../src/tools/omada/getDevice.js';
import { registerSearchDevicesTool } from '../../../src/tools/omada/searchDevices.js';
import { registerGetSwitchStackDetailTool } from '../../../src/tools/omada/getSwitchStackDetail.js';
import { registerListDevicesStatsTool } from '../../../src/tools/omada/listDevicesStats.js';
import { registerListClientsTool } from '../../../src/tools/omada/listClients.js';
import { registerGetClientTool } from '../../../src/tools/omada/getClient.js';
import { registerListMostActiveClientsTool } from '../../../src/tools/omada/listMostActiveClients.js';
import { registerListClientsActivityTool } from '../../../src/tools/omada/listClientsActivity.js';
import { registerListClientsPastConnectionsTool } from '../../../src/tools/omada/listClientsPastConnections.js';
import { registerGetRateLimitProfilesTool } from '../../../src/tools/omada/getRateLimitProfiles.js';
import { registerSetClientRateLimitTool } from '../../../src/tools/omada/setClientRateLimit.js';
import { registerSetClientRateLimitProfileTool } from '../../../src/tools/omada/setClientRateLimitProfile.js';
import { registerDisableClientRateLimitTool } from '../../../src/tools/omada/disableClientRateLimit.js';
import { registerGetThreatListTool } from '../../../src/tools/omada/getThreatList.js';
import { registerGetInternetInfoTool } from '../../../src/tools/omada/getInternetInfo.js';
import { registerGetPortForwardingStatusTool } from '../../../src/tools/omada/getPortForwardingStatus.js';
import { registerGetLanNetworkListTool } from '../../../src/tools/omada/getLanNetworkList.js';
import { registerGetLanProfileListTool } from '../../../src/tools/omada/getLanProfileList.js';
import { registerGetWlanGroupListTool } from '../../../src/tools/omada/getWlanGroupList.js';
import { registerGetSsidListTool } from '../../../src/tools/omada/getSsidList.js';
import { registerGetSsidDetailTool } from '../../../src/tools/omada/getSsidDetail.js';
import { registerGetFirewallSettingTool } from '../../../src/tools/omada/getFirewallSetting.js';

// Create mock server that captures registered handlers
function createMockServer() {
  const handlers = new Map<string, { config: unknown; handler: Function }>();
  return {
    registerTool: vi.fn((name: string, config: unknown, handler: Function) => {
      handlers.set(name, { config, handler });
    }),
    handlers,
  } as unknown as McpServer & { handlers: Map<string, { config: unknown; handler: Function }> };
}

// Create mock OmadaClient
function createMockClient() {
  return {
    listSites: vi.fn(),
    listDevices: vi.fn(),
    getDevice: vi.fn(),
    searchDevices: vi.fn(),
    getSwitchStackDetail: vi.fn(),
    listDevicesStats: vi.fn(),
    listClients: vi.fn(),
    getClient: vi.fn(),
    listMostActiveClients: vi.fn(),
    listClientsActivity: vi.fn(),
    listClientsPastConnections: vi.fn(),
    getRateLimitProfiles: vi.fn(),
    setClientRateLimit: vi.fn(),
    setClientRateLimitProfile: vi.fn(),
    disableClientRateLimit: vi.fn(),
    getThreatList: vi.fn(),
    getInternetInfo: vi.fn(),
    getPortForwardingStatus: vi.fn(),
    getLanNetworkList: vi.fn(),
    getLanProfileList: vi.fn(),
    getWlanGroupList: vi.fn(),
    getSsidList: vi.fn(),
    getSsidDetail: vi.fn(),
    getFirewallSetting: vi.fn(),
  } as unknown as OmadaClient;
}

// Mock extra with all permissions
const mockExtra = {
  sessionId: 'test-session',
  authInfo: {
    extra: {
      permissions: 0xff, // All permissions
    },
  },
};

// Parse JSON result from tool output
function parseResult(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

describe('Omada Tool Handlers - Site Tools', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    vi.clearAllMocks();
  });

  describe('omada_listSites', () => {
    it('should register the tool', () => {
      registerListSitesTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_listSites',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return sites from client', async () => {
      const mockSites = [
        { id: 'site1', name: 'Site 1' },
        { id: 'site2', name: 'Site 2' },
      ];
      (client.listSites as ReturnType<typeof vi.fn>).mockResolvedValue(mockSites);

      registerListSitesTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_listSites')!.handler;
      const result = await handler({}, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockSites);
      expect(client.listSites).toHaveBeenCalled();
    });
  });
});

describe('Omada Tool Handlers - Device Tools', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    vi.clearAllMocks();
  });

  describe('omada_listDevices', () => {
    it('should register the tool', () => {
      registerListDevicesTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_listDevices',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return devices for a site', async () => {
      const mockDevices = [
        { mac: '00:11:22:33:44:55', name: 'AP1', type: 'ap' },
        { mac: '00:11:22:33:44:66', name: 'Switch1', type: 'switch' },
      ];
      (client.listDevices as ReturnType<typeof vi.fn>).mockResolvedValue(mockDevices);

      registerListDevicesTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_listDevices')!.handler;
      const result = await handler({ siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockDevices);
      expect(client.listDevices).toHaveBeenCalledWith('site1');
    });
  });

  describe('omada_getDevice', () => {
    it('should register the tool', () => {
      registerGetDeviceTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_getDevice',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return device details', async () => {
      const mockDevice = {
        mac: '00:11:22:33:44:55',
        name: 'AP1',
        type: 'ap',
        model: 'EAP225',
        firmware: '1.0.0',
      };
      (client.getDevice as ReturnType<typeof vi.fn>).mockResolvedValue(mockDevice);

      registerGetDeviceTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_getDevice')!.handler;
      const result = await handler({ deviceId: '00:11:22:33:44:55', siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockDevice);
      expect(client.getDevice).toHaveBeenCalledWith('00:11:22:33:44:55', 'site1');
    });
  });

  describe('omada_searchDevices', () => {
    it('should register the tool', () => {
      registerSearchDevicesTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_searchDevices',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should search devices by keyword', async () => {
      const mockResults = [{ mac: '00:11:22:33:44:55', name: 'Switch1' }];
      (client.searchDevices as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);

      registerSearchDevicesTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_searchDevices')!.handler;
      const result = await handler({ searchKey: 'switch' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockResults);
      expect(client.searchDevices).toHaveBeenCalledWith('switch');
    });
  });

  describe('omada_getSwitchStackDetail', () => {
    it('should register the tool', () => {
      registerGetSwitchStackDetailTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_getSwitchStackDetail',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return switch stack details', async () => {
      const mockStack = { stackId: 'stack1', switches: ['sw1', 'sw2'] };
      (client.getSwitchStackDetail as ReturnType<typeof vi.fn>).mockResolvedValue(mockStack);

      registerGetSwitchStackDetailTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_getSwitchStackDetail')!.handler;
      const result = await handler({ stackId: 'stack1', siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockStack);
      expect(client.getSwitchStackDetail).toHaveBeenCalledWith('stack1', 'site1');
    });
  });

  describe('omada_listDevicesStats', () => {
    it('should register the tool', () => {
      registerListDevicesStatsTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_listDevicesStats',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return device statistics with filters', async () => {
      const mockStats = { totalDevices: 10, devices: [] };
      (client.listDevicesStats as ReturnType<typeof vi.fn>).mockResolvedValue(mockStats);

      registerListDevicesStatsTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_listDevicesStats')!.handler;
      const result = await handler({ page: 1, pageSize: 10, filterTag: 'office' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockStats);
      expect(client.listDevicesStats).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, pageSize: 10, filterTag: 'office' })
      );
    });
  });
});

describe('Omada Tool Handlers - Client Tools', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    vi.clearAllMocks();
  });

  describe('omada_listClients', () => {
    it('should register the tool', () => {
      registerListClientsTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_listClients',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return clients for a site', async () => {
      const mockClients = [
        { mac: 'AA:BB:CC:DD:EE:FF', name: 'Phone1', ip: '192.168.0.100' },
        { mac: 'AA:BB:CC:DD:EE:00', name: 'Laptop1', ip: '192.168.0.101' },
      ];
      (client.listClients as ReturnType<typeof vi.fn>).mockResolvedValue(mockClients);

      registerListClientsTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_listClients')!.handler;
      const result = await handler({ siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockClients);
      expect(client.listClients).toHaveBeenCalledWith('site1');
    });
  });

  describe('omada_getClient', () => {
    it('should register the tool', () => {
      registerGetClientTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_getClient',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return client details', async () => {
      const mockClient = {
        mac: 'AA:BB:CC:DD:EE:FF',
        name: 'Phone1',
        ip: '192.168.0.100',
        ssid: 'MyWiFi',
      };
      (client.getClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);

      registerGetClientTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_getClient')!.handler;
      const result = await handler({ clientId: 'AA:BB:CC:DD:EE:FF', siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockClient);
      expect(client.getClient).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF', 'site1');
    });
  });

  describe('omada_listMostActiveClients', () => {
    it('should register the tool', () => {
      registerListMostActiveClientsTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_listMostActiveClients',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return most active clients', async () => {
      const mockActiveClients = [
        { mac: 'AA:BB:CC:DD:EE:FF', traffic: 1000000 },
        { mac: 'AA:BB:CC:DD:EE:00', traffic: 500000 },
      ];
      (client.listMostActiveClients as ReturnType<typeof vi.fn>).mockResolvedValue(mockActiveClients);

      registerListMostActiveClientsTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_listMostActiveClients')!.handler;
      const result = await handler({ siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockActiveClients);
      expect(client.listMostActiveClients).toHaveBeenCalledWith('site1');
    });
  });

  describe('omada_listClientsActivity', () => {
    it('should register the tool', () => {
      registerListClientsActivityTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_listClientsActivity',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return client activity', async () => {
      const mockActivity = [{ timestamp: 1234567890, clientCount: 10 }];
      (client.listClientsActivity as ReturnType<typeof vi.fn>).mockResolvedValue(mockActivity);

      registerListClientsActivityTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_listClientsActivity')!.handler;
      const result = await handler({ siteId: 'site1', start: 1000, end: 2000 }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockActivity);
      expect(client.listClientsActivity).toHaveBeenCalledWith(expect.objectContaining({ siteId: 'site1', start: 1000, end: 2000 }));
    });
  });

  describe('omada_listClientsPastConnections', () => {
    it('should register the tool', () => {
      registerListClientsPastConnectionsTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_listClientsPastConnections',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return past client connections', async () => {
      const mockPastConnections = [{ mac: 'AA:BB:CC:DD:EE:FF', lastSeen: 1234567890 }];
      (client.listClientsPastConnections as ReturnType<typeof vi.fn>).mockResolvedValue(mockPastConnections);

      registerListClientsPastConnectionsTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_listClientsPastConnections')!.handler;
      const result = await handler({ siteId: 'site1', page: 1, pageSize: 10 }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockPastConnections);
      expect(client.listClientsPastConnections).toHaveBeenCalledWith(expect.objectContaining({ siteId: 'site1', page: 1, pageSize: 10 }));
    });
  });
});

describe('Omada Tool Handlers - Rate Limit Tools', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    vi.clearAllMocks();
  });

  describe('omada_getRateLimitProfiles', () => {
    it('should register the tool', () => {
      registerGetRateLimitProfilesTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_getRateLimitProfiles',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return rate limit profiles', async () => {
      const mockProfiles = [
        { id: 'profile1', name: 'Default', downLimit: 10000, upLimit: 5000 },
      ];
      (client.getRateLimitProfiles as ReturnType<typeof vi.fn>).mockResolvedValue(mockProfiles);

      registerGetRateLimitProfilesTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_getRateLimitProfiles')!.handler;
      const result = await handler({ siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockProfiles);
      expect(client.getRateLimitProfiles).toHaveBeenCalledWith('site1');
    });
  });

  describe('omada_setClientRateLimit', () => {
    it('should register the tool', () => {
      registerSetClientRateLimitTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_setClientRateLimit',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should set client rate limit', async () => {
      const mockResult = { success: true };
      (client.setClientRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      registerSetClientRateLimitTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_setClientRateLimit')!.handler;
      const result = await handler(
        { clientMac: 'AA:BB:CC:DD:EE:FF', downLimit: 10000, upLimit: 5000, siteId: 'site1' },
        mockExtra
      );
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockResult);
      expect(client.setClientRateLimit).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF', 10000, 5000, 'site1');
    });
  });

  describe('omada_setClientRateLimitProfile', () => {
    it('should register the tool', () => {
      registerSetClientRateLimitProfileTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_setClientRateLimitProfile',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should apply rate limit profile to client', async () => {
      const mockResult = { success: true };
      (client.setClientRateLimitProfile as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      registerSetClientRateLimitProfileTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_setClientRateLimitProfile')!.handler;
      const result = await handler(
        { clientMac: 'AA:BB:CC:DD:EE:FF', profileId: 'profile1', siteId: 'site1' },
        mockExtra
      );
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockResult);
      expect(client.setClientRateLimitProfile).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF', 'profile1', 'site1');
    });
  });

  describe('omada_disableClientRateLimit', () => {
    it('should register the tool', () => {
      registerDisableClientRateLimitTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_disableClientRateLimit',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should disable client rate limit', async () => {
      const mockResult = { success: true };
      (client.disableClientRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      registerDisableClientRateLimitTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_disableClientRateLimit')!.handler;
      const result = await handler({ clientMac: 'AA:BB:CC:DD:EE:FF', siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockResult);
      expect(client.disableClientRateLimit).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF', 'site1');
    });
  });
});

describe('Omada Tool Handlers - Security Tools', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    vi.clearAllMocks();
  });

  describe('omada_getThreatList', () => {
    it('should register the tool', () => {
      registerGetThreatListTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_getThreatList',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return threat list', async () => {
      const mockThreats = [{ id: 'threat1', severity: 'high', description: 'Test threat' }];
      (client.getThreatList as ReturnType<typeof vi.fn>).mockResolvedValue(mockThreats);

      registerGetThreatListTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_getThreatList')!.handler;
      const result = await handler({ severity: 3 }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockThreats);
      expect(client.getThreatList).toHaveBeenCalledWith(expect.objectContaining({ severity: 3 }));
    });
  });
});

describe('Omada Tool Handlers - Network Tools', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    vi.clearAllMocks();
  });

  describe('omada_getInternetInfo', () => {
    it('should register the tool', () => {
      registerGetInternetInfoTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_getInternetInfo',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return internet info', async () => {
      const mockInfo = { wanType: 'dhcp', ip: '203.0.113.1', gateway: '203.0.113.254' };
      (client.getInternetInfo as ReturnType<typeof vi.fn>).mockResolvedValue(mockInfo);

      registerGetInternetInfoTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_getInternetInfo')!.handler;
      const result = await handler({ siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockInfo);
      expect(client.getInternetInfo).toHaveBeenCalledWith('site1');
    });
  });

  describe('omada_getPortForwardingStatus', () => {
    it('should register the tool', () => {
      registerGetPortForwardingStatusTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_getPortForwardingStatus',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return port forwarding rules', async () => {
      const mockRules = [{ name: 'SSH', externalPort: 22, internalPort: 22, ip: '192.168.0.10' }];
      (client.getPortForwardingStatus as ReturnType<typeof vi.fn>).mockResolvedValue(mockRules);

      registerGetPortForwardingStatusTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_getPortForwardingStatus')!.handler;
      const result = await handler({ siteId: 'site1', type: 'User' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockRules);
      // Handler calls client.getPortForwardingStatus(type, siteId, page, pageSize)
      expect(client.getPortForwardingStatus).toHaveBeenCalledWith('User', 'site1', 1, 10);
    });
  });

  describe('omada_getLanNetworkList', () => {
    it('should register the tool', () => {
      registerGetLanNetworkListTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_getLanNetworkList',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return LAN networks', async () => {
      const mockNetworks = [{ name: 'Default', vlan: 1, subnet: '192.168.0.0/24' }];
      (client.getLanNetworkList as ReturnType<typeof vi.fn>).mockResolvedValue(mockNetworks);

      registerGetLanNetworkListTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_getLanNetworkList')!.handler;
      const result = await handler({ siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockNetworks);
      expect(client.getLanNetworkList).toHaveBeenCalledWith('site1');
    });
  });

  describe('omada_getLanProfileList', () => {
    it('should register the tool', () => {
      registerGetLanProfileListTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_getLanProfileList',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return LAN profiles', async () => {
      const mockProfiles = [{ name: 'Default', nativeVlan: 1 }];
      (client.getLanProfileList as ReturnType<typeof vi.fn>).mockResolvedValue(mockProfiles);

      registerGetLanProfileListTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_getLanProfileList')!.handler;
      const result = await handler({ siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockProfiles);
      expect(client.getLanProfileList).toHaveBeenCalledWith('site1');
    });
  });

  describe('omada_getWlanGroupList', () => {
    it('should register the tool', () => {
      registerGetWlanGroupListTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_getWlanGroupList',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return WLAN groups', async () => {
      const mockGroups = [{ id: 'wlan1', name: 'Default' }];
      (client.getWlanGroupList as ReturnType<typeof vi.fn>).mockResolvedValue(mockGroups);

      registerGetWlanGroupListTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_getWlanGroupList')!.handler;
      const result = await handler({ siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockGroups);
      expect(client.getWlanGroupList).toHaveBeenCalledWith('site1');
    });
  });

  describe('omada_getSsidList', () => {
    it('should register the tool', () => {
      registerGetSsidListTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_getSsidList',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return SSIDs for a WLAN group', async () => {
      const mockSsids = [{ id: 'ssid1', name: 'MyWiFi', enabled: true }];
      (client.getSsidList as ReturnType<typeof vi.fn>).mockResolvedValue(mockSsids);

      registerGetSsidListTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_getSsidList')!.handler;
      const result = await handler({ wlanId: 'wlan1', siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockSsids);
      expect(client.getSsidList).toHaveBeenCalledWith('wlan1', 'site1');
    });
  });

  describe('omada_getSsidDetail', () => {
    it('should register the tool', () => {
      registerGetSsidDetailTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_getSsidDetail',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return SSID details', async () => {
      const mockSsid = {
        id: 'ssid1',
        name: 'MyWiFi',
        enabled: true,
        security: 'wpa2',
        vlan: 1,
      };
      (client.getSsidDetail as ReturnType<typeof vi.fn>).mockResolvedValue(mockSsid);

      registerGetSsidDetailTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_getSsidDetail')!.handler;
      const result = await handler({ ssidId: 'ssid1', wlanId: 'wlan1', siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockSsid);
      // Handler calls client.getSsidDetail(wlanId, ssidId, siteId)
      expect(client.getSsidDetail).toHaveBeenCalledWith('wlan1', 'ssid1', 'site1');
    });
  });

  describe('omada_getFirewallSetting', () => {
    it('should register the tool', () => {
      registerGetFirewallSettingTool(server, client as OmadaClient);
      expect(server.registerTool).toHaveBeenCalledWith(
        'omada_getFirewallSetting',
        expect.objectContaining({ description: expect.any(String) }),
        expect.any(Function)
      );
    });

    it('should return firewall settings', async () => {
      const mockSettings = { enabled: true, rules: [] };
      (client.getFirewallSetting as ReturnType<typeof vi.fn>).mockResolvedValue(mockSettings);

      registerGetFirewallSettingTool(server, client as OmadaClient);
      const handler = server.handlers.get('omada_getFirewallSetting')!.handler;
      const result = await handler({ siteId: 'site1' }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockSettings);
      expect(client.getFirewallSetting).toHaveBeenCalledWith('site1');
    });
  });
});

describe('Omada Tool Handlers - Permission Enforcement', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  const readonlyExtra = {
    sessionId: 'test-session',
    authInfo: {
      extra: {
        permissions: 0x08, // QUERY only
      },
    },
  };

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    vi.clearAllMocks();
  });

  it('should deny CONTROL tool access for QUERY-only user', async () => {
    registerSetClientRateLimitTool(server, client as OmadaClient);
    const handler = server.handlers.get('omada_setClientRateLimit')!.handler;
    const result = await handler(
      { clientMac: 'AA:BB:CC:DD:EE:FF', downLimit: 10000, upLimit: 5000 },
      readonlyExtra
    );
    const parsed = parseResult(result) as { error: string; message: string };

    expect(parsed.error).toBe('Permission denied');
    expect(parsed.message).toContain('CONTROL');
    expect(client.setClientRateLimit).not.toHaveBeenCalled();
  });

  it('should allow QUERY tool access for QUERY-only user', async () => {
    const mockSites = [{ id: 'site1', name: 'Site 1' }];
    (client.listSites as ReturnType<typeof vi.fn>).mockResolvedValue(mockSites);

    registerListSitesTool(server, client as OmadaClient);
    const handler = server.handlers.get('omada_listSites')!.handler;
    const result = await handler({}, readonlyExtra);
    const parsed = parseResult(result);

    expect(parsed).toEqual(mockSites);
    expect(client.listSites).toHaveBeenCalled();
  });
});

describe('Omada Tool Handlers - Error Handling', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    vi.clearAllMocks();
  });

  it('should handle client errors gracefully', async () => {
    (client.listSites as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection failed'));

    registerListSitesTool(server, client as OmadaClient);
    const handler = server.handlers.get('omada_listSites')!.handler;
    const result = await handler({}, mockExtra);
    const parsed = parseResult(result) as { error: string; message: string };

    expect(parsed.error).toBe('Failed to execute omada_listSites');
    expect(parsed.message).toContain('Connection failed');
  });

  it('should handle API errors', async () => {
    (client.getDevice as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Device not found'));

    registerGetDeviceTool(server, client as OmadaClient);
    const handler = server.handlers.get('omada_getDevice')!.handler;
    const result = await handler({ identifier: 'nonexistent', siteId: 'site1' }, mockExtra);
    const parsed = parseResult(result) as { error: string; message: string };

    expect(parsed.error).toBe('Failed to execute omada_getDevice');
    expect(parsed.message).toContain('Device not found');
  });
});
