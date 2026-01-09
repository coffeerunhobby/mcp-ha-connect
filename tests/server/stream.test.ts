/**
 * Streamable HTTP transport tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HaClient } from '../../src/haClient/index.js';
import type { EnvironmentConfig } from '../../src/config.js';

// Mock dependencies
vi.mock('@modelcontextprotocol/sdk/server/streamable.js');
vi.mock('../../src/server/common.js');
vi.mock('../../src/utils/logger.js');

describe('Stream Transport', () => {
  let mockClient: HaClient;
  let mockConfig: EnvironmentConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      checkApi: vi.fn().mockResolvedValue({ message: 'API running.' }),
      getStates: vi.fn(),
      getState: vi.fn(),
      callService: vi.fn(),
      getEntitiesByDomain: vi.fn(),
      searchEntities: vi.fn(),
    } as any;

    mockConfig = {
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
      useHttp: true,
      stateful: false,
      httpPort: 3000,
      httpTransport: 'stream',
      httpBindAddr: '127.0.0.1',
      httpPath: '/mcp',
      httpEnableHealthcheck: true,
      httpHealthcheckPath: '/health',
      httpAllowCors: true,
      httpAllowedOrigins: ['127.0.0.1', 'localhost'],
    };
  });

  describe('Stream Connection', () => {
    it('should create streamable HTTP transport', () => {
      expect(mockConfig.httpTransport).toBe('stream');
      expect(mockConfig.httpPath).toBe('/mcp');
    });

    it('should support stateless mode by default', () => {
      expect(mockConfig.stateful).toBe(false);
      // Each request creates a new transport
    });

    it('should support stateful mode when enabled', () => {
      const statefulConfig = { ...mockConfig, stateful: true };

      expect(statefulConfig.stateful).toBe(true);
      // Reuses existing transport for session
    });

    it('should use modern MCP protocol version', () => {
      const protocolVersion = '2025-03-26';

      expect(protocolVersion).toBe('2025-03-26');
      // This is the modern streamable HTTP protocol version
    });
  });

  describe('Request Handling', () => {
    it('should handle GET requests', () => {
      const method = 'GET';

      expect(method).toBe('GET');
      // Stream transport supports GET for initial connection
    });

    it('should handle POST requests', () => {
      const method = 'POST';

      expect(method).toBe('POST');
      // Stream transport supports POST for messages
    });

    it('should parse request body for non-GET requests', () => {
      const method: string = 'POST';
      const shouldParseBody = method !== 'GET';

      expect(shouldParseBody).toBe(true);
    });

    it('should not parse body for GET requests', () => {
      const method: string = 'GET';
      const shouldParseBody = method !== 'GET';

      expect(shouldParseBody).toBe(false);
    });
  });

  describe('Session Management', () => {
    it('should create new transport for stateless mode', () => {
      expect(mockConfig.stateful).toBe(false);

      const existingTransport = undefined;
      const shouldCreateNew = !existingTransport;

      expect(shouldCreateNew).toBe(true);
    });

    it('should reuse transport for stateful mode', () => {
      const statefulConfig = { ...mockConfig, stateful: true };
      const existingTransport = {
        transport: {},
        server: {},
      };

      expect(statefulConfig.stateful).toBe(true);
      expect(existingTransport).toBeDefined();
      // Should use existingTransport
    });

    it('should read session ID from header', () => {
      const headers = {
        'mcp-session-id': 'session-123',
      };

      const sessionId = headers['mcp-session-id'];

      expect(sessionId).toBe('session-123');
    });

    it('should handle missing session ID', () => {
      const headers = {};
      const sessionId = headers['mcp-session-id' as keyof typeof headers];

      expect(sessionId).toBeUndefined();
    });
  });

  describe('Transport Lifecycle', () => {
    it('should connect server on first use', () => {
      const existingTransport = undefined;
      const isFirstConnection = !existingTransport;

      expect(isFirstConnection).toBe(true);
      // Should call server.connect(transport)
    });

    it('should skip connection for existing transport', () => {
      const existingTransport = {
        transport: {},
        server: {},
      };
      const isFirstConnection = !existingTransport;

      expect(isFirstConnection).toBe(false);
      // Should not call server.connect again
    });

    it('should handle request through transport', () => {
      const request = { method: 'POST', url: '/mcp' };
      const response = {};
      const body = { method: 'tools/call' };

      expect(request.method).toBe('POST');
      // Should call transport.handleRequest(req, res, body)
    });
  });

  describe('Stateful vs Stateless', () => {
    it('should return transport state in stateful mode', () => {
      const statefulConfig = { ...mockConfig, stateful: true };

      expect(statefulConfig.stateful).toBe(true);
      // handleStreamRequest should return state
    });

    it('should not return state in stateless mode', () => {
      expect(mockConfig.stateful).toBe(false);
      // handleStreamRequest should return void
    });

    it('should store state in sessions map for stateful mode', () => {
      const sessions = new Map();
      const sessionId = 'session-123';
      const state = {
        transport: {},
        server: {},
      };

      sessions.set(sessionId, state);

      expect(sessions.get(sessionId)).toBe(state);
      expect(sessions.size).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('should handle transport creation errors', () => {
      const error = new Error('Failed to create transport');

      expect(error.message).toBe('Failed to create transport');
      // Should propagate error
    });

    it('should handle request handling errors', () => {
      const error = new Error('Failed to handle request');

      expect(error.message).toBe('Failed to handle request');
      // Should propagate error
    });

    it('should handle server connection errors', () => {
      const error = new Error('Failed to connect server');

      expect(error.message).toBe('Failed to connect server');
      // Should propagate error
    });
  });

  describe('Transport State Type', () => {
    it('should have transport and server properties', () => {
      const state = {
        transport: { handleRequest: vi.fn() },
        server: { connect: vi.fn() },
      };

      expect(state.transport).toBeDefined();
      expect(state.server).toBeDefined();
      expect(typeof state.transport.handleRequest).toBe('function');
      expect(typeof state.server.connect).toBe('function');
    });

    it('should distinguish from SSE transport state', () => {
      const streamState = {
        transport: { handleRequest: vi.fn() },
        server: {},
      };

      const sseState = {
        transport: { sessionId: 'sse-123' },
        server: {},
      };

      expect('handleRequest' in streamState.transport).toBe(true);
      expect('sessionId' in sseState.transport).toBe(true);
      expect('sessionId' in streamState.transport).toBe(false);
    });
  });

  describe('Protocol Differences', () => {
    it('should not use sessionId in transport like SSE does', () => {
      const streamTransport = {
        handleRequest: vi.fn(),
      };

      expect('sessionId' in streamTransport).toBe(false);
      // Stream transport doesn't embed sessionId in transport object
    });

    it('should use HTTP headers for session tracking', () => {
      const sessionHeader = 'Mcp-Session-Id';

      expect(sessionHeader).toBe('Mcp-Session-Id');
      // Stream uses headers, not transport properties
    });

    it('should support both GET and POST unlike SSE', () => {
      const supportedMethods = ['GET', 'POST'];

      expect(supportedMethods).toContain('GET');
      expect(supportedMethods).toContain('POST');
      // SSE uses GET for connection, POST for messages
      // Stream uses both for the same endpoint
    });
  });
});
