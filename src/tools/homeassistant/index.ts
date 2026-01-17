/**
 * Home Assistant tools index - registers all HA MCP tools
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../haClient/index.js';
import { logger } from '../../utils/logger.js';

// State & Entity Tools
import { registerGetStatesTool } from './getStates.js';
import { registerGetStateTool } from './getState.js';
import { registerGetEntitiesByDomainTool } from './getEntitiesByDomain.js';
import { registerSearchEntitiesTool } from './searchEntities.js';
import { registerGetAllSensorsTool } from './getAllSensors.js';
import { registerListEntitiesTool } from './listEntities.js';
import { registerGetDomainSummaryTool } from './getDomainSummary.js';
import { registerGetHistoryTool } from './getHistory.js';

// Service & Control Tools
import { registerCallServiceTool } from './callService.js';
import { registerEntityActionTool } from './entityAction.js';

// Device Control Tools
import { registerControlLightTool } from './controlLight.js';
import { registerControlClimateTool } from './controlClimate.js';
import { registerControlMediaPlayerTool } from './controlMediaPlayer.js';
import { registerControlCoverTool } from './controlCover.js';
import { registerControlFanTool } from './controlFan.js';
import { registerActivateSceneTool, registerRunScriptTool } from './sceneAndScript.js';
import { registerSendNotificationTool, registerListNotificationTargetsTool } from './sendNotification.js';

// Automation Tools
import { registerListAutomationsTool } from './listAutomations.js';
import { registerTriggerAutomationTool } from './triggerAutomation.js';
import {
  registerEnableAutomationTool,
  registerDisableAutomationTool,
  registerToggleAutomationTool,
  registerReloadAutomationsTool,
} from './automationControls.js';
import { registerCreateAutomationTool } from './createAutomation.js';
import { registerDeleteAutomationTool } from './deleteAutomation.js';
import { registerGetAutomationTraceTool } from './getAutomationTrace.js';

// System Tools
import { registerGetVersionTool } from './getVersion.js';
import {
  registerRestartHomeAssistantTool,
  registerGetSystemLogTool,
  registerCheckUpdatesTool,
} from './systemTools.js';

// Calendar Tools
import { registerListCalendarsTool, registerGetCalendarEventsTool } from './calendar.js';

// Person Tools
import { registerListPersonsTool } from './listPersons.js';

export function registerHomeAssistantTools(server: McpServer, client: HaClient): number {
  logger.debug('Registering Home Assistant tools');
  let toolCount = 0;

  // State & Entity Tools
  registerGetStatesTool(server, client);
  registerGetStateTool(server, client);
  registerGetEntitiesByDomainTool(server, client);
  registerSearchEntitiesTool(server, client);
  registerGetAllSensorsTool(server, client);
  registerListEntitiesTool(server, client);
  registerGetDomainSummaryTool(server, client);
  registerGetHistoryTool(server, client);
  toolCount += 8;

  // Service & Control Tools
  registerCallServiceTool(server, client);
  registerEntityActionTool(server, client);
  toolCount += 2;

  // Device Control Tools
  registerControlLightTool(server, client);
  registerControlClimateTool(server, client);
  registerControlMediaPlayerTool(server, client);
  registerControlCoverTool(server, client);
  registerControlFanTool(server, client);
  registerActivateSceneTool(server, client);
  registerRunScriptTool(server, client);
  registerSendNotificationTool(server, client);
  registerListNotificationTargetsTool(server, client);
  toolCount += 9;

  // Automation Tools
  registerListAutomationsTool(server, client);
  registerTriggerAutomationTool(server, client);
  registerEnableAutomationTool(server, client);
  registerDisableAutomationTool(server, client);
  registerToggleAutomationTool(server, client);
  registerReloadAutomationsTool(server, client);
  registerCreateAutomationTool(server, client);
  registerDeleteAutomationTool(server, client);
  registerGetAutomationTraceTool(server, client);
  toolCount += 9;

  // System Tools
  registerGetVersionTool(server, client);
  registerRestartHomeAssistantTool(server, client);
  registerGetSystemLogTool(server, client);
  registerCheckUpdatesTool(server, client);
  toolCount += 4;

  // Calendar Tools
  registerListCalendarsTool(server, client);
  registerGetCalendarEventsTool(server, client);
  toolCount += 2;

  // Person Tools
  registerListPersonsTool(server, client);
  toolCount += 1;

  logger.info('Home Assistant tools registered', { toolCount });
  return toolCount;
}
