/**
 * Tool layer for omada_diagnoseClient and the MAC group tools: registration,
 * per-tool permissions, ADMIN-only audit, and the SSID effects of a change.
 */

import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import type { OmadaClient } from '../../../src/omadaClient/index.js';
import { registerOmadaClientDiagnosticTools } from '../../../src/tools/omada/macGroups.js';
import { Permission } from '../../../src/permissions/index.js';

type Handler = (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function createMockServer() {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: vi.fn((name: string, _config: unknown, handler: Handler) => handlers.set(name, handler)) };
  return { server: server as unknown as McpServer, handlers };
}

const MAC = '4C-1D-96-8D-37-C7';
const groups = [{ groupId: 'g1', name: 'KnownWiFi', type: 2, macAddressList: [{ name: 'tv', macAddress: 'AA-BB-CC-DD-EE-01' }] }];

function createMockClient(policy = 1) {
  return {
    listClients: vi.fn(async () => []),
    listKnownClients: vi.fn(async () => []),
    listMacGroups: vi.fn(async () => groups),
    getWlanGroupList: vi.fn(async () => [{ wlanId: 'w1' }]),
    getSsidList: vi.fn(async () => [{ ssidId: 's1', name: 'Home' }]),
    getSsidDetail: vi.fn(async () => ({ name: 'Home', macFilter: { macFilterEnable: true, policy, macFilterId: 'g1' } })),
    readResource: vi.fn(async () => ({ data: [] })),
    setMacGroupEntry: vi.fn(async () => ({ group: { groupId: 'g1', name: 'KnownWiFi' }, mac: MAC, action: 'added', entries: { before: 1, after: 2 } })),
    removeMacGroupEntry: vi.fn(async () => ({ group: { groupId: 'g1', name: 'KnownWiFi' }, mac: MAC, action: 'removed', entries: { before: 2, after: 1 } })),
  };
}

const as = (permissions: number) => ({ sessionId: 'test', http: { authInfo: { extra: { permissions } } } });
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe('Omada client diagnostic tools', () => {
  it('registers four tools in eager mode and leaves listing to omada_read in graph mode', () => {
    const eager = createMockServer();
    const graph = createMockServer();

    expect(registerOmadaClientDiagnosticTools(eager.server, createMockClient() as unknown as OmadaClient)).toBe(4);
    expect(registerOmadaClientDiagnosticTools(graph.server, createMockClient() as unknown as OmadaClient, 'graph')).toBe(3);
    expect([...eager.handlers.keys()]).toEqual(['omada_diagnoseClient', 'omada_listMacGroups', 'omada_setMacGroupEntry', 'omada_removeMacGroupEntry']);
    expect(graph.handlers.has('omada_listMacGroups')).toBe(false);
  });

  it('diagnoses with QUERY and reads the audit log only for ADMIN', async () => {
    const { server, handlers } = createMockServer();
    const client = createMockClient();
    registerOmadaClientDiagnosticTools(server, client as unknown as OmadaClient);
    const diagnose = handlers.get('omada_diagnoseClient')!;
    const auditCalls = () => client.readResource.mock.calls.filter(([o]) => (o as { pathTemplate: string }).pathTemplate.endsWith('/audit-logs')).length;

    const query = await diagnose({ clientMac: MAC }, as(Permission.QUERY));
    expect(query.isError).toBeFalsy();
    expect(parse(query).auditEntries).toBeUndefined();
    expect(auditCalls()).toBe(0);

    const admin = await diagnose({ clientMac: MAC }, as(Permission.QUERY | Permission.ADMIN));
    expect(parse(admin).auditEntries).toEqual([]);
    expect(auditCalls()).toBe(1);

    expect((await diagnose({ clientMac: MAC }, as(Permission.CONTROL))).isError).toBe(true);
  });

  it('lists groups with the SSIDs that use them', async () => {
    const { server, handlers } = createMockServer();
    registerOmadaClientDiagnosticTools(server, createMockClient() as unknown as OmadaClient);

    const result = parse(await handlers.get('omada_listMacGroups')!({}, as(Permission.QUERY)));

    expect(result).toEqual([
      { groupId: 'g1', name: 'KnownWiFi', builtIn: false, entries: [{ name: 'tv', mac: 'AA-BB-CC-DD-EE-01' }], usedBy: [{ ssid: 'Home', policy: 'allow', enabled: true }] },
    ]);
  });

  it('requires CONFIGURE to change a group', async () => {
    const { server, handlers } = createMockServer();
    const client = createMockClient();
    registerOmadaClientDiagnosticTools(server, client as unknown as OmadaClient);

    expect((await handlers.get('omada_setMacGroupEntry')!({ group: 'KnownWiFi', clientMac: MAC, name: 'x' }, as(Permission.QUERY))).isError).toBe(true);
    expect((await handlers.get('omada_removeMacGroupEntry')!({ group: 'KnownWiFi', clientMac: MAC }, as(Permission.QUERY | Permission.CONTROL))).isError).toBe(true);
    expect(client.setMacGroupEntry).not.toHaveBeenCalled();
    expect(client.removeMacGroupEntry).not.toHaveBeenCalled();
  });

  it.each([
    [1, 'omada_setMacGroupEntry', 'Home: allow list, so the device can join'],
    [1, 'omada_removeMacGroupEntry', 'Home: allow list, so the device can no longer join'],
    [0, 'omada_setMacGroupEntry', 'Home: deny list, so the device is shut out'],
    [0, 'omada_removeMacGroupEntry', 'Home: deny list, so the device is no longer shut out'],
  ])('explains the effect on SSIDs (policy %i, %s)', async (policy, tool, effect) => {
    const { server, handlers } = createMockServer();
    const client = createMockClient(policy);
    registerOmadaClientDiagnosticTools(server, client as unknown as OmadaClient);

    const result = parse(await handlers.get(tool)!({ group: 'KnownWiFi', clientMac: MAC, name: 'phone' }, as(Permission.CONFIGURE)));

    expect(result.effects).toEqual([effect]);
  });

  it.each([
    [1, 'Home: allow list, so the device is not on it and cannot join'],
    [0, 'Home: deny list, so the device is not on it and is not shut out by it'],
  ])('describes removing a MAC that was not in the group (policy %i)', async (policy, effect) => {
    const { server, handlers } = createMockServer();
    const client = createMockClient(policy);
    client.removeMacGroupEntry.mockResolvedValue({ group: { groupId: 'g1', name: 'KnownWiFi' }, mac: MAC, action: 'not-present', entries: { before: 1, after: 1 } });
    registerOmadaClientDiagnosticTools(server, client as unknown as OmadaClient);

    const result = parse(await handlers.get('omada_removeMacGroupEntry')!({ group: 'KnownWiFi', clientMac: MAC }, as(Permission.CONFIGURE)));

    expect(result.effects).toEqual([effect]);
  });

  it('still reports the change when SSID usage cannot be read', async () => {
    const { server, handlers } = createMockServer();
    const client = createMockClient();
    client.getWlanGroupList.mockRejectedValue(new Error('down'));
    registerOmadaClientDiagnosticTools(server, client as unknown as OmadaClient);

    const result = parse(await handlers.get('omada_setMacGroupEntry')!({ group: 'KnownWiFi', clientMac: MAC, name: 'phone' }, as(Permission.CONFIGURE)));

    expect(result).toMatchObject({ action: 'added', effects: ['Could not read which SSIDs use this group.'] });
  });
});
