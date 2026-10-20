/**
 * net_* tools: registration, permissions (lists QUERY, writes CONFIGURE), dry run vs
 * apply, and how inputs become model changes.
 */

import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';

import { createNetworkSchema, createRuleSchema, registerNetTools, updateNetworkSchema, updateRuleSchema } from '../../../src/tools/net/index.js';
import { NetError, type NetworkController, type Plan } from '../../../src/net/model.js';
import { Permission } from '../../../src/permissions/index.js';

type Handler = (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function setup() {
  const handlers = new Map<string, Handler>();
  const server = { registerTool: vi.fn((name: string, _c: unknown, h: Handler) => handlers.set(name, h)) } as unknown as McpServer;
  const plan: Plan = {
    change: { op: 'delete', kind: 'wifi', ref: { name: 'x' } },
    vendor: 'omada',
    steps: [{ action: 'delete', object: 'omada.ssid', name: 'x' }],
    effects: ['gone'],
    wouldLockOut: [{ mac: '02-00-00-00-00-01', name: 'phone', online: true }],
    basis: 'abc',
  };
  const controller = {
    id: 'omada:default',
    vendor: 'omada',
    capabilities: vi.fn(async () => ({ vendor: 'omada' })),
    listNetworks: vi.fn(async () => [{ id: 'n1', name: 'Default' }]),
    listWifi: vi.fn(async () => []),
    listRules: vi.fn(async () => [{ id: 'acl-1', name: 'IoT to Home' }]),
    listGroups: vi.fn(async () => []),
    plan: vi.fn(async () => plan),
    apply: vi.fn(async () => ({ applied: true, owned: [], object: { id: 'n2', name: 'IoT' } })),
  } as unknown as NetworkController & { plan: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn> };
  const count = registerNetTools(server, controller);
  return { handlers, controller, count };
}

const as = (permissions: number) => ({ sessionId: 's', http: { authInfo: { extra: { permissions } } } });
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe('net tools', () => {
  it('registers fifteen tools', () => {
    const { handlers, count } = setup();

    expect(count).toBe(15);
    expect([...handlers.keys()]).toEqual([
      'net_capabilities', 'net_listNetworks', 'net_listWifi', 'net_createNetwork', 'net_updateNetwork', 'net_deleteNetwork', 'net_createWifi', 'net_updateWifi', 'net_deleteWifi',
      'net_listRules', 'net_listGroups', 'net_createRule', 'net_updateRule', 'net_deleteRule', 'net_moveRule',
    ]);
  });

  it('lists with QUERY; writes need CONFIGURE', async () => {
    const { handlers, controller } = setup();

    expect((await handlers.get('net_listNetworks')!({}, as(Permission.QUERY))).isError).toBeFalsy();
    const denied = await handlers.get('net_deleteWifi')!({ wifi: 'x' }, as(Permission.QUERY | Permission.CONTROL));
    expect(denied.isError).toBe(true);
    expect(controller.plan).not.toHaveBeenCalled();
  });

  it('dry run returns the plan and applies nothing', async () => {
    const { handlers, controller } = setup();

    const result = parse(await handlers.get('net_deleteWifi')!({ wifi: 'x', dryRun: true }, as(Permission.CONFIGURE)));

    expect(result).toEqual({
      dryRun: true,
      controller: 'omada',
      steps: [{ action: 'delete', object: 'omada.ssid', name: 'x' }],
      effects: ['gone'],
      wouldLockOut: [{ mac: '02-00-00-00-00-01', name: 'phone' }],
      note: 'Applying needs allowLockout: these online devices would be disconnected.',
    });
    expect(controller.apply).not.toHaveBeenCalled();
  });

  it('applies with allowLockout passed through', async () => {
    const { handlers, controller } = setup();

    const result = parse(await handlers.get('net_deleteWifi')!({ wifi: 'x', allowLockout: true }, as(Permission.CONFIGURE)));

    expect(controller.apply).toHaveBeenCalledWith(expect.objectContaining({ basis: 'abc' }), { allowLockout: true });
    expect(result).toMatchObject({ applied: true, controller: 'omada:default', result: { name: 'IoT' } });
  });

  it('turns inputs into model changes with defaults, and never takes a password', async () => {
    const { handlers, controller } = setup();

    await handlers.get('net_createWifi')!({ name: 'iot-wifi', network: 'IoT', dryRun: true }, as(Permission.CONFIGURE));
    await handlers.get('net_updateWifi')!({ wifi: 'home', macFilter: null, newTemporaryPassword: true, dryRun: true }, as(Permission.CONFIGURE));
    await handlers.get('net_createNetwork')!(
      { name: 'Untrusted', vlan: 3, gateway: '10.0.3.1/24', dhcp: { enabled: true, from: '10.0.3.100', to: '10.0.3.200' }, dryRun: true },
      as(Permission.CONFIGURE)
    );

    expect(controller.plan.mock.calls.map((c) => c[0])).toEqual([
      {
        op: 'create',
        kind: 'wifi',
        value: { name: 'iot-wifi', network: { name: 'IoT' }, bands: ['2.4', '5'], security: 'wpa2', pmf: 'optional', clientIsolation: false, hidden: false, fastRoaming: false, macFilter: null, enabled: true },
        passphrase: { kind: 'temporary' },
      },
      { op: 'update', kind: 'wifi', value: { ref: { name: 'home' }, set: { macFilter: null } }, passphrase: { kind: 'temporary' } },
      {
        op: 'create',
        kind: 'network',
        value: { name: 'Untrusted', purpose: 'normal', vlan: 3, gateway: '10.0.3.1/24', dhcp: { enabled: true, range: { from: '10.0.3.100', to: '10.0.3.200' } }, ipv6: false, isolated: false },
      },
    ]);
  });

  it('refuses a DHCP range given with only one end', () => {
    expect(updateNetworkSchema.safeParse({ network: 'Lab', dhcp: { enabled: true, from: '10.0.70.150' } }).success).toBe(false);
    expect(createNetworkSchema.safeParse({ name: 'X', vlan: 5, dhcp: { enabled: true, to: '10.0.5.20' } }).success).toBe(false);
    expect(updateNetworkSchema.safeParse({ network: 'Lab', dhcp: { enabled: true, leaseMinutes: 60 } }).success).toBe(true);
    expect(updateNetworkSchema.safeParse({ network: 'Lab', dhcp: { enabled: true, from: '10.0.70.150', to: '10.0.70.160' } }).success).toBe(true);
  });

  it('reports a refusal as a tool error with its message', async () => {
    const { handlers, controller } = setup();
    controller.plan.mockRejectedValueOnce(new NetError('PROTECTED', "'Default' carries the controller"));

    const result = await handlers.get('net_deleteNetwork')!({ network: 'Default' }, as(Permission.CONFIGURE));

    expect(result.isError).toBe(true);
    expect(parse(result).message).toMatch(/carries the controller/);
  });

  it('turns a rule into a stateful, always-on model change with defaults', async () => {
    const { handlers, controller } = setup();

    await handlers.get('net_createRule')!(
      { name: 'IoT to HA', action: 'allow', from: [{ network: 'IoT' }], to: [{ addresses: ['192.168.0.19'] }], protocol: { tcpUdpPorts: '1883, 8123' }, position: 1, dryRun: true },
      as(Permission.CONFIGURE)
    );
    await handlers.get('net_createRule')!({ name: 'Lab offline', action: 'block', from: [{ group: 'lab-pcs' }], to: [{ internet: true }], dryRun: true }, as(Permission.CONFIGURE));

    expect(controller.plan.mock.calls[0][0]).toEqual({
      op: 'create',
      kind: 'rule',
      value: {
        name: 'IoT to HA',
        action: 'allow',
        from: [{ network: { name: 'IoT' } }],
        to: [{ addresses: ['192.168.0.19'] }],
        protocol: { tcpUdpPorts: '1883, 8123' },
        replies: 'allow',
        schedule: { kind: 'always' },
        enabled: true,
        position: 1,
      },
    });
    expect(controller.plan.mock.calls[1][0].value).toMatchObject({ from: [{ group: { name: 'lab-pcs' } }], to: [{ internet: true }], protocol: 'any', enabled: true });
    expect(controller.plan.mock.calls[1][0].value).not.toHaveProperty('position');
    expect(controller.apply).not.toHaveBeenCalled();
  });

  it('passes only the fields an update names, and maps delete and move', async () => {
    const { handlers, controller } = setup();

    await handlers.get('net_updateRule')!({ rule: 'IoT to HA', enabled: false, position: 2, dryRun: true }, as(Permission.CONFIGURE));
    await handlers.get('net_deleteRule')!({ rule: 'IoT to HA', dryRun: true }, as(Permission.CONFIGURE));
    await handlers.get('net_moveRule')!({ rule: 'IoT to HA', position: 1, dryRun: true }, as(Permission.CONFIGURE));

    expect(controller.plan.mock.calls.map((c) => c[0])).toEqual([
      { op: 'update', kind: 'rule', value: { ref: { name: 'IoT to HA' }, set: { enabled: false, position: 2 } } },
      { op: 'delete', kind: 'rule', ref: { name: 'IoT to HA' } },
      { op: 'move', kind: 'rule', ref: { name: 'IoT to HA' }, position: 1 },
    ]);
  });

  it('lists rules and groups with QUERY; rule changes need CONFIGURE', async () => {
    const { handlers, controller } = setup();

    expect(parse(await handlers.get('net_listRules')!({}, as(Permission.QUERY)))).toEqual([{ id: 'acl-1', name: 'IoT to Home' }]);
    expect((await handlers.get('net_listGroups')!({ kind: 'address' }, as(Permission.QUERY))).isError).toBeFalsy();
    expect(controller.listGroups).toHaveBeenCalledWith('address');
    for (const [tool, args] of [
      ['net_createRule', { name: 'x', action: 'block', from: [{ network: 'IoT' }], to: [{ internet: true }] }],
      ['net_updateRule', { rule: 'x', enabled: false }],
      ['net_deleteRule', { rule: 'x' }],
      ['net_moveRule', { rule: 'x', position: 1 }],
    ] as const) {
      expect((await handlers.get(tool)!(args, as(Permission.QUERY | Permission.CONTROL))).isError).toBe(true);
    }
    expect(controller.plan).not.toHaveBeenCalled();
  });

  it('takes one key per selector and known protocols only', () => {
    const base = { name: 'x', action: 'block', from: [{ network: 'IoT' }], to: [{ internet: true }] };
    expect(createRuleSchema.safeParse(base).success).toBe(true);
    expect(createRuleSchema.safeParse({ ...base, from: [{ network: 'IoT', addresses: ['10.0.0.1'] }] }).success).toBe(false);
    expect(createRuleSchema.safeParse({ ...base, to: [{ internet: false }] }).success).toBe(false);
    expect(createRuleSchema.safeParse({ ...base, from: [] }).success).toBe(false);
    expect(createRuleSchema.safeParse({ ...base, protocol: 'gre' }).success).toBe(false);
    expect(createRuleSchema.safeParse({ ...base, action: 'deny' }).success).toBe(false);
    expect(updateRuleSchema.safeParse({ rule: 'x', position: 0 }).success).toBe(false);
  });
});
