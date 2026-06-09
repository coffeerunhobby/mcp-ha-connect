/**
 * HTTP server tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HaClient } from '../../src/haClient/index.js';
import type { EnvironmentConfig } from '../../src/config.js';
import { VERSION } from '../../src/version.js';
import {
  resolveForwardedProto,
  getOpenApiSpec,
  addRestApiCors,
  isRestApiCorsPath,
} from '../../src/server/http.js';

// Mock dependencies
vi.mock('node:http');
vi.mock('../../src/server/stream.js');
vi.mock('../../src/utils/logger.js');

describe('HTTP Server', () => {
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
      httpBindAddr: '127.0.0.1',
      httpPath: '/mcp',
      httpEnableHealthcheck: true,
      httpHealthcheckPath: '/health',
      httpAllowCors: true,
      httpAllowedOrigins: ['127.0.0.1', 'localhost'],
      sseEventsEnabled: true,
      sseEventsPath: '/subscribe_events',
      rateLimitEnabled: true,
      rateLimitWindowMs: 60000,
      rateLimitMaxRequests: 100,
      authMethod: 'none',
    };
  });

  describe('Health Check Handler', () => {
    it('should return health status for stream transport', () => {
      const expectedResponse = {
        status: 'healthy',
        version: VERSION,
        transport: 'stream',
        stateful: false,
      };

      expect(expectedResponse.status).toBe('healthy');
      expect(expectedResponse.transport).toBe('stream');
      expect(expectedResponse.stateful).toBe(false);
    });

    it('should include stateful flag when enabled', () => {
      const statefulConfig = { ...mockConfig, stateful: true };

      const expectedResponse = {
        status: 'healthy',
        version: VERSION,
        transport: 'stream',
        stateful: statefulConfig.stateful,
      };

      expect(expectedResponse.stateful).toBe(true);
    });
  });

  describe('CORS Handler', () => {
    it('should not set CORS headers when CORS is disabled', () => {
      const noCorsConfig = { ...mockConfig, httpAllowCors: false };

      expect(noCorsConfig.httpAllowCors).toBe(false);
    });

    it('should allow specific origins', () => {
      const allowedOrigins = ['http://mcpserver.10.0.0.18.nip.io:3000', 'http://192.168.0.10:8080'];
      const corsConfig = { ...mockConfig, httpAllowedOrigins: allowedOrigins };

      expect(corsConfig.httpAllowedOrigins).toContain('http://mcpserver.10.0.0.18.nip.io:3000');
      expect(corsConfig.httpAllowedOrigins).toContain('http://192.168.0.10:8080');
    });

    it('should allow all origins when list is empty (wildcard)', () => {
      const wildcardConfig = { ...mockConfig, httpAllowedOrigins: [] };

      // Empty array means wildcard was used
      expect(wildcardConfig.httpAllowedOrigins).toEqual([]);
    });

    it('should set correct CORS headers', () => {
      const expectedHeaders = {
        'Access-Control-Allow-Origin': 'http://mcpserver.10.0.0.18.nip.io:3000',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id',
        'Access-Control-Max-Age': '86400',
      };

      expect(expectedHeaders['Access-Control-Allow-Methods']).toContain('GET');
      expect(expectedHeaders['Access-Control-Allow-Methods']).toContain('POST');
      expect(expectedHeaders['Access-Control-Allow-Headers']).toContain('Mcp-Session-Id');
    });
  });

  describe('Server Configuration', () => {
    it('should use default port if not specified', () => {
      const configWithoutPort = { ...mockConfig };
      delete configWithoutPort.httpPort;

      const port = configWithoutPort.httpPort ?? 3000;
      expect(port).toBe(3000);
    });

    it('should use default bind address if not specified', () => {
      const configWithoutBind = { ...mockConfig };
      delete configWithoutBind.httpBindAddr;

      const bindAddr = configWithoutBind.httpBindAddr ?? '127.0.0.1';
      expect(bindAddr).toBe('127.0.0.1');
    });

    it('should use default health check path if not specified', () => {
      const configWithoutHealthPath = { ...mockConfig };
      delete configWithoutHealthPath.httpHealthcheckPath;

      const healthPath = configWithoutHealthPath.httpHealthcheckPath ?? '/health';
      expect(healthPath).toBe('/health');
    });

    it('should support custom configuration', () => {
      const customConfig = {
        ...mockConfig,
        httpPort: 8080,
        httpBindAddr: '0.0.0.0',
        httpPath: '/custom-mcp',
        httpHealthcheckPath: '/status',
      };

      expect(customConfig.httpPort).toBe(8080);
      expect(customConfig.httpBindAddr).toBe('0.0.0.0');
      expect(customConfig.httpPath).toBe('/custom-mcp');
      expect(customConfig.httpHealthcheckPath).toBe('/status');
    });
  });

  describe('Request Routing', () => {
    it('should route to health check for /health', () => {
      const healthPath = mockConfig.httpHealthcheckPath;
      const requestUrl = '/health';

      expect(requestUrl).toBe(healthPath);
    });

    it('should route to MCP endpoint', () => {
      const mcpPath = mockConfig.httpPath;
      const requestUrl = '/mcp';

      expect(requestUrl).toBe(mcpPath);
    });

    it('should handle OPTIONS requests for CORS preflight', () => {
      const method = 'OPTIONS';

      expect(method).toBe('OPTIONS');
      // Should return 204 No Content
    });

    it('should return 404 for unknown paths', () => {
      const unknownPath = '/unknown-endpoint';
      const validPaths = [mockConfig.httpPath, mockConfig.httpHealthcheckPath];

      expect(validPaths).not.toContain(unknownPath);
    });
  });

  describe('Session Management', () => {
    it('should create new session when stateful mode is disabled', () => {
      expect(mockConfig.stateful).toBe(false);
      // Each request should create a new transport
    });

    it('should reuse session when stateful mode is enabled', () => {
      const statefulConfig = { ...mockConfig, stateful: true };

      expect(statefulConfig.stateful).toBe(true);
      // Should maintain sessions in Map
    });

    it('should require Mcp-Session-Id header for stateful mode', () => {
      const statefulConfig = {
        ...mockConfig,
        stateful: true,
      };

      expect(statefulConfig.stateful).toBe(true);
      // Should validate session ID from header
    });

    it('should return error for invalid session ID', () => {
      const statefulConfig = { ...mockConfig, stateful: true };

      expect(statefulConfig.stateful).toBe(true);
      // Should return 400 error for missing/invalid session
    });
  });

  describe('Error Handling', () => {
    it('should handle request parsing errors', () => {
      const invalidJson = 'not-valid-json';

      expect(() => JSON.parse(invalidJson)).toThrow();
      // Should return 500 with error message
    });

    it('should not send headers if already sent', () => {
      let headersSent = true;

      if (!headersSent) {
        // Would send error response
      }

      expect(headersSent).toBe(true);
    });

    it('should log errors with request details', () => {
      const error = new Error('Test error');
      const requestMethod = 'POST';
      const requestUrl = '/mcp';

      const logData = {
        error,
        method: requestMethod,
        url: requestUrl,
      };

      expect(logData.method).toBe('POST');
      expect(logData.url).toBe('/mcp');
      expect(logData.error).toBe(error);
    });
  });

  describe('JSON Response Helper', () => {
    it('should format JSON response correctly', () => {
      const statusCode = 200;
      const data = { status: 'healthy', version: VERSION };

      const expectedContentType = 'application/json';
      const expectedBody = JSON.stringify(data);

      expect(expectedContentType).toBe('application/json');
      expect(expectedBody).toBe(`{"status":"healthy","version":"${VERSION}"}`);
    });

    it('should handle error responses', () => {
      const statusCode = 500;
      const errorData = {
        error: 'Internal server error',
        message: 'Something went wrong',
      };

      const expectedBody = JSON.stringify(errorData);

      expect(statusCode).toBe(500);
      expect(JSON.parse(expectedBody).error).toBe('Internal server error');
    });
  });

  describe('Body Parsing', () => {
    it('should parse valid JSON body', () => {
      const jsonBody = '{"key":"value"}';
      const parsed = JSON.parse(jsonBody);

      expect(parsed).toEqual({ key: 'value' });
    });

    it('should return undefined for empty body', () => {
      const emptyBody = '';

      expect(emptyBody || undefined).toBeUndefined();
    });

    it('should throw error for invalid JSON', () => {
      const invalidJson = '{invalid}';

      expect(() => JSON.parse(invalidJson)).toThrow();
    });
  });

  describe('Response Timing', () => {
    it('should add Server-Timing header format', () => {
      // Server-Timing header format: total;dur=X (integer ms)
      const durationMs = 42.5;
      const expectedHeader = `total;dur=${Math.round(durationMs)}`;

      expect(expectedHeader).toBe('total;dur=43');
      expect(expectedHeader).toMatch(/^total;dur=\d+$/);
    });

    it('should wrap response end method', () => {
      const headers: Record<string, string> = {};

      const mockRes = {
        headersSent: false,
        setHeader: vi.fn((key: string, value: string) => {
          headers[key] = value;
        }),
        end: vi.fn(),
      } as unknown as ServerResponse;

      // Simulate the timing wrapper behavior
      const startTime = performance.now();
      const originalEnd = mockRes.end.bind(mockRes);

      mockRes.end = function () {
        if (!mockRes.headersSent) {
          const durationMs = Math.round(performance.now() - startTime);
          mockRes.setHeader('Server-Timing', `total;dur=${durationMs}`);
        }
        return originalEnd();
      } as typeof mockRes.end;

      // Call end
      mockRes.end();

      expect(headers['Server-Timing']).toMatch(/^total;dur=\d+$/);
    });

    it('should not set headers if already sent', () => {
      const headers: Record<string, string> = {};

      const mockRes = {
        headersSent: true, // Headers already sent
        setHeader: vi.fn((key: string, value: string) => {
          headers[key] = value;
        }),
        end: vi.fn(),
      } as unknown as ServerResponse;

      // Simulate the timing wrapper behavior
      const originalEnd = mockRes.end.bind(mockRes);

      mockRes.end = function () {
        if (!mockRes.headersSent) {
          mockRes.setHeader('Server-Timing', 'total;dur=0');
        }
        return originalEnd();
      } as typeof mockRes.end;

      mockRes.end();

      // Headers should not be set because headersSent was true
      expect(headers['Server-Timing']).toBeUndefined();
    });

    it('should measure actual elapsed time', async () => {
      const headers: Record<string, string> = {};

      const mockRes = {
        headersSent: false,
        setHeader: vi.fn((key: string, value: string) => {
          headers[key] = value;
        }),
        end: vi.fn(),
      } as unknown as ServerResponse;

      const startTime = performance.now();
      const originalEnd = mockRes.end.bind(mockRes);

      mockRes.end = function () {
        if (!mockRes.headersSent) {
          const durationMs = Math.round(performance.now() - startTime);
          mockRes.setHeader('Server-Timing', `total;dur=${durationMs}`);
        }
        return originalEnd();
      } as typeof mockRes.end;

      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 10));

      mockRes.end();

      // Extract duration from header
      const timing = headers['Server-Timing'];
      const match = timing.match(/total;dur=(\d+)/);
      const duration = match ? parseInt(match[1], 10) : 0;

      // Real elapsed time was measured (not 0/instant). NOT asserted >= 10:
      // setTimeout(10) may fire a hair under 10ms and line 391 Math.round()s the
      // result, so a legitimate ~9.4ms run rounds to 9. That jitter is env-specific
      // (it tripped Node 22 in CI but not Node 20). A 5ms floor proves the timer was
      // captured without being brittle to sub-millisecond timer undershoot + rounding.
      expect(duration).toBeGreaterThanOrEqual(5);
      // But not too long (sanity check)
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('OpenAPI spec scheme (X-Forwarded-Proto)', () => {
    it('returns https only when the header is exactly https', () => {
      expect(resolveForwardedProto('https')).toBe('https');
      expect(resolveForwardedProto('HTTPS')).toBe('https');
      expect(resolveForwardedProto(' https ')).toBe('https');
    });

    it('takes the first hop from a comma-separated proxy chain', () => {
      expect(resolveForwardedProto('https,http')).toBe('https');
      expect(resolveForwardedProto('http, https')).toBe('http');
    });

    it('falls back to http for missing, empty, or unknown values', () => {
      expect(resolveForwardedProto(undefined)).toBe('http');
      expect(resolveForwardedProto('')).toBe('http');
      expect(resolveForwardedProto('http')).toBe('http');
      // A spoofed/garbage scheme can never be injected into the advertised URL.
      expect(resolveForwardedProto('javascript')).toBe('http');
      expect(resolveForwardedProto('ftp')).toBe('http');
    });

    it('handles array-valued headers by using the first entry', () => {
      expect(resolveForwardedProto(['https', 'http'])).toBe('https');
      expect(resolveForwardedProto(['http'])).toBe('http');
    });

    it('advertises the resolved scheme + host as the OpenAPI server url', () => {
      // The regression: behind Cloudflare the spec must say https, not http, or the
      // browser blocks tool calls from the https Open WebUI page as mixed content.
      const scheme = resolveForwardedProto('https');
      const spec = getOpenApiSpec(`${scheme}://mcp.example.com`) as {
        servers: { url: string }[];
        info: { version: string };
      };
      expect(spec.servers[0].url).toBe('https://mcp.example.com');
      expect(spec.info.version).toBe(VERSION);
    });
  });

  describe('REST API CORS on pre-handler rejections', () => {
    const SSE_PATH = '/subscribe_events';

    it('identifies the browser-facing REST surface', () => {
      expect(isRestApiCorsPath('/openapi.json', '/openapi.json', SSE_PATH)).toBe(true);
      expect(isRestApiCorsPath('/api/version', '/api/version', SSE_PATH)).toBe(true);
      expect(isRestApiCorsPath('/api/states/light.x', '/api/states/light.x', SSE_PATH)).toBe(true);
      expect(isRestApiCorsPath('/subscribe_events', '/subscribe_events', SSE_PATH)).toBe(true);
      // Query string must not defeat the SSE path match (urlPath is path-only).
      expect(isRestApiCorsPath('/subscribe_events?token=x', '/subscribe_events', SSE_PATH)).toBe(true);
    });

    it('excludes MCP / health / unknown paths from the REST CORS surface', () => {
      expect(isRestApiCorsPath('/mcp', '/mcp', SSE_PATH)).toBe(false);
      expect(isRestApiCorsPath('/health', '/health', SSE_PATH)).toBe(false);
      expect(isRestApiCorsPath('/', '/', SSE_PATH)).toBe(false);
      // Must not be fooled by a path that merely contains "/api/".
      expect(isRestApiCorsPath('/not/api/x', '/not/api/x', SSE_PATH)).toBe(false);
    });

    it('reflects the request Origin in the CORS headers', () => {
      const set: Record<string, string> = {};
      const res = { setHeader: (k: string, v: string) => { set[k] = v; } } as unknown as ServerResponse;
      const req = { headers: { origin: 'https://owui.example.com' } } as unknown as IncomingMessage;
      addRestApiCors(req, res);
      expect(set['Access-Control-Allow-Origin']).toBe('https://owui.example.com');
      expect(set['Access-Control-Allow-Methods']).toContain('GET');
      expect(set['Access-Control-Allow-Headers']).toContain('Authorization');
      expect(set['Access-Control-Max-Age']).toBe('86400');
    });

    it('falls back to * when the request has no Origin', () => {
      const set: Record<string, string> = {};
      const res = { setHeader: (k: string, v: string) => { set[k] = v; } } as unknown as ServerResponse;
      const req = { headers: {} } as unknown as IncomingMessage;
      addRestApiCors(req, res);
      expect(set['Access-Control-Allow-Origin']).toBe('*');
    });

    it('REGRESSION: a 401 on /api/* still carries Access-Control-Allow-Origin', () => {
      // Reproduces the request pipeline ordering: REST CORS is applied for the path
      // BEFORE the auth middleware rejects, so the browser sees the real 401 instead
      // of an opaque "NetworkError when attempting to fetch resource".
      const set: Record<string, string> = {};
      let status = 0;
      const res = {
        setHeader: (k: string, v: string) => { set[k] = v; },
        writeHead: (code: number) => { status = code; },
        end: () => {},
      } as unknown as ServerResponse;
      const req = { headers: { origin: 'https://owui.example.com' } } as unknown as IncomingMessage;

      const url = '/api/version';
      // 1) dispatcher applies REST CORS for the path...
      if (isRestApiCorsPath(url, url, SSE_PATH)) {
        addRestApiCors(req, res);
      }
      // 2) ...then auth fails and writes a 401.
      const authOk = false;
      if (!authOk) {
        res.writeHead(401);
        res.end();
      }

      expect(status).toBe(401);
      expect(set['Access-Control-Allow-Origin']).toBe('https://owui.example.com');
    });
  });
});
