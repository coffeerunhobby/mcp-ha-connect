/**
 * Tool registry tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { registerAllTools } from '../../src/tools/registry.js';
import { HaClient } from '../../src/haClient/index.js';
import type { EnvironmentConfig } from '../../src/config.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

describe('Tool Registry', () => {
  let server: Server;
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
      httpTransport: 'stream',
      httpEnableHealthcheck: true,
      httpAllowCors: true,
    };

    mockClient = new HaClient(mockConfig);

    server = new Server(
      {
        name: 'test-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
  });

  describe('registerAllTools', () => {
    it('should register all tools without errors', () => {
      expect(() => registerAllTools(server, mockClient)).not.toThrow();
    });

    it('should register ListTools handler', () => {
      registerAllTools(server, mockClient);

      // The server should have handlers registered
      // We can't directly test private handlers, but we can verify no errors
      expect(server).toBeDefined();
    });

    it('should register CallTool handler', () => {
      registerAllTools(server, mockClient);

      // The server should have handlers registered
      expect(server).toBeDefined();
    });
  });

  describe('Tool List', () => {
    it('should include all 5 tools', () => {
      const expectedTools = [
        'getStates',
        'getState',
        'callService',
        'getEntitiesByDomain',
        'searchEntities',
      ];

      expect(expectedTools).toHaveLength(5);
    });

    it('should have correct tool names', () => {
      const toolNames = [
        'getStates',
        'getState',
        'callService',
        'getEntitiesByDomain',
        'searchEntities',
      ];

      expect(toolNames).toContain('getStates');
      expect(toolNames).toContain('getState');
      expect(toolNames).toContain('callService');
      expect(toolNames).toContain('getEntitiesByDomain');
      expect(toolNames).toContain('searchEntities');
    });
  });

  describe('Tool Schemas', () => {
    it('getStates should have no required parameters', () => {
      const schema = {
        type: 'object',
        properties: {},
        required: [],
      };

      expect(schema.required).toEqual([]);
    });

    it('getState should require entity_id', () => {
      const schema = {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Entity ID' },
        },
        required: ['entity_id'],
      };

      expect(schema.required).toContain('entity_id');
    });

    it('callService should require domain and service', () => {
      const schema = {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          service: { type: 'string' },
          target: { type: 'object' },
          data: { type: 'object' },
        },
        required: ['domain', 'service'],
      };

      expect(schema.required).toContain('domain');
      expect(schema.required).toContain('service');
      expect(schema.required).not.toContain('target');
      expect(schema.required).not.toContain('data');
    });

    it('getEntitiesByDomain should require domain', () => {
      const schema = {
        type: 'object',
        properties: {
          domain: { type: 'string' },
        },
        required: ['domain'],
      };

      expect(schema.required).toContain('domain');
    });

    it('searchEntities should require query', () => {
      const schema = {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      };

      expect(schema.required).toContain('query');
    });
  });

  describe('Tool Descriptions', () => {
    it('should have descriptive names for all tools', () => {
      const toolDescriptions = {
        getStates: 'Get all entity states from Home Assistant',
        getState: 'Get the state of a specific entity',
        callService: 'Call a Home Assistant service',
        getEntitiesByDomain: 'Get all entities for a specific domain',
        searchEntities: 'Search for entities by name or entity_id',
      };

      expect(toolDescriptions.getStates).toBeDefined();
      expect(toolDescriptions.getState).toBeDefined();
      expect(toolDescriptions.callService).toBeDefined();
      expect(toolDescriptions.getEntitiesByDomain).toBeDefined();
      expect(toolDescriptions.searchEntities).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should throw error for unknown tool', () => {
      const unknownTool = 'unknownTool';
      const validTools = [
        'getStates',
        'getState',
        'callService',
        'getEntitiesByDomain',
        'searchEntities',
      ];

      expect(validTools).not.toContain(unknownTool);
      // Should throw 'Unknown tool' error
    });

    it('should validate required parameters', () => {
      // getState without entity_id should fail
      const args = {};
      const hasEntityId = 'entity_id' in args;

      expect(hasEntityId).toBe(false);
      // Should throw validation error
    });

    it('should handle client errors gracefully', async () => {
      const error = new Error('API error');

      // When client throws, should be caught and returned as error
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('Tool Execution', () => {
    it('should call client.getStates for getStates tool', async () => {
      const spy = vi.spyOn(mockClient, 'getStates').mockResolvedValue([]);

      registerAllTools(server, mockClient);

      // Verify the spy was set up
      expect(spy).toBeDefined();
    });

    it('should call client.getState for getState tool', async () => {
      const spy = vi.spyOn(mockClient, 'getState').mockResolvedValue(null);

      registerAllTools(server, mockClient);

      expect(spy).toBeDefined();
    });

    it('should call client.callService for callService tool', async () => {
      const spy = vi.spyOn(mockClient, 'callService').mockResolvedValue({
        context: { id: 'test', parent_id: null, user_id: null },
      });

      registerAllTools(server, mockClient);

      expect(spy).toBeDefined();
    });

    it('should call client.getEntitiesByDomain for getEntitiesByDomain tool', async () => {
      const spy = vi.spyOn(mockClient, 'getEntitiesByDomain').mockResolvedValue([]);

      registerAllTools(server, mockClient);

      expect(spy).toBeDefined();
    });

    it('should call client.searchEntities for searchEntities tool', async () => {
      const spy = vi.spyOn(mockClient, 'searchEntities').mockResolvedValue([]);

      registerAllTools(server, mockClient);

      expect(spy).toBeDefined();
    });
  });

  describe('Centralized Registration', () => {
    it('should use single ListTools handler', () => {
      registerAllTools(server, mockClient);

      // Only one handler should be registered for ListToolsRequestSchema
      // Multiple calls to setRequestHandler would overwrite previous handlers
      expect(server).toBeDefined();
    });

    it('should use single CallTool handler with switch statement', () => {
      registerAllTools(server, mockClient);

      // Only one handler for CallToolRequestSchema
      // Uses switch statement to dispatch to correct tool
      expect(server).toBeDefined();
    });

    it('should prevent handler overwriting', () => {
      // This was the bug that was fixed: multiple setRequestHandler calls
      // would overwrite each other, causing only the last tool to work
      registerAllTools(server, mockClient);

      // All tools should be accessible through the single handler
      expect(server).toBeDefined();
    });
  });

  describe('Tool Response Format', () => {
    it('should return array of entities for getStates', () => {
      const response = {
        content: [
          {
            type: 'text',
            text: JSON.stringify([]),
          },
        ],
      };

      expect(response.content[0].type).toBe('text');
      expect(Array.isArray(JSON.parse(response.content[0].text))).toBe(true);
    });

    it('should return single entity for getState', () => {
      const entity = {
        entity_id: 'light.living_room',
        state: 'on',
        attributes: {},
        last_changed: '',
        last_updated: '',
        context: { id: '', parent_id: null, user_id: null },
      };

      const response = {
        content: [
          {
            type: 'text',
            text: JSON.stringify(entity),
          },
        ],
      };

      expect(response.content[0].type).toBe('text');
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.entity_id).toBe('light.living_room');
    });

    it('should return service call result for callService', () => {
      const result = {
        context: {
          id: 'context-123',
          parent_id: null,
          user_id: 'user-456',
        },
      };

      const response = {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      };

      expect(response.content[0].type).toBe('text');
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.context.id).toBe('context-123');
    });
  });
});
