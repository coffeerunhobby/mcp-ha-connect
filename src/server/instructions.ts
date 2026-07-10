/**
 * MCP Server Instructions
 *
 * Provides guidance to LLMs on how to optimally use the server's tools.
 * These instructions are sent during initialization and help LLMs understand
 * tool relationships, best practices, and constraints.
 *
 * @see https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/
 */

export interface InstructionsConfig {
  haEnabled: boolean;
  omadaEnabled: boolean;
  aiEnabled: boolean;
}

/**
 * Generates server instructions based on enabled plugins.
 * Instructions are kept concise and actionable per MCP best practices.
 */
export function generateInstructions(config: InstructionsConfig): string {
  const sections: string[] = [];

  // Base instructions
  sections.push(
    'MCP-HA-Connect: Smart home control via Home Assistant with network management via TP-Link Omada.'
  );

  if (config.haEnabled) {
    sections.push(getHomeAssistantInstructions());
  }

  if (config.omadaEnabled) {
    sections.push(getOmadaInstructions());
  }

  if (config.aiEnabled) {
    sections.push(getAIInstructions());
  }

  // Cross-plugin relationships
  if (config.haEnabled && config.omadaEnabled) {
    sections.push(getCrossPluginInstructions());
  }

  return sections.join(' ');
}

function getHomeAssistantInstructions(): string {
  return [
    // Entity queries
    'ENTITY QUERIES: Entity tools return paginated results (50/page default). Use includeAttributes=true only when full attribute data is needed. For people/family queries, use listPersons instead of searchEntities.',

    // State management
    'STATE: getState returns single entity; getStates returns all entities paginated. Use getDomainSummary for quick counts by domain.',

    // Device control
    'CONTROL: Use specialized control tools (controlLight, controlClimate, controlFan, controlCover, controlMediaPlayer) instead of generic callService when available - they provide better validation and defaults.',

    // Automations
    'AUTOMATIONS: After createAutomation, automations reload automatically. Use listAutomations to verify. triggerAutomation can pass variables to test automations safely.',

    // Notifications
    'NOTIFICATIONS: Use listNotificationTargets to discover available mobile devices before sendNotification. Target format is usually mobile_app_<device_name>.',
  ].join(' ');
}

function getOmadaInstructions(): string {
  return [
    // Site context
    'OMADA: Most Omada tools require siteId. Use omada_listSites first to get available sites if siteId is unknown.',

    // Client vs Device
    'CLIENTS vs DEVICES: Clients are connected users/devices (phones, laptops). Devices are network infrastructure (APs, switches, gateways). Use omada_listClients for user devices, omada_listDevices for infrastructure.',

    // Rate limiting
    'RATE LIMITS: Use omada_getRateLimitProfiles before setting limits. omada_setClientRateLimitProfile applies predefined profiles; omada_setClientRateLimit sets custom Kbps values.',

    // Remote-hands actions (v1.6)
    'ACTIONS: omada_cyclePoePort power-cycles PoE ports (remote-reboots APs/cameras; switch MAC via omada_listDevices). omada_setSsidEnabled toggles an SSID by name (guest WiFi on/off).',

    // Read-only preference
    'SAFETY: Prefer read-only Omada tools. Rate limits, PoE cycling, and SSID toggles affect real availability - confirm with user before applying.',
  ].join(' ');
}

function getAIInstructions(): string {
  return [
    'AI ANALYSIS: analyzeSensors uses local Ollama for privacy-preserving sensor analysis. Pass sensor data as key-value pairs. Useful for anomaly detection and recommendations.',
  ].join(' ');
}

function getCrossPluginInstructions(): string {
  return [
    'INTEGRATION: Network clients from Omada can correlate with HA device_trackers for presence detection. HA person entities link to device_trackers which may correspond to Omada clients.',
  ].join(' ');
}
