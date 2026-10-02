/**
 * Common MCP server creation
 * Shared across all transport types (stdio, SSE, stream)
 */

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { registerAllTools } from '../tools/index.js';
import { getToolRequiredPermission } from '../tools/common.js';
import { hasPermission } from '../permissions/index.js';
import type { OmadaRegistrationMode } from '../tools/omada/index.js';
import type { RestAction } from '../tools/infra/index.js';
import { registerAllResources } from '../resources/index.js';
import { generateInstructions } from './instructions.js';
import { logger } from '../utils/logger.js';
import { VERSION } from '../version.js';

export interface CreateServerOptions {
  haClient?: HaClient;
  omadaClient?: OmadaClient;
  aiClient?: LocalAIClient;
  /** Pre-registered REST actions for invokeAction (empty/undefined = tool not registered). */
  restActions?: Record<string, RestAction>;
  /** Tool registration strategy for the Omada plugin (default 'eager'). */
  toolRegistrationMode?: OmadaRegistrationMode;
  /**
   * The caller's permission mask. When set, tools whose static permission the
   * caller lacks are disabled, which hides them from `tools/list` (and the SDK
   * rejects calls to them). Undefined = no filtering (stdio local trust).
   * Execution-time RBAC in wrapToolHandler still applies either way.
   */
  callerPermissions?: number;
}

export function createServer(options: CreateServerOptions): McpServer {
  const { haClient, omadaClient, aiClient, restActions, toolRegistrationMode, callerPermissions } = options;
  logger.debug('Creating MCP server instance');

  // Generate instructions based on enabled plugins
  const instructions = generateInstructions({
    haEnabled: !!haClient,
    omadaEnabled: !!omadaClient,
    aiEnabled: !!aiClient,
  });

  const server = new McpServer(
    {
      name: 'mcp-ha-connect',
      version: VERSION,
    },
    {
      instructions,
    }
  );

  logger.debug('Server instructions generated', { length: instructions.length });

  // Register all tools based on configured clients, capturing each RegisteredTool
  // handle so tools the caller can never use can be hidden afterwards.
  const registeredTools = new Map<string, RegisteredTool>();
  const originalRegisterTool = server.registerTool;
  server.registerTool = ((...args: Parameters<McpServer['registerTool']>) => {
    const tool = (originalRegisterTool as (...a: unknown[]) => RegisteredTool).apply(server, args);
    registeredTools.set(args[0], tool);
    return tool;
  }) as McpServer['registerTool'];
  try {
    registerAllTools({
      server,
      haClient,
      omadaClient,
      aiClient,
      restActions,
      toolRegistrationMode,
    });
  } finally {
    server.registerTool = originalRegisterTool;
  }

  if (callerPermissions !== undefined) {
    const hidden = hideUnpermittedTools(registeredTools, callerPermissions);
    logger.debug('Filtered tools by caller permissions', { visible: registeredTools.size - hidden, hidden });
  }

  // Register Home Assistant resources (if HA client provided)
  if (haClient) {
    registerAllResources(server, haClient);
  }

  logger.debug('MCP server instance created');

  return server;
}

/**
 * Disable every tool whose static permission the caller lacks. Disabled tools are
 * omitted from `tools/list`, so an LLM client only plans with tools it can use.
 * Returns the number of tools hidden.
 */
export function hideUnpermittedTools(tools: Map<string, RegisteredTool>, callerPermissions: number): number {
  let hidden = 0;
  for (const [name, tool] of tools) {
    const required = getToolRequiredPermission(name);
    if (required !== undefined && !hasPermission(callerPermissions, required)) {
      tool.disable();
      hidden++;
    }
  }
  return hidden;
}
