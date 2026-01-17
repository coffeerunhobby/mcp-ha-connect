/**
 * Common tool utilities tests
 */

import { describe, it, expect, vi } from 'vitest';
import { wrapToolHandler, toToolResult, Permission } from '../../src/tools/common.js';
import type { ToolExtra } from '../../src/tools/common.js';

describe('toToolResult', () => {
  it('should convert string to text content', () => {
    const result = toToolResult('hello');
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result.isError).toBe(false);
  });

  it('should convert object to JSON text content', () => {
    const result = toToolResult({ foo: 'bar' });
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ foo: 'bar' });
  });

  it('should set isError when specified', () => {
    const result = toToolResult('error', true);
    expect(result.isError).toBe(true);
  });
});

describe('wrapToolHandler permission checks', () => {
  // Helper to create ToolExtra with permissions in authInfo.extra (MCP SDK format)
  const createExtra = (permissions?: number): ToolExtra => ({
    sessionId: 'test-session',
    signal: new AbortController().signal,
    requestId: 1,
    authInfo: permissions !== undefined ? {
      token: 'test-token',
      clientId: 'test-client',
      scopes: [],
      extra: { permissions },
    } : undefined,
  });

  it('should allow access when user has required permission', async () => {
    const handler = vi.fn().mockResolvedValue(toToolResult('success'));
    const wrapped = wrapToolHandler('testTool', handler, Permission.QUERY);

    const extra = createExtra(Permission.QUERY);
    const result = await wrapped({}, extra);

    expect(handler).toHaveBeenCalled();
    expect(result.isError).toBe(false);
  });

  it('should deny access when user lacks required permission', async () => {
    const handler = vi.fn().mockResolvedValue(toToolResult('success'));
    const wrapped = wrapToolHandler('testTool', handler, Permission.ADMIN);

    const extra = createExtra(Permission.QUERY); // Only QUERY, not ADMIN
    const result = await wrapped({}, extra);

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Permission denied');
    expect(text).toContain('ADMIN');
  });

  it('should allow access with combined permissions', async () => {
    const handler = vi.fn().mockResolvedValue(toToolResult('success'));
    const wrapped = wrapToolHandler('testTool', handler, Permission.CONTROL);

    // User has QUERY | CONTROL | NOTIFY
    const extra = createExtra(Permission.QUERY | Permission.CONTROL | Permission.NOTIFY);
    const result = await wrapped({}, extra);

    expect(handler).toHaveBeenCalled();
    expect(result.isError).toBe(false);
  });

  it('should default to full permissions when authInfo not set', async () => {
    const handler = vi.fn().mockResolvedValue(toToolResult('success'));
    const wrapped = wrapToolHandler('testTool', handler, Permission.ADMIN);

    // No authInfo set should default to 0xFF (full permissions)
    const extra = createExtra(undefined);
    const result = await wrapped({}, extra);

    expect(handler).toHaveBeenCalled();
    expect(result.isError).toBe(false);
  });

  it('should allow access when no permission required', async () => {
    const handler = vi.fn().mockResolvedValue(toToolResult('success'));
    const wrapped = wrapToolHandler('testTool', handler); // No permission required

    const extra = createExtra(0); // No permissions
    const result = await wrapped({}, extra);

    expect(handler).toHaveBeenCalled();
    expect(result.isError).toBe(false);
  });

  it('should catch and handle errors from handler', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('Something went wrong'));
    const wrapped = wrapToolHandler('testTool', handler, Permission.QUERY);

    const extra = createExtra(Permission.QUERY);
    const result = await wrapped({}, extra);

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Something went wrong');
  });
});

describe('Permission values', () => {
  it('should have correct bit values sorted by criticality', () => {
    expect(Permission.ADMIN).toBe(1);      // Highest criticality
    expect(Permission.CONFIGURE).toBe(2);
    expect(Permission.CONTROL).toBe(4);
    expect(Permission.QUERY).toBe(8);
    expect(Permission.NOTIFY).toBe(16);
    expect(Permission.AI).toBe(32);
  });
});
