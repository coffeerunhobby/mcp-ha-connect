/**
 * analyzeSensors tool - AI-powered sensor analysis
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { LocalAIClient, SensorData } from '../../localAI/index.js';
import { analyzeSensorsSchema, toToolResult, wrapToolHandler, Permission } from '../common.js';
import type { z } from 'zod';

type AnalyzeSensorsArgs = z.infer<typeof analyzeSensorsSchema>;

export function registerAnalyzeSensorsTool(server: McpServer, aiClient: LocalAIClient): void {
  server.registerTool(
    'analyzeSensors',
    {
      description: 'Analyze sensor data using AI (Ollama) to detect issues and provide recommendations.',
      inputSchema: analyzeSensorsSchema,
    },
    wrapToolHandler('analyzeSensors', async ({ sensors }: AnalyzeSensorsArgs) => {
      if (!sensors || typeof sensors !== 'object') {
        return toToolResult({ error: 'sensors object is required' }, true);
      }
      const analysis = await aiClient.analyzeSensors(sensors as SensorData);
      return toToolResult(analysis);
    }, Permission.AI)
  );
}
