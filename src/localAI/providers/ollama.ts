/**
 * Ollama AI Provider
 * Native Ollama API implementation
 */

import type { AIProviderConfig, SensorData } from '../types.js';
import { buildSensorAnalysisPrompt } from '../prompts.js';
import { BaseAIProvider } from './base.js';

/**
 * Ollama API response format
 */
interface OllamaResponse {
  response?: string;
  error?: string;
}

/**
 * Ollama AI provider using native Ollama API
 */
export class OllamaProvider extends BaseAIProvider {
  constructor(config: AIProviderConfig) {
    super(config);
  }

  getProviderName(): string {
    return 'ollama';
  }

  /**
   * Make request to Ollama API
   */
  protected async makeRequest(sensors: SensorData): Promise<string> {
    const prompt = buildSensorAnalysisPrompt(sensors);

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(),
      },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 2000,
          num_ctx: 4096,
        },
      }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama request failed: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as OllamaResponse;
    return result.response ?? '';
  }

  /**
   * Check if Ollama is available
   */
  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        headers: this.getAuthHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
