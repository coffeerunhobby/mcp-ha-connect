/**
 * Permission System - Role-based access control with binary masks
 */

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
 * Get permission mask for a user by their JWT sub claim
 */
export function getUserPermissions(sub: string | undefined, config: PermissionsConfig): number {
  if (!sub) {
    return config.defaultRole ? Role[config.defaultRole] : Role.NONE;
  }

  const user = config.users.find((u) => u.sub === sub);
  if (!user) {
    return config.defaultRole ? Role[config.defaultRole] : Role.NONE;
  }

  // Direct mask takes precedence over role
  if (user.mask !== undefined) {
    return user.mask;
  }

  // Convert role to uppercase for lookup (config may have lowercase)
  const roleKey = user.role?.toUpperCase() as RoleName | undefined;
  return roleKey && Role[roleKey] !== undefined ? Role[roleKey] : Role.NONE;
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
  } catch {
    return { users: [], defaultRole: 'NONE' };
  }
}
