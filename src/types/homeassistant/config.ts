/**
 * Home Assistant configuration and version types
 * Note: Only safe, public information - sensitive fields are filtered out
 */

export interface HaVersion {
  version: string;
  location_name?: string;
  time_zone?: string;
  unit_system?: Record<string, string>;
  // Excluded for privacy/security: config_dir, components, allowlist_external_dirs,
  // allowlist_external_urls, state, external_url, internal_url, latitude, longitude,
  // elevation, currency, country, language
}
