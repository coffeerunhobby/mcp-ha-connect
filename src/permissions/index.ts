/**
 * Permission System - Role-based access control with binary masks
 */

import { logger } from '../utils/logger.js';

/** Permission flags (powers of 2 for bitwise operations, sorted by criticality) */
export const Permission = {
  ADMIN: 1,      // System operations (restart, updates) - highest criticality
  CONFIGURE: 2,  // Create/modify automations, scripts
  CONTROL: 4,    // Control devices (lights, climate, etc.)
  QUERY: 8,      // Read entity states, history, lists
  NOTIFY: 16,    // Send notifications
  AI: 32,        // Use AI analysis features
} as const;

export type PermissionFlag = (typeof Permission)[keyof typeof Permission];

/** Role presets (combinations of permissions) */
export const Role = {
  NONE: 0,
  READONLY: Permission.QUERY,
  OPERATOR: Permission.QUERY | Permission.CONTROL | Permission.NOTIFY,
  CONTRIBUTOR: Permission.QUERY | Permission.CONTROL | Permission.NOTIFY | Permission.CONFIGURE,
  ADMIN: Permission.QUERY | Permission.CONTROL | Permission.NOTIFY | Permission.CONFIGURE | Permission.AI | Permission.ADMIN,
  SUPERUSER: 0xFF, // All permissions
} as const;

export type RoleName = keyof typeof Role;

/** User permission mapping from config */
export interface UserPermission {
  sub: string;
  role?: RoleName;
  mask?: number; // Direct mask override
}

export interface PermissionsConfig {
  users: UserPermission[];
  defaultRole?: RoleName;
}

/**
 * Resolve a role name to its permission mask, case-insensitively.
 *
 * Config (and JSON) commonly use lowercase role names ("operator") while the
 * `Role` map is keyed uppercase ("OPERATOR"). Normalize here so BOTH the per-user
 * role and the `defaultRole` fall-back resolve consistently. An unknown/undefined
 * name fails closed to `Role.NONE` (never `undefined`, which downstream coerces to
 * a zero mask anyway but is easy to mishandle).
 */
function resolveRoleName(name: string | undefined): number {
  if (!name) {
    return Role.NONE;
  }
  const key = name.toUpperCase() as RoleName;
  return Role[key] ?? Role.NONE;
}

/**
 * Get permission mask for a user by their JWT sub claim
 */
export function getUserPermissions(sub: string | undefined, config: PermissionsConfig): number {
  const fallback = resolveRoleName(config.defaultRole);

  if (!sub) {
    return fallback;
  }

  const user = config.users.find((u) => u.sub === sub);
  if (!user) {
    return fallback;
  }

  // Direct mask takes precedence over role
  if (user.mask !== undefined) {
    return user.mask;
  }

  return resolveRoleName(user.role);
}

/**
 * Check if a permission mask includes required permission
 */
export function hasPermission(userMask: number, required: number): boolean {
  return (userMask & required) === required;
}

/**
 * Get human-readable permission names from mask
 */
export function getPermissionNames(mask: number): string[] {
  const names: string[] = [];
  for (const [name, flag] of Object.entries(Permission)) {
    if ((mask & flag) === flag) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Parse permissions config from environment JSON
 */
export function parsePermissionsConfig(json: string | undefined): PermissionsConfig {
  if (!json) {
    return { users: [], defaultRole: 'NONE' };
  }

  try {
    const parsed = JSON.parse(json);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      defaultRole: parsed.defaultRole ?? 'NONE',
    };
  } catch (error) {
    // Fail closed (empty config → every caller resolves to NONE), but make the
    // misconfiguration loud: a silent all-NONE is otherwise very hard to diagnose.
    logger.warn('MCP_PERMISSIONS_CONFIG is not valid JSON — ignoring it; all callers resolve to NONE (fail-closed)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { users: [], defaultRole: 'NONE' };
  }
}
