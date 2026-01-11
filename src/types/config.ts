/**
 * Home Assistant configuration and version types
 */

export interface HaVersion {
  version: string;
  location_name?: string;
  config_dir?: string;
  time_zone?: string;
  unit_system?: Record<string, string>;
}
