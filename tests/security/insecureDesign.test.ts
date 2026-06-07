/**
 * SEC-DESIGN — Insecure Design / Fail-open
 * OWASP A04:2021 (Insecure Design).
 *
 * Findings covered:
 *   L3 — default-allow `?? 0xFF` fallbacks. A tool invocation that arrives with no
 *        permission mask was granted FULL permissions. Secure behavior: fail closed
 *        (deny) unless the transport is the trusted-local stdio path, which opts in
 *        explicitly via setLocalFullTrust().
 *   L1 — automation/script CREATION is effectively arbitrary HA template/shell exec.
 *        Policy: it must remain behind a privileged bit (CONFIGURE), never a read or
 *        plain-control bit. This guard locks that contract so it can't silently
 *        regress to a lower tier.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ToolExtra } from '../../src/tools/common.js';
import { wrapToolHandler, toToolResult, setLocalFullTrust } from '../../src/tools/common.js';
import { Permission, Role, hasPermission } from '../../src/permissions/index.js';

/** Build a ToolExtra; pass `undefined` to omit the permission mask entirely. */
function extraWith(permissions?: number): ToolExtra {
  return {
    sessionId: 'test-session',
    signal: new AbortController().signal,
    requestId: 1,
    authInfo:
      permissions !== undefined
        ? { token: 't', clientId: 'c', scopes: [], extra: { permissions } }
        : undefined,
  } as unknown as ToolExtra;
}

describe('SEC-DESIGN — Insecure Design / Fail-open', () => {
  // The local-trust flag is process-global; never let a test leak it.
  afterEach(() => setLocalFullTrust(false));

  describe('L3: missing permission mask fails closed', () => {
    it('denies a privileged tool when no authInfo is present (HTTP anomaly)', async () => {
      const handler = vi.fn().mockResolvedValue(toToolResult('ok'));
      const wrapped = wrapToolHandler('dangerTool', handler, Permission.ADMIN);

      const result = await wrapped({}, extraWith(undefined));

      expect(handler).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain('Permission denied');
    });

    it('denies even a QUERY-only tool when no mask is present', async () => {
      const handler = vi.fn().mockResolvedValue(toToolResult('ok'));
      const wrapped = wrapToolHandler('readTool', handler, Permission.QUERY);

      const result = await wrapped({}, extraWith(undefined));

      expect(handler).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });

    it('still enforces an explicit insufficient mask (regression guard)', async () => {
      const handler = vi.fn().mockResolvedValue(toToolResult('ok'));
      const wrapped = wrapToolHandler('dangerTool', handler, Permission.ADMIN);

      const result = await wrapped({}, extraWith(Permission.QUERY));

      expect(handler).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });
  });

  describe('L3: stdio local-trust opt-in', () => {
    it('grants full permissions for no-auth calls ONLY when local trust is enabled', async () => {
      const handler = vi.fn().mockResolvedValue(toToolResult('ok'));
      const wrapped = wrapToolHandler('dangerTool', handler, Permission.ADMIN);

      setLocalFullTrust(true);
      const result = await wrapped({}, extraWith(undefined));

      expect(handler).toHaveBeenCalledOnce();
      expect(result.isError).toBe(false);
    });

    it('reverts to fail-closed once local trust is turned back off', async () => {
      const handler = vi.fn().mockResolvedValue(toToolResult('ok'));
      const wrapped = wrapToolHandler('dangerTool', handler, Permission.ADMIN);

      setLocalFullTrust(true);
      setLocalFullTrust(false);
      const result = await wrapped({}, extraWith(undefined));

      expect(handler).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });
  });

  describe('L1: automation/script creation stays behind a privileged bit', () => {
    it('CONFIGURE (the createAutomation gate) is NOT granted by read/operator roles', () => {
      // createAutomation is registered with Permission.CONFIGURE. Document & lock that
      // this bit represents code-exec-equivalent power: it must not leak into the
      // low-privilege roles a typical read/control token would carry.
      expect(hasPermission(Role.READONLY, Permission.CONFIGURE)).toBe(false);
      expect(hasPermission(Role.OPERATOR, Permission.CONFIGURE)).toBe(false);

      // Only the explicitly-privileged roles include it.
      expect(hasPermission(Role.CONTRIBUTOR, Permission.CONFIGURE)).toBe(true);
      expect(hasPermission(Role.ADMIN, Permission.CONFIGURE)).toBe(true);
    });

    it('a CONFIGURE gate denies an OPERATOR token but allows a CONTRIBUTOR token', async () => {
      const handler = vi.fn().mockResolvedValue(toToolResult('created'));
      const wrapped = wrapToolHandler('createAutomation', handler, Permission.CONFIGURE);

      const denied = await wrapped({}, extraWith(Role.OPERATOR));
      expect(handler).not.toHaveBeenCalled();
      expect(denied.isError).toBe(true);

      const allowed = await wrapped({}, extraWith(Role.CONTRIBUTOR));
      expect(handler).toHaveBeenCalledOnce();
      expect(allowed.isError).toBe(false);
    });
  });
});
