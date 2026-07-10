/**
 * Unit tests for the v1.6 Omada action operations:
 *  - DeviceOperations.cyclePoePorts (PoE recovery = remote hard-reboot of PoE devices)
 *  - NetworkOperations.setSsidEnabled (SSID on/off via the WLAN-schedule mechanism)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DeviceOperations } from '../../src/omadaClient/device.js';
import { NetworkOperations, ALWAYS_PROFILE_NAME } from '../../src/omadaClient/network.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

const buildPath = (p: string): string => `/openapi/v1/omadac1${p.startsWith('/') ? p : `/${p}`}`;

function createMockRequest() {
    return {
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        fetchPaginated: vi.fn(),
        // Mirrors the real ensureSuccess: unwrap result, throw on errorCode !== 0
        ensureSuccess: vi.fn((response: { errorCode: number; msg?: string; result?: unknown }) => {
            if (response.errorCode !== 0) {
                throw new Error(response.msg ?? `Omada error ${String(response.errorCode)}`);
            }
            return response.result;
        }),
    };
}

const mockSite = { resolveSiteId: vi.fn(() => 'site-1') } as unknown as SiteOperations;

const ok = (result?: unknown) => ({ errorCode: 0, msg: 'Success', result });

describe('DeviceOperations.cyclePoePorts', () => {
    let request: ReturnType<typeof createMockRequest>;
    let ops: DeviceOperations;

    beforeEach(() => {
        request = createMockRequest();
        ops = new DeviceOperations(request as unknown as RequestHandler, mockSite, buildPath);
    });

    it('POSTs the poe-recovery endpoint with the ports payload', async () => {
        request.post.mockResolvedValue(ok());

        await ops.cyclePoePorts('AA-BB-CC-DD-EE-FF', [1, 3]);

        expect(request.post).toHaveBeenCalledWith(
            '/openapi/v1/omadac1/sites/site-1/switches/AA-BB-CC-DD-EE-FF/multi-ports/poe-recovery',
            { ports: [1, 3] }
        );
    });

    it('rejects a missing switchMac with an actionable hint', async () => {
        await expect(ops.cyclePoePorts('', [1])).rejects.toThrow(/switchMac.*omada_listDevices/);
        expect(request.post).not.toHaveBeenCalled();
    });

    it('rejects an empty ports array', async () => {
        await expect(ops.cyclePoePorts('AA-BB-CC-DD-EE-FF', [])).rejects.toThrow(/at least one port/i);
        expect(request.post).not.toHaveBeenCalled();
    });

    it('propagates controller errors via ensureSuccess', async () => {
        request.post.mockResolvedValue({ errorCode: -1, msg: 'port not PoE capable' });
        await expect(ops.cyclePoePorts('AA-BB-CC-DD-EE-FF', [9])).rejects.toThrow('port not PoE capable');
    });
});

describe('NetworkOperations.setSsidEnabled', () => {
    let request: ReturnType<typeof createMockRequest>;
    let ops: NetworkOperations;

    const WLANS = [
        {
            wlanId: 'wlan-1',
            wlanName: 'Default',
            ssidList: [
                { ssidId: 'ssid-main', ssidName: 'Tower' },
                { ssidId: 'ssid-guest', ssidName: 'Tower-Guest' },
            ],
        },
    ];

    beforeEach(() => {
        request = createMockRequest();
        ops = new NetworkOperations(request as unknown as RequestHandler, mockSite, buildPath);
    });

    it('enables an SSID by simply disabling its WLAN schedule', async () => {
        request.get.mockResolvedValueOnce(ok(WLANS)); // listAllSsids
        request.patch.mockResolvedValue(ok());

        const result = await ops.setSsidEnabled('Tower-Guest', true);

        expect(request.patch).toHaveBeenCalledWith(
            '/openapi/v1/omadac1/sites/site-1/wireless-network/wlans/wlan-1/ssids/ssid-guest/update-wlan-schedule',
            { wlanScheduleEnable: false }
        );
        expect(result).toMatchObject({ ssidId: 'ssid-guest', ssidName: 'Tower-Guest', enabled: true });
    });

    it('resolves the SSID case-insensitively by name, or exactly by ssidId', async () => {
        request.get.mockResolvedValue(ok(WLANS));
        request.patch.mockResolvedValue(ok());

        await ops.setSsidEnabled('tower-guest', true);
        await ops.setSsidEnabled('ssid-main', true);

        expect(request.patch).toHaveBeenCalledTimes(2);
        expect(request.patch.mock.calls[1][0]).toContain('/ssids/ssid-main/');
    });

    it('disables an SSID by applying a radio-off schedule with the reusable 24/7 profile', async () => {
        request.get
            .mockResolvedValueOnce(ok(WLANS)) // listAllSsids
            .mockResolvedValueOnce(ok([{ profileId: 'prof-247', name: ALWAYS_PROFILE_NAME }])); // profiles: exists
        request.patch.mockResolvedValue(ok());

        const result = await ops.setSsidEnabled('Tower-Guest', false);

        expect(request.post).not.toHaveBeenCalled(); // profile existed — no create
        expect(request.patch).toHaveBeenCalledWith(
            expect.stringContaining('/ssids/ssid-guest/update-wlan-schedule'),
            { wlanScheduleEnable: true, action: 0, scheduleId: 'prof-247' }
        );
        expect(result).toMatchObject({ enabled: false, scheduleId: 'prof-247' });
    });

    it('creates the 24/7 profile once when missing (and re-lists for its id — the API returns none)', async () => {
        request.get
            .mockResolvedValueOnce(ok(WLANS)) // listAllSsids
            .mockResolvedValueOnce(ok([{ profileId: 'other', name: 'unrelated' }])) // profiles: missing
            .mockResolvedValueOnce(ok([{ profileId: 'prof-new', name: ALWAYS_PROFILE_NAME }])); // re-list after create
        request.post.mockResolvedValue(ok());
        request.patch.mockResolvedValue(ok());

        const result = await ops.setSsidEnabled('Tower-Guest', false);

        expect(request.post).toHaveBeenCalledWith(
            '/openapi/v1/omadac1/sites/site-1/time-range-profiles',
            expect.objectContaining({
                name: ALWAYS_PROFILE_NAME,
                dayMode: 0,
                timeList: [expect.objectContaining({ startTimeH: 0, endTimeH: 24 })],
            })
        );
        expect(result.scheduleId).toBe('prof-new');
    });

    it('rejects an unknown SSID and lists the available ones', async () => {
        request.get.mockResolvedValueOnce(ok(WLANS));

        await expect(ops.setSsidEnabled('DoesNotExist', false)).rejects.toThrow(
            /not found.*Tower.*Tower-Guest/s
        );
        expect(request.patch).not.toHaveBeenCalled();
    });
});
