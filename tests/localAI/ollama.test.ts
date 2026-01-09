import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider } from '../../src/localAI/providers/ollama.js';
import type { AIProviderConfig, SensorData } from '../../src/localAI/types.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('OllamaProvider', () => {
  const defaultConfig: AIProviderConfig = {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:14b',
    timeout: 60000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getProviderName', () => {
    it('should return "ollama"', () => {
      const provider = new OllamaProvider(defaultConfig);
      expect(provider.getProviderName()).toBe('ollama');
    });
  });

  describe('checkHealth', () => {
    it('should return true when Ollama is available', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const provider = new OllamaProvider(defaultConfig);
      const result = await provider.checkHealth();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/tags',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('should return false when Ollama is not available', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const provider = new OllamaProvider(defaultConfig);
      const result = await provider.checkHealth();

      expect(result).toBe(false);
    });

    it('should return false when Ollama returns non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });

      const provider = new OllamaProvider(defaultConfig);
      const result = await provider.checkHealth();

      expect(result).toBe(false);
    });
  });

  describe('analyzeSensors', () => {
    const sensorData: SensorData = {
      'sensor.temperature': {
        state: '45',
        unit: '°C',
        attributes: { friendly_name: 'Indoor Temperature' },
      },
    };

    it('should analyze sensors successfully', async () => {
      const mockResponse = {
        severity: 'critical',
        issue: 'High temperature detected',
        reasoning: 'Temperature is above 40°C',
        recommended_actions: ['Check HVAC', 'Open windows'],
        ssh_diagnostics: ['systemctl status hvac'],
        confidence: 0.95,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: JSON.stringify(mockResponse) }),
      });

      const provider = new OllamaProvider(defaultConfig);
      const result = await provider.analyzeSensors(sensorData);

      expect(result.severity).toBe('critical');
      expect(result.issue).toBe('High temperature detected');
      expect(result.model).toBe('qwen3:14b');
      expect(result.provider).toBe('ollama');
      expect(result.response_time).toBeGreaterThanOrEqual(0);
    });

    it('should throw error on API failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const provider = new OllamaProvider(defaultConfig);

      await expect(provider.analyzeSensors(sensorData)).rejects.toThrow('Ollama request failed');
    });

    it('should throw error on empty response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: '' }),
      });

      const provider = new OllamaProvider(defaultConfig);

      await expect(provider.analyzeSensors(sensorData)).rejects.toThrow('Empty response from ollama');
    });

    it('should throw error when no JSON in response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: 'This is not JSON' }),
      });

      const provider = new OllamaProvider(defaultConfig);

      await expect(provider.analyzeSensors(sensorData)).rejects.toThrow('No JSON found in AI response');
    });

    it('should extract JSON from response with extra text', async () => {
      const mockResponse = {
        severity: 'medium',
        issue: 'Minor issue',
        reasoning: 'Test',
        recommended_actions: [],
        ssh_diagnostics: [],
        confidence: 0.8,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: `Here is the analysis:\n${JSON.stringify(mockResponse)}\n\nEnd of analysis.`,
        }),
      });

      const provider = new OllamaProvider(defaultConfig);
      const result = await provider.analyzeSensors(sensorData);

      expect(result.severity).toBe('medium');
    });

    it('should include auth headers when API key is set', async () => {
      const configWithKey: AIProviderConfig = {
        ...defaultConfig,
        apiKey: 'test-api-key',
      };

      const mockResponse = {
        severity: 'low',
        issue: 'Test',
        reasoning: 'Test',
        recommended_actions: [],
        ssh_diagnostics: [],
        confidence: 0.9,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: JSON.stringify(mockResponse) }),
      });

      const provider = new OllamaProvider(configWithKey);
      await provider.analyzeSensors(sensorData);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
          }),
        })
      );
    });
  });
});
