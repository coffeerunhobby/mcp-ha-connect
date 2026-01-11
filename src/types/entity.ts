export interface Entity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context: {
    id: string;
    parent_id: string | null;
    user_id: string | null;
  };
}

export interface EntityListResponse {
  entities: Entity[];
  total: number;
}

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

export interface DomainSummary {
  domain: string;
  count: number;
  states: Record<string, number>;
  entities: Array<{
    entity_id: string;
    state: string;
    friendly_name?: string;
  }>;
}

export interface HaVersion {
  version: string;
  location_name?: string;
  config_dir?: string;
  time_zone?: string;
  unit_system?: Record<string, string>;
}

export interface LogbookEntry {
  when: string;
  name: string;
  message?: string;
  entity_id?: string;
  state?: string;
  domain?: string;
  context_user_id?: string;
}

export interface UpdateInfo {
  update_type: 'core' | 'supervisor' | 'os' | 'addon';
  name: string;
  version_current: string;
  version_latest: string;
}

export interface SupervisorCoreInfo {
  version: string;
  version_latest?: string;
  update_available?: boolean;
}

export interface SupervisorInfo {
  version: string;
  version_latest?: string;
  update_available?: boolean;
}

export interface SupervisorOsInfo {
  version: string;
  version_latest?: string;
  update_available?: boolean;
}
