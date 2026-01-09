import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the providers before importing LocalAIClient
const mockOllamaAnalyze = vi.fn();
const mockOllamaHealth = vi.fn();
const mockOpenAIAnalyze = vi.fn();
const mockOpenAIHealth = vi.fn();

vi.mock('../../src/localAI/providers/ollama.js', () => ({
  OllamaProvider: vi.fn().mockImplementation(() => ({
    analyzeSensors: mockOllamaAnalyze,
    checkHealth: mockOllamaHealth,
    getProviderName: () => 'ollama',
  })),
}));

vi.mock('../../src/localAI/providers/openai.js', () => ({
  OpenAICompatibleProvider: vi.fn().mockImplementation(() => ({
    analyzeSensors: mockOpenAIAnalyze,
    checkHealth: mockOpenAIHealth,
    getProviderName: () => 'openai-compatible',
  })),
}));

import { LocalAIClient } from '../../src/localAI/index.js';
import type { EnvironmentConfig } from '../../src/config.js';
import type { AIProviderType } from '../../src/localAI/types.js';

describe('LocalAIClient', () => {
  const createConfig = (provider: AIProviderType = 'ollama'): EnvironmentConfig =>
    ({
      aiProvider: provider,
      aiUrl: 'http://localhost:11434',
      aiModel: 'qwen3:14b',
      aiTimeout: 60000,
      aiApiKey: undefined,
      // Other required config fields
      baseUrl: 'http://localhost:8123',
      token: 'test-token',
      strictSsl: true,
      timeout: 30000,
      logLevel: 'info',
      logFormat: 'plain',
      useHttp: false,
      stateful: false,
      httpTransport: 'stream',
      httpEnableHealthcheck: true,
      httpAllowCors: true,
    }) as EnvironmentConfig;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create OllamaProvider for ollama provider type', () => {
      const config = createConfig('ollama');
      const client = new LocalAIClient(config);

      expect(client.getProviderName()).toBe('ollama');
    });

    it('should create OpenAICompatibleProvider for openai provider type', () => {
      const config = createConfig('openai');
      const client = new LocalAIClient(config);

      expect(client.getProviderName()).toBe('openai-compatible');
    });

    it('should default to OllamaProvider when provider is unknown', () => {
      const config = createConfig('ollama');
      // Force unknown provider
      (config as unknown as { aiProvider: string }).aiProvider = 'unknown';
      const client = new LocalAIClient(config);

      // Should fall back to ollama
      expect(client.getProviderName()).toBe('ollama');
    });
  });

  describe('analyzeSensors', () => {
    it('should delegate to the provider', async () => {
      const mockResult = {
        severity: 'critical' as const,
        issue: 'Test issue',
        reasoning: 'Test reasoning',
        recommended_actions: [],
        ssh_diagnostics: [],
        confidence: 0.9,
        model: 'qwen3:14b',
        provider: 'ollama',
        response_time: 1.5,
      };
      mockOllamaAnalyze.mockResolvedValueOnce(mockResult);

      const config = createConfig('ollama');
      const client = new LocalAIClient(config);
      const sensors = { 'sensor.test': { state: '25' } };

      const result = await client.analyzeSensors(sensors);

      expect(mockOllamaAnalyze).toHaveBeenCalledWith(sensors);
      expect(result).toEqual(mockResult);
    });
  });

  describe('checkHealth', () => {
    it('should delegate to the provider', async () => {
      mockOllamaHealth.mockResolvedValueOnce(true);

      const config = createConfig('ollama');
      const client = new LocalAIClient(config);

      const result = await client.checkHealth();

      expect(mockOllamaHealth).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should return false when provider is unhealthy', async () => {
      mockOllamaHealth.mockResolvedValueOnce(false);

      const config = createConfig('ollama');
      const client = new LocalAIClient(config);

      const result = await client.checkHealth();

      expect(result).toBe(false);
    });
  });

  describe('getModelName', () => {
    it('should return the configured model name', () => {
      const config = createConfig('ollama');
      config.aiModel = 'phi4:14b';
      const client = new LocalAIClient(config);

      expect(client.getModelName()).toBe('phi4:14b');
    });
  });

  describe('getConfig', () => {
    it('should return the provider configuration', () => {
      const config = createConfig('ollama');
      config.aiApiKey = 'test-key';
      const client = new LocalAIClient(config);

      const providerConfig = client.getConfig();

      expect(providerConfig.provider).toBe('ollama');
      expect(providerConfig.baseUrl).toBe('http://localhost:11434');
      expect(providerConfig.model).toBe('qwen3:14b');
      expect(providerConfig.timeout).toBe(60000);
      expect(providerConfig.apiKey).toBe('test-key');
    });

    it('should return a copy of the config (immutable)', () => {
      const config = createConfig('ollama');
      const client = new LocalAIClient(config);

      const providerConfig1 = client.getConfig();
      const providerConfig2 = client.getConfig();

      expect(providerConfig1).not.toBe(providerConfig2);
      expect(providerConfig1).toEqual(providerConfig2);
    });
  });
});
