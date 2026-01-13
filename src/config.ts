import { z } from 'zod';
import { isValidBindAddress, isValidOrigin } from './utils/config-validations.js';
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

const listStringSchema = z
  .string()
  .optional()
  .transform((value: string | undefined) =>
    value
      ? value
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean)
      : undefined
  );

const envSchema = z
  .object({
    // Home Assistant Client Configuration
    haUrl: z.string().url({ message: 'HA_URL must be a valid URL' }),
    haToken: z.string().min(1, 'HA_TOKEN is required'),
    haStrictSsl: createBooleanStringSchema(true),
    haTimeout: numericStringSchema,

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
    httpAllowedOrigins: listStringSchema,

    // SSE Event Subscription Configuration
    sseEventsEnabled: createBooleanStringSchema(true),
    sseEventsPath: z.string().optional(),

    // Rate Limiting Configuration
    rateLimitEnabled: createBooleanStringSchema(true),
    rateLimitWindowMs: numericStringSchema,
    rateLimitMaxRequests: numericStringSchema,

    // Authentication Configuration
    authMethod: z.enum(['none', 'bearer']).optional().default('none'),
    authToken: listStringSchema,
  })
  .refine(
    (data) => {
      // Validate httpBindAddr if provided
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
      // Validate httpAllowedOrigins if provided
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
      // If bearer auth is enabled, token must be provided
      if (data.authMethod === 'bearer' && !data.authToken) {
        return false;
      }
      return true;
    },
    {
      message: 'MCP_AUTH_TOKEN is required when MCP_AUTH_METHOD is "bearer"',
      path: ['authToken'],
    }
  );

export interface EnvironmentConfig {
  // Home Assistant Client Configuration
  baseUrl: string;
  token: string;
  strictSsl: boolean;
  timeout: number;

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
  authToken?: Set<string>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EnvironmentConfig {
  const parsed = envSchema.safeParse({
    // Home Assistant Client Configuration
    haUrl: env.HA_URL,
    haToken: env.HA_TOKEN,
    haStrictSsl: env.HA_STRICT_SSL,
    haTimeout: env.HA_TIMEOUT,

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
    authToken: env.MCP_AUTH_TOKEN,
  });

  if (!parsed.success) {
    const messages = parsed.error.issues.map((issue: z.ZodIssue) => issue.message);
    throw new Error(`Invalid environment configuration:\n${messages.join('\n')}`);
  }

  // Default MCP endpoint path
  const httpPath = parsed.data.httpPath ?? '/mcp';

  // Set default bind address and allowed origins for security
  const httpBindAddr = parsed.data.httpBindAddr ?? '127.0.0.1';
  let httpAllowedOrigins = parsed.data.httpAllowedOrigins ?? ['127.0.0.1', 'localhost'];

  // If wildcard is present, use empty array to disable SDK origin validation
  if (httpAllowedOrigins.includes('*')) {
    logger.warn('Wildcard (*) origin allowed - origin validation is disabled. This should only be used in development.');
    httpAllowedOrigins = [];
  }

  return {
    // Home Assistant Client Configuration
    baseUrl: parsed.data.haUrl.replace(/\/$/, ''),
    token: parsed.data.haToken,
    strictSsl: parsed.data.haStrictSsl,
    timeout: parsed.data.haTimeout ?? 30000,

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
    authToken: parsed.data.authToken ? new Set(parsed.data.authToken) : undefined,
  };
}

// Legacy compatibility functions
export function validateConfig(config: EnvironmentConfig): void {
  // Config is already validated by Zod, this is for compatibility
  if (!config.baseUrl || !config.token) {
    throw new Error('Invalid configuration: missing baseUrl or token');
  }
}

export function loadConfigFromEnv(): EnvironmentConfig {
  return loadConfig();
}
