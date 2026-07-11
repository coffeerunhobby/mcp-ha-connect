import { z } from 'zod';
import { isValidBindAddress, isValidOrigin, isLoopbackAddress } from './utils/config-validations.js';
import { parsePermissionsConfig, type PermissionsConfig } from './permissions/index.js';
import { parseRestActions, type RestAction } from './tools/infra/actions.js';
import { parseChatTools, type ChatToolsSlice } from './server/chatSlice.js';
import { logger } from './utils/logger.js';
import type { AIProviderType } from './localAI/types.js';

const createBooleanStringSchema = (
  defaultValue: boolean
): z.ZodEffects<z.ZodOptional<z.ZodUnion<[z.ZodLiteral<'true'>, z.ZodLiteral<'false'>]>>, boolean, 'true' | 'false' | undefined> =>
  z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((value: 'true' | 'false' | undefined) => {
      if (value === undefined) return defaultValue;
      return value === 'true';
    });

const numericStringSchema = z
  .string()
  .optional()
  .transform((value: string | undefined) => (value ? Number.parseInt(value, 10) : undefined))
  .pipe(z.number().positive().optional());

const envSchema = z
  .object({
    // Plugin Enable Flags (default: false)
    haPluginEnabled: createBooleanStringSchema(false),
    aiPluginEnabled: createBooleanStringSchema(false),
    omadaPluginEnabled: createBooleanStringSchema(false),

    // Home Assistant Client Configuration (optional if using Omada only)
    haUrl: z.string().url({ message: 'HA_URL must be a valid URL' }).optional(),
    haToken: z.string().min(1).optional(),
    haStrictSsl: createBooleanStringSchema(true),
    haTimeout: numericStringSchema,

    // Omada Client Configuration (optional)
    omadaBaseUrl: z.string().url({ message: 'OMADA_BASE_URL must be a valid URL' }).optional(),
    omadaClientId: z.string().min(1).optional(),
    omadaClientSecret: z.string().min(1).optional(),
    omadaOmadacId: z.string().min(1).optional(),
    omadaSiteId: z.string().min(1).optional(),
    omadaStrictSsl: createBooleanStringSchema(true),
    omadaTimeout: numericStringSchema,

    // Pre-registered REST actions for the invokeAction tool (optional; raw JSON,
    // parsed + validated by parseRestActions after the env parse)
    restActions: z.string().optional(),

    // Chat-face tool slice for the OpenAPI/REST surface (optional; raw
    // `category:rw` list, parsed + validated by parseChatTools after the env parse)
    chatTools: z.string().optional(),

    // AI Provider Configuration (use 'none' to disable AI features)
    aiProvider: z.enum(['ollama', 'openai', 'none']).optional(),
    aiUrl: z.string().url().optional(),
    aiModel: z.string().optional(),
    aiTimeout: numericStringSchema,
    aiApiKey: z.string().optional(),

    // MCP Generic Server Configuration
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
    logFormat: z.enum(['plain', 'json', 'gcp-json']).optional().default('plain'),
    useHttp: createBooleanStringSchema(false),
    stateful: createBooleanStringSchema(false),
    // Tool registration strategy. `eager` (default) registers every typed tool;
    // `graph` registers the Omada resource-graph reads (omada_browse/omada_read)
    // plus typed writes, shrinking the tool-schema budget for low-context models.
    toolRegistrationMode: z.enum(['eager', 'graph']).optional().default('eager'),

    // MCP Server HTTP Configuration
    httpPort: numericStringSchema,
    httpBindAddr: z.string().optional(),
    httpPath: z.string().optional(),
    httpEnableHealthcheck: createBooleanStringSchema(true),
    httpHealthcheckPath: z.string().optional(),
    httpAllowCors: createBooleanStringSchema(true),
    httpAllowedOrigins: z.string().optional().transform((v) => v?.split(',').map((s) => s.trim()).filter(Boolean)),
    httpAllowedHosts: z.string().optional().transform((v) => v?.split(',').map((s) => s.trim()).filter(Boolean)),

    // SSE Event Subscription Configuration
    sseEventsEnabled: createBooleanStringSchema(true),
    sseEventsPath: z.string().optional(),

    // Rate Limiting Configuration
    rateLimitEnabled: createBooleanStringSchema(true),
    rateLimitWindowMs: numericStringSchema,
    rateLimitMaxRequests: numericStringSchema,
    // M4: immediate-peer IPs whose forwarding headers may be trusted (CSV).
    rateLimitTrustedProxies: z
      .string()
      .optional()
      .transform((v) => v?.split(',').map((s) => s.trim()).filter(Boolean)),

    // Authentication Configuration
    authMethod: z.enum(['none', 'bearer']).optional().default('none'),
    authSecret: z.string().optional(),
    authRequireExp: createBooleanStringSchema(false),
    authIssuer: z.string().min(1).optional(),
    authAudience: z.string().min(1).optional(),
    permissionsConfig: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.httpBindAddr && !isValidBindAddress(data.httpBindAddr)) {
        return false;
      }
      return true;
    },
    {
      message: 'MCP_HTTP_BIND_ADDR must be a valid IPv4 or IPv6 address',
      path: ['httpBindAddr'],
    }
  )
  .refine(
    (data) => {
      if (data.httpAllowedOrigins) {
        for (const origin of data.httpAllowedOrigins) {
          if (!isValidOrigin(origin)) {
            return false;
          }
        }
      }
      return true;
    },
    (data) => {
      const invalidOrigin = data.httpAllowedOrigins?.find((origin) => !isValidOrigin(origin));
      return {
        message: `MCP_HTTP_ALLOWED_ORIGINS contains invalid origin: ${invalidOrigin}`,
        path: ['httpAllowedOrigins'],
      };
    }
  )
  .refine(
    (data) => {
      if (data.authMethod === 'bearer' && !data.authSecret) {
        return false;
      }
      return true;
    },
    {
      message: 'MCP_AUTH_SECRET is required when MCP_AUTH_METHOD is "bearer"',
      path: ['authSecret'],
    }
  )
  .refine(
    (data) => {
      // M8: a weak signing secret undermines the whole bearer scheme.
      if (data.authMethod === 'bearer' && data.authSecret && data.authSecret.length < 32) {
        return false;
      }
      return true;
    },
    {
      message: 'MCP_AUTH_SECRET must be at least 32 characters when MCP_AUTH_METHOD is "bearer"',
      path: ['authSecret'],
    }
  )
  .refine(
    (data) => {
      // H5: an unauthenticated server must never be reachable off-host. Allow
      // method=none only when the (explicit) bind address is loopback. A missing
      // bind address defaults to 127.0.0.1 later, so it is safe.
      if (
        data.authMethod === 'none' &&
        data.httpBindAddr &&
        !isLoopbackAddress(data.httpBindAddr)
      ) {
        return false;
      }
      return true;
    },
    {
      message:
        'MCP_AUTH_METHOD=none is only permitted on a loopback bind address ' +
        '(127.0.0.0/8 or ::1). Set MCP_AUTH_METHOD=bearer (with MCP_AUTH_SECRET) ' +
        'to bind a public interface such as 0.0.0.0.',
      path: ['authMethod'],
    }
  );

export interface EnvironmentConfig {
  // Plugin Enable Flags
  haPluginEnabled: boolean;
  aiPluginEnabled: boolean;
  omadaPluginEnabled: boolean;

  // Home Assistant Client Configuration (optional if using Omada only)
  baseUrl?: string;
  token?: string;
  strictSsl: boolean;
  timeout: number;

  // Omada Client Configuration (optional)
  omadaBaseUrl?: string;
  omadaClientId?: string;
  omadaClientSecret?: string;
  omadacId?: string;
  siteId?: string;
  omadaStrictSsl: boolean;
  requestTimeout?: number;

  // AI Provider Configuration
  aiProvider: AIProviderType;
  aiUrl: string;
  aiModel: string;
  aiTimeout: number;
  aiApiKey?: string;

  // Pre-registered REST actions for the invokeAction tool (empty = tool not registered)
  restActions: Record<string, RestAction>;

  // Chat-face (OpenAPI/REST) tool slice (undefined = legacy 8-tool default)
  chatTools?: ChatToolsSlice;

  // MCP Generic Server Configuration
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'plain' | 'json' | 'gcp-json';
  useHttp: boolean;
  stateful: boolean;
  toolRegistrationMode: 'eager' | 'graph';

  // MCP Server HTTP Configuration
  httpPort?: number;
  httpBindAddr?: string;
  httpPath?: string;
  httpEnableHealthcheck: boolean;
  httpHealthcheckPath?: string;
  httpAllowCors: boolean;
  httpAllowedOrigins?: string[];
  /**
   * Opt-in list of Host-header values (host[:port]) the server is reached by.
   * When set, DNS-rebinding Host validation is enforced at the transport (M3);
   * when unset, Host validation is OFF (origin/CORS is handled separately).
   */
  httpAllowedHosts?: string[];

  // SSE Event Subscription Configuration
  sseEventsEnabled: boolean;
  sseEventsPath: string;

  // Rate Limiting Configuration
  rateLimitEnabled: boolean;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  rateLimitTrustedProxies?: string[];

  // Authentication Configuration
  authMethod: 'none' | 'bearer';
  authSecret?: string;
  authRequireExp: boolean;
  authIssuer?: string;
  authAudience?: string;
  permissions: PermissionsConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EnvironmentConfig {
  const parsed = envSchema.safeParse({
    // Plugin Enable Flags
    haPluginEnabled: env.HA_PLUGIN_ENABLED,
    aiPluginEnabled: env.AI_PLUGIN_ENABLED,
    omadaPluginEnabled: env.OMADA_PLUGIN_ENABLED,

    // Home Assistant Client Configuration
    haUrl: env.HA_URL,
    haToken: env.HA_TOKEN,
    haStrictSsl: env.HA_STRICT_SSL,
    haTimeout: env.HA_TIMEOUT,

    // Omada Client Configuration
    omadaBaseUrl: env.OMADA_BASE_URL,
    omadaClientId: env.OMADA_CLIENT_ID,
    omadaClientSecret: env.OMADA_CLIENT_SECRET,
    omadaOmadacId: env.OMADA_OMADAC_ID,
    omadaSiteId: env.OMADA_SITE_ID,
    omadaStrictSsl: env.OMADA_STRICT_SSL,
    omadaTimeout: env.OMADA_TIMEOUT,

    // Pre-registered REST actions
    restActions: env.MCP_REST_ACTIONS,

    // Chat-face tool slice
    chatTools: env.MCP_CHAT_TOOLS,

    // AI Provider Configuration
    aiProvider: env.AI_PROVIDER,
    aiUrl: env.AI_URL,
    aiModel: env.AI_MODEL,
    aiTimeout: env.AI_TIMEOUT,
    aiApiKey: env.AI_API_KEY,

    // MCP Generic Server Configuration
    logLevel: env.MCP_SERVER_LOG_LEVEL,
    logFormat: env.MCP_SERVER_LOG_FORMAT,
    useHttp: env.MCP_SERVER_USE_HTTP,
    stateful: env.MCP_SERVER_STATEFUL,
    toolRegistrationMode: env.MCP_TOOL_REGISTRATION_MODE,

    // MCP Server HTTP Configuration
    httpPort: env.MCP_HTTP_PORT,
    httpBindAddr: env.MCP_HTTP_BIND_ADDR,
    httpPath: env.MCP_HTTP_PATH,
    httpEnableHealthcheck: env.MCP_HTTP_ENABLE_HEALTHCHECK,
    httpHealthcheckPath: env.MCP_HTTP_HEALTHCHECK_PATH,
    httpAllowCors: env.MCP_HTTP_ALLOW_CORS,
    httpAllowedOrigins: env.MCP_HTTP_ALLOWED_ORIGINS,
    httpAllowedHosts: env.MCP_HTTP_ALLOWED_HOSTS,

    // SSE Event Subscription Configuration
    sseEventsEnabled: env.MCP_SSE_EVENTS_ENABLED,
    sseEventsPath: env.MCP_SSE_EVENTS_PATH,

    // Rate Limiting Configuration
    rateLimitEnabled: env.MCP_RATE_LIMIT_ENABLED,
    rateLimitWindowMs: env.MCP_RATE_LIMIT_WINDOW_MS,
    rateLimitMaxRequests: env.MCP_RATE_LIMIT_MAX_REQUESTS,
    rateLimitTrustedProxies: env.MCP_RATE_LIMIT_TRUSTED_PROXIES,

    // Authentication Configuration
    authMethod: env.MCP_AUTH_METHOD,
    authSecret: env.MCP_AUTH_SECRET,
    authRequireExp: env.MCP_AUTH_REQUIRE_EXP,
    authIssuer: env.MCP_AUTH_ISSUER,
    authAudience: env.MCP_AUTH_AUDIENCE,
    permissionsConfig: env.MCP_PERMISSIONS_CONFIG,
  });

  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue: z.ZodIssue) => issue.message);
    throw new Error(`Invalid environment configuration:\n${messages.join('\n')}`);
  }

  const httpPath = parsed.data.httpPath ?? '/mcp';
  const httpBindAddr = parsed.data.httpBindAddr ?? '127.0.0.1';
  const httpPort = parsed.data.httpPort ?? 3000;

  // M3: default origins must be full scheme://host:port so they actually match a
  // real browser `Origin` header (the SDK compares it by exact string). Bare
  // hostnames like "localhost" never match "http://localhost:3000" and so left
  // DNS-rebinding/CORS protection effectively disabled for the default config.
  let httpAllowedOrigins =
    parsed.data.httpAllowedOrigins ??
    [`http://localhost:${httpPort}`, `http://127.0.0.1:${httpPort}`];

  if (httpAllowedOrigins.includes('*')) {
    logger.warn('Wildcard (*) origin allowed - origin validation disabled');
    httpAllowedOrigins = [];
  }

  // H5: make the no-auth posture loud even when the bind is loopback.
  if (parsed.data.authMethod === 'none') {
    logger.warn(
      'MCP_AUTH_METHOD=none: authentication is DISABLED. This is only permitted ' +
        'on a loopback bind; set MCP_AUTH_METHOD=bearer to expose the server.'
    );
  }

  return {
    // Plugin Enable Flags
    haPluginEnabled: parsed.data.haPluginEnabled,
    aiPluginEnabled: parsed.data.aiPluginEnabled,
    omadaPluginEnabled: parsed.data.omadaPluginEnabled,

    // Home Assistant Client Configuration (optional)
    baseUrl: parsed.data.haUrl?.replace(/\/$/, ''),
    token: parsed.data.haToken,
    strictSsl: parsed.data.haStrictSsl,
    timeout: parsed.data.haTimeout ?? 30000,

    // Omada Client Configuration (optional)
    omadaBaseUrl: parsed.data.omadaBaseUrl?.replace(/\/$/, ''),
    omadaClientId: parsed.data.omadaClientId,
    omadaClientSecret: parsed.data.omadaClientSecret,
    omadacId: parsed.data.omadaOmadacId,
    siteId: parsed.data.omadaSiteId,
    omadaStrictSsl: parsed.data.omadaStrictSsl,
    requestTimeout: parsed.data.omadaTimeout,

    // Pre-registered REST actions (throws on malformed JSON — config typos fail loudly)
    restActions: parseRestActions(parsed.data.restActions),

    // Chat-face tool slice (throws on unknown category/access — typos fail loudly)
    chatTools: parseChatTools(parsed.data.chatTools),

    // AI Provider Configuration
    aiProvider: (parsed.data.aiProvider ?? 'ollama') as AIProviderType,
    aiUrl: parsed.data.aiUrl ?? 'http://localhost:11434',
    aiModel: parsed.data.aiModel ?? 'qwen3:14b',
    aiTimeout: parsed.data.aiTimeout ?? 60000,
    aiApiKey: parsed.data.aiApiKey,

    // MCP Generic Server Configuration
    logLevel: parsed.data.logLevel,
    logFormat: parsed.data.logFormat,
    useHttp: parsed.data.useHttp,
    stateful: parsed.data.stateful,
    toolRegistrationMode: parsed.data.toolRegistrationMode,

    // MCP Server HTTP Configuration
    httpPort,
    httpBindAddr,
    httpPath,
    httpEnableHealthcheck: parsed.data.httpEnableHealthcheck,
    httpHealthcheckPath: parsed.data.httpHealthcheckPath,
    httpAllowCors: parsed.data.httpAllowCors,
    httpAllowedOrigins,
    httpAllowedHosts: parsed.data.httpAllowedHosts,

    // SSE Event Subscription Configuration
    sseEventsEnabled: parsed.data.sseEventsEnabled,
    sseEventsPath: parsed.data.sseEventsPath ?? '/subscribe_events',

    // Rate Limiting Configuration
    rateLimitEnabled: parsed.data.rateLimitEnabled,
    rateLimitWindowMs: parsed.data.rateLimitWindowMs ?? 60000,
    rateLimitMaxRequests: parsed.data.rateLimitMaxRequests ?? 100,
    rateLimitTrustedProxies: parsed.data.rateLimitTrustedProxies,

    // Authentication Configuration
    authMethod: parsed.data.authMethod,
    authSecret: parsed.data.authSecret,
    authRequireExp: parsed.data.authRequireExp,
    authIssuer: parsed.data.authIssuer,
    authAudience: parsed.data.authAudience,
    permissions: parsePermissionsConfig(parsed.data.permissionsConfig),
  };
}

export function validateConfig(config: EnvironmentConfig): void {
  if (!config.baseUrl || !config.token) {
    throw new Error('Invalid configuration: missing baseUrl or token');
  }
}

export function loadConfigFromEnv(): EnvironmentConfig {
  return loadConfig();
}
