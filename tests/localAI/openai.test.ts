import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatibleProvider } from '../../src/localAI/providers/openai.js';
import type { AIProviderConfig, SensorData } from '../../src/localAI/types.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('OpenAICompatibleProvider', () => {
  const defaultConfig: AIProviderConfig = {
    provider: 'openai',
    baseUrl: 'http://localhost:8080',
    model: 'gpt-3.5-turbo',
    timeout: 60000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getProviderName', () => {
    it('should return "openai-compatible"', () => {
      const provider = new OpenAICompatibleProvider(defaultConfig);
      expect(provider.getProviderName()).toBe('openai-compatible');
    });
  });

  describe('checkHealth', () => {
    it('should return true when API is available', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const provider = new OpenAICompatibleProvider(defaultConfig);
      const result = await provider.checkHealth();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/models',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('should return false when API is not available', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const provider = new OpenAICompatibleProvider(defaultConfig);
      const result = await provider.checkHealth();

      expect(result).toBe(false);
    });

    it('should return false when API returns non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });

      const provider = new OpenAICompatibleProvider(defaultConfig);
      const result = await provider.checkHealth();

      expect(result).toBe(false);
    });

    it('should include auth headers in health check when API key is set', async () => {
      const configWithKey: AIProviderConfig = {
        ...defaultConfig,
        apiKey: 'test-api-key',
      };

      mockFetch.mockResolvedValueOnce({ ok: true });

      const provider = new OpenAICompatibleProvider(configWithKey);
      await provider.checkHealth();

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
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify(mockResponse),
              },
            },
          ],
        }),
      });

      const provider = new OpenAICompatibleProvider(defaultConfig);
      const result = await provider.analyzeSensors(sensorData);

      expect(result.severity).toBe('critical');
      expect(result.issue).toBe('High temperature detected');
      expect(result.model).toBe('gpt-3.5-turbo');
      expect(result.provider).toBe('openai-compatible');
      expect(result.response_time).toBeGreaterThanOrEqual(0);
    });

    it('should use chat completions endpoint', async () => {
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
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(mockResponse) } }],
        }),
      });

      const provider = new OpenAICompatibleProvider(defaultConfig);
      await provider.analyzeSensors(sensorData);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"messages"'),
        })
      );
    });

    it('should send messages in OpenAI format', async () => {
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
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(mockResponse) } }],
        }),
      });

      const provider = new OpenAICompatibleProvider(defaultConfig);
      await provider.analyzeSensors(sensorData);

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.messages).toHaveLength(2);
      expect(callBody.messages[0].role).toBe('system');
      expect(callBody.messages[1].role).toBe('user');
      expect(callBody.model).toBe('gpt-3.5-turbo');
      expect(callBody.temperature).toBe(0.3);
      expect(callBody.max_tokens).toBe(2000);
    });

    it('should throw error on API failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const provider = new OpenAICompatibleProvider(defaultConfig);

      await expect(provider.analyzeSensors(sensorData)).rejects.toThrow('OpenAI-compatible API request failed');
    });

    it('should throw error on API error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          error: { message: 'Model not found' },
        }),
      });

      const provider = new OpenAICompatibleProvider(defaultConfig);

      await expect(provider.analyzeSensors(sensorData)).rejects.toThrow('API error: Model not found');
    });

    it('should throw error on empty response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '' } }],
        }),
      });

      const provider = new OpenAICompatibleProvider(defaultConfig);

      await expect(provider.analyzeSensors(sensorData)).rejects.toThrow('Empty response from openai-compatible');
    });

    it('should include auth headers when API key is set', async () => {
      const configWithKey: AIProviderConfig = {
        ...defaultConfig,
        apiKey: 'sk-test-key',
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
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(mockResponse) } }],
        }),
      });

      const provider = new OpenAICompatibleProvider(configWithKey);
      await provider.analyzeSensors(sensorData);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test-key',
          }),
        })
      );
    });
  });
});
