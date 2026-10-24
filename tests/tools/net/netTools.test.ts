/**
 * net_* tools: registration, permissions (lists QUERY, writes CONFIGURE), dry run vs
 * apply, and how inputs become model changes.
 */

import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';

import { assignPortSchema, createNetworkSchema, createRuleSchema, registerNetTools, setMdnsSchema, updateNetworkSchema, updateRuleSchema } from '../../../src/tools/net/index.js';
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
    listNetworks: vi.fn(async () => [{ id: 'n1', name: 'Default', vlan: 1 }, { id: 'n2', name: 'IoT', vlan: 2 }]),
    listClients: vi.fn(async () => [
      { mac: '02-00-00-00-00-01', name: 'phone', ip: '10.0.0.101', network: { id: 'n1' }, wifi: { name: 'home-wifi' }, online: true },
      { mac: '02-00-00-00-00-02', name: 'plug', ip: '10.0.1.20', network: { id: 'n2' }, port: { device: { mac: 'AA-BB-CC-00-00-01' }, port: 5 }, online: true },
      { mac: '02-00-00-00-00-03', online: true },
    ]),
    listPortProfiles: vi.fn(async () => [
      { id: 'p-all', name: 'All', isolation: false },
      { id: 'p-iot', name: 'IoT', networks: { native: { id: 'n2' }, tagged: [{ id: 'n1' }, { id: 'n9' }] }, isolation: false },
      { id: 'p-off', name: 'Disable', networks: { untagged: [{ id: 'n2' }, { name: 'by-name' }], tagged: 'none' }, isolation: false },
      { id: 'p-trunk', name: 'Trunk', networks: { native: { id: 'n1' }, tagged: 'all' }, isolation: true },
    ]),
    listPorts: vi.fn(async () => [
      {
        device: { mac: 'AA-BB-CC-00-00-01' },
        port: 5,
        profile: { id: 'p-iot' },
        networks: { native: { id: 'n2' }, tagged: [{ id: 'n1' }, { id: 'n9' }] },
        customSettings: false,
        seen: [{ mac: '02-00-00-00-00-02', name: 'plug', ip: '10.0.1.20', network: { id: 'n2' }, online: true }],
        uplink: false,
      },
      { device: { mac: 'AA-BB-CC-00-00-01' }, port: 6, customSettings: false, seen: [{ mac: '02-00-00-00-00-03', online: true }], uplink: false },
    ]),
    getMdnsRepeater: vi.fn(async () => ({ enabled: true, networks: [{ id: 'n1' }, { id: 'n2' }, { id: 'gone' }] })),
    listWifi: vi.fn(async () => []),
    listRules: vi.fn(async () => [{ id: 'acl-1', name: 'IoT to Home' }]),
    listGroups: vi.fn(async () => []),
    plan: vi.fn(async () => plan),
    apply: vi.fn(async () => ({ applied: true, owned: [], object: { id: 'n2', name: 'IoT' } })),
  } as unknown as NetworkController & { plan: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn>; listNetworks: ReturnType<typeof vi.fn>; listPorts: ReturnType<typeof vi.fn> };
  const count = registerNetTools(server, controller);
  return { handlers, controller, count };
}

const as = (permissions: number) => ({ sessionId: 's', http: { authInfo: { extra: { permissions } } } });
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe('net tools', () => {
  it('registers twenty-three tools', () => {
    const { handlers, count } = setup();

    expect(count).toBe(23);
    expect([...handlers.keys()]).toEqual([
      'net_capabilities', 'net_listNetworks', 'net_listWifi', 'net_createNetwork', 'net_updateNetwork', 'net_deleteNetwork', 'net_createWifi', 'net_updateWifi', 'net_deleteWifi',
      'net_listRules', 'net_listGroups', 'net_createRule', 'net_updateRule', 'net_deleteRule', 'net_moveRule',
      'net_listClients', 'net_listPortProfiles', 'net_listPorts', 'net_assignPort', 'net_getMdnsRepeater', 'net_setMdnsRepeater',
      'net_listFirmware', 'net_upgradeFirmware',
    ]);
  });

  it('lists firmware with QUERY; upgrading needs ADMIN, and a device by MAC or name', async () => {
    const { handlers, controller } = setup();
    controller.listFirmware = vi.fn(async () => [{ device: { mac: '02-00-00-00-00-02' }, current: 'v1', upgradable: false }]);

    expect(parse(await handlers.get('net_listFirmware')!({}, as(Permission.QUERY)))).toEqual([{ device: { mac: '02-00-00-00-00-02' }, current: 'v1', upgradable: false }]);
    const denied = await handlers.get('net_upgradeFirmware')!({ dryRun: true }, as(Permission.CONFIGURE));
    expect(denied.isError).toBe(true);
    expect(controller.plan).not.toHaveBeenCalled();

    await handlers.get('net_upgradeFirmware')!({ dryRun: true }, as(Permission.ADMIN));
    expect(controller.plan).toHaveBeenLastCalledWith({ op: 'upgrade', kind: 'firmware' });
    await handlers.get('net_upgradeFirmware')!({ device: '02:00:00:00:00:02', dryRun: true }, as(Permission.ADMIN));
    expect(controller.plan).toHaveBeenLastCalledWith({ op: 'upgrade', kind: 'firmware', device: { mac: '02:00:00:00:00:02' } });
    await handlers.get('net_upgradeFirmware')!({ device: 'router', dryRun: true }, as(Permission.ADMIN));
    expect(controller.plan).toHaveBeenLastCalledWith({ op: 'upgrade', kind: 'firmware', device: { name: 'router' } });
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
      basis: 'abc',
      note: 'Applying needs allowLockout and this basis: these online devices would be disconnected.',
    });
    expect(controller.apply).not.toHaveBeenCalled();
  });

  it('applies with allowLockout only with the basis of the dry run the user saw', async () => {
    const { handlers, controller } = setup();

    const result = parse(await handlers.get('net_deleteWifi')!({ wifi: 'x', allowLockout: true, basis: 'abc' }, as(Permission.CONFIGURE)));

    expect(controller.apply).toHaveBeenCalledWith(expect.objectContaining({ basis: 'abc' }), { allowLockout: true });
    expect(result).toMatchObject({ applied: true, controller: 'omada:default', result: { name: 'IoT' } });
  });

  it('refuses allowLockout without a basis, and any apply whose basis no longer matches (state or devices changed since the dry run)', async () => {
    const { handlers, controller } = setup();

    const missing = await handlers.get('net_assignPort')!({ switch: 'sw', port: 5, profile: 'IoT', allowLockout: true }, as(Permission.CONFIGURE));
    expect(missing.isError).toBe(true);
    expect(parse(missing).message).toBe('allowLockout needs the basis from a dry run of this change, so that only the devices it showed are cut off. Run it with dryRun first.');
    const stale = await handlers.get('net_assignPort')!({ switch: 'sw', port: 5, profile: 'IoT', allowLockout: true, basis: 'old' }, as(Permission.CONFIGURE));
    expect(parse(stale).message).toBe('This is not the change the dry run was for, or the controller or the devices it cuts off changed since; nothing was written. Run the dry run of this change again.');
    const staleNoLockout = await handlers.get('net_setMdnsRepeater')!({ enabled: false, basis: 'old' }, as(Permission.CONFIGURE));
    expect(staleNoLockout.isError).toBe(true);
    expect(controller.apply).not.toHaveBeenCalled();

    // A dry run never needs one (it is where the basis comes from), allowLockout or not.
    expect(parse(await handlers.get('net_assignPort')!({ switch: 'sw', port: 5, profile: 'IoT', allowLockout: true, dryRun: true }, as(Permission.CONFIGURE)))).toMatchObject({ dryRun: true, basis: 'abc' });
    await handlers.get('net_setMdnsRepeater')!({ enabled: false }, as(Permission.CONFIGURE));
    expect(controller.apply).toHaveBeenCalledTimes(1); // without allowLockout a basis is optional
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

  it('lists clients with their network name and VLAN, filtered by network name or id', async () => {
    const { handlers, controller } = setup();

    expect(parse(await handlers.get('net_listClients')!({}, as(Permission.QUERY)))).toEqual([
      { mac: '02-00-00-00-00-01', name: 'phone', ip: '10.0.0.101', network: 'Default', vlan: 1, wifi: 'home-wifi', online: true },
      { mac: '02-00-00-00-00-02', name: 'plug', ip: '10.0.1.20', network: 'IoT', vlan: 2, port: { device: { mac: 'AA-BB-CC-00-00-01' }, port: 5 }, online: true },
      { mac: '02-00-00-00-00-03', network: 'unknown', online: true },
    ]);
    expect(parse(await handlers.get('net_listClients')!({ network: 'iot' }, as(Permission.QUERY))).map((c: { name: string }) => c.name)).toEqual(['plug']);
    expect(parse(await handlers.get('net_listClients')!({ network: 'n1' }, as(Permission.QUERY))).map((c: { name: string }) => c.name)).toEqual(['phone']);
    const missing = await handlers.get('net_listClients')!({ network: 'Guest' }, as(Permission.QUERY));
    expect(missing.isError).toBe(true);
    expect(parse(missing).message).toBe("Network 'Guest' not found. Available: Default, IoT");
    controller.listNetworks.mockResolvedValueOnce([]);
    expect(parse(await handlers.get('net_listClients')!({ network: 'IoT' }, as(Permission.QUERY))).message).toBe("Network 'IoT' not found. Available: (none)");
  });

  it('names the networks of port profiles, the profile and networks of each port, and the networks of the mDNS repeater', async () => {
    const { handlers, controller } = setup();

    expect(parse(await handlers.get('net_listPortProfiles')!({}, as(Permission.QUERY)))).toEqual([
      { id: 'p-all', name: 'All', isolation: false },
      { id: 'p-iot', name: 'IoT', networks: { native: { id: 'n2', name: 'IoT' }, tagged: [{ id: 'n1', name: 'Default' }, { id: 'n9' }] }, isolation: false },
      { id: 'p-off', name: 'Disable', networks: { untagged: [{ id: 'n2', name: 'IoT' }, { name: 'by-name' }], tagged: 'none' }, isolation: false },
      { id: 'p-trunk', name: 'Trunk', networks: { native: { id: 'n1', name: 'Default' }, tagged: 'all' }, isolation: true },
    ]);
    expect(parse(await handlers.get('net_listPorts')!({}, as(Permission.QUERY)))).toEqual([
      {
        device: { mac: 'AA-BB-CC-00-00-01' },
        port: 5,
        profile: { id: 'p-iot', name: 'IoT' },
        networks: { native: { id: 'n2', name: 'IoT' }, tagged: [{ id: 'n1', name: 'Default' }, { id: 'n9' }] },
        customSettings: false,
        seen: [{ mac: '02-00-00-00-00-02', name: 'plug', ip: '10.0.1.20' }],
        uplink: false,
      },
      { device: { mac: 'AA-BB-CC-00-00-01' }, port: 6, customSettings: false, seen: [{ mac: '02-00-00-00-00-03' }], uplink: false },
    ]);
    expect(controller.listPorts).toHaveBeenCalledWith(undefined);
    expect(parse(await handlers.get('net_getMdnsRepeater')!({}, as(Permission.QUERY)))).toEqual({ enabled: true, networks: [{ id: 'n1', name: 'Default' }, { id: 'n2', name: 'IoT' }, { id: 'gone' }] });
  });

  it('picks a switch by MAC when given one, else by name', async () => {
    const { handlers, controller } = setup();

    for (const value of ['AA-BB-CC-00-00-01', 'aa:bb:cc:00:00:01', 'aabbcc000001']) await handlers.get('net_listPorts')!({ switch: value }, as(Permission.QUERY));
    await handlers.get('net_listPorts')!({ switch: 'switch-sw1' }, as(Permission.QUERY));
    await handlers.get('net_listPorts')!({ switch: 'aabbcc00000' }, as(Permission.QUERY));
    await handlers.get('net_listPorts')!({ switch: 'deadbeefcafe-sw' }, as(Permission.QUERY));

    expect(controller.listPorts.mock.calls.map((c) => c[0])).toEqual([
      { mac: 'AA-BB-CC-00-00-01' },
      { mac: 'aa:bb:cc:00:00:01' },
      { mac: 'aabbcc000001' },
      { name: 'switch-sw1' },
      { name: 'aabbcc00000' },
      { name: 'deadbeefcafe-sw' },
    ]);
  });

  it('turns port and mDNS inputs into changes; both need CONFIGURE', async () => {
    const { handlers, controller } = setup();

    await handlers.get('net_assignPort')!({ switch: 'switch-sw1', port: 5, network: 'IoT', dryRun: true }, as(Permission.CONFIGURE));
    await handlers.get('net_assignPort')!({ switch: 'switch-sw1', port: 5, network: 'IoT', tagged: ['Engineering', 'n9'], dryRun: true }, as(Permission.CONFIGURE));
    await handlers.get('net_assignPort')!({ switch: 'switch-sw1', port: 5, network: 'Default', tagged: 'all', dryRun: true }, as(Permission.CONFIGURE));
    await handlers.get('net_setMdnsRepeater')!({ enabled: true, networks: ['Default', 'IoT'], dryRun: true }, as(Permission.CONFIGURE));
    await handlers.get('net_setMdnsRepeater')!({ enabled: false, dryRun: true }, as(Permission.CONFIGURE));

    expect(controller.plan.mock.calls.map((c) => c[0])).toEqual([
      { op: 'assign', kind: 'port', port: { device: { name: 'switch-sw1' }, port: 5 }, networks: { native: { name: 'IoT' }, tagged: 'none' } },
      { op: 'assign', kind: 'port', port: { device: { name: 'switch-sw1' }, port: 5 }, networks: { native: { name: 'IoT' }, tagged: [{ name: 'Engineering' }, { name: 'n9' }] } },
      { op: 'assign', kind: 'port', port: { device: { name: 'switch-sw1' }, port: 5 }, networks: { native: { name: 'Default' }, tagged: 'all' } },
      { op: 'set', kind: 'mdnsRepeater', enabled: true, networks: [{ name: 'Default' }, { name: 'IoT' }] },
      { op: 'set', kind: 'mdnsRepeater', enabled: false },
    ]);
    for (const [tool, args] of [
      ['net_assignPort', { switch: 'x', port: 1, network: 'IoT' }],
      ['net_setMdnsRepeater', { enabled: false }],
    ] as const) {
      expect((await handlers.get(tool)!(args, as(Permission.QUERY | Permission.CONTROL))).isError).toBe(true);
    }
    expect(controller.plan).toHaveBeenCalledTimes(5);
    expect(assignPortSchema.safeParse({ switch: 'x', port: 0, network: 'IoT' }).success).toBe(false);
    expect(assignPortSchema.safeParse({ switch: 'x', port: 1, network: 'IoT', tagged: [] }).success).toBe(false);
    expect(assignPortSchema.safeParse({ switch: 'x', port: 1, network: 'IoT', tagged: 'some' }).success).toBe(false);
    expect(assignPortSchema.parse({ switch: 'x', port: 1, network: 'IoT' }).tagged).toBe('none');
    expect(setMdnsSchema.safeParse({ enabled: true, networks: [] }).success).toBe(false);
  });
});
