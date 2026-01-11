/**
 * Tools index - registers all MCP tools
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';
import { logger } from '../utils/logger.js';

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

// AI Tools
import { registerAnalyzeSensorsTool } from './analyzeSensors.js';

export function registerAllTools(server: McpServer, client: HaClient, aiClient?: LocalAIClient): void {
  logger.debug('Registering all tools');

  // State & Entity Tools (8)
  registerGetStatesTool(server, client);
  registerGetStateTool(server, client);
  registerGetEntitiesByDomainTool(server, client);
  registerSearchEntitiesTool(server, client);
  registerGetAllSensorsTool(server, client);
  registerListEntitiesTool(server, client);
  registerGetDomainSummaryTool(server, client);
  registerGetHistoryTool(server, client);

  // Service & Control Tools (2)
  registerCallServiceTool(server, client);
  registerEntityActionTool(server, client);

  // Device Control Tools (9)
  registerControlLightTool(server, client);
  registerControlClimateTool(server, client);
  registerControlMediaPlayerTool(server, client);
  registerControlCoverTool(server, client);
  registerControlFanTool(server, client);
  registerActivateSceneTool(server, client);
  registerRunScriptTool(server, client);
  registerSendNotificationTool(server, client);
  registerListNotificationTargetsTool(server, client);

  // Automation Tools (9)
  registerListAutomationsTool(server, client);
  registerTriggerAutomationTool(server, client);
  registerEnableAutomationTool(server, client);
  registerDisableAutomationTool(server, client);
  registerToggleAutomationTool(server, client);
  registerReloadAutomationsTool(server, client);
  registerCreateAutomationTool(server, client);
  registerDeleteAutomationTool(server, client);
  registerGetAutomationTraceTool(server, client);

  // System Tools (4)
  registerGetVersionTool(server, client);
  registerRestartHomeAssistantTool(server, client);
  registerGetSystemLogTool(server, client);
  registerCheckUpdatesTool(server, client);

  // AI Tools (1)
  registerAnalyzeSensorsTool(server, aiClient);

  const toolCount = 8 + 2 + 9 + 9 + 4 + 1; // 33 tools
  logger.info('All tools registered successfully', { toolCount, aiEnabled: !!aiClient });
}

// Re-export common utilities
export { toToolResult, wrapToolHandler } from './common.js';
