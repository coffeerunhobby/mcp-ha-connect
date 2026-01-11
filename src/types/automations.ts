/**
 * Automation-related types for Home Assistant
 */

export interface Automation {
  id: string;
  alias: string;
  state: 'on' | 'off';
  last_triggered: string | null;
  description?: string;
  mode?: 'single' | 'restart' | 'queued' | 'parallel';
}

export interface AutomationTrigger {
  platform: string;
  [key: string]: unknown;
}

export interface AutomationCondition {
  condition: string;
  [key: string]: unknown;
}

export interface AutomationAction {
  service?: string;
  target?: {
    entity_id?: string | string[];
    device_id?: string | string[];
    area_id?: string | string[];
  };
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AutomationConfig {
  id?: string;
  alias: string;
  description?: string;
  mode?: 'single' | 'restart' | 'queued' | 'parallel';
  trigger: AutomationTrigger | AutomationTrigger[];
  condition?: AutomationCondition | AutomationCondition[];
  action: AutomationAction | AutomationAction[];
}
