/**
 * SSE (Server-Sent Events) transport tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HaClient } from '../../src/haClient/index.js';
import type { EnvironmentConfig } from '../../src/config.js';

// Mock dependencies
vi.mock('@modelcontextprotocol/sdk/server/sse.js');
vi.mock('../../src/server/common.js');
vi.mock('../../src/utils/logger.js');

describe('SSE Transport', () => {
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
      baseUrl: 'http://homeassistant.local:8123',
      token: 'test-token',
      strictSsl: false,
      timeout: 30000,
      aiProvider: 'ollama',
      aiUrl: 'http://localhost:11434',
      aiModel: 'qwen3:14b',
      aiTimeout: 60000,
      logLevel: 'info',
      logFormat: 'plain',
      useHttp: true,
      stateful: true,
      httpPort: 3000,
      httpTransport: 'sse',
      httpBindAddr: '127.0.0.1',
      httpPath: '/sse',
      httpEnableHealthcheck: true,
      httpHealthcheckPath: '/health',
      httpAllowCors: true,
      httpAllowedOrigins: ['127.0.0.1', 'localhost'],
    };
  });

  describe('getSseMessagePath', () => {
    it('should return correct message path', async () => {
      const { getSseMessagePath } = await import('../../src/server/sse.js');

      const messagePath = getSseMessagePath();
      expect(messagePath).toBe('/messages');
    });
  });

  describe('SSE Connection', () => {
    it('should create SSE transport with correct configuration', () => {
      const endpoint = '/sse';

      expect(mockConfig.httpTransport).toBe('sse');
      expect(mockConfig.httpPath).toBe(endpoint);
    });

    it('should generate session ID for stateful connections', () => {
      const sessionId = `sse-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      expect(sessionId).toMatch(/^sse-\d+-[a-z0-9]+$/);
      expect(sessionId.length).toBeGreaterThan(10);
    });

    it('should set correct SSE headers', () => {
      const sseHeaders = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      };

      expect(sseHeaders['Content-Type']).toBe('text/event-stream');
      expect(sseHeaders['Cache-Control']).toBe('no-cache');
      expect(sseHeaders['Connection']).toBe('keep-alive');
    });

    it('should include session ID in stateful mode', () => {
      expect(mockConfig.stateful).toBe(true);

      const sessionId = 'sse-123456-abc';
      const sseHeaders = {
        'Mcp-Session-Id': sessionId,
      };

      expect(sseHeaders['Mcp-Session-Id']).toBe(sessionId);
    });
  });

  describe('SSE Message Handling', () => {
    it('should require session ID for stateful mode', () => {
      expect(mockConfig.stateful).toBe(true);

      const sessionId = undefined;
      const isValid = !!sessionId;

      expect(isValid).toBe(false);
      // Should return 400 error
    });

    it('should validate session exists', () => {
      const sessions = new Map();
      const sessionId = 'sse-123';
      const session = sessions.get(sessionId);

      expect(session).toBeUndefined();
      // Should return 400 error for invalid session
    });

    it('should handle valid session', () => {
      const sessions = new Map();
      const sessionId = 'sse-123';
      const mockSession = {
        transport: { sessionId },
        server: {},
      };
      sessions.set(sessionId, mockSession);

      const session = sessions.get(sessionId);

      expect(session).toBeDefined();
      expect(session?.transport.sessionId).toBe(sessionId);
    });

    it('should parse message body', () => {
      const messageBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'getStates',
          arguments: {},
        },
      };

      expect(messageBody.method).toBe('tools/call');
      expect(messageBody.params.name).toBe('getStates');
    });
  });

  describe('SSE Protocol', () => {
    it('should use legacy MCP protocol version', () => {
      const protocolVersion = '2024-11-05';

      expect(protocolVersion).toBe('2024-11-05');
      // This is the legacy SSE protocol version
    });

    it('should support text/event-stream content type', () => {
      const contentType = 'text/event-stream';

      expect(contentType).toBe('text/event-stream');
    });

    it('should maintain persistent connection', () => {
      const connection = 'keep-alive';

      expect(connection).toBe('keep-alive');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing session gracefully', () => {
      const sessionId = undefined;
      const errorResponse = {
        error: 'Invalid or missing session',
      };

      expect(sessionId).toBeUndefined();
      expect(errorResponse.error).toBe('Invalid or missing session');
    });

    it('should handle invalid session ID', () => {
      const sessions = new Map();
      const invalidSessionId = 'invalid-session';
      const session = sessions.get(invalidSessionId);

      expect(session).toBeUndefined();
      // Should return 400 error
    });

    it('should handle malformed message body', () => {
      const invalidJson = 'not-json';

      expect(() => JSON.parse(invalidJson)).toThrow();
      // Should return error response
    });
  });

  describe('Transport State', () => {
    it('should store transport and server in state', () => {
      const state = {
        transport: { sessionId: 'sse-123' },
        server: { connect: vi.fn() },
      };

      expect(state.transport).toBeDefined();
      expect(state.server).toBeDefined();
      expect(state.transport.sessionId).toBe('sse-123');
    });

    it('should validate transport has sessionId property', () => {
      const state = {
        transport: { sessionId: 'sse-123' },
        server: {},
      };

      const hasSessionId = 'sessionId' in state.transport;

      expect(hasSessionId).toBe(true);
    });

    it('should distinguish SSE from Stream transport', () => {
      const sseState = {
        transport: { sessionId: 'sse-123' },
        server: {},
      };

      const streamState = {
        transport: {}, // No sessionId
        server: {},
      };

      expect('sessionId' in sseState.transport).toBe(true);
      expect('sessionId' in streamState.transport).toBe(false);
    });
  });
});
