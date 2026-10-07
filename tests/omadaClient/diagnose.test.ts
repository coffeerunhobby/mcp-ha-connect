/**
 * omada_diagnoseClient: which sources are read and which verdicts follow.
 */

import { describe, it, expect, vi } from 'vitest';

import { diagnoseClient } from '../../src/omadaClient/diagnose.js';
import type { OmadaClient } from '../../src/omadaClient/index.js';
import type { MacGroup } from '../../src/omadaClient/macGroups.js';
import { OmadaApiError } from '../../src/omadaClient/request.js';
import { logger } from '../../src/utils/logger.js';

const MAC = '4C-1D-96-8D-37-C7';

const group = (groupId: string, name: string, macs: string[]): MacGroup => ({
    groupId,
    name,
    type: 2,
    macAddressList: macs.map((macAddress, i) => ({ name: `e${i}`, macAddress })),
});

interface FakeOptions {
    clients?: unknown[];
    known?: unknown[];
    groups?: MacGroup[];
    ssidFilter?: { macFilterEnable: boolean; policy?: number; macFilterId?: string };
    pages?: Record<string, unknown[]>;
    audit?: Array<{ time: number; content: string }>;
    fail?: string[];
}

function fakeClient(o: FakeOptions = {}) {
    const failing = () => () => Promise.reject(new Error('GET https://omada.internal:8043/x failed, Authorization: Bearer s3cr3t'));
    const readResource = vi.fn(async ({ pathTemplate }: { pathTemplate: string }) => {
        if (o.fail?.includes(pathTemplate)) throw new OmadaApiError('https://omada.internal:8043 says no (AccessToken=s3cr3t)', -1005);
        if (pathTemplate.endsWith('/audit-logs')) return { data: o.audit ?? [] };
        return { data: o.pages?.[pathTemplate] ?? [] };
    });
    const client = {
        listClients: o.fail?.includes('clients') ? failing() : vi.fn(async () => o.clients ?? []),
        listKnownClients: vi.fn(async () => o.known ?? []),
        listMacGroups: vi.fn(async () => o.groups ?? []),
        getWlanGroupList: vi.fn(async () => [{ wlanId: 'w1' }]),
        getSsidList: vi.fn(async () => ({ data: [{ ssidId: 's1', name: 'Home' }] })),
        getSsidDetail: vi.fn(async () => ({ name: 'Home', macFilter: o.ssidFilter ?? { macFilterEnable: false } })),
        readResource,
    };
    return { client: client as unknown as OmadaClient, readResource };
}

const levels = (d: { verdict: Array<{ level: string; message: string }> }) => d.verdict.map((f) => `${f.level}: ${f.message}`);

describe('diagnoseClient', () => {
    it('reports a connected, unrestricted client', async () => {
        const { client } = fakeClient({ clients: [{ mac: '4c:1d:96:8d:37:c7', name: 'node-1271', ip: '192.168.0.50', blocked: false }] });

        const d = await diagnoseClient(client, '4c1d968d37c7');

        expect(d.mac).toBe(MAC);
        expect(d.active).toMatchObject({ name: 'node-1271', ip: '192.168.0.50', blocked: false });
        expect(levels(d)).toEqual(['info: Connected; nothing in Omada restricts it.']);
    });

    it('flags a block on the known client record', async () => {
        const { client } = fakeClient({ known: [{ mac: MAC, name: 'node-1271', block: true }] });

        expect(levels(await diagnoseClient(client, MAC))[0]).toMatch(/^blocks: Blocked in Omada. Use omada_unblockClient/);
    });

    it('flags an SSID allow list that does not contain the MAC', async () => {
        const { client } = fakeClient({
            clients: [{ mac: MAC }],
            groups: [group('g1', 'KnownWiFi', ['AA-BB-CC-DD-EE-01'])],
            ssidFilter: { macFilterEnable: true, policy: 1, macFilterId: 'g1' },
        });

        const d = await diagnoseClient(client, MAC);

        expect(d.ssidFilters).toEqual([{ ssid: 'Home', ssidId: 's1', wlanId: 'w1', macFilterEnabled: true, policy: 'allow', group: 'KnownWiFi', groupId: 'g1', containsMac: false }]);
        expect(levels(d)).toEqual([expect.stringMatching(/^blocks: Not on the allow list 'KnownWiFi' of SSID Home/)]);
    });

    it('is satisfied when the allow list contains the MAC', async () => {
        const { client } = fakeClient({
            clients: [{ mac: MAC }],
            groups: [group('g1', 'KnownWiFi', [MAC])],
            ssidFilter: { macFilterEnable: true, policy: 1, macFilterId: 'g1' },
        });

        const d = await diagnoseClient(client, MAC);

        expect(d.macGroups).toEqual([{ group: 'KnownWiFi', groupId: 'g1', entryName: 'e0' }]);
        expect(levels(d)).toEqual(['info: Connected; nothing in Omada restricts it.']);
    });

    it('flags an SSID deny list that contains the MAC', async () => {
        const { client } = fakeClient({
            clients: [{ mac: MAC }],
            groups: [group('g2', 'Banned', ['4c:1d:96:8d:37:c7'])],
            ssidFilter: { macFilterEnable: true, policy: 0, macFilterId: 'g2' },
        });

        expect(levels(await diagnoseClient(client, MAC))).toEqual([expect.stringMatching(/^blocks: On the deny list 'Banned' of SSID Home/)]);
    });

    it('warns when an SSID filters by a group that could not be read', async () => {
        const { client } = fakeClient({ clients: [{ mac: MAC }], ssidFilter: { macFilterEnable: true, policy: 1, macFilterId: 'gone' } });

        expect(levels(await diagnoseClient(client, MAC))).toEqual([expect.stringMatching(/^warning: SSID Home filters by MAC group gone/)]);
    });

    it('finds the MAC in the site deny list, IP-MAC binding and DHCP reservations', async () => {
        const { client } = fakeClient({
            clients: [{ mac: MAC }],
            pages: {
                '/sites/{siteId}/mac-filters/deny': [{ mac: '4C1D968D37C7' }],
                '/sites/{siteId}/ip-mac-binds': [{ macAddress: MAC, ip: '192.168.0.50' }],
                '/sites/{siteId}/setting/service/dhcp': [{ clientMac: MAC }],
            },
        });

        const d = await diagnoseClient(client, MAC);

        expect(d.siteMacFilter).toEqual({ inAllowList: false, inDenyList: true });
        expect(d.ipMacBinding).toBe(true);
        expect(d.dhcpReservation).toBe(true);
        expect(levels(d)).toEqual([expect.stringMatching(/^warning: Listed in the site MAC filter deny list/)]);
    });

    it('detects an orphaned block from the audit log (ADMIN)', async () => {
        const { client, readResource } = fakeClient({
            audit: [
                { time: 2000, content: `Client ${MAC} failed to unblock.` },
                { time: 1000, content: `Client ${MAC} was blocked.` },
            ],
        });

        const d = await diagnoseClient(client, MAC, { includeAudit: true });

        expect(readResource).toHaveBeenCalledWith(expect.objectContaining({ pathTemplate: '/sites/{siteId}/audit-logs', query: { searchKey: MAC } }));
        expect(d.auditEntries).toEqual([`${new Date(2000).toISOString()} Client ${MAC} failed to unblock.`, `${new Date(1000).toISOString()} Client ${MAC} was blocked.`]);
        expect(levels(d)).toEqual([expect.stringMatching(/^blocks: Orphaned block suspected.*clientSetting\.clientConfigs/)]);
    });

    it('does not call it orphaned while Omada still knows the client', async () => {
        const { client } = fakeClient({ known: [{ mac: MAC, name: 'node-1271', block: false }], audit: [{ time: 1, content: `Client ${MAC} failed to unblock.` }] });

        expect(levels(await diagnoseClient(client, MAC, { includeAudit: true }))).toEqual(['info: Nothing that Omada exposes restricts this client.']);
    });

    it('skips the audit log without ADMIN and says an orphan cannot be ruled out', async () => {
        const { client, readResource } = fakeClient({ audit: [{ time: 1, content: `Client ${MAC} failed to unblock.` }] });

        const d = await diagnoseClient(client, MAC);

        expect(d.auditEntries).toBeUndefined();
        expect(readResource).not.toHaveBeenCalledWith(expect.objectContaining({ pathTemplate: '/sites/{siteId}/audit-logs' }));
        expect(levels(d)).toEqual([expect.stringMatching(/^info: Omada has no record of this client. The audit log was not checked \(needs ADMIN\)/)]);
    });

    it('keeps going when sources fail and names them without the error text, in the response and the log', async () => {
        const { client } = fakeClient({ fail: ['clients', '/sites/{siteId}/ip-mac-binds'], known: [{ mac: MAC }] });
        const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(logger, level));

        const d = await diagnoseClient(client, MAC);

        const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
        spies.forEach((spy) => spy.mockRestore());
        expect(logged).toContain('IP-MAC binding');
        expect(logged).not.toMatch(/s3cr3t|omada.internal|Bearer/);

        expect(d.unavailable).toEqual(['active clients: read failed', 'IP-MAC binding: read failed (Omada errorCode -1005)']);
        expect(JSON.stringify(d)).not.toMatch(/s3cr3t|omada.internal|Bearer/);
        expect(levels(d)).toContain('info: Some sources could not be read (2); see "unavailable".');
    });

    it('rejects an incomplete MAC before reading anything', async () => {
        const { client, readResource } = fakeClient();

        await expect(diagnoseClient(client, '4C-1D-96')).rejects.toThrow(/not a complete MAC address/);
        expect(readResource).not.toHaveBeenCalled();
    });
});
