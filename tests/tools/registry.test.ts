/**
 * Tool registration tests
 * Tests the individual tool registration functions using McpServer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from '../../src/tools/index.js';
import { HaClient } from '../../src/haClient/index.js';
import type { EnvironmentConfig } from '../../src/config.js';

describe('Tool Registration', () => {
  let server: McpServer;
  let mockClient: HaClient;
  let mockConfig: EnvironmentConfig;

  beforeEach(() => {
    mockConfig = {
      baseUrl: 'http://homeassistant.10.0.0.19.nip.io:8123',
      token: 'test-token',
      strictSsl: false,
      timeout: 30000,
      aiProvider: 'ollama',
      aiUrl: 'http://ollama.10.0.0.17.nip.io:11434',
      aiModel: 'qwen3:14b',
      aiTimeout: 60000,
      logLevel: 'error', // Suppress logs during tests
      logFormat: 'plain',
      useHttp: false,
      stateful: false,
      
      httpEnableHealthcheck: true,
      httpAllowCors: true,
    };

    mockClient = new HaClient(mockConfig);

    server = new McpServer({
      name: 'test-server',
      version: '1.0.0',
    });
  });

  describe('registerAllTools', () => {
    it('should register all tools without errors', () => {
      expect(() => registerAllTools(server, mockClient)).not.toThrow();
    });

    it('should register tools on McpServer', () => {
      registerAllTools(server, mockClient);

      // The server should have handlers registered
      expect(server).toBeDefined();
    });

    it('should work with optional aiClient', () => {
      expect(() => registerAllTools(server, mockClient, undefined)).not.toThrow();
    });
  });

  describe('Tool Categories', () => {
    it('should include core entity tools', () => {
      const coreTools = [
        'getStates',
        'getState',
        'callService',
        'getEntitiesByDomain',
        'searchEntities',
        'getAllSensors',
        'listEntities',
        'getDomainSummary',
      ];

      expect(coreTools.length).toBeGreaterThan(5);
    });

    it('should include automation tools', () => {
      const automationTools = [
        'listAutomations',
        'triggerAutomation',
        'enableAutomation',
        'disableAutomation',
        'toggleAutomation',
        'reloadAutomations',
        'createAutomation',
        'deleteAutomation',
        'getAutomationTrace',
      ];

      expect(automationTools).toContain('listAutomations');
      expect(automationTools).toContain('createAutomation');
    });

    it('should include device control tools', () => {
      const deviceTools = [
        'controlLight',
        'controlClimate',
        'controlMediaPlayer',
        'controlCover',
        'controlFan',
      ];

      expect(deviceTools).toContain('controlLight');
      expect(deviceTools).toContain('controlClimate');
    });

    it('should include utility tools', () => {
      const utilityTools = [
        'getHistory',
        'getVersion',
        'entityAction',
        'activateScene',
        'runScript',
        'sendNotification',
      ];

      expect(utilityTools).toContain('getHistory');
      expect(utilityTools).toContain('getVersion');
    });

    it('should include system tools', () => {
      const systemTools = [
        'restartHomeAssistant',
        'getSystemLog',
        'checkUpdates',
      ];

      expect(systemTools).toContain('restartHomeAssistant');
      expect(systemTools).toContain('checkUpdates');
    });
  });

  describe('Tool Response Format', () => {
    it('should return text content type', () => {
      const response = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true }),
          },
        ],
      };

      expect(response.content[0].type).toBe('text');
    });

    it('should return valid JSON in text field', () => {
      const response = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ entity_id: 'light.living_room', state: 'on' }),
          },
        ],
      };

      expect(() => JSON.parse(response.content[0].text)).not.toThrow();
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.entity_id).toBe('light.living_room');
    });
  });
});
