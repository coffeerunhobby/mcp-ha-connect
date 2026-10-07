/**
 * Common MCP server creation
 * Shared across all transport types (stdio, SSE, stream)
 */

import { McpServer } from '@modelcontextprotocol/server';
import type { RegisteredTool } from '@modelcontextprotocol/server';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { registerAllTools } from '../tools/index.js';
import { isToolVisibleTo } from '../tools/common.js';
import type { OmadaRegistrationMode } from '../tools/omada/index.js';
import type { RestAction } from '../tools/infra/index.js';
import { registerAllResources } from '../resources/index.js';
import { generateInstructions } from './instructions.js';
import { logger } from '../utils/logger.js';
import type { OwnerQuestionService } from '../ownerQuestions/service.js';
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
  /** Owner questions service (askOwner & co.), when running. */
  ownerQuestions?: OwnerQuestionService;
}

export function createServer(options: CreateServerOptions): McpServer {
  const { haClient, omadaClient, aiClient, restActions, toolRegistrationMode, callerPermissions, ownerQuestions } = options;
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
    const config = args[1] as { inputSchema?: unknown; outputSchema?: unknown } | undefined;
    memoizeJsonSchema(config?.inputSchema);
    memoizeJsonSchema(config?.outputSchema);
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
      ownerQuestions,
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
 * Disable every tool the caller cannot use (it lacks the tool's static permission, or the
 * tool's visibility rule — e.g. omada_read's per-path one — finds nothing usable). Disabled
 * tools are omitted from `tools/list`, so an LLM client only plans with tools it can use.
 * Returns the number of tools hidden.
 */
export function hideUnpermittedTools(tools: Map<string, RegisteredTool>, callerPermissions: number): number {
  let hidden = 0;
  for (const [name, tool] of tools) {
    if (!isToolVisibleTo(name, callerPermissions)) {
      tool.disable();
      hidden++;
    }
  }
  return hidden;
}

/** Schemas whose JSON Schema conversion is already memoized (process lifetime). */
const memoizedSchemas = new WeakSet<object>();

type JsonSchemaConverter = (options?: unknown) => unknown;

/** Whether `schema`'s JSON Schema conversion has been memoized (for tests/diagnostics). */
export function isJsonSchemaMemoized(schema: unknown): boolean {
  return schema !== null && typeof schema === 'object' && memoizedSchemas.has(schema);
}

/**
 * Convert a tool schema to JSON Schema once per process instead of once per request.
 *
 * MCP SDK v2 converts every tool's schema to JSON Schema eagerly inside
 * `registerTool`, through the schema's Standard Schema `~standard.jsonSchema`
 * provider. The server is stateless and registers every tool on every request, so
 * that conversion (zod's `toJSONSchema`) became about half of request setup time. Tool
 * schemas are module-level constants, so the result never changes: this shadows the
 * provider on the schema instance with a cached one (the SDK's documented hook for a
 * custom provider). Each call returns a deep clone, so a caller that mutates the
 * result can never corrupt the cache. Validation (`~standard.validate`) is untouched.
 */
export function memoizeJsonSchema(schema: unknown): void {
  if (schema === null || typeof schema !== 'object' || memoizedSchemas.has(schema)) {
    return;
  }
  memoizedSchemas.add(schema);
  const std = (schema as { '~standard'?: { jsonSchema?: { input?: JsonSchemaConverter; output?: JsonSchemaConverter } } })[
    '~standard'
  ];
  if (!std?.jsonSchema?.input || !std.jsonSchema.output) {
    return; // Not a converter-carrying Standard Schema: leave it to the SDK as-is.
  }
  const memo = (convert: JsonSchemaConverter): JsonSchemaConverter => {
    const cache = new Map<string, unknown>();
    return (options) => {
      const key = JSON.stringify(options ?? null);
      if (!cache.has(key)) {
        cache.set(key, convert(options));
      }
      return structuredClone(cache.get(key));
    };
  };
  Object.defineProperty(schema, '~standard', {
    value: { ...std, jsonSchema: { input: memo(std.jsonSchema.input), output: memo(std.jsonSchema.output) } },
    configurable: true,
    enumerable: false,
    writable: false,
  });
}
