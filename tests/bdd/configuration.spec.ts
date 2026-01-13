/**
 * BDD tests for Server Configuration
 * Uses vitest-cucumber for Gherkin syntax
 */

import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { EnvironmentConfig } from '../../src/config.js';

const feature = await loadFeature('tests/features/configuration.feature');

describeFeature(feature, ({ Scenario }) => {
  // Shared test state
  let env: Record<string, string>;
  let config: EnvironmentConfig;
  let error: Error | null;

  Scenario('Load valid configuration', ({ Given, When, Then, And }) => {
    Given('environment variables with HA_URL and HA_TOKEN', () => {
      env = {
        HA_URL: 'http://homeassistant.local:8123',
        HA_TOKEN: 'test-token-12345',
      };
      error = null;
    });

    When('I load the configuration', () => {
      config = loadConfig(env);
    });

    Then('the configuration should be valid', () => {
      expect(config).toBeDefined();
    });

    And('baseUrl should be set correctly', () => {
      expect(config.baseUrl).toBe('http://homeassistant.local:8123');
    });

    And('token should be set correctly', () => {
      expect(config.token).toBe('test-token-12345');
    });
  });

  Scenario('Apply default values for optional settings', ({ Given, When, Then, And }) => {
    Given('only required environment variables', () => {
      env = {
        HA_URL: 'http://homeassistant.local:8123',
        HA_TOKEN: 'test-token',
      };
    });

    When('I load the configuration', () => {
      config = loadConfig(env);
    });

    Then('strictSsl should default to true', () => {
      expect(config.strictSsl).toBe(true);
    });

    And('timeout should default to 30000', () => {
      expect(config.timeout).toBe(30000);
    });

    And('logLevel should default to "info"', () => {
      expect(config.logLevel).toBe('info');
    });

    And('logFormat should default to "plain"', () => {
      expect(config.logFormat).toBe('plain');
    });
  });

  Scenario('Remove trailing slash from URL', ({ Given, When, Then }) => {
    Given('HA_URL with trailing slash "http://ha.local:8123/"', () => {
      env = {
        HA_URL: 'http://ha.local:8123/',
        HA_TOKEN: 'test-token',
      };
    });

    When('I load the configuration', () => {
      config = loadConfig(env);
    });

    Then('baseUrl should not have a trailing slash', () => {
      expect(config.baseUrl).toBe('http://ha.local:8123');
      expect(config.baseUrl.endsWith('/')).toBe(false);
    });
  });

  Scenario('Reject missing HA_URL', ({ Given, When, Then }) => {
    Given('environment variables without HA_URL', () => {
      env = {
        HA_TOKEN: 'test-token',
      };
      error = null;
    });

    When('I attempt to load the configuration', () => {
      try {
        config = loadConfig(env);
      } catch (e) {
        error = e as Error;
      }
    });

    Then('it should throw an error about invalid configuration', () => {
      expect(error).not.toBeNull();
      expect(error?.message).toContain('Invalid environment configuration');
    });
  });

  Scenario('Reject missing HA_TOKEN', ({ Given, When, Then }) => {
    Given('environment variables without HA_TOKEN', () => {
      env = {
        HA_URL: 'http://homeassistant.local:8123',
      };
      error = null;
    });

    When('I attempt to load the configuration', () => {
      try {
        config = loadConfig(env);
      } catch (e) {
        error = e as Error;
      }
    });

    Then('it should throw an error about invalid configuration', () => {
      expect(error).not.toBeNull();
      expect(error?.message).toContain('Invalid environment configuration');
    });
  });

  Scenario('Reject invalid URL format', ({ Given, When, Then }) => {
    Given('HA_URL with invalid format "not-a-url"', () => {
      env = {
        HA_URL: 'not-a-url',
        HA_TOKEN: 'test-token',
      };
      error = null;
    });

    When('I attempt to load the configuration', () => {
      try {
        config = loadConfig(env);
      } catch (e) {
        error = e as Error;
      }
    });

    Then('it should throw an error about invalid configuration', () => {
      expect(error).not.toBeNull();
      expect(error?.message).toContain('Invalid environment configuration');
    });
  });

  Scenario('Parse HTTP server configuration', ({ Given, When, Then, And }) => {
    Given('HTTP mode is enabled', () => {
      env = {
        HA_URL: 'http://homeassistant.local:8123',
        HA_TOKEN: 'test-token',
        MCP_SERVER_USE_HTTP: 'true',
        MCP_HTTP_PORT: '3000',
      };
    });

    When('I load the configuration', () => {
      config = loadConfig(env);
    });

    Then('useHttp should be true', () => {
      expect(config.useHttp).toBe(true);
    });

    And('httpPort should be set', () => {
      expect(config.httpPort).toBe(3000);
    });
  });

  Scenario('Validate bind address format', ({ Given, When, Then }) => {
    Given('an invalid bind address "invalid-ip"', () => {
      env = {
        HA_URL: 'http://homeassistant.local:8123',
        HA_TOKEN: 'test-token',
        MCP_HTTP_BIND_ADDR: 'invalid-ip',
      };
      error = null;
    });

    When('I attempt to load the configuration', () => {
      try {
        config = loadConfig(env);
      } catch (e) {
        error = e as Error;
      }
    });

    Then('it should throw an error about invalid bind address', () => {
      expect(error).not.toBeNull();
      expect(error?.message).toContain('MCP_HTTP_BIND_ADDR must be a valid IPv4 or IPv6 address');
    });
  });

  Scenario('Accept valid IPv4 bind address', ({ Given, When, Then }) => {
    Given('a valid IPv4 bind address "192.168.1.100"', () => {
      env = {
        HA_URL: 'http://homeassistant.local:8123',
        HA_TOKEN: 'test-token',
        MCP_HTTP_BIND_ADDR: '192.168.1.100',
      };
    });

    When('I load the configuration', () => {
      config = loadConfig(env);
    });

    Then('httpBindAddr should be "192.168.1.100"', () => {
      expect(config.httpBindAddr).toBe('192.168.1.100');
    });
  });

  Scenario('Accept valid IPv6 bind address', ({ Given, When, Then }) => {
    Given('a valid IPv6 bind address "::1"', () => {
      env = {
        HA_URL: 'http://homeassistant.local:8123',
        HA_TOKEN: 'test-token',
        MCP_HTTP_BIND_ADDR: '::1',
      };
    });

    When('I load the configuration', () => {
      config = loadConfig(env);
    });

    Then('httpBindAddr should be "::1"', () => {
      expect(config.httpBindAddr).toBe('::1');
    });
  });

  Scenario('Handle wildcard in allowed origins', ({ Given, When, Then }) => {
    Given('allowed origins set to "*"', () => {
      env = {
        HA_URL: 'http://homeassistant.local:8123',
        HA_TOKEN: 'test-token',
        MCP_HTTP_ALLOWED_ORIGINS: '*',
      };
    });

    When('I load the configuration', () => {
      config = loadConfig(env);
    });

    Then('httpAllowedOrigins should be an empty array', () => {
      expect(config.httpAllowedOrigins).toEqual([]);
    });
  });

  Scenario('Parse comma-separated allowed origins', ({ Given, When, Then }) => {
    Given('allowed origins "http://localhost:3000,http://192.168.1.100"', () => {
      env = {
        HA_URL: 'http://homeassistant.local:8123',
        HA_TOKEN: 'test-token',
        MCP_HTTP_ALLOWED_ORIGINS: 'http://localhost:3000,http://192.168.1.100',
      };
    });

    When('I load the configuration', () => {
      config = loadConfig(env);
    });

    Then('httpAllowedOrigins should contain both origins', () => {
      expect(config.httpAllowedOrigins).toContain('http://localhost:3000');
      expect(config.httpAllowedOrigins).toContain('http://192.168.1.100');
    });
  });
});
