/**
 * Local AI Client Types
 * Shared interfaces for AI provider implementations
 */

/**
 * Supported AI provider types
 * Use 'none' to explicitly disable AI features
 */
export type AIProviderType = 'ollama' | 'openai' | 'none';

/**
 * Sensor data input for analysis
 */
export interface SensorData {
  [entity_id: string]: {
    state: string;
    unit?: string;
    attributes?: Record<string, unknown>;
  };
}

/**
 * AI analysis result
 */
export interface AnalysisResult {
  severity: 'critical' | 'high' | 'medium' | 'low';
  issue: string;
  reasoning: string;
  recommended_actions: string[];
  ssh_diagnostics: string[];
  confidence: number;
  model: string;
  provider: string;
  response_time: number;
}

/**
 * AI provider configuration
 */
export interface AIProviderConfig {
  provider: AIProviderType;
  baseUrl: string;
  model: string;
  timeout: number;
  apiKey?: string;
}

/**
 * AI provider interface - all providers must implement this
 */
export interface AIProviderInterface {
  /**
   * Analyze sensor data using AI
   */
  analyzeSensors(sensors: SensorData): Promise<AnalysisResult>;

  /**
   * Check if the AI provider is available
   */
  checkHealth(): Promise<boolean>;

  /**
   * Get the provider name
   */
  getProviderName(): string;
}
