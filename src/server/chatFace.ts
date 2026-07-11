/**
 * Chat face — the OpenAPI/REST surface consumed by Open WebUI (Harvey's voice).
 *
 * THE FACES PROBLEM (v1.7): this server answers on two doors — the MCP face
 * (`/mcp`, ~60 tools) and this REST face (`/openapi.json` + `/api/*`). Before
 * v1.7 the REST face was THREE hand-maintained implementations (route handlers,
 * a permission map, and a hand-written spec object) that had to be kept in sync
 * by hand — so it fossilized at the 8 HA tools wired in the v1.5.1 era.
 *
 * Now ONE binding registry drives all three:
 *   - route dispatch          (`dispatchChatRequest`)
 *   - per-route RBAC          (`binding.permission`, same Permission bits as MCP)
 *   - the generated spec      (`buildOpenApiSpec`)
 *
 * Two locks decide what chat can see:
 *   1. Code: a tool must have a binding here at all (chat-ELIGIBLE).
 *   2. Operator: `MCP_CHAT_TOOLS=ha-core:rw,omada-read:r` selects which
 *      category:access slices are ACTIVE (unset = exactly the legacy 8 —
 *      zero-surprise upgrade).
 *
 * SECURITY INVARIANT (tested): ADMIN-bit tools (invokeAction) can never be
 * chat-faced. Chat is the most prompt-injectable surface; the deploy trigger
 * stays off it structurally, not by prompt-politeness.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

import type { ChatCategory, ChatAccess, ChatToolsSlice } from './chatSlice.js';

import type { HaClient } from '../haClient/index.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { Permission, hasPermission, getPermissionNames } from '../permissions/index.js';
import type { AuthenticatedRequest } from './auth.js';
import { logger } from '../utils/logger.js';
import { sanitizeError } from '../utils/sanitizeError.js';
import { VERSION } from '../version.js';
import type { ToolExtra } from '../tools/common.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { createBrowseHandler, createReadHandler, browseSchema, readSchema } from '../tools/omada/graph.js';
import { createSetSsidEnabledHandler, setSsidEnabledSchema } from '../tools/omada/setSsidEnabled.js';
import { createGetDomainSummaryHandler } from '../tools/homeassistant/getDomainSummary.js';
import { createListAutomationsHandler } from '../tools/homeassistant/listAutomations.js';
import { domainSchema, automationFilterSchema } from '../tools/common.js';

// ---------------------------------------------------------------------------
// Categories + operator slice (MCP_CHAT_TOOLS) — parsing lives in chatSlice.ts
// (zero-import module) so config.ts can use it without import cycles.
// ---------------------------------------------------------------------------

export { CHAT_CATEGORIES, parseChatTools } from './chatSlice.js';
export type { ChatCategory, ChatAccess, ChatToolsSlice } from './chatSlice.js';

// ---------------------------------------------------------------------------
// Binding model
// ---------------------------------------------------------------------------

/** Clients a binding's handler may need. */
export interface ChatDeps {
  haClient?: HaClient;
  omadaClient?: OmadaClient;
}

interface ChatRequestContext {
  /** Path parameters captured from the URL template. */
  params: Record<string, string>;
  /** Query string parameters. */
  query: URLSearchParams;
  /** Parsed JSON body (POST only; undefined otherwise). */
  body: unknown;
  /** Caller's permission mask (from the auth middleware). */
  permissions: number;
  deps: ChatDeps;
}

interface ChatResponse {
  status: number;
  body: unknown;
}

export interface ChatBinding {
  /** OpenAPI operationId; also the tool's identity for invariants/tests. */
  operationId: string;
  category: ChatCategory;
  access: ChatAccess;
  /** RBAC bit required on the route — mirrors the MCP-tool twin (BFLA guard). */
  permission: number;
  method: 'GET' | 'POST';
  /** Path template, e.g. `/api/states/{entity_id}`. */
  pathTemplate: string;
  /** Which client the handler needs (503 when absent). */
  requires: 'ha' | 'omada';
  /** OpenAPI operation object (verbatim for legacy; generated for tool bindings). */
  spec: Record<string, unknown>;
  handle: (ctx: ChatRequestContext) => Promise<ChatResponse>;
}

/** Compile a `/api/x/{a}/{b}` template into a matcher returning named params. */
function compileMatcher(template: string): (pathname: string) => Record<string, string> | null {
  const names: string[] = [];
  const pattern = template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  const regex = new RegExp(`^${pattern}$`);
  return (pathname: string) => {
    const m = pathname.match(regex);
    if (!m) return null;
    const params: Record<string, string> = {};
    names.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1]);
    });
    return params;
  };
}

// ---------------------------------------------------------------------------
// Legacy bindings — the pre-v1.7 REST surface, verbatim.
//
// Handlers intentionally keep their original response CONTRACTS (raw HA-style
// JSON, not the MCP tools' paginated envelopes) — Open WebUI has consumed these
// shapes since v1.5.x, and Phase 1 is byte-compatible by design. The golden-file
// test (tests/fixtures/openapi-default-slice.json) pins the spec.
// ---------------------------------------------------------------------------

const entityStateArraySchema = {
  type: 'array',
  items: { $ref: '#/components/schemas/EntityState' },
};

function ha(ctx: ChatRequestContext): HaClient {
  // `requires: 'ha'` guarantees presence; the dispatcher 503s before this runs.
  return ctx.deps.haClient as HaClient;
}

export const LEGACY_BINDINGS: ChatBinding[] = [
  {
    operationId: 'getStates',
    category: 'ha-core',
    access: 'read',
    permission: Permission.QUERY,
    method: 'GET',
    pathTemplate: '/api/states',
    requires: 'ha',
    spec: {
      operationId: 'getStates',
      summary: 'Get all entity states from Home Assistant',
      responses: {
        '200': {
          description: 'List of all entity states',
          content: { 'application/json': { schema: entityStateArraySchema } },
        },
      },
    },
    handle: async (ctx) => ({ status: 200, body: await ha(ctx).getStates() }),
  },
  {
    operationId: 'getState',
    category: 'ha-core',
    access: 'read',
    permission: Permission.QUERY,
    method: 'GET',
    pathTemplate: '/api/states/{entity_id}',
    requires: 'ha',
    spec: {
      operationId: 'getState',
      summary: 'Get state of a specific entity',
      parameters: [
        { name: 'entity_id', in: 'path', required: true, schema: { type: 'string' }, description: 'Entity ID (e.g., light.living_room)' },
      ],
      responses: {
        '200': {
          description: 'Entity state',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/EntityState' } } },
        },
      },
    },
    handle: async (ctx) => {
      const entityId = ctx.params.entity_id;
      const state = await ha(ctx).getState(entityId);
      return state
        ? { status: 200, body: state }
        : { status: 404, body: { error: `Entity ${entityId} not found` } };
    },
  },
  {
    operationId: 'callService',
    category: 'ha-core',
    access: 'write',
    permission: Permission.CONTROL,
    method: 'POST',
    pathTemplate: '/api/services/{domain}/{service}',
    requires: 'ha',
    spec: {
      operationId: 'callService',
      summary: 'Call a Home Assistant service',
      parameters: [
        { name: 'domain', in: 'path', required: true, schema: { type: 'string' }, description: 'Service domain (e.g., light, switch)' },
        { name: 'service', in: 'path', required: true, schema: { type: 'string' }, description: 'Service name (e.g., turn_on, turn_off)' },
      ],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                entity_id: { type: 'string', description: 'Target entity ID' },
                data: { type: 'object', description: 'Service data' },
              },
            },
          },
        },
      },
      responses: { '200': { description: 'Service call result' } },
    },
    handle: async (ctx) => {
      const body = ctx.body as { entity_id?: string; data?: Record<string, unknown> } | undefined;
      const result = await ha(ctx).callService({
        domain: ctx.params.domain,
        service: ctx.params.service,
        target: body?.entity_id ? { entity_id: body.entity_id } : undefined,
        service_data: body?.data,
      });
      return { status: 200, body: result };
    },
  },
  {
    operationId: 'getAllSensors',
    category: 'ha-core',
    access: 'read',
    permission: Permission.QUERY,
    method: 'GET',
    pathTemplate: '/api/sensors',
    requires: 'ha',
    spec: {
      operationId: 'getAllSensors',
      summary: 'Get all sensor and binary_sensor states',
      responses: {
        '200': {
          description: 'List of sensor states',
          content: { 'application/json': { schema: entityStateArraySchema } },
        },
      },
    },
    handle: async (ctx) => {
      const states = await ha(ctx).getStates();
      const sensors = states.filter(
        (s: { entity_id: string }) =>
          s.entity_id.startsWith('sensor.') || s.entity_id.startsWith('binary_sensor.')
      );
      return { status: 200, body: sensors };
    },
  },
  {
    operationId: 'getEntitiesByDomain',
    category: 'ha-core',
    access: 'read',
    permission: Permission.QUERY,
    method: 'GET',
    pathTemplate: '/api/entities/{domain}',
    requires: 'ha',
    spec: {
      operationId: 'getEntitiesByDomain',
      summary: 'Get all entities for a specific domain',
      parameters: [
        { name: 'domain', in: 'path', required: true, schema: { type: 'string' }, description: 'Domain name (e.g., light, sensor)' },
      ],
      responses: {
        '200': {
          description: 'List of entities in domain',
          content: { 'application/json': { schema: entityStateArraySchema } },
        },
      },
    },
    handle: async (ctx) => {
      const states = await ha(ctx).getStates();
      const filtered = states.filter((s: { entity_id: string }) =>
        s.entity_id.startsWith(`${ctx.params.domain}.`)
      );
      return { status: 200, body: filtered };
    },
  },
  {
    operationId: 'searchEntities',
    category: 'ha-core',
    access: 'read',
    permission: Permission.QUERY,
    method: 'GET',
    pathTemplate: '/api/search',
    requires: 'ha',
    spec: {
      operationId: 'searchEntities',
      summary: 'Search entities by name or ID',
      parameters: [
        { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' },
      ],
      responses: {
        '200': {
          description: 'Matching entities',
          content: { 'application/json': { schema: entityStateArraySchema } },
        },
      },
    },
    handle: async (ctx) => {
      const query = ctx.query.get('q')?.toLowerCase() ?? '';
      const states = await ha(ctx).getStates();
      const filtered = states.filter(
        (s: { entity_id: string; attributes?: { friendly_name?: string } }) =>
          s.entity_id.toLowerCase().includes(query) ||
          s.attributes?.friendly_name?.toLowerCase().includes(query)
      );
      return { status: 200, body: filtered };
    },
  },
  {
    operationId: 'getHistory',
    category: 'ha-history',
    access: 'read',
    permission: Permission.QUERY,
    method: 'GET',
    pathTemplate: '/api/history/{entity_id}',
    requires: 'ha',
    spec: {
      operationId: 'getHistory',
      summary: 'Get historical data for an entity',
      parameters: [
        { name: 'entity_id', in: 'path', required: true, schema: { type: 'string' }, description: 'Entity ID' },
        { name: 'hours', in: 'query', schema: { type: 'number', default: 24 }, description: 'Hours of history' },
      ],
      responses: {
        '200': {
          description: 'Historical data',
          content: { 'application/json': { schema: { type: 'array' } } },
        },
      },
    },
    handle: async (ctx) => {
      const hours = parseInt(ctx.query.get('hours') ?? '24', 10);
      const history = await ha(ctx).getHistory(ctx.params.entity_id, hours);
      return { status: 200, body: history };
    },
  },
  {
    operationId: 'getVersion',
    category: 'ha-core',
    access: 'read',
    permission: Permission.QUERY,
    method: 'GET',
    pathTemplate: '/api/version',
    requires: 'ha',
    spec: {
      operationId: 'getVersion',
      summary: 'Get Home Assistant version information',
      responses: {
        '200': {
          description: 'Version information',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  ha_version: { type: 'string', description: 'Home Assistant version' },
                  mcp_version: { type: 'string', description: 'MCP server version' },
                },
              },
            },
          },
        },
      },
    },
    handle: async (ctx) => {
      const haConfig = await ha(ctx).getVersion();
      return { status: 200, body: { ha_version: haConfig.version, mcp_version: VERSION } };
    },
  },
];

// The spec paths must render in the ORIGINAL order for byte-compatibility with
// the pre-v1.7 hand-written spec (JSON key order = insertion order). The legacy
// spec listed callService third; LEGACY_BINDINGS above preserves that order.

// ---------------------------------------------------------------------------
// Zod -> OpenAPI schema (minimal, for tool bindings only)
// ---------------------------------------------------------------------------

/**
 * Convert the small zod subset our chat-faced tools use into an OpenAPI schema.
 * Deliberately minimal (no dependency on zod-to-json-schema — adding a dep means
 * regenerating the lockfile, a recurring cross-OS trap). Unknown types degrade
 * to `{}` (permissive) rather than throwing.
 */
export function zodToOpenApiSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as { _def: { typeName: string } })._def;

  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodDefault': {
      const inner = zodToOpenApiSchema(
        (def as unknown as { innerType: z.ZodTypeAny }).innerType
      );
      if (def.typeName === 'ZodDefault') {
        const dv = (def as unknown as { defaultValue: () => unknown }).defaultValue();
        return { ...inner, default: dv };
      }
      return inner;
    }
    case 'ZodString':
      return { type: 'string', ...describeOf(schema) };
    case 'ZodNumber':
      return { type: 'number', ...describeOf(schema) };
    case 'ZodBoolean':
      return { type: 'boolean', ...describeOf(schema) };
    case 'ZodEnum':
      return {
        type: 'string',
        enum: (def as unknown as { values: string[] }).values,
        ...describeOf(schema),
      };
    case 'ZodArray':
      return {
        type: 'array',
        items: zodToOpenApiSchema((def as unknown as { type: z.ZodTypeAny }).type),
        ...describeOf(schema),
      };
    case 'ZodRecord':
      return { type: 'object', ...describeOf(schema) };
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToOpenApiSchema(value);
        if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
          required.push(key);
        }
      }
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...describeOf(schema),
      };
    }
    default:
      return {};
  }
}

function describeOf(schema: z.ZodTypeAny): { description?: string } {
  const description = (schema as { description?: string }).description;
  return description ? { description } : {};
}

// ---------------------------------------------------------------------------
// MCP-tool bindings — new chat tools dispatch THROUGH the shared MCP handler
// (single source of truth: same validation, RBAC, hints, and logging as /mcp).
// ---------------------------------------------------------------------------

/** Minimal synthetic ToolExtra for REST-originated tool calls. */
function restToolExtra(permissions: number): ToolExtra {
  return {
    sessionId: 'chat-rest',
    authInfo: { extra: { permissions } },
  } as unknown as ToolExtra;
}

/** Map a CallToolResult back onto an HTTP response. */
function toolResultToResponse(result: CallToolResult): ChatResponse {
  const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON tool output stays a plain string */
  }

  if (result.isError) {
    const errName = (body as { error?: string } | undefined)?.error;
    const status = errName === 'Permission denied' ? 403 : 500;
    return { status, body };
  }
  return { status: 200, body };
}

interface McpToolBindingOptions {
  name: string;
  category: ChatCategory;
  access: ChatAccess;
  permission: number;
  requires: 'ha' | 'omada';
  summary: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  createHandler: (deps: ChatDeps) => (args: never, extra: ToolExtra) => Promise<CallToolResult>;
}

/**
 * Build a chat binding that exposes an MCP tool as `POST /api/tools/{name}`.
 * The request body is the tool's arguments (validated by the tool's own zod
 * schema); the response is the tool result's JSON payload.
 */
function mcpToolBinding(options: McpToolBindingOptions): ChatBinding {
  const { name, category, access, permission, requires, summary, inputSchema, createHandler } = options;
  return {
    operationId: name,
    category,
    access,
    permission,
    method: 'POST',
    pathTemplate: `/api/tools/${name}`,
    requires,
    spec: {
      operationId: name,
      summary,
      requestBody: {
        content: { 'application/json': { schema: zodToOpenApiSchema(inputSchema) } },
      },
      responses: { '200': { description: 'Tool result' } },
    },
    handle: async (ctx) => {
      const parsed = inputSchema.safeParse(ctx.body ?? {});
      if (!parsed.success) {
        return {
          status: 400,
          body: {
            error: 'Invalid arguments',
            issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
        };
      }
      const handler = createHandler(ctx.deps);
      const result = await handler(parsed.data as never, restToolExtra(ctx.permissions));
      return toolResultToResponse(result);
    },
  };
}

/**
 * Chat-ELIGIBLE MCP tools. Adding an entry makes a tool *available* to the chat
 * face; the operator's MCP_CHAT_TOOLS slice decides whether it's *active*.
 *
 * NEVER list ADMIN-bit tools here (invokeAction). The invariant test enforces it.
 * omada_cyclePoePort is deliberately absent for now — hard power action.
 */
export const CHAT_TOOL_BINDINGS: ChatBinding[] = [
  mcpToolBinding({
    name: 'getDomainSummary',
    category: 'ha-core',
    access: 'read',
    permission: Permission.QUERY,
    requires: 'ha',
    summary: 'Get a summary of entities in a domain (counts and state breakdown)',
    inputSchema: domainSchema,
    createHandler: (deps) => createGetDomainSummaryHandler(deps.haClient as HaClient),
  }),
  mcpToolBinding({
    name: 'listAutomations',
    category: 'ha-automations',
    access: 'read',
    permission: Permission.QUERY,
    requires: 'ha',
    summary: 'List Home Assistant automations with status and last-triggered time',
    inputSchema: automationFilterSchema,
    createHandler: (deps) => createListAutomationsHandler(deps.haClient as HaClient),
  }),
  mcpToolBinding({
    name: 'omada_browse',
    category: 'omada-read',
    access: 'read',
    permission: Permission.QUERY,
    requires: 'omada',
    summary: 'Discover the Omada network resource graph (browse from "/" downward)',
    inputSchema: browseSchema,
    createHandler: (deps) => createBrowseHandler(deps.omadaClient as OmadaClient),
  }),
  mcpToolBinding({
    name: 'omada_read',
    category: 'omada-read',
    access: 'read',
    // Route-level QUERY; each resource path enforces its own bit inside the handler.
    permission: Permission.QUERY,
    requires: 'omada',
    summary: 'Read data from an Omada resource path discovered via omada_browse',
    inputSchema: readSchema,
    createHandler: (deps) => createReadHandler(deps.omadaClient as OmadaClient),
  }),
  mcpToolBinding({
    name: 'omada_setSsidEnabled',
    category: 'omada-write',
    access: 'write',
    permission: Permission.CONTROL,
    requires: 'omada',
    summary: 'Turn an SSID (e.g. the guest WiFi) on or off by name — reversible',
    inputSchema: setSsidEnabledSchema,
    createHandler: (deps) => createSetSsidEnabledHandler(deps.omadaClient as OmadaClient),
  }),
];

// ---------------------------------------------------------------------------
// Slice resolution + spec generation + dispatch
// ---------------------------------------------------------------------------

/**
 * Resolve the ACTIVE chat bindings.
 *
 * - Slice unset (MCP_CHAT_TOOLS not configured) -> exactly the legacy 8
 *   (pre-v1.7 behavior, byte-compatible spec).
 * - Slice set -> it governs BOTH legacy and tool bindings by category:access.
 *   The slice can only narrow relative to what the code marks chat-eligible.
 */
export function resolveChatBindings(slice: ChatToolsSlice | undefined, deps: ChatDeps): ChatBinding[] {
  const all = slice === undefined ? LEGACY_BINDINGS : [...LEGACY_BINDINGS, ...CHAT_TOOL_BINDINGS];

  return all.filter((binding) => {
    if (slice !== undefined) {
      const levels = slice.get(binding.category);
      if (!levels || !levels.has(binding.access)) {
        return false;
      }
    }
    // A binding whose client isn't configured is dropped from the face entirely
    // (absent from the spec, 404 on the route) rather than serving 503s.
    if (binding.requires === 'omada' && !deps.omadaClient) return false;
    // HA bindings stay visible without a client for legacy parity (503 at call
    // time via dispatch, matching pre-v1.7 behavior).
    return true;
  });
}

/** Generate the OpenAPI spec for the active chat face. */
export function buildOpenApiSpec(baseUrl: string, bindings: ChatBinding[]): object {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const binding of bindings) {
    const item = paths[binding.pathTemplate] ?? {};
    item[binding.method.toLowerCase()] = binding.spec;
    paths[binding.pathTemplate] = item;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Home Assistant MCP Tools',
      description: 'MCP server for Home Assistant - exposes entity states and service calls',
      version: VERSION,
    },
    servers: [{ url: baseUrl }],
    paths,
    components: {
      schemas: {
        EntityState: {
          type: 'object',
          properties: {
            entity_id: { type: 'string' },
            state: { type: 'string' },
            attributes: { type: 'object' },
            last_changed: { type: 'string' },
            last_updated: { type: 'string' },
          },
        },
      },
    },
  };
}

/** Compiled matcher cache (module-level; templates are static). */
const matcherCache = new Map<string, (pathname: string) => Record<string, string> | null>();

function matcherFor(template: string): (pathname: string) => Record<string, string> | null {
  let matcher = matcherCache.get(template);
  if (!matcher) {
    matcher = compileMatcher(template);
    matcherCache.set(template, matcher);
  }
  return matcher;
}

/**
 * Resolve the permission a REST route requires under the given bindings.
 * Exposed for tests and for auth-layer reasoning; returns null for unknown
 * routes (they 404 without needing a permission).
 */
export function requiredPermissionFor(
  bindings: ChatBinding[],
  method: string,
  pathname: string
): number | null {
  const m = method.toUpperCase();
  for (const binding of bindings) {
    if (binding.method !== m) continue;
    if (matcherFor(binding.pathTemplate)(pathname)) {
      return binding.permission;
    }
  }
  return null;
}

export interface DispatchOptions {
  bindings: ChatBinding[];
  deps: ChatDeps;
  /** Parse the request body (injected so http.ts's size-capped parser is used). */
  parseBody: (req: IncomingMessage) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}

/**
 * Dispatch a `/api/*` request against the active bindings: match, enforce the
 * route's RBAC bit (fail closed), parse the body for POSTs, run the handler.
 * Unknown routes 404; missing clients 503 — same semantics as the pre-v1.7
 * hand-written bridge.
 */
export async function dispatchChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  options: DispatchOptions
): Promise<void> {
  const { bindings, deps, parseBody, sendJson } = options;
  const parsedUrl = new URL(url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // Find the matching binding.
  let matched: { binding: ChatBinding; params: Record<string, string> } | undefined;
  for (const binding of bindings) {
    if (binding.method !== method) continue;
    const params = matcherFor(binding.pathTemplate)(pathname);
    if (params) {
      matched = { binding, params };
      break;
    }
  }

  if (!matched) {
    sendJson(res, 404, { error: 'API endpoint not found' });
    return;
  }
  const { binding, params } = matched;

  // Fail closed: a missing mask grants nothing (H1 / BFLA guard).
  const permissions = ((req as AuthenticatedRequest).auth?.extra?.permissions as number | undefined) ?? 0;
  if (!hasPermission(permissions, binding.permission)) {
    logger.warn('REST API permission denied', {
      method,
      path: pathname,
      required: getPermissionNames(binding.permission),
      has: getPermissionNames(permissions),
    });
    sendJson(res, 403, {
      error: 'Forbidden',
      message: `This endpoint requires permission: ${getPermissionNames(binding.permission).join(', ')}`,
    });
    return;
  }

  if (binding.requires === 'ha' && !deps.haClient) {
    sendJson(res, 503, { error: 'Home Assistant not configured' });
    return;
  }
  if (binding.requires === 'omada' && !deps.omadaClient) {
    sendJson(res, 503, { error: 'Omada not configured' });
    return;
  }

  try {
    const body = method === 'POST' ? await parseBody(req) : undefined;
    const response = await binding.handle({
      params,
      query: parsedUrl.searchParams,
      body,
      permissions,
      deps,
    });
    sendJson(res, response.status, response.body);
  } catch (error) {
    // M5: a body that exceeded the size cap surfaces as 413, not a generic 500.
    const statusCode = (error as { statusCode?: number } | undefined)?.statusCode;
    if (statusCode === 413) {
      if (!res.headersSent) {
        sendJson(res, 413, { error: 'Payload Too Large', message: 'Request body exceeds the size limit' });
      }
      return;
    }
    logger.error('REST API error', { error, url });
    // M6: log the detail above; never echo raw error text to the client.
    sendJson(res, 500, { error: 'Internal server error', message: sanitizeError(error) });
  }
}
