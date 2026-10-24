/**
 * Tools index - registers all MCP tools organized by domain
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';
import type { OmadaClient } from '../omadaClient/index.js';
import type { RuijieClient } from '../ruijieClient/index.js';
import { logger } from '../utils/logger.js';

// Tool registration functions by domain
import { registerHomeAssistantTools } from './homeassistant/index.js';
import { registerOmadaTools, type OmadaRegistrationMode } from './omada/index.js';
import { registerNetTools } from './net/index.js';
import { OmadaNetworkController } from '../net/adapters/omada.js';
import { RuijieNetworkController } from '../net/adapters/ruijie.js';
import type { NetworkController } from '../net/model.js';
import { registerAITools } from './ai/index.js';
import { registerInfraTools, type RestAction } from './infra/index.js';
import { registerOwnerQuestionTools } from './homeassistant/askOwner.js';
import type { OwnerQuestionService } from '../ownerQuestions/service.js';

export interface RegisterToolsOptions {
  server: McpServer;
  haClient?: HaClient;
  omadaClient?: OmadaClient;
  /** A Ruijie / Reyee router (its net_ tools take controller: "ruijie"). */
  ruijieClient?: RuijieClient;
  aiClient?: LocalAIClient;
  /** Pre-registered REST actions for invokeAction (empty/undefined = tool not registered). */
  restActions?: Record<string, RestAction>;
  /** Tool registration strategy for the Omada plugin (default 'eager'). */
  toolRegistrationMode?: OmadaRegistrationMode;
  /** Owner questions (askOwner & co.); registered only when the service is running. */
  ownerQuestions?: OwnerQuestionService;
}

/**
 * Register all available tools based on configured clients
 */
export function registerAllTools(options: RegisterToolsOptions): void {
  const { server, haClient, omadaClient, ruijieClient, aiClient, restActions, toolRegistrationMode, ownerQuestions } = options;
  logger.debug('Registering all tools');

  let totalTools = 0;

  // Home Assistant tools (if client provided)
  if (haClient) {
    const haToolCount = registerHomeAssistantTools(server, haClient);
    totalTools += haToolCount;
    if (ownerQuestions) {
      totalTools += registerOwnerQuestionTools(server, ownerQuestions);
    }
  }

  // Omada tools (if client provided)
  const netControllers: NetworkController[] = [];
  if (omadaClient) {
    const omadaToolCount = registerOmadaTools(server, omadaClient, toolRegistrationMode);
    totalTools += omadaToolCount;
    netControllers.push(new OmadaNetworkController(omadaClient, { controllerHost: omadaClient.controllerHost, serverHosts: omadaClient.serverAddresses }));
  }
  if (ruijieClient) netControllers.push(new RuijieNetworkController(ruijieClient));
  // Vendor-neutral net_* tools, through every configured adapter (same in eager and graph mode).
  totalTools += registerNetTools(server, netControllers);

  // AI tools (only with an AI client)
  const aiToolCount = registerAITools(server, aiClient);
  totalTools += aiToolCount;

  // Infra tools (only when REST actions are configured)
  totalTools += registerInfraTools(server, restActions ?? {});

  logger.info('All tools registered successfully', {
    totalTools,
    haEnabled: !!haClient,
    omadaEnabled: !!omadaClient,
    ruijieEnabled: !!ruijieClient,
    aiEnabled: !!aiClient,
    infraEnabled: Object.keys(restActions ?? {}).length > 0,
  });
}

// Re-export common utilities
export { toToolResult, wrapToolHandler, Permission } from './common.js';

// Re-export domain-specific registration functions for selective use
export { registerHomeAssistantTools } from './homeassistant/index.js';
export { registerOmadaTools } from './omada/index.js';
export { registerAITools } from './ai/index.js';
