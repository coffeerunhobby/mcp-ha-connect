/**
 * OpenAI-Compatible AI Provider
 * Works with LocalAI, LM Studio, vLLM, and any OpenAI-compatible API
 */

import type { AIProviderConfig, SensorData } from '../types.js';
import { buildChatMessages } from '../prompts.js';
import { BaseAIProvider } from './base.js';

/**
 * OpenAI chat completion response format
 */
interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

/**
 * OpenAI-compatible AI provider
 * Works with LocalAI, LM Studio, vLLM, and other OpenAI-compatible APIs
 */
export class OpenAICompatibleProvider extends BaseAIProvider {
  constructor(config: AIProviderConfig) {
    super(config);
  }

  getProviderName(): string {
    return 'openai-compatible';
  }

  /**
   * Make request to OpenAI-compatible API
   */
  protected async makeRequest(sensors: SensorData): Promise<string> {
    const messages = buildChatMessages(sensors);

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders(),
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.3,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI-compatible API request failed: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as OpenAIChatResponse;

    if (result.error) {
      throw new Error(`API error: ${result.error.message}`);
    }

    return result.choices?.[0]?.message?.content ?? '';
  }

  /**
   * Check if the OpenAI-compatible API is available
   */
  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.getAuthHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
