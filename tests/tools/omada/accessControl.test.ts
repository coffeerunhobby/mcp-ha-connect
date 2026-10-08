/**
 * Access control tools: registration per mode and permissions (writes need CONFIGURE).
 */

import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import type { OmadaClient } from '../../../src/omadaClient/index.js';
import { registerOmadaAccessControlTools } from '../../../src/tools/omada/accessControl.js';
import { Permission } from '../../../src/permissions/index.js';

type Handler = (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function setup(mode: 'eager' | 'graph' = 'eager') {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: vi.fn((name: string, _config: unknown, handler: Handler) => handlers.set(name, handler)) } as unknown as McpServer;
  const accessControl = {
    listTimeRanges: vi.fn(async () => [{ profileId: 'tr-1', name: 'Curfew', windows: ['mon 00:00-14:30'] }]),
    listIpGroups: vi.fn(async () => [{ groupId: 'ip-any', name: 'IPGroup_Any', ipList: [{ ip: '0.0.0.0', mask: 0 }] }]),
    listGatewayAcls: vi.fn(async () => [{ id: 'acl-1' }]),
    describeAcl: vi.fn(async () => ({ id: 'acl-1', description: 'Curfew laptop' })),
    createTimeRange: vi.fn(async () => ({ profileId: 'tr-new' })),
    createGatewayAcl: vi.fn(async () => ({ id: 'acl-new' })),
    updateGatewayAcl: vi.fn(async () => ({ id: 'acl-1', enabled: false })),
    setSsidMacFilter: vi.fn(async () => ({ applied: false })),
    setDhcpReservation: vi.fn(async () => ({ action: 'created' })),
  };
  const count = registerOmadaAccessControlTools(server, { accessControl } as unknown as OmadaClient, mode);
  return { handlers, accessControl, count };
}

const as = (permissions: number) => ({ sessionId: 'test', http: { authInfo: { extra: { permissions } } } });
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe('Omada access control tools', () => {
  it('registers 13 tools in eager mode and leaves the listing to omada_read in graph mode', () => {
    const eager = setup();
    const graph = setup('graph');

    expect(eager.count).toBe(13);
    expect(eager.handlers.size).toBe(13);
    expect(graph.count).toBe(12);
    expect(graph.handlers.has('omada_listAccessControl')).toBe(false);
  });

  it('lists with QUERY', async () => {
    const { handlers } = setup();

    const result = parse(await handlers.get('omada_listAccessControl')!({}, as(Permission.QUERY)));

    expect(result).toEqual({
      timeRanges: [{ profileId: 'tr-1', name: 'Curfew', windows: ['mon 00:00-14:30'] }],
      ipGroups: [{ groupId: 'ip-any', name: 'IPGroup_Any', ips: ['0.0.0.0/0'] }],
      gatewayAcls: [{ id: 'acl-1', description: 'Curfew laptop' }],
    });
  });

  it.each([
    ['omada_createTimeRange', { name: 'Curfew', windows: [{ days: ['mon'], start: '14:30', end: '19:00' }], invertWindows: true }, 'createTimeRange'],
    ['omada_createGatewayAcl', { description: 'Curfew laptop', policy: 'deny', source: { type: 'ipGroup', ids: ['Laptop'] }, timeRange: 'Curfew' }, 'createGatewayAcl'],
    ['omada_updateGatewayAcl', { acl: 'Curfew laptop', enabled: false }, 'updateGatewayAcl'],
    ['omada_setDhcpReservation', { clientMac: '02-1A-2B-3C-4D-5E', ip: '10.0.0.60' }, 'setDhcpReservation'],
    ['omada_setSsidMacFilter', { ssid: 'home-wifi', enabled: true, policy: 'allow', group: 'KnownWiFi', dryRun: true }, 'setSsidMacFilter'],
  ] as const)('%s needs CONFIGURE', async (tool, args, method) => {
    const { handlers, accessControl } = setup();

    const denied = await handlers.get(tool)!(args, as(Permission.QUERY | Permission.CONTROL));
    expect(denied.isError).toBe(true);
    expect(accessControl[method]).not.toHaveBeenCalled();

    const allowed = await handlers.get(tool)!(args, as(Permission.CONFIGURE));
    expect(allowed.isError).toBeFalsy();
    expect(accessControl[method]).toHaveBeenCalledTimes(1);
  });

  it('passes the curfew arguments through', async () => {
    const { handlers, accessControl } = setup();

    await handlers.get('omada_createTimeRange')!(
      { name: 'Curfew', windows: [{ days: ['sat'], start: '09:00', end: '19:00' }], invertWindows: true, siteId: 's' },
      as(Permission.CONFIGURE)
    );
    await handlers.get('omada_updateGatewayAcl')!({ acl: 'Curfew laptop', timeRange: null, siteId: 's' }, as(Permission.CONFIGURE));

    expect(accessControl.createTimeRange).toHaveBeenCalledWith('Curfew', [{ days: ['sat'], start: '09:00', end: '19:00' }], { invert: true, siteId: 's' });
    expect(accessControl.updateGatewayAcl).toHaveBeenCalledWith('Curfew laptop', { timeRange: null }, 's');
  });
});
