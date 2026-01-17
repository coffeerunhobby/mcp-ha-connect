/**
 * Stdio server tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../src/server/common.js');
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockStdioServerTransport {},
}));
vi.mock('../../src/utils/logger.js');

describe('startStdioServer', () => {
  let mockClient: any;
  let startStdioServer: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Mock HaClient
    mockClient = {
      checkApi: vi.fn().mockResolvedValue({ message: 'API running.' }),
      getStates: vi.fn(),
      getState: vi.fn(),
      callService: vi.fn(),
      getEntitiesByDomain: vi.fn(),
      searchEntities: vi.fn(),
    };

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

    await startStdioServer({ haClient: mockClient });

    expect(createServer).toHaveBeenCalledWith({
      haClient: mockClient,
      omadaClient: undefined,
      aiClient: undefined,
    });
    expect(mockServer.connect).toHaveBeenCalled();
  });

  it('should log server startup', async () => {
    const { logger } = await import('../../src/utils/logger.js');
    const { createServer } = await import('../../src/server/common.js');

    const mockServer = {
      connect: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createServer).mockReturnValue(mockServer as any);

    await startStdioServer({ haClient: mockClient });

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

    await expect(startStdioServer({ haClient: mockClient })).rejects.toThrow('Connection failed');
  });

  it('should work without haClient (Omada-only mode)', async () => {
    const { createServer } = await import('../../src/server/common.js');

    const mockServer = {
      connect: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createServer).mockReturnValue(mockServer as any);

    await startStdioServer({});

    expect(createServer).toHaveBeenCalledWith({
      haClient: undefined,
      omadaClient: undefined,
      aiClient: undefined,
    });
  });
});
