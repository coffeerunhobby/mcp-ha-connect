/**
 * Omada tools index - registers all Omada MCP tools
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmadaClient } from '../../omadaClient/index.js';
import { logger } from '../../utils/logger.js';

import { registerDisableClientRateLimitTool } from './disableClientRateLimit.js';
import { registerGetClientTool } from './getClient.js';
import { registerGetDeviceTool } from './getDevice.js';
import { registerGetFirewallSettingTool } from './getFirewallSetting.js';
import { registerGetInternetInfoTool } from './getInternetInfo.js';
import { registerGetLanNetworkListTool } from './getLanNetworkList.js';
import { registerGetLanProfileListTool } from './getLanProfileList.js';
import { registerGetPortForwardingStatusTool } from './getPortForwardingStatus.js';
import { registerGetRateLimitProfilesTool } from './getRateLimitProfiles.js';
import { registerGetSsidDetailTool } from './getSsidDetail.js';
import { registerGetSsidListTool } from './getSsidList.js';
import { registerGetSwitchStackDetailTool } from './getSwitchStackDetail.js';
import { registerGetThreatListTool } from './getThreatList.js';
import { registerGetWlanGroupListTool } from './getWlanGroupList.js';
import { registerListClientsTool } from './listClients.js';
import { registerListClientsActivityTool } from './listClientsActivity.js';
import { registerListClientsPastConnectionsTool } from './listClientsPastConnections.js';
import { registerListDevicesTool } from './listDevices.js';
import { registerListDevicesStatsTool } from './listDevicesStats.js';
import { registerListMostActiveClientsTool } from './listMostActiveClients.js';
import { registerListSitesTool } from './listSites.js';
import { registerSearchDevicesTool } from './searchDevices.js';
import { registerSetClientRateLimitTool } from './setClientRateLimit.js';
import { registerSetClientRateLimitProfileTool } from './setClientRateLimitProfile.js';

export function registerOmadaTools(server: McpServer, client: OmadaClient): number {
  logger.debug('Registering Omada tools');
  let toolCount = 0;

  // Site tools
  registerListSitesTool(server, client);
  toolCount += 1;

  // Device tools
  registerListDevicesTool(server, client);
  registerGetDeviceTool(server, client);
  registerSearchDevicesTool(server, client);
  registerGetSwitchStackDetailTool(server, client);
  registerListDevicesStatsTool(server, client);
  toolCount += 5;

  // Client tools
  registerListClientsTool(server, client);
  registerGetClientTool(server, client);
  registerListMostActiveClientsTool(server, client);
  registerListClientsActivityTool(server, client);
  registerListClientsPastConnectionsTool(server, client);
  toolCount += 5;

  // Rate limit tools
  registerGetRateLimitProfilesTool(server, client);
  registerSetClientRateLimitTool(server, client);
  registerSetClientRateLimitProfileTool(server, client);
  registerDisableClientRateLimitTool(server, client);
  toolCount += 4;

  // Security tools
  registerGetThreatListTool(server, client);
  toolCount += 1;

  // Network tools
  registerGetInternetInfoTool(server, client);
  registerGetPortForwardingStatusTool(server, client);
  registerGetLanNetworkListTool(server, client);
  registerGetLanProfileListTool(server, client);
  registerGetWlanGroupListTool(server, client);
  registerGetSsidListTool(server, client);
  registerGetSsidDetailTool(server, client);
  registerGetFirewallSettingTool(server, client);
  toolCount += 8;

  logger.info('Omada tools registered', { toolCount });
  return toolCount;
}
