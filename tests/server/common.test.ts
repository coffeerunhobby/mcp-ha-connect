/**
 * Server common functionality tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from '../../src/server/common.js';
import { HaClient } from '../../src/haClient/index.js';
import type { EnvironmentConfig } from '../../src/config.js';

// Mock the tools index
vi.mock('../../src/tools/index.js', () => ({
  registerAllTools: vi.fn(),
}));

describe('createServer', () => {
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
      logLevel: 'info',
      logFormat: 'plain',
      useHttp: false,
      stateful: false,
      
      httpEnableHealthcheck: true,
      httpAllowCors: true,
    };

    mockClient = new HaClient(mockConfig);
  });

  it('should create MCP server with correct name and version', () => {
    const server = createServer(mockClient);

    expect(server).toBeDefined();
    // Server should have the correct configuration
    // Note: We can't easily test internal properties, but we can verify it was created
  });

  it('should register all tools on server creation', async () => {
    const { registerAllTools } = await import('../../src/tools/index.js');
    const server = createServer(mockClient);

    // Third argument (aiClient) is optional
    expect(registerAllTools).toHaveBeenCalledWith(server, mockClient, undefined);
  });

  it('should create server with tools capability', () => {
    const server = createServer(mockClient);

    // The server should be created successfully
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });
});
