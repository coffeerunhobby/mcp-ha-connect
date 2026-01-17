import { z } from 'zod';
import { isValidBindAddress, isValidOrigin } from './utils/config-validations.js';
import { parsePermissionsConfig, type PermissionsConfig } from './permissions/index.js';
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

    // MCP Server HTTP Configuration
    httpPort: numericStringSchema,
    httpBindAddr: z.string().optional(),
    httpPath: z.string().optional(),
    httpEnableHealthcheck: createBooleanStringSchema(true),
    httpHealthcheckPath: z.string().optional(),
    httpAllowCors: createBooleanStringSchema(true),
    httpAllowedOrigins: z.string().optional().transform((v) => v?.split(',').map((s) => s.trim()).filter(Boolean)),

    // SSE Event Subscription Configuration
    sseEventsEnabled: createBooleanStringSchema(true),
    sseEventsPath: z.string().optional(),

    // Rate Limiting Configuration
    rateLimitEnabled: createBooleanStringSchema(true),
    rateLimitWindowMs: numericStringSchema,
    rateLimitMaxRequests: numericStringSchema,

    // Authentication Configuration
    authMethod: z.enum(['none', 'bearer']).optional().default('none'),
    authSecret: z.string().optional(),
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

  // MCP Generic Server Configuration
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'plain' | 'json' | 'gcp-json';
  useHttp: boolean;
  stateful: boolean;

  // MCP Server HTTP Configuration
  httpPort?: number;
  httpBindAddr?: string;
  httpPath?: string;
  httpEnableHealthcheck: boolean;
  httpHealthcheckPath?: string;
  httpAllowCors: boolean;
  httpAllowedOrigins?: string[];

  // SSE Event Subscription Configuration
  sseEventsEnabled: boolean;
  sseEventsPath: string;

  // Rate Limiting Configuration
  rateLimitEnabled: boolean;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;

  // Authentication Configuration
  authMethod: 'none' | 'bearer';
  authSecret?: string;
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

    // MCP Server HTTP Configuration
    httpPort: env.MCP_HTTP_PORT,
    httpBindAddr: env.MCP_HTTP_BIND_ADDR,
    httpPath: env.MCP_HTTP_PATH,
    httpEnableHealthcheck: env.MCP_HTTP_ENABLE_HEALTHCHECK,
    httpHealthcheckPath: env.MCP_HTTP_HEALTHCHECK_PATH,
    httpAllowCors: env.MCP_HTTP_ALLOW_CORS,
    httpAllowedOrigins: env.MCP_HTTP_ALLOWED_ORIGINS,

    // SSE Event Subscription Configuration
    sseEventsEnabled: env.MCP_SSE_EVENTS_ENABLED,
    sseEventsPath: env.MCP_SSE_EVENTS_PATH,

    // Rate Limiting Configuration
    rateLimitEnabled: env.MCP_RATE_LIMIT_ENABLED,
    rateLimitWindowMs: env.MCP_RATE_LIMIT_WINDOW_MS,
    rateLimitMaxRequests: env.MCP_RATE_LIMIT_MAX_REQUESTS,

    // Authentication Configuration
    authMethod: env.MCP_AUTH_METHOD,
    authSecret: env.MCP_AUTH_SECRET,
    permissionsConfig: env.MCP_PERMISSIONS_CONFIG,
  });

  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue: z.ZodIssue) => issue.message);
    throw new Error(`Invalid environment configuration:\n${messages.join('\n')}`);
  }

  const httpPath = parsed.data.httpPath ?? '/mcp';
  const httpBindAddr = parsed.data.httpBindAddr ?? '127.0.0.1';
  let httpAllowedOrigins = parsed.data.httpAllowedOrigins ?? ['127.0.0.1', 'localhost'];

  if (httpAllowedOrigins.includes('*')) {
    logger.warn('Wildcard (*) origin allowed - origin validation disabled');
    httpAllowedOrigins = [];
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

    // MCP Server HTTP Configuration
    httpPort: parsed.data.httpPort,
    httpBindAddr,
    httpPath,
    httpEnableHealthcheck: parsed.data.httpEnableHealthcheck,
    httpHealthcheckPath: parsed.data.httpHealthcheckPath,
    httpAllowCors: parsed.data.httpAllowCors,
    httpAllowedOrigins,

    // SSE Event Subscription Configuration
    sseEventsEnabled: parsed.data.sseEventsEnabled,
    sseEventsPath: parsed.data.sseEventsPath ?? '/subscribe_events',

    // Rate Limiting Configuration
    rateLimitEnabled: parsed.data.rateLimitEnabled,
    rateLimitWindowMs: parsed.data.rateLimitWindowMs ?? 60000,
    rateLimitMaxRequests: parsed.data.rateLimitMaxRequests ?? 100,

    // Authentication Configuration
    authMethod: parsed.data.authMethod,
    authSecret: parsed.data.authSecret,
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
