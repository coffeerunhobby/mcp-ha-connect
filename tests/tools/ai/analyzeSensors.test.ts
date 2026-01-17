/**
 * Unit tests for AI analyzeSensors tool handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocalAIClient } from '../../../src/localAI/index.js';
import { registerAnalyzeSensorsTool } from '../../../src/tools/ai/analyzeSensors.js';

// Create mock server that captures registered handlers
function createMockServer() {
  const handlers = new Map<string, { config: unknown; handler: Function }>();
  return {
    registerTool: vi.fn((name: string, config: unknown, handler: Function) => {
      handlers.set(name, { config, handler });
    }),
    handlers,
  } as unknown as McpServer & { handlers: Map<string, { config: unknown; handler: Function }> };
}

// Create mock LocalAIClient
function createMockAIClient() {
  return {
    analyzeSensors: vi.fn(),
  } as unknown as LocalAIClient;
}

// Mock extra with AI permission
const mockExtra = {
  sessionId: 'test-session',
  authInfo: {
    extra: {
      permissions: 0xff, // All permissions including AI
    },
  },
};

// Mock extra without AI permission
const noAiPermExtra = {
  sessionId: 'test-session',
  authInfo: {
    extra: {
      permissions: 0x08, // QUERY only
    },
  },
};

// Parse JSON result from tool output
function parseResult(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

describe('AI analyzeSensors Tool Handler', () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    server = createMockServer();
    vi.clearAllMocks();
  });

  describe('Registration', () => {
    it('should register the tool', () => {
      const aiClient = createMockAIClient();
      registerAnalyzeSensorsTool(server, aiClient);

      expect(server.registerTool).toHaveBeenCalledWith(
        'analyzeSensors',
        expect.objectContaining({
          description: expect.any(String),
        }),
        expect.any(Function)
      );
    });

    it('should register with optional AI client', () => {
      registerAnalyzeSensorsTool(server, undefined);

      expect(server.registerTool).toHaveBeenCalledWith(
        'analyzeSensors',
        expect.objectContaining({
          description: expect.any(String),
        }),
        expect.any(Function)
      );
    });
  });

  describe('AI Client Not Configured', () => {
    it('should return error when AI client is not provided', async () => {
      registerAnalyzeSensorsTool(server, undefined);
      const handler = server.handlers.get('analyzeSensors')!.handler;

      const sensorData = {
        'sensor.temperature': { state: '25', unit: '°C' },
      };

      const result = await handler({ sensors: sensorData }, mockExtra);
      const parsed = parseResult(result) as { error: string; message: string };

      expect(parsed.error).toBe('AI client not configured');
      expect(parsed.message).toContain('AI_URL');
    });
  });

  describe('Input Validation', () => {
    it('should return error when sensors is undefined', async () => {
      const aiClient = createMockAIClient();
      registerAnalyzeSensorsTool(server, aiClient);
      const handler = server.handlers.get('analyzeSensors')!.handler;

      const result = await handler({ sensors: undefined }, mockExtra);
      const parsed = parseResult(result) as { error: string };

      expect(parsed.error).toBe('sensors object is required');
      expect(aiClient.analyzeSensors).not.toHaveBeenCalled();
    });

    it('should return error when sensors is not an object', async () => {
      const aiClient = createMockAIClient();
      registerAnalyzeSensorsTool(server, aiClient);
      const handler = server.handlers.get('analyzeSensors')!.handler;

      const result = await handler({ sensors: 'invalid' }, mockExtra);
      const parsed = parseResult(result) as { error: string };

      expect(parsed.error).toBe('sensors object is required');
      expect(aiClient.analyzeSensors).not.toHaveBeenCalled();
    });
  });

  describe('Successful Analysis', () => {
    it('should analyze sensors and return result', async () => {
      const aiClient = createMockAIClient();
      const mockAnalysis = {
        summary: 'All sensors are operating normally',
        issues: [],
        recommendations: ['Consider adding humidity sensors'],
      };
      (aiClient.analyzeSensors as ReturnType<typeof vi.fn>).mockResolvedValue(mockAnalysis);

      registerAnalyzeSensorsTool(server, aiClient);
      const handler = server.handlers.get('analyzeSensors')!.handler;

      const sensorData = {
        'sensor.temperature': { state: '25', unit: '°C', attributes: { friendly_name: 'Living Room' } },
        'sensor.humidity': { state: '50', unit: '%', attributes: { friendly_name: 'Living Room Humidity' } },
      };

      const result = await handler({ sensors: sensorData }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockAnalysis);
      expect(aiClient.analyzeSensors).toHaveBeenCalledWith(sensorData);
    });

    it('should handle empty sensor object', async () => {
      const aiClient = createMockAIClient();
      const mockAnalysis = { summary: 'No sensors provided for analysis', issues: [], recommendations: [] };
      (aiClient.analyzeSensors as ReturnType<typeof vi.fn>).mockResolvedValue(mockAnalysis);

      registerAnalyzeSensorsTool(server, aiClient);
      const handler = server.handlers.get('analyzeSensors')!.handler;

      const result = await handler({ sensors: {} }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockAnalysis);
      expect(aiClient.analyzeSensors).toHaveBeenCalledWith({});
    });
  });

  describe('AI Client Error Handling', () => {
    it('should handle AI client errors gracefully', async () => {
      const aiClient = createMockAIClient();
      (aiClient.analyzeSensors as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Ollama connection failed'));

      registerAnalyzeSensorsTool(server, aiClient);
      const handler = server.handlers.get('analyzeSensors')!.handler;

      const sensorData = { 'sensor.test': { state: '10' } };
      const result = await handler({ sensors: sensorData }, mockExtra);
      const parsed = parseResult(result) as { error: string; message: string };

      expect(parsed.error).toBe('Failed to execute analyzeSensors');
      expect(parsed.message).toContain('Ollama connection failed');
    });

    it('should handle timeout errors', async () => {
      const aiClient = createMockAIClient();
      (aiClient.analyzeSensors as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Request timeout'));

      registerAnalyzeSensorsTool(server, aiClient);
      const handler = server.handlers.get('analyzeSensors')!.handler;

      const sensorData = { 'sensor.test': { state: '10' } };
      const result = await handler({ sensors: sensorData }, mockExtra);
      const parsed = parseResult(result) as { error: string; message: string };

      expect(parsed.error).toBe('Failed to execute analyzeSensors');
      expect(parsed.message).toContain('timeout');
    });
  });

  describe('Permission Enforcement', () => {
    it('should deny access without AI permission', async () => {
      const aiClient = createMockAIClient();
      registerAnalyzeSensorsTool(server, aiClient);
      const handler = server.handlers.get('analyzeSensors')!.handler;

      const sensorData = { 'sensor.test': { state: '10' } };
      const result = await handler({ sensors: sensorData }, noAiPermExtra);
      const parsed = parseResult(result) as { error: string; message: string };

      expect(parsed.error).toBe('Permission denied');
      expect(parsed.message).toContain('AI');
      expect(aiClient.analyzeSensors).not.toHaveBeenCalled();
    });

    it('should allow access with AI permission', async () => {
      const aiClient = createMockAIClient();
      const mockAnalysis = { summary: 'Analysis complete', issues: [], recommendations: [] };
      (aiClient.analyzeSensors as ReturnType<typeof vi.fn>).mockResolvedValue(mockAnalysis);

      registerAnalyzeSensorsTool(server, aiClient);
      const handler = server.handlers.get('analyzeSensors')!.handler;

      const sensorData = { 'sensor.test': { state: '10' } };
      const result = await handler({ sensors: sensorData }, mockExtra);
      const parsed = parseResult(result);

      expect(parsed).toEqual(mockAnalysis);
      expect(aiClient.analyzeSensors).toHaveBeenCalled();
    });
  });
});
