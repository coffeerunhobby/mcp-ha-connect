/**
 * Configuration tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadConfig, validateConfig } from '../src/config.js';
import type { EnvironmentConfig } from '../src/config.js';

describe('loadConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  it('should load valid configuration from environment', () => {
    const env = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
      HA_TOKEN: 'test-token-12345',
      HA_STRICT_SSL: 'false',
      HA_TIMEOUT: '30000',
      MCP_SERVER_LOG_LEVEL: 'info',
      MCP_SERVER_LOG_FORMAT: 'plain',
      MCP_SERVER_USE_HTTP: 'false',
      MCP_SERVER_STATEFUL: 'false',
    };

    const config = loadConfig(env);

    expect(config.baseUrl).toBe('http://homeassistant.10.0.0.19.nip.io:8123');
    expect(config.token).toBe('test-token-12345');
    expect(config.strictSsl).toBe(false);
    expect(config.timeout).toBe(30000);
    expect(config.logLevel).toBe('info');
    expect(config.logFormat).toBe('plain');
    expect(config.useHttp).toBe(false);
    expect(config.stateful).toBe(false);
  });

  it('should apply default values for optional fields', () => {
    const env = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
      HA_TOKEN: 'test-token-12345',
    };

    const config = loadConfig(env);

    expect(config.strictSsl).toBe(true); // default
    expect(config.timeout).toBe(30000); // default
    expect(config.logLevel).toBe('info'); // default
    expect(config.logFormat).toBe('plain'); // default
    expect(config.useHttp).toBe(false); // default
    expect(config.stateful).toBe(false); // default
    expect(config.httpEnableHealthcheck).toBe(true); // default
    expect(config.httpAllowCors).toBe(true); // default
    expect(config.httpTransport).toBe('stream'); // default
  });

  it('should remove trailing slash from baseUrl', () => {
    const env = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123/',
      HA_TOKEN: 'test-token-12345',
    };

    const config = loadConfig(env);

    expect(config.baseUrl).toBe('http://homeassistant.10.0.0.19.nip.io:8123');
  });

  it('should throw error for missing HA_URL', () => {
    const env = {
      HA_TOKEN: 'test-token-12345',
    };

    expect(() => loadConfig(env)).toThrow('Invalid environment configuration');
  });

  it('should throw error for missing HA_TOKEN', () => {
    const env = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
    };

    expect(() => loadConfig(env)).toThrow('Invalid environment configuration');
  });

  it('should throw error for invalid HA_URL', () => {
    const env = {
      HA_URL: 'not-a-url',
      HA_TOKEN: 'test-token-12345',
    };

    expect(() => loadConfig(env)).toThrow('Invalid environment configuration');
  });

  it('should parse HTTP configuration when USE_HTTP is true', () => {
    const env = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
      HA_TOKEN: 'test-token-12345',
      MCP_SERVER_USE_HTTP: 'true',
      MCP_HTTP_PORT: '3000',
      MCP_HTTP_TRANSPORT: 'stream',
      MCP_HTTP_BIND_ADDR: '127.0.0.1',
      MCP_HTTP_PATH: '/mcp',
      MCP_HTTP_ENABLE_HEALTHCHECK: 'true',
      MCP_HTTP_HEALTHCHECK_PATH: '/health',
      MCP_HTTP_ALLOW_CORS: 'true',
      MCP_HTTP_ALLOWED_ORIGINS: '127.0.0.1,localhost',
    };

    const config = loadConfig(env);

    expect(config.useHttp).toBe(true);
    expect(config.httpPort).toBe(3000);
    expect(config.httpTransport).toBe('stream');
    expect(config.httpBindAddr).toBe('127.0.0.1');
    expect(config.httpPath).toBe('/mcp');
    expect(config.httpEnableHealthcheck).toBe(true);
    expect(config.httpHealthcheckPath).toBe('/health');
    expect(config.httpAllowCors).toBe(true);
    expect(config.httpAllowedOrigins).toEqual(['127.0.0.1', 'localhost']);
  });

  it('should use default httpPath based on transport', () => {
    const envStream = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
      HA_TOKEN: 'test-token-12345',
      MCP_HTTP_TRANSPORT: 'stream',
    };

    const configStream = loadConfig(envStream);
    expect(configStream.httpPath).toBe('/mcp');

    const envSse = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
      HA_TOKEN: 'test-token-12345',
      MCP_HTTP_TRANSPORT: 'sse',
    };

    const configSse = loadConfig(envSse);
    expect(configSse.httpPath).toBe('/sse');
  });

  it('should handle wildcard in allowed origins', () => {
    const env = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
      HA_TOKEN: 'test-token-12345',
      MCP_HTTP_ALLOWED_ORIGINS: '*',
    };

    const config = loadConfig(env);

    // Wildcard should result in empty array to disable SDK validation
    expect(config.httpAllowedOrigins).toEqual([]);
  });

  it('should parse comma-separated origins', () => {
    const env = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
      HA_TOKEN: 'test-token-12345',
      MCP_HTTP_ALLOWED_ORIGINS: 'http://mcpserver.10.0.0.18.nip.io:3000,http://192.168.0.10:8080,localhost',
    };

    const config = loadConfig(env);

    expect(config.httpAllowedOrigins).toEqual([
      'http://mcpserver.10.0.0.18.nip.io:3000',
      'http://192.168.0.10:8080',
      'localhost',
    ]);
  });

  it('should throw error for invalid bind address', () => {
    const env = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
      HA_TOKEN: 'test-token-12345',
      MCP_HTTP_BIND_ADDR: 'invalid-ip',
    };

    expect(() => loadConfig(env)).toThrow('MCP_HTTP_BIND_ADDR must be a valid IPv4 or IPv6 address');
  });

  it('should accept valid IPv4 bind address', () => {
    const env = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
      HA_TOKEN: 'test-token-12345',
      MCP_HTTP_BIND_ADDR: '192.168.1.100',
    };

    const config = loadConfig(env);
    expect(config.httpBindAddr).toBe('192.168.1.100');
  });

  it('should accept valid IPv6 bind address', () => {
    const env = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
      HA_TOKEN: 'test-token-12345',
      MCP_HTTP_BIND_ADDR: '::1',
    };

    const config = loadConfig(env);
    expect(config.httpBindAddr).toBe('::1');
  });

  it('should parse numeric timeout', () => {
    const env = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
      HA_TOKEN: 'test-token-12345',
      HA_TIMEOUT: '45000',
    };

    const config = loadConfig(env);
    expect(config.timeout).toBe(45000);
  });

  it('should support all log levels', () => {
    const levels = ['debug', 'info', 'warn', 'error'] as const;

    for (const level of levels) {
      const env = {
        HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
        HA_TOKEN: 'test-token-12345',
        MCP_SERVER_LOG_LEVEL: level,
      };

      const config = loadConfig(env);
      expect(config.logLevel).toBe(level);
    }
  });

  it('should support all log formats', () => {
    const formats = ['plain', 'json', 'gcp-json'] as const;

    for (const format of formats) {
      const env = {
        HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
        HA_TOKEN: 'test-token-12345',
        MCP_SERVER_LOG_FORMAT: format,
      };

      const config = loadConfig(env);
      expect(config.logFormat).toBe(format);
    }
  });

  it('should support both HTTP transports', () => {
    const transports = ['stream', 'sse'] as const;

    for (const transport of transports) {
      const env = {
        HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
        HA_TOKEN: 'test-token-12345',
        MCP_HTTP_TRANSPORT: transport,
      };

      const config = loadConfig(env);
      expect(config.httpTransport).toBe(transport);
    }
  });

  it('should parse boolean strings correctly', () => {
    const envTrue = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
      HA_TOKEN: 'test-token-12345',
      HA_STRICT_SSL: 'true',
      MCP_SERVER_USE_HTTP: 'true',
      MCP_SERVER_STATEFUL: 'true',
    };

    const configTrue = loadConfig(envTrue);
    expect(configTrue.strictSsl).toBe(true);
    expect(configTrue.useHttp).toBe(true);
    expect(configTrue.stateful).toBe(true);

    const envFalse = {
      HA_URL: 'http://homeassistant.10.0.0.19.nip.io:8123',
      HA_TOKEN: 'test-token-12345',
      HA_STRICT_SSL: 'false',
      MCP_SERVER_USE_HTTP: 'false',
      MCP_SERVER_STATEFUL: 'false',
    };

    const configFalse = loadConfig(envFalse);
    expect(configFalse.strictSsl).toBe(false);
    expect(configFalse.useHttp).toBe(false);
    expect(configFalse.stateful).toBe(false);
  });
});

describe('validateConfig', () => {
  it('should validate valid configuration', () => {
    const config: EnvironmentConfig = {
      baseUrl: 'http://homeassistant.10.0.0.19.nip.io:8123',
      token: 'test-token-12345',
      strictSsl: false,
      timeout: 30000,
      aiProvider: 'ollama',
      aiUrl: 'http://ollama.10.0.0.17.nip.io:11434',
      aiModel: 'qwen3:14b',
      aiTimeout: 60000,
      logLevel: 'info',
      logFormat: 'plain',
      useHttp: false,
      stateful: false,
      httpTransport: 'stream',
      httpEnableHealthcheck: true,
      httpAllowCors: true,
      sseEventsEnabled: true,
      sseEventsPath: '/subscribe_events',
      rateLimitEnabled: true,
      rateLimitWindowMs: 60000,
      rateLimitMaxRequests: 100,
    };

    expect(() => validateConfig(config)).not.toThrow();
  });

  it('should throw error for missing baseUrl', () => {
    const config = {
      token: 'test-token-12345',
    } as EnvironmentConfig;

    expect(() => validateConfig(config)).toThrow('Invalid configuration');
  });

  it('should throw error for missing token', () => {
    const config = {
      baseUrl: 'http://homeassistant.10.0.0.19.nip.io:8123',
    } as EnvironmentConfig;

    expect(() => validateConfig(config)).toThrow('Invalid configuration');
  });
});
