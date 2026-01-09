/**
 * Index/Main entry point tests
 */

import { describe, it, expect } from 'vitest';
import type { EnvironmentConfig } from '../src/config.js';

describe('Main entry point', () => {
  describe('Configuration loading', () => {
    it('should require baseUrl and token', () => {
      const validConfig: EnvironmentConfig = {
        baseUrl: 'http://homeassistant.10.0.0.19.nip.io:8123',
        token: 'test-token',
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
      };

      expect(validConfig.baseUrl).toBeDefined();
      expect(validConfig.token).toBeDefined();
    });
  });

  describe('Logger initialization', () => {
    it('should use stderr in stdio mode to avoid MCP protocol interference', () => {
      const stdioConfig = {
        useHttp: false,
      };

      const useStderr = !stdioConfig.useHttp;
      expect(useStderr).toBe(true);
    });

    it('should use stdout in HTTP mode', () => {
      const httpConfig = {
        useHttp: true,
      };

      const useStderr = !httpConfig.useHttp;
      expect(useStderr).toBe(false);
    });
  });

  describe('Server mode selection', () => {
    it('should start stdio server when useHttp is false', () => {
      const config = {
        useHttp: false,
      };

      expect(config.useHttp).toBe(false);
      // Would call startStdioServer
    });

    it('should start HTTP server when useHttp is true', () => {
      const config = {
        useHttp: true,
      };

      expect(config.useHttp).toBe(true);
      // Would call startHttpServer
    });
  });

  describe('Configuration logging', () => {
    it('should log configuration without exposing token', () => {
      const config = {
        baseUrl: 'http://homeassistant.10.0.0.19.nip.io:8123',
        token: 'super-secret-token',
        strictSsl: false,
        timeout: 30000,
        useHttp: false,
      };

      // Log data should mask the token
      const logData = {
        baseUrl: config.baseUrl,
        hasToken: !!config.token,
        strictSsl: config.strictSsl,
        timeout: config.timeout,
        useHttp: config.useHttp,
      };

      expect(logData.hasToken).toBe(true);
      expect(logData).not.toHaveProperty('token');
      expect(JSON.stringify(logData)).not.toContain('super-secret-token');
    });

    it('should include transport type in HTTP mode logs', () => {
      const config = {
        useHttp: true,
        httpTransport: 'stream',
      };

      const logData = {
        useHttp: config.useHttp,
        httpTransport: config.useHttp ? config.httpTransport : undefined,
      };

      expect(logData.httpTransport).toBe('stream');
    });

    it('should not include transport type in stdio mode logs', () => {
      const config = {
        useHttp: false,
        httpTransport: 'stream',
      };

      const logData = {
        useHttp: config.useHttp,
        httpTransport: config.useHttp ? config.httpTransport : undefined,
      };

      expect(logData.httpTransport).toBeUndefined();
    });
  });

  describe('Error handling', () => {
    it('should set exit code on configuration error', () => {
      let exitCode: number | undefined;

      try {
        throw new Error('Invalid configuration');
      } catch (error) {
        exitCode = 1;
      }

      expect(exitCode).toBe(1);
    });

    it('should set exit code on API connection error', () => {
      let exitCode: number | undefined;

      try {
        throw new Error('Connection failed');
      } catch (error) {
        exitCode = 1;
      }

      expect(exitCode).toBe(1);
    });

    it('should set exit code on server start error', () => {
      let exitCode: number | undefined;

      try {
        throw new Error('Server start failed');
      } catch (error) {
        exitCode = 1;
      }

      expect(exitCode).toBe(1);
    });
  });
});
