/**
 * Stdio server tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HaClient } from '../../src/haClient/index.js';
import type { EnvironmentConfig } from '../../src/config.js';

// Mock dependencies
vi.mock('../../src/server/common.js');
vi.mock('@modelcontextprotocol/sdk/server/stdio.js');
vi.mock('../../src/utils/logger.js');

describe('startStdioServer', () => {
  let mockClient: HaClient;
  let mockConfig: EnvironmentConfig;
  let startStdioServer: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

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
      useHttp: false,
      stateful: false,
      httpTransport: 'stream',
      httpEnableHealthcheck: true,
      httpAllowCors: true,
    };

    // Mock HaClient
    mockClient = {
      checkApi: vi.fn().mockResolvedValue({ message: 'API running.' }),
      getStates: vi.fn(),
      getState: vi.fn(),
      callService: vi.fn(),
      getEntitiesByDomain: vi.fn(),
      searchEntities: vi.fn(),
    } as any;

    // Import the function to test
    const stdioModule = await import('../../src/server/stdio.js');
    startStdioServer = stdioModule.startStdioServer;
  });

  it('should create and start stdio server', async () => {
    const { createServer } = await import('../../src/server/common.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

    const mockServer = {
      connect: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createServer).mockReturnValue(mockServer as any);

    const mockTransport = {};
    vi.mocked(StdioServerTransport).mockImplementation(() => mockTransport as any);

    await startStdioServer(mockClient);

    // Second argument (ollamaClient) is optional
    expect(createServer).toHaveBeenCalledWith(mockClient, undefined);
    expect(StdioServerTransport).toHaveBeenCalled();
    expect(mockServer.connect).toHaveBeenCalledWith(mockTransport);
  });

  it('should log server startup', async () => {
    const { logger } = await import('../../src/utils/logger.js');
    const { createServer } = await import('../../src/server/common.js');

    const mockServer = {
      connect: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createServer).mockReturnValue(mockServer as any);

    await startStdioServer(mockClient);

    expect(logger.info).toHaveBeenCalledWith('Starting stdio server');
    expect(logger.info).toHaveBeenCalledWith('Connecting stdio server');
    expect(logger.info).toHaveBeenCalledWith('Stdio server connected and ready');
  });

  it('should handle connection errors', async () => {
    const { createServer } = await import('../../src/server/common.js');

    const mockServer = {
      connect: vi.fn().mockRejectedValue(new Error('Connection failed')),
    };
    vi.mocked(createServer).mockReturnValue(mockServer as any);

    await expect(startStdioServer(mockClient)).rejects.toThrow('Connection failed');
  });
});
