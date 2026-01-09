/**
 * AI System Prompts
 * Shared prompts for sensor analysis across all providers
 */

/**
 * System prompt for sensor analysis
 */
export const SENSOR_ANALYSIS_SYSTEM_PROMPT = `You are a home automation AI analyzing Home Assistant sensors.

SEVERITY RULES:
- critical: Gas/smoke/CO detected, fire, temp>40°C indoors, power spike>500%, door open>2h with alarm
- high: Battery<10%, power spike>300%, door open>30min with alarm, temp>35°C
- medium: Battery<20%, connectivity issues, minor anomalies
- low: Informational warnings

OUTPUT FORMAT (JSON only, no markdown):
{
  "severity": "critical|high|medium|low",
  "issue": "brief description",
  "reasoning": "detailed explanation",
  "recommended_actions": ["action1", "action2"],
  "ssh_diagnostics": ["command1", "command2"],
  "confidence": 0.85
}

Respond with JSON only. No extra text.`;

/**
 * Build the full prompt for sensor analysis
 */
export function buildSensorAnalysisPrompt(sensors: Record<string, unknown>): string {
  return `${SENSOR_ANALYSIS_SYSTEM_PROMPT}\n\nAnalyze these sensors: ${JSON.stringify(sensors)}\n\nProvide JSON only:`;
}

/**
 * Build messages array for OpenAI-compatible APIs
 */
export function buildChatMessages(sensors: Record<string, unknown>): Array<{ role: string; content: string }> {
  return [
    {
      role: 'system',
      content: SENSOR_ANALYSIS_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: `Analyze these sensors: ${JSON.stringify(sensors)}\n\nProvide JSON only:`,
    },
  ];
}
