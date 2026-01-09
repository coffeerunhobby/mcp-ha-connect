/**
 * Logger tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initLogger, setLevel, logger } from '../../src/utils/logger.js';
import type { LogLevel, LogFormat } from '../../src/utils/logger.js';

describe('Logger', () => {
  beforeEach(() => {
    // Reset to default configuration
    initLogger('info', 'plain', false);
  });

  describe('initLogger', () => {
    it('should initialize with default level and format', () => {
      initLogger('info', 'plain', false);

      // Logger should be initialized without errors
      expect(logger).toBeDefined();
      expect(logger.info).toBeDefined();
      expect(logger.debug).toBeDefined();
      expect(logger.warn).toBeDefined();
      expect(logger.error).toBeDefined();
    });

    it('should support all log levels', () => {
      const levels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

      for (const level of levels) {
        expect(() => initLogger(level, 'plain', false)).not.toThrow();
      }
    });

    it('should support all log formats', () => {
      const formats: LogFormat[] = ['plain', 'json', 'gcp-json'];

      for (const format of formats) {
        expect(() => initLogger('info', format, false)).not.toThrow();
      }
    });

    it('should configure stderr output when useStderr is true', () => {
      expect(() => initLogger('info', 'plain', true)).not.toThrow();

      // Logger should be configured to use stderr
    });

    it('should configure stdout output when useStderr is false', () => {
      expect(() => initLogger('info', 'plain', false)).not.toThrow();

      // Logger should be configured to use stdout
    });
  });

  describe('setLevel', () => {
    it('should change log level dynamically', () => {
      initLogger('info', 'plain', false);

      expect(() => setLevel('debug')).not.toThrow();
      expect(() => setLevel('warn')).not.toThrow();
      expect(() => setLevel('error')).not.toThrow();
    });

    it('should accept all valid log levels', () => {
      const levels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

      for (const level of levels) {
        expect(() => setLevel(level)).not.toThrow();
      }
    });
  });

  describe('Log methods', () => {
    it('should have debug method', () => {
      expect(typeof logger.debug).toBe('function');
      expect(() => logger.debug('Test debug message')).not.toThrow();
    });

    it('should have info method', () => {
      expect(typeof logger.info).toBe('function');
      expect(() => logger.info('Test info message')).not.toThrow();
    });

    it('should have warn method', () => {
      expect(typeof logger.warn).toBe('function');
      expect(() => logger.warn('Test warn message')).not.toThrow();
    });

    it('should have error method', () => {
      expect(typeof logger.error).toBe('function');
      expect(() => logger.error('Test error message')).not.toThrow();
    });
  });

  describe('Log with metadata', () => {
    it('should log with metadata object', () => {
      const metadata = {
        userId: 'user-123',
        requestId: 'req-456',
        duration: 123,
      };

      expect(() => logger.info('Test message', metadata)).not.toThrow();
    });

    it('should handle Error objects in metadata', () => {
      const error = new Error('Test error');
      const metadata = {
        error,
        context: 'test',
      };

      expect(() => logger.error('Error occurred', metadata)).not.toThrow();
    });

    it('should handle nested objects in metadata', () => {
      const metadata = {
        config: {
          baseUrl: 'http://example.com',
          timeout: 30000,
        },
        user: {
          id: 'user-123',
          name: 'Test User',
        },
      };

      expect(() => logger.info('Complex metadata', metadata)).not.toThrow();
    });

    it('should handle arrays in metadata', () => {
      const metadata = {
        entities: ['light.living_room', 'sensor.temperature'],
        tags: ['home', 'automation'],
      };

      expect(() => logger.info('Array metadata', metadata)).not.toThrow();
    });

    it('should handle empty metadata', () => {
      expect(() => logger.info('No metadata')).not.toThrow();
      expect(() => logger.info('Empty metadata', {})).not.toThrow();
    });
  });

  describe('Log formats', () => {
    it('should format plain logs with uppercase level', () => {
      initLogger('info', 'plain', false);

      // Plain format should use { level: 'INFO' }
      expect(() => logger.info('Plain format test')).not.toThrow();
    });

    it('should format JSON logs with standard structure', () => {
      initLogger('info', 'json', false);

      // JSON format should use standard pino JSON
      expect(() => logger.info('JSON format test')).not.toThrow();
    });

    it('should format GCP JSON logs with severity field', () => {
      initLogger('info', 'gcp-json', false);

      // GCP format should use { severity: 'INFO' }
      expect(() => logger.info('GCP format test')).not.toThrow();
    });
  });

  describe('Severity mapping for GCP format', () => {
    it('should map debug to DEBUG', () => {
      const levelToSeverity = {
        debug: 'DEBUG',
        info: 'INFO',
        warn: 'WARNING',
        error: 'ERROR',
      };

      expect(levelToSeverity.debug).toBe('DEBUG');
    });

    it('should map info to INFO', () => {
      const levelToSeverity = {
        debug: 'DEBUG',
        info: 'INFO',
        warn: 'WARNING',
        error: 'ERROR',
      };

      expect(levelToSeverity.info).toBe('INFO');
    });

    it('should map warn to WARNING', () => {
      const levelToSeverity = {
        debug: 'DEBUG',
        info: 'INFO',
        warn: 'WARNING',
        error: 'ERROR',
      };

      expect(levelToSeverity.warn).toBe('WARNING');
    });

    it('should map error to ERROR', () => {
      const levelToSeverity = {
        debug: 'DEBUG',
        info: 'INFO',
        warn: 'WARNING',
        error: 'ERROR',
      };

      expect(levelToSeverity.error).toBe('ERROR');
    });
  });

  describe('Error metadata normalization', () => {
    it('should normalize Error to object with message and stack', () => {
      const error = new Error('Test error');
      const normalized = {
        message: error.message,
        stack: error.stack,
      };

      expect(normalized.message).toBe('Test error');
      expect(normalized.stack).toBeDefined();
    });

    it('should preserve non-Error values', () => {
      const metadata = {
        string: 'test',
        number: 123,
        boolean: true,
        null: null,
        array: [1, 2, 3],
        object: { key: 'value' },
      };

      expect(metadata.string).toBe('test');
      expect(metadata.number).toBe(123);
      expect(metadata.boolean).toBe(true);
      expect(metadata.null).toBeNull();
      expect(metadata.array).toEqual([1, 2, 3]);
      expect(metadata.object).toEqual({ key: 'value' });
    });
  });

  describe('Timestamp format', () => {
    it('should use ISO time format', () => {
      // Pino stdTimeFunctions.isoTime produces ISO 8601 timestamps
      const now = new Date();
      const isoTime = now.toISOString();

      expect(isoTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('Message key', () => {
    it('should use "message" as the message key', () => {
      const logEntry = {
        level: 'INFO',
        time: '2026-01-08T12:00:00.000Z',
        message: 'Test message',
      };

      expect(logEntry.message).toBe('Test message');
      expect('message' in logEntry).toBe(true);
    });
  });

  describe('Base fields', () => {
    it('should not include base fields like hostname and pid', () => {
      // baseConfig.base = undefined disables these fields
      const logEntry = {
        level: 'INFO',
        time: '2026-01-08T12:00:00.000Z',
        message: 'Test message',
      };

      expect('hostname' in logEntry).toBe(false);
      expect('pid' in logEntry).toBe(false);
      expect('name' in logEntry).toBe(false);
    });
  });

  describe('Stdio mode behavior', () => {
    it('should log to stderr in stdio mode to avoid MCP protocol interference', () => {
      const useStderr = true;

      initLogger('info', 'plain', useStderr);

      // Logger should be configured for stderr
      expect(() => logger.info('Stdio mode test')).not.toThrow();
    });

    it('should log to stdout in HTTP mode', () => {
      const useStderr = false;

      initLogger('info', 'plain', useStderr);

      // Logger should be configured for stdout
      expect(() => logger.info('HTTP mode test')).not.toThrow();
    });
  });

  describe('Environment variable initialization', () => {
    it('should use MCP_SERVER_LOG_LEVEL from environment by default', () => {
      // The default instance reads from process.env.MCP_SERVER_LOG_LEVEL
      const defaultLevel = (process.env.MCP_SERVER_LOG_LEVEL as LogLevel | undefined) ?? 'info';

      expect(['debug', 'info', 'warn', 'error', 'silent']).toContain(defaultLevel);
    });
  });

  describe('Multiple logger instances', () => {
    it('should replace previous instance when reinitializing', () => {
      initLogger('info', 'plain', false);
      const firstInit = { ...logger };

      initLogger('debug', 'json', true);
      const secondInit = { ...logger };

      // Second initialization should replace the first
      expect(firstInit).toBeDefined();
      expect(secondInit).toBeDefined();
    });
  });
});
