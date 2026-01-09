/**
 * Local AI Client
 * Factory and facade for AI providers
 */

import { logger } from '../utils/logger.js';
import type { EnvironmentConfig } from '../config.js';
import type { AIProviderConfig, AIProviderInterface, AnalysisResult, SensorData } from './types.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAICompatibleProvider } from './providers/openai.js';

// Re-export types for convenience
export type { SensorData, AnalysisResult, AIProviderType } from './types.js';

/**
 * Create the appropriate AI provider based on configuration
 */
function createProvider(providerConfig: AIProviderConfig): AIProviderInterface {
  switch (providerConfig.provider) {
    case 'openai':
      return new OpenAICompatibleProvider(providerConfig);
    case 'ollama':
    default:
      return new OllamaProvider(providerConfig);
  }
}

/**
 * Local AI Client
 * Facade for AI analysis using configurable providers
 */
export class LocalAIClient {
  private provider: AIProviderInterface;
  private providerConfig: AIProviderConfig;

  constructor(config: EnvironmentConfig) {
    this.providerConfig = {
      provider: config.aiProvider,
      baseUrl: config.aiUrl,
      model: config.aiModel,
      timeout: config.aiTimeout,
      apiKey: config.aiApiKey,
    };

    this.provider = createProvider(this.providerConfig);

    logger.info('LocalAIClient initialized', {
      provider: this.providerConfig.provider,
      model: this.providerConfig.model,
      url: this.providerConfig.baseUrl,
    });
  }

  /**
   * Analyze sensor data using AI
   */
  async analyzeSensors(sensors: SensorData): Promise<AnalysisResult> {
    return this.provider.analyzeSensors(sensors);
  }

  /**
   * Check if the AI provider is available
   */
  async checkHealth(): Promise<boolean> {
    return this.provider.checkHealth();
  }

  /**
   * Get the provider name
   */
  getProviderName(): string {
    return this.provider.getProviderName();
  }

  /**
   * Get the configured model name
   */
  getModelName(): string {
    return this.providerConfig.model;
  }

  /**
   * Get the provider configuration
   */
  getConfig(): Readonly<AIProviderConfig> {
    return { ...this.providerConfig };
  }
}
