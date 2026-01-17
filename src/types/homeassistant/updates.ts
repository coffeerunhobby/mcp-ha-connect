/**
 * Update and supervisor types for Home Assistant
 */

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
