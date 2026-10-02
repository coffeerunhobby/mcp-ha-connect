/**
 * tools/list is filtered by the caller's permission mask.
 *
 * A caller is only offered tools it can actually use, so an LLM client does not
 * plan around (or learn about) admin tools it would be denied. Execution-time
 * RBAC in wrapToolHandler is unchanged and still enforced.
 */

import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server/common.js';
import { Role, Permission } from '../../src/permissions/index.js';
import { getToolRequiredPermission } from '../../src/tools/common.js';

// Registration never calls the HA client; a stub is enough to register HA tools.
const haClient = {} as never;

async function listToolNames(callerPermissions: number | undefined): Promise<string[]> {
  const server = createServer({ haClient, callerPermissions });
  const client = new Client({ name: 'visibility-test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

describe('tools/list visibility by caller permissions', () => {
  it('lists every tool when no caller mask is given (stdio local trust)', async () => {
    const all = await listToolNames(undefined);
    expect(all).toContain('restartHomeAssistant');
    expect(all).toContain('controlLight');
    expect(all).toContain('getState');
  });

  it('a full-permission caller sees the same list as unfiltered', async () => {
    expect(await listToolNames(0xff)).toEqual(await listToolNames(undefined));
  });

  it('a READONLY caller sees only tools it is permitted to call', async () => {
    const all = await listToolNames(undefined);
    const visible = await listToolNames(Role.READONLY);

    expect(visible).toContain('getState');
    expect(visible).not.toContain('controlLight');
    expect(visible).not.toContain('restartHomeAssistant');
    expect(visible).not.toContain('deleteAutomation');
    expect(visible.length).toBeLessThan(all.length);

    // Every hidden tool really is one the caller would be denied, and every
    // visible tool with a static bit is one the caller holds.
    for (const name of all) {
      const required = getToolRequiredPermission(name);
      const permitted = required === undefined || (Role.READONLY & required) === required;
      expect(visible.includes(name), `${name} visibility`).toBe(permitted);
    }
  });

  it('an OPERATOR caller sees control tools but not admin/configure tools', async () => {
    const visible = await listToolNames(Role.OPERATOR);
    expect(visible).toContain('controlLight');
    expect(visible).toContain('sendNotification');
    expect(visible).not.toContain('restartHomeAssistant');
    expect(visible).not.toContain('createAutomation');
  });

  it('a caller with no permissions sees no permission-gated tools', async () => {
    const visible = await listToolNames(Role.NONE);
    for (const name of visible) {
      expect(getToolRequiredPermission(name), `${name} should not be listed for NONE`).toBeUndefined();
    }
  });

  it('a hidden tool cannot be called either', async () => {
    const server = createServer({ haClient, callerPermissions: Permission.QUERY });
    const client = new Client({ name: 'visibility-test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const outcome = await client
        .callTool({ name: 'restartHomeAssistant', arguments: {} })
        .then((r) => (r.isError ? 'error-result' : 'success'), () => 'rejected');
      expect(outcome).not.toBe('success');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
