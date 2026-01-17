/**
 * Permission system tests
 */

import { describe, it, expect } from 'vitest';
import {
  Permission,
  Role,
  getUserPermissions,
  hasPermission,
  getPermissionNames,
  parsePermissionsConfig,
} from '../../src/permissions/index.js';

describe('Permission', () => {
  it('should have correct bit values sorted by criticality', () => {
    expect(Permission.ADMIN).toBe(1);      // Highest criticality
    expect(Permission.CONFIGURE).toBe(2);
    expect(Permission.CONTROL).toBe(4);
    expect(Permission.QUERY).toBe(8);
    expect(Permission.NOTIFY).toBe(16);
    expect(Permission.AI).toBe(32);
  });

  it('should be powers of 2 for bitwise operations', () => {
    const values = Object.values(Permission);
    for (const v of values) {
      expect(Math.log2(v) % 1).toBe(0); // Is power of 2
    }
  });
});

describe('Role', () => {
  it('should have NONE with zero permissions', () => {
    expect(Role.NONE).toBe(0);
  });

  it('should have READONLY with only QUERY', () => {
    expect(Role.READONLY).toBe(Permission.QUERY);
  });

  it('should have OPERATOR with QUERY, CONTROL, NOTIFY', () => {
    expect(hasPermission(Role.OPERATOR, Permission.QUERY)).toBe(true);
    expect(hasPermission(Role.OPERATOR, Permission.CONTROL)).toBe(true);
    expect(hasPermission(Role.OPERATOR, Permission.NOTIFY)).toBe(true);
    expect(hasPermission(Role.OPERATOR, Permission.CONFIGURE)).toBe(false);
    expect(hasPermission(Role.OPERATOR, Permission.AI)).toBe(false);
    expect(hasPermission(Role.OPERATOR, Permission.ADMIN)).toBe(false);
  });

  it('should have CONTRIBUTOR with QUERY, CONTROL, NOTIFY, CONFIGURE', () => {
    expect(hasPermission(Role.CONTRIBUTOR, Permission.QUERY)).toBe(true);
    expect(hasPermission(Role.CONTRIBUTOR, Permission.CONTROL)).toBe(true);
    expect(hasPermission(Role.CONTRIBUTOR, Permission.NOTIFY)).toBe(true);
    expect(hasPermission(Role.CONTRIBUTOR, Permission.CONFIGURE)).toBe(true);
    expect(hasPermission(Role.CONTRIBUTOR, Permission.AI)).toBe(false);
    expect(hasPermission(Role.CONTRIBUTOR, Permission.ADMIN)).toBe(false);
  });

  it('should have ADMIN with all permissions', () => {
    expect(hasPermission(Role.ADMIN, Permission.QUERY)).toBe(true);
    expect(hasPermission(Role.ADMIN, Permission.CONTROL)).toBe(true);
    expect(hasPermission(Role.ADMIN, Permission.NOTIFY)).toBe(true);
    expect(hasPermission(Role.ADMIN, Permission.CONFIGURE)).toBe(true);
    expect(hasPermission(Role.ADMIN, Permission.AI)).toBe(true);
    expect(hasPermission(Role.ADMIN, Permission.ADMIN)).toBe(true);
  });

  it('should have SUPERUSER with 0xFF (all bits)', () => {
    expect(Role.SUPERUSER).toBe(0xFF);
  });
});

describe('hasPermission', () => {
  it('should return true when permission is present', () => {
    const mask = Permission.QUERY | Permission.CONTROL;
    expect(hasPermission(mask, Permission.QUERY)).toBe(true);
    expect(hasPermission(mask, Permission.CONTROL)).toBe(true);
  });

  it('should return false when permission is missing', () => {
    const mask = Permission.QUERY | Permission.CONTROL;
    expect(hasPermission(mask, Permission.ADMIN)).toBe(false);
  });

  it('should check combined permissions', () => {
    const mask = Permission.QUERY | Permission.CONTROL;
    expect(hasPermission(mask, Permission.QUERY | Permission.CONTROL)).toBe(true);
    expect(hasPermission(mask, Permission.QUERY | Permission.ADMIN)).toBe(false);
  });
});

describe('getPermissionNames', () => {
  it('should return empty array for zero mask', () => {
    expect(getPermissionNames(0)).toEqual([]);
  });

  it('should return single permission name', () => {
    expect(getPermissionNames(Permission.QUERY)).toEqual(['QUERY']);
  });

  it('should return multiple permission names', () => {
    const names = getPermissionNames(Permission.QUERY | Permission.CONTROL);
    expect(names).toContain('QUERY');
    expect(names).toContain('CONTROL');
    expect(names).toHaveLength(2);
  });
});

describe('getUserPermissions', () => {
  const config = {
    users: [
      { sub: 'admin', role: 'ADMIN' as const },
      { sub: 'readonly', role: 'READONLY' as const },
      { sub: 'operator', role: 'OPERATOR' as const },
      { sub: 'custom', mask: Permission.QUERY | Permission.AI },
    ],
    defaultRole: 'NONE' as const,
  };

  it('should return role permissions for known user', () => {
    expect(getUserPermissions('admin', config)).toBe(Role.ADMIN);
    expect(getUserPermissions('readonly', config)).toBe(Role.READONLY);
    expect(getUserPermissions('operator', config)).toBe(Role.OPERATOR);
  });

  it('should return custom mask when specified', () => {
    const perms = getUserPermissions('custom', config);
    expect(hasPermission(perms, Permission.QUERY)).toBe(true);
    expect(hasPermission(perms, Permission.AI)).toBe(true);
    expect(hasPermission(perms, Permission.CONTROL)).toBe(false);
  });

  it('should return default role for unknown user', () => {
    expect(getUserPermissions('unknown', config)).toBe(Role.NONE);
  });

  it('should return default role for undefined sub', () => {
    expect(getUserPermissions(undefined, config)).toBe(Role.NONE);
  });

  it('should use default role from config', () => {
    const configWithDefault = { ...config, defaultRole: 'READONLY' as const };
    expect(getUserPermissions('unknown', configWithDefault)).toBe(Role.READONLY);
  });
});

describe('parsePermissionsConfig', () => {
  it('should parse valid JSON', () => {
    const json = '{"users":[{"sub":"admin","role":"ADMIN"}],"defaultRole":"READONLY"}';
    const config = parsePermissionsConfig(json);
    expect(config.users).toHaveLength(1);
    expect(config.users[0].sub).toBe('admin');
    expect(config.defaultRole).toBe('READONLY');
  });

  it('should return empty config for undefined', () => {
    const config = parsePermissionsConfig(undefined);
    expect(config.users).toEqual([]);
    expect(config.defaultRole).toBe('NONE');
  });

  it('should return empty config for invalid JSON', () => {
    const config = parsePermissionsConfig('not valid json');
    expect(config.users).toEqual([]);
    expect(config.defaultRole).toBe('NONE');
  });

  it('should handle missing users array', () => {
    const config = parsePermissionsConfig('{}');
    expect(config.users).toEqual([]);
  });
});
