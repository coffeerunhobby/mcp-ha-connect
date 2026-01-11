/**
 * analyzeSensors tool - AI-powered sensor analysis
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocalAIClient, SensorData } from '../localAI/index.js';
import { analyzeSensorsSchema, toToolResult, wrapToolHandler } from './common.js';
import type { z } from 'zod';

type AnalyzeSensorsArgs = z.infer<typeof analyzeSensorsSchema>;

export function registerAnalyzeSensorsTool(server: McpServer, aiClient?: LocalAIClient): void {
  server.registerTool(
    'analyzeSensors',
    {
      description: 'Analyze sensor data using AI (Ollama) to detect issues and provide recommendations.',
      inputSchema: analyzeSensorsSchema.shape,
    },
    wrapToolHandler('analyzeSensors', async ({ sensors }: AnalyzeSensorsArgs) => {
      if (!aiClient) {
        return toToolResult({
          error: 'AI client not configured',
          message: 'AI analysis requires AI_URL to be set (or legacy OLLAMA_URL)',
        }, true);
      }
      if (!sensors || typeof sensors !== 'object') {
        return toToolResult({ error: 'sensors object is required' }, true);
      }
      const analysis = await aiClient.analyzeSensors(sensors as SensorData);
      return toToolResult(analysis);
    })
  );
}
