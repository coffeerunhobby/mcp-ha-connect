/**
 * Access control writes against a fake controller that keeps state: time ranges,
 * groups, DHCP reservations, gateway ACLs and the SSID MAC filter.
 */

import { describe, it, expect, vi } from 'vitest';

import { AccessControlOperations, type GatewayAcl } from '../../src/omadaClient/accessControl.js';
import type { ClientOperations } from '../../src/omadaClient/client.js';
import { MacGroupOperations, type MacGroup } from '../../src/omadaClient/macGroups.js';
import { ALWAYS_PROFILE_NAME, type NetworkOperations } from '../../src/omadaClient/network.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

const LAPTOP = '02-1A-2B-3C-4D-5E';
const PHONE = '02-1A-2B-3C-4D-6F';
const base = '/openapi/v1/c1/sites/site-1';

function controller() {
    const state = {
        timeRanges: [{ profileId: 'tr-1', name: 'School night', dayMode: 0, timeList: [{ dayType: 0, startTimeH: 18, startTimeM: 0, endTimeH: 19, endTimeM: 0 }] }] as Array<Record<string, unknown>>,
        ipGroups: [
            { groupId: 'ip-any', name: 'IPGroup_Any', ipList: [{ ip: '0.0.0.0', mask: 0 }] },
            { groupId: 'ip-rfc', name: 'IPGroup_RFC1918', ipList: [{ ip: '10.0.0.0', mask: 8 }] },
        ] as Array<Record<string, unknown>>,
        macGroups: [{ groupId: 'mg-known', name: 'KnownWiFi', type: 2, macAddressList: [{ name: 'phone', macAddress: PHONE }] }] as MacGroup[],
        acls: [
            { id: 'acl-1', index: 1, description: 'Deny-RFC1918', status: true, policy: 0, protocols: [256], sourceType: 1, sourceIds: ['ip-rfc'], destinationType: 1, destinationIds: ['ip-any'], direction: { lanToWan: false, lanToLan: false, wanInIds: ['wan1'], vpnInIds: [] }, stateMode: 0 },
        ] as GatewayAcl[],
        dhcp: [{ netId: 'lan-default', mac: '02-00-00-00-00-01', ip: '10.0.0.23', description: 'Lamp', status: true, options: [] }] as Array<Record<string, unknown>>,
        macFilter: { macFilterEnable: false, policy: 1, macFilterId: 'mg-known' } as Record<string, unknown>,
        clients: [{ mac: PHONE, name: 'phone', ssid: 'home-wifi' }] as Array<Record<string, unknown>>,
        /** Called after each gateway ACL listing (to simulate an outside edit). */
        switchAcls: [] as Array<Record<string, unknown>>,
        wlanSchedule: { wlanScheduleEnable: false } as Record<string, unknown>,
        afterAclList: undefined as undefined | ((call: number) => void),
        aclLists: 0,
    };
    const writes: Array<{ method: string; url: string; data?: unknown }> = [];
    const ok = (result?: unknown) => ({ errorCode: 0, result });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    /** MAC group membership at the moment the SSID MAC filter was written. */
    const filterWrittenWith: string[][] = [];

    const request = {
        get: vi.fn(async (url: string) => {
            await tick();
            if (url === `${base}/time-range-profiles`) return ok(structuredClone(state.timeRanges));
            if (url === `${base}/profiles/groups/0`) return ok(structuredClone(state.ipGroups));
            if (url === `${base}/profiles/groups/2`) return ok(structuredClone(state.macGroups));
            throw new Error(`unexpected GET ${url}`);
        }),
        fetchPaginated: vi.fn(async (url: string) => {
            await tick();
            if (url === `${base}/acls/osw-acls`) {
                // Slow, so a rule can be created while a time range delete is checking its users.
                for (let i = 0; i < 10; i++) await tick();
                return structuredClone(state.switchAcls);
            }
            if (url === `${base}/acls/osg-acls`) {
                const rows = structuredClone(state.acls);
                state.afterAclList?.(++state.aclLists);
                return rows;
            }
            if (url === `${base}/setting/service/dhcp`) return structuredClone(state.dhcp);
            throw new Error(`unexpected list ${url}`);
        }),
        request: vi.fn(async ({ method, url, data }: { method: string; url: string; data?: Record<string, unknown> }) => {
            writes.push({ method, url, data });
            if (url.endsWith('/update-mac-filter')) filterWrittenWith.push(state.macGroups[0].macAddressList!.map((e) => e.macAddress));
            if (method === 'POST' && url === `${base}/time-range-profiles`) state.timeRanges.push({ profileId: 'tr-new', ...data });
            if (method === 'POST' && url === `${base}/profiles/groups`) {
                (data!.type === 0 ? state.ipGroups : (state.macGroups as unknown as Array<Record<string, unknown>>)).push({ groupId: 'g-new', ...data });
            }
            if (method === 'DELETE' && url.startsWith(`${base}/time-range-profile/`)) state.timeRanges = state.timeRanges.filter((p) => p.profileId !== url.split('/').pop());
            if (method === 'POST' && url === `${base}/acls/osg-acls`) state.acls.push({ id: 'acl-new', index: state.acls.length + 1, ...(data as object) } as GatewayAcl);
            if (method === 'PUT' && url.startsWith(`${base}/acls/osg-acls/`)) {
                const id = url.split('/').pop();
                state.acls = state.acls.map((a) => (a.id === id ? ({ id, index: a.index, ...(data as object) } as GatewayAcl) : a));
            }
            return ok();
        }),
        patch: vi.fn(async (url: string, data: { macAddressList: MacGroup['macAddressList'] }) => {
            await tick();
            writes.push({ method: 'PATCH', url, data });
            const id = url.split('/').pop();
            state.macGroups = state.macGroups.map((g) => (g.groupId === id ? { ...g, macAddressList: data.macAddressList } : g));
            return ok();
        }),
        ensureSuccess: (r: { result?: unknown }) => r.result,
    };
    const site = { resolveSiteId: (id?: string) => id ?? 'site-1' } as unknown as SiteOperations;
    const buildPath = (p: string) => `/openapi/v1/c1${p}`;
    const network = {
        getLanNetworkList: vi.fn(async () => [
            { id: 'lan-default', name: 'Default', gatewaySubnet: '10.0.0.1/24' },
            { id: 'lan-iot', name: 'IoT', gatewaySubnet: '10.0.1.1/24' },
        ]),
        // Like the real controller: every SSID again (here listed first) under a pseudo WLAN group 'gateway' without SSID detail.
        listAllSsids: vi.fn(async () => [
            { wlanId: 'gateway', wlanName: 'gateway', ssidList: [{ ssidId: 's1', ssidName: 'home-wifi' }] },
            { wlanId: 'w1', wlanName: 'Home', ssidList: [{ ssidId: 's1', ssidName: 'home-wifi' }] },
        ]),
        getSsidDetail: vi.fn(async (wlanId: string) => {
            if (wlanId === 'gateway') throw new Error('Invalid request parameters.');
            return { name: 'home-wifi', macFilter: structuredClone(state.macFilter), wlanSchedule: structuredClone(state.wlanSchedule) };
        }),
    } as unknown as NetworkOperations;
    // Slow like a real controller, so other calls can interleave with a lockout check.
    const clients = {
        listClients: vi.fn(async () => {
            for (let i = 0; i < 10; i++) await tick();
            return structuredClone(state.clients);
        }),
    } as unknown as ClientOperations;
    const macGroups = new MacGroupOperations(request as unknown as RequestHandler, site, buildPath);
    const ops = new AccessControlOperations(request as unknown as RequestHandler, site, buildPath, network, macGroups, clients);
    return { state, writes, ops, macGroups, filterWrittenWith, request };
}

describe('time ranges', () => {
    it('creates a curfew from the allowed hours and finds its id again', async () => {
        const { writes, ops } = controller();

        const result = await ops.createTimeRange('Curfew', [{ days: ['sat'], start: '09:00', end: '19:00' }], { invert: true });

        expect(result.profileId).toBe('tr-new');
        expect(result.windows).toContain('sat 00:00-09:00');
        expect(result.windows).toContain('mon 00:00-24:00');
        expect(writes).toEqual([{ method: 'POST', url: `${base}/time-range-profiles`, data: expect.objectContaining({ name: 'Curfew', dayMode: 3 }) }]);
    });

    it('refuses a duplicate name', async () => {
        const { writes, ops } = controller();

        await expect(ops.createTimeRange('School night', [{ days: ['mon'], start: '18:00', end: '19:00' }])).rejects.toThrow(/already exists/);
        expect(writes).toEqual([]);
    });

    it('updates by name and reports before and after', async () => {
        const { writes, ops } = controller();

        const result = await ops.updateTimeRange('school NIGHT', [{ days: ['fri'], start: '20:00', end: '21:00' }]);

        expect(result).toEqual({ profileId: 'tr-1', name: 'School night', before: ['every day 18:00-19:00'], after: ['fri 20:00-21:00'] });
        expect(writes[0]).toMatchObject({ method: 'PUT', url: `${base}/time-range-profile/tr-1` });
    });

    it('refuses to delete a time range a switch ACL or an SSID Wi-Fi schedule uses', async () => {
        const { state, writes, ops, request } = controller();

        state.switchAcls = [{ id: 'sw-1', description: 'Lab ports', timeRangeId: 'tr-1' }];
        await expect(ops.deleteTimeRange('tr-1')).rejects.toThrow(/used by switch ACL 'Lab ports'/);

        state.switchAcls = [];
        state.wlanSchedule = { wlanScheduleEnable: true, action: 0, scheduleId: 'tr-1' };
        await expect(ops.deleteTimeRange('tr-1')).rejects.toThrow(/used by the Wi-Fi schedule of SSID home-wifi/);
        expect(writes).toEqual([]);
        // The switch ACL list rejects the default page size of 200.
        expect(request.fetchPaginated).toHaveBeenCalledWith(`${base}/acls/osw-acls`, { pageSize: 50 });
    });

    it('never lets a rule be created on a time range that is being deleted', async () => {
        const { state, ops } = controller();

        const [create, remove] = await Promise.allSettled([
            ops.createGatewayAcl({ description: 'Curfew', policy: 'deny', source: { type: 'ipGroup', ids: ['IPGroup_RFC1918'] }, timeRange: 'School night' }),
            ops.deleteTimeRange('School night'),
        ]);

        // One of them must lose: no rule may point at a deleted time range.
        expect([create.status, remove.status]).not.toEqual(['fulfilled', 'fulfilled']);
        const dangling = state.acls.filter((a) => a.timeRangeId && !state.timeRanges.some((p) => p.profileId === a.timeRangeId));
        expect(dangling).toEqual([]);
    });

    it('refuses the name omada_setSsidEnabled finds its 24/7 profile by, on create and rename', async () => {
        const { writes, ops } = controller();
        const w = [{ days: ['mon' as const], start: '18:00', end: '19:00' }];

        await expect(ops.createTimeRange(ALWAYS_PROFILE_NAME, w)).rejects.toThrow(/reserved for omada_setSsidEnabled/);
        await expect(ops.updateTimeRange('School night', w, { name: ALWAYS_PROFILE_NAME })).rejects.toThrow(/reserved for omada_setSsidEnabled/);
        expect(writes).toEqual([]);
    });

    it('leaves the omada_setSsidEnabled profile alone', async () => {
        const { state, writes, ops } = controller();
        state.timeRanges.push({ profileId: 'tr-always', name: ALWAYS_PROFILE_NAME, dayMode: 0, timeList: [] });

        await expect(ops.deleteTimeRange('tr-always')).rejects.toThrow(/belongs to omada_setSsidEnabled/);
        expect(writes).toEqual([]);
    });

    it('refuses to delete a time range a rule uses, and deletes it otherwise', async () => {
        const { state, writes, ops } = controller();
        state.acls[0].timeRangeId = 'tr-1';

        await expect(ops.deleteTimeRange('School night')).rejects.toThrow(/used by gateway ACL 'Deny-RFC1918'/);
        expect(writes).toEqual([]);

        delete state.acls[0].timeRangeId;
        await expect(ops.deleteTimeRange('School night')).resolves.toMatchObject({ deleted: true });
        expect(writes).toEqual([{ method: 'DELETE', url: `${base}/time-range-profile/tr-1`, data: undefined }]);
    });
});

describe('groups', () => {
    it('creates an IP group, a bare address meaning /32', async () => {
        const { writes, ops } = controller();

        await expect(ops.createGroup({ name: 'Laptop', type: 'ip', ips: ['10.0.0.60', '10.0.2.0/24'] })).resolves.toMatchObject({ groupId: 'g-new' });
        expect(writes[0]).toEqual({ method: 'POST', url: `${base}/profiles/groups`, data: { name: 'Laptop', type: 0, ipList: [{ ip: '10.0.0.60', mask: 32 }, { ip: '10.0.2.0', mask: 24 }] } });
    });

    it('creates a MAC group with formatted MACs', async () => {
        const { writes, ops } = controller();

        await ops.createGroup({ name: 'Kids', type: 'mac', macs: [{ mac: '02:1a:2b:3c:4d:5e', name: 'laptop' }] });
        expect(writes[0].data).toEqual({ name: 'Kids', type: 2, macAddressList: [{ name: 'laptop', macAddress: LAPTOP }] });
    });

    it.each([
        [{ name: 'ipgroup_any', type: 'ip', ips: ['10.0.0.1'] }, /already exists/],
        [{ name: 'Bad', type: 'ip', ips: ['10.0.0.300'] }, /not an IPv4 address/],
        [{ name: 'Bad', type: 'ip', ips: ['10.0.0.1/33'] }, /mask must be 1 to 32/],
        [{ name: 'Empty', type: 'ip', ips: [] }, /at least one entry/],
    ])('refuses %j', async (input, error) => {
        const { writes, ops } = controller();

        await expect(ops.createGroup(input as never)).rejects.toThrow(error);
        expect(writes).toEqual([]);
    });

    it('refuses to delete IPGroup_Any or a group still in use', async () => {
        const { state, writes, ops } = controller();
        state.macFilter.macFilterId = 'mg-known';

        await expect(ops.deleteGroup('IPGroup_Any', 'ip')).rejects.toThrow(/built in/);
        await expect(ops.deleteGroup('IPGroup_RFC1918', 'ip')).rejects.toThrow(/used by gateway ACL 'Deny-RFC1918'/);
        await expect(ops.deleteGroup('KnownWiFi', 'mac')).rejects.toThrow(/used by the MAC filter of SSID home-wifi/);
        expect(writes).toEqual([]);
    });

    it('deletes an unused group by its type path', async () => {
        const { state, writes, ops } = controller();
        state.acls = [];

        await expect(ops.deleteGroup('IPGroup_RFC1918', 'ip')).resolves.toMatchObject({ deleted: true });
        expect(writes).toEqual([{ method: 'DELETE', url: `${base}/profiles/groups/0/ip-rfc`, data: undefined }]);
    });
});

describe('DHCP reservations', () => {
    it('creates a reservation in the LAN whose subnet holds the IP', async () => {
        const { writes, ops } = controller();

        await expect(ops.setDhcpReservation('02:1a:2b:3c:4d:5e', '10.0.1.60', 'laptop')).resolves.toMatchObject({ action: 'created', network: 'IoT' });
        expect(writes).toEqual([
            { method: 'POST', url: `${base}/setting/service/dhcp`, data: { netId: 'lan-iot', mac: LAPTOP, ip: '10.0.1.60', description: 'laptop', status: true, options: [] } },
        ]);
    });

    it('changes an existing reservation, keeping its description, or does nothing', async () => {
        const { writes, ops } = controller();

        await expect(ops.setDhcpReservation('02-00-00-00-00-01', '10.0.0.23', undefined)).resolves.toMatchObject({ action: 'unchanged' });
        await expect(ops.setDhcpReservation('02-00-00-00-00-01', '10.0.0.24', undefined)).resolves.toMatchObject({ action: 'updated', previousIp: '10.0.0.23' });
        expect(writes).toEqual([
            { method: 'PATCH', url: `${base}/setting/service/dhcp/02-00-00-00-00-01`, data: expect.objectContaining({ ip: '10.0.0.24', description: 'Lamp' }) },
        ]);
    });

    it('refuses an address already reserved for another device or outside every LAN', async () => {
        const { writes, ops } = controller();

        await expect(ops.setDhcpReservation(LAPTOP, '10.0.0.23', undefined)).rejects.toThrow(/already reserved for 02-00-00-00-00-01 \(Lamp\)/);
        await expect(ops.setDhcpReservation(LAPTOP, '172.16.0.5', undefined)).rejects.toThrow(/in no LAN network/);
        expect(writes).toEqual([]);
    });

    it('removes a reservation, or reports it absent', async () => {
        const { writes, ops } = controller();

        await expect(ops.removeDhcpReservation(LAPTOP)).resolves.toEqual({ mac: LAPTOP, action: 'not-present' });
        await expect(ops.removeDhcpReservation('02:00:00:00:00:01')).resolves.toMatchObject({ action: 'removed', ip: '10.0.0.23' });
        expect(writes).toEqual([{ method: 'DELETE', url: `${base}/setting/service/dhcp/02-00-00-00-00-01`, data: undefined }]);
    });
});

describe('gateway ACL', () => {
    it('creates a scheduled LAN to internet deny rule, resolving names to ids', async () => {
        const { writes, ops } = controller();

        const rule = await ops.createGatewayAcl({ description: 'Curfew laptop', policy: 'deny', source: { type: 'ipGroup', ids: ['IPGroup_RFC1918'] }, timeRange: 'School night' });

        expect(writes[0]).toEqual({
            method: 'POST',
            url: `${base}/acls/osg-acls`,
            data: {
                description: 'Curfew laptop',
                status: true,
                policy: 0,
                protocols: [256],
                sourceType: 1,
                sourceIds: ['ip-rfc'],
                destinationType: 1,
                destinationIds: ['ip-any'],
                syslog: false,
                direction: { lanToWan: true, lanToLan: false, wanInIds: [], vpnInIds: [] },
                stateMode: 0,
                timeRangeId: 'tr-1',
            },
        });
        expect(rule).toMatchObject({ id: 'acl-new', policy: 'deny', source: 'ipGroup: IPGroup_RFC1918', destination: 'ipGroup: IPGroup_Any', schedule: { name: 'School night' } });
    });

    it('refuses a duplicate description, an unknown source or time range', async () => {
        const { writes, ops } = controller();
        const source = { type: 'ipGroup' as const, ids: ['IPGroup_RFC1918'] };

        await expect(ops.createGatewayAcl({ description: 'Deny-RFC1918', policy: 'deny', source })).rejects.toThrow(/already exists/);
        await expect(ops.createGatewayAcl({ description: 'x', policy: 'deny', source: { type: 'ipGroup', ids: ['Nope'] } })).rejects.toThrow(/IP group 'Nope' not found/);
        await expect(ops.createGatewayAcl({ description: 'x', policy: 'deny', source, timeRange: 'Never' })).rejects.toThrow(/Time range 'Never' not found/);
        expect(writes).toEqual([]);
    });

    it('updates only what changed, and can drop the schedule', async () => {
        const { state, writes, ops } = controller();
        state.acls[0].timeRangeId = 'tr-1';

        const rule = await ops.updateGatewayAcl('Deny-RFC1918', { enabled: false, timeRange: null });

        expect(writes[0].url).toBe(`${base}/acls/osg-acls/acl-1`);
        expect(writes[0].data).toMatchObject({ status: false, policy: 0, sourceIds: ['ip-rfc'], direction: { wanInIds: ['wan1'] } });
        expect(writes[0].data).not.toHaveProperty('timeRangeId');
        expect(rule).toMatchObject({ enabled: false, schedule: 'always' });
    });

    it('keeps the schedule when it is not mentioned', async () => {
        const { state, writes, ops } = controller();
        state.acls[0].timeRangeId = 'tr-1';

        await ops.updateGatewayAcl('acl-1', { policy: 'allow' });
        expect(writes[0].data).toMatchObject({ policy: 1, timeRangeId: 'tr-1' });
    });

    it('applies two concurrent updates of one rule one after the other, losing neither', async () => {
        const { state, ops } = controller();

        await Promise.all([ops.updateGatewayAcl('acl-1', { enabled: false }), ops.updateGatewayAcl('acl-1', { timeRange: 'School night' })]);

        expect(state.acls[0]).toMatchObject({ status: false, timeRangeId: 'tr-1' });
    });

    it('refuses the update if the rule changed between the read and the write', async () => {
        const { state, writes, ops } = controller();
        state.afterAclList = (call) => {
            if (call === 1) state.acls[0].status = false;
        };

        await expect(ops.updateGatewayAcl('acl-1', { policy: 'allow' })).rejects.toThrow(/changed while preparing the update; nothing was written/);
        expect(writes).toEqual([]);
    });

    it('lists and disables a rule whose endpoint type these tools do not edit, but refuses to edit that endpoint', async () => {
        const { state, writes, ops } = controller();
        state.acls[0] = { ...state.acls[0], sourceType: 2, sourceIds: ['ipport-1'] };

        await expect(ops.describeAcl(state.acls[0])).resolves.toMatchObject({ source: 'type 2: ipport-1', destination: 'ipGroup: IPGroup_Any' });
        await expect(ops.updateGatewayAcl('acl-1', { enabled: false })).resolves.toMatchObject({ enabled: false, source: 'type 2: ipport-1' });
        expect(writes[0].data).toMatchObject({ sourceType: 2, sourceIds: ['ipport-1'], status: false });

        await expect(ops.updateGatewayAcl('acl-1', { destination: { type: 'ipGroup', ids: ['IPGroup_RFC1918'] } })).rejects.toThrow(/endpoint type \(2\) these tools do not handle/);
        expect(writes).toHaveLength(1);
    });

    it('deletes and reorders rules', async () => {
        const { state, writes, ops } = controller();
        state.acls.push({ ...state.acls[0], id: 'acl-2', index: 2, description: 'Second' }, { ...state.acls[0], id: 'acl-3', index: 3, description: 'Third' });

        await expect(ops.moveGatewayAcl('Third', 1)).resolves.toEqual({ order: ['1. Third', '2. Deny-RFC1918', '3. Second'] });
        await expect(ops.moveGatewayAcl('Third', 4)).rejects.toThrow(/Position must be 1 to 3/);
        await ops.deleteGatewayAcl('Second');

        expect(writes).toEqual([
            { method: 'POST', url: `${base}/acls/modifyIndex`, data: { type: 'gateway', indexes: { 'acl-3': 1, 'acl-1': 2, 'acl-2': 3 } } },
            { method: 'DELETE', url: `${base}/acls/acl-2`, data: undefined },
        ]);
    });
});

describe('SSID MAC filter', () => {
    it('dry run shows who an allow list would lock out', async () => {
        const { state, writes, ops } = controller();
        state.clients.push({ mac: '06-AA-BB-CC-DD-EE', name: 'random-mac', ssid: 'home-wifi' }, { mac: '06-11-22-33-44-55', name: 'elsewhere', ssid: 'guest' });

        const change = await ops.setSsidMacFilter('home-wifi', { enabled: true, policy: 'allow', group: 'KnownWiFi' }, { dryRun: true });

        expect(change).toEqual({
            ssid: 'home-wifi',
            ssidId: 's1',
            before: { enabled: false, policy: 'allow', group: 'KnownWiFi' },
            after: { enabled: true, policy: 'allow', group: 'KnownWiFi' },
            wouldLockOut: [{ mac: '06-AA-BB-CC-DD-EE', name: 'random-mac' }],
            applied: false,
        });
        expect(writes).toEqual([]);
    });

    it('refuses to lock out connected clients unless allowed', async () => {
        const { state, writes, ops } = controller();
        state.clients.push({ mac: '06-AA-BB-CC-DD-EE', name: 'random-mac', ssid: 'home-wifi' });

        await expect(ops.setSsidMacFilter('home-wifi', { enabled: true, policy: 'allow' })).rejects.toThrow(/disconnect 1 connected client.*random-mac.*Nothing was changed/);
        expect(writes).toEqual([]);

        await expect(ops.setSsidMacFilter('home-wifi', { enabled: true, policy: 'allow' }, { allowLockout: true })).resolves.toMatchObject({ applied: true });
        expect(writes).toEqual([
            { method: 'PATCH', url: `${base}/wireless-network/wlans/w1/ssids/s1/update-mac-filter`, data: { macFilterEnable: true, policy: 1, macFilterId: 'mg-known' } },
        ]);
    });

    it('checks for lockouts against the membership the filter is switched on with, even while an entry is being removed', async () => {
        const { ops, macGroups, filterWrittenWith } = controller();

        const [filter, removal] = await Promise.allSettled([
            ops.setSsidMacFilter('home-wifi', { enabled: true, policy: 'allow', group: 'KnownWiFi' }),
            macGroups.removeMacGroupEntry('KnownWiFi', PHONE),
        ]);

        expect(removal.status).toBe('fulfilled');
        // Either the filter went first (the phone was still a member) or it saw the removal and refused.
        if (filter.status === 'fulfilled') expect(filterWrittenWith).toEqual([[PHONE]]);
        else expect(filterWrittenWith).toEqual([]);
    });

    it('applies a deny list that hits nobody connected, and turns the filter off', async () => {
        const { writes, ops } = controller();

        await expect(ops.setSsidMacFilter('s1', { enabled: true, policy: 'deny', group: 'KnownWiFi' })).rejects.toThrow(/phone/);
        await expect(ops.setSsidMacFilter('home-wifi', { enabled: false })).resolves.toMatchObject({ applied: true, after: { enabled: false } });
        expect(writes).toEqual([{ method: 'PATCH', url: `${base}/wireless-network/wlans/w1/ssids/s1/update-mac-filter`, data: { macFilterEnable: false } }]);
    });
});
