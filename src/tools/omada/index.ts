/**
 * Omada tools index - registers all Omada MCP tools
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmadaClient } from '../../omadaClient/index.js';
import { logger } from '../../utils/logger.js';

import { registerBlockClientTool } from './blockClient.js';
import { registerOmadaGraphTools } from './graph.js';
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
import { registerUnblockClientTool } from './unblockClient.js';

/**
 * Tool registration strategy for the Omada plugin.
 *  - `eager` (default): register every typed Omada tool (~25). Backwards-compatible.
 *  - `graph`: register only the resource-graph reads (`omada_browse` + `omada_read`)
 *    plus the typed write/action tools. Keeps the tool-schema budget small for
 *    low-context models while still exposing every read endpoint via the namespace.
 */
export type OmadaRegistrationMode = 'eager' | 'graph';

export function registerOmadaTools(
  server: McpServer,
  client: OmadaClient,
  mode: OmadaRegistrationMode = 'eager'
): number {
  if (mode === 'graph') {
    return registerOmadaToolsGraph(server, client);
  }

  logger.debug('Registering Omada tools', { mode });
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

  // Client block tools
  registerBlockClientTool(server, client);
  registerUnblockClientTool(server, client);
  toolCount += 2;

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

  logger.info('Omada tools registered', { mode, toolCount });
  return toolCount;
}

/**
 * Graph mode: resource-graph reads + typed writes/actions only.
 *
 * Reads collapse into `omada_browse` + `omada_read` (see ./graph.ts and
 * ./namespace.ts). Writes stay as individual, explicitly permission-gated tools —
 * they mutate real network state, so each keeps its own narrow schema and RBAC
 * (CONTROL) rather than being funneled through a generic verb.
 */
function registerOmadaToolsGraph(server: McpServer, client: OmadaClient): number {
  logger.debug('Registering Omada tools', { mode: 'graph' });
  let toolCount = 0;

  // Resource-graph reads (browse + read)
  toolCount += registerOmadaGraphTools(server, client);

  // Typed write / action tools (unchanged, individually permission-gated)
  registerSetClientRateLimitTool(server, client);
  registerSetClientRateLimitProfileTool(server, client);
  registerDisableClientRateLimitTool(server, client);
  registerBlockClientTool(server, client);
  registerUnblockClientTool(server, client);
  toolCount += 5;

  logger.info('Omada tools registered', { mode: 'graph', toolCount });
  return toolCount;
}
