/**
 * Base AI Provider
 * Abstract class with shared logic for all AI providers
 */

import { logger } from '../../utils/logger.js';
import type { AIProviderConfig, AIProviderInterface, AnalysisResult, SensorData } from '../types.js';

/**
 * Raw analysis result from AI (before adding metadata)
 */
export interface RawAnalysisResult {
  severity: 'critical' | 'high' | 'medium' | 'low';
  issue: string;
  reasoning: string;
  recommended_actions: string[];
  ssh_diagnostics: string[];
  confidence: number;
}

/**
 * Abstract base class for AI providers
 */
export abstract class BaseAIProvider implements AIProviderInterface {
  protected baseUrl: string;
  protected model: string;
  protected timeout: number;
  protected apiKey?: string;

  constructor(config: AIProviderConfig) {
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.timeout = config.timeout;
    this.apiKey = config.apiKey;
  }

  /**
   * Get the provider name - must be implemented by subclasses
   */
  abstract getProviderName(): string;

  /**
   * Make the actual API request - must be implemented by subclasses
   */
  protected abstract makeRequest(sensors: SensorData): Promise<string>;

  /**
   * Check health - must be implemented by subclasses
   */
  abstract checkHealth(): Promise<boolean>;

  /**
   * Analyze sensors using AI
   */
  async analyzeSensors(sensors: SensorData): Promise<AnalysisResult> {
    const sensorCount = Object.keys(sensors).length;
    const providerName = this.getProviderName();

    logger.info('Starting AI analysis', { sensorCount, model: this.model, provider: providerName });

    const startTime = Date.now();

    try {
      const aiText = await this.makeRequest(sensors);

      if (!aiText) {
        throw new Error(`Empty response from ${providerName}`);
      }

      // Extract JSON from response (handles potential text around JSON)
      const analysis = this.extractJson(aiText);
      const elapsed = (Date.now() - startTime) / 1000;

      logger.info('AI analysis complete', {
        severity: analysis.severity,
        elapsed: `${elapsed.toFixed(2)}s`,
        model: this.model,
        provider: providerName,
      });

      return {
        ...analysis,
        model: this.model,
        provider: providerName,
        response_time: parseFloat(elapsed.toFixed(2)),
      };
    } catch (error) {
      const elapsed = (Date.now() - startTime) / 1000;
      logger.error('AI analysis failed', {
        error: error instanceof Error ? error.message : String(error),
        elapsed: `${elapsed.toFixed(2)}s`,
        provider: providerName,
      });
      throw error;
    }
  }

  /**
   * Extract JSON from AI response text
   */
  protected extractJson(text: string): RawAnalysisResult {
    // Try to find JSON object in the response
    const jsonMatch = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
    if (!jsonMatch) {
      throw new Error(`No JSON found in AI response: ${text.substring(0, 200)}`);
    }

    return JSON.parse(jsonMatch[0]) as RawAnalysisResult;
  }

  /**
   * Build authorization headers if API key is set
   */
  protected getAuthHeaders(): Record<string, string> {
    if (this.apiKey) {
      return { Authorization: `Bearer ${this.apiKey}` };
    }
    return {};
  }
}
