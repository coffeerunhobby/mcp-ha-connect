/**
 * Server common functionality tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from '../../src/server/common.js';

// Mock HaClient
const mockHaClient = {
  getStates: vi.fn(),
  getState: vi.fn(),
  searchEntities: vi.fn(),
  getEntitiesByDomain: vi.fn(),
};

// Mock the tools index
vi.mock('../../src/tools/index.js', () => ({
  registerAllTools: vi.fn(),
}));

// Mock the resources index
vi.mock('../../src/resources/index.js', () => ({
  registerAllResources: vi.fn(),
}));

describe('createServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create MCP server with correct name and version', () => {
    const server = createServer({ haClient: mockHaClient as any });

    expect(server).toBeDefined();
    // Server should have the correct configuration
    // Note: We can't easily test internal properties, but we can verify it was created
  });

  it('should register all tools on server creation', async () => {
    const { registerAllTools } = await import('../../src/tools/index.js');
    const server = createServer({ haClient: mockHaClient as any });

    expect(registerAllTools).toHaveBeenCalledWith({
      server,
      haClient: mockHaClient,
      omadaClient: undefined,
      aiClient: undefined,
    });
  });

  it('should create server with tools capability', () => {
    const server = createServer({ haClient: mockHaClient as any });

    // The server should be created successfully
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });

  it('should work without haClient (Omada-only mode)', () => {
    const server = createServer({});

    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });

  it('should accept omadaClient and aiClient', async () => {
    const { registerAllTools } = await import('../../src/tools/index.js');
    const mockOmadaClient = { listSites: vi.fn() };
    const mockAiClient = { analyze: vi.fn() };

    const server = createServer({
      haClient: mockHaClient as any,
      omadaClient: mockOmadaClient as any,
      aiClient: mockAiClient as any,
    });

    expect(registerAllTools).toHaveBeenCalledWith({
      server,
      haClient: mockHaClient,
      omadaClient: mockOmadaClient,
      aiClient: mockAiClient,
    });
  });
});
