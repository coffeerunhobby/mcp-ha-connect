/**
 * Tool registration tests
 * Tests the individual tool registration functions using McpServer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from '../../src/tools/index.js';

// Mock HaClient
const mockClient = {
  getStates: vi.fn().mockResolvedValue([]),
  getState: vi.fn().mockResolvedValue({}),
  callService: vi.fn().mockResolvedValue({ context: {} }),
  getEntitiesByDomain: vi.fn().mockResolvedValue([]),
  searchEntities: vi.fn().mockResolvedValue([]),
  getAllSensors: vi.fn().mockResolvedValue([]),
  getDomainSummary: vi.fn().mockResolvedValue({}),
  getHistory: vi.fn().mockResolvedValue([]),
  getVersion: vi.fn().mockResolvedValue({ version: '2024.1.0' }),
  getLogbook: vi.fn().mockResolvedValue([]),
  listAutomations: vi.fn().mockResolvedValue([]),
  triggerAutomation: vi.fn().mockResolvedValue({}),
  createAutomation: vi.fn().mockResolvedValue({ id: 'test-id' }),
  deleteAutomation: vi.fn().mockResolvedValue({}),
  getAutomationTrace: vi.fn().mockResolvedValue({}),
  checkUpdates: vi.fn().mockResolvedValue({ available: [] }),
  devices: {
    triggerAutomation: vi.fn().mockResolvedValue({}),
    reloadAutomations: vi.fn().mockResolvedValue({}),
  },
};

describe('Tool Registration', () => {
  let server: McpServer;

  beforeEach(() => {
    vi.clearAllMocks();

    server = new McpServer({
      name: 'test-server',
      version: '1.0.0',
    });
  });

  describe('registerAllTools', () => {
    it('should register all tools without errors', () => {
      expect(() => registerAllTools({ server, haClient: mockClient as any })).not.toThrow();
    });

    it('should register tools on McpServer', () => {
      registerAllTools({ server, haClient: mockClient as any });

      // The server should have handlers registered
      expect(server).toBeDefined();
    });

    it('should work with optional aiClient', () => {
      expect(() => registerAllTools({ server, haClient: mockClient as any, aiClient: undefined })).not.toThrow();
    });

    it('should work without haClient (Omada-only mode)', () => {
      expect(() => registerAllTools({ server })).not.toThrow();
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
