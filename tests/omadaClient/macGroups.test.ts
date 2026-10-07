/**
 * MAC group entries (add / rename / remove) as a guarded read-modify-write.
 */

import { describe, it, expect, vi } from 'vitest';

import { MacGroupOperations, MAC_GROUP_TYPE, type MacGroup } from '../../src/omadaClient/macGroups.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

const buildPath = (p: string): string => `/openapi/v1/omadac1${p}`;
const ok = (result?: unknown) => ({ errorCode: 0, result });

const knownWifi = (): MacGroup => ({
    groupId: 'g-known',
    name: 'KnownWiFi',
    type: MAC_GROUP_TYPE,
    macAddressList: [
        { ruleId: 1, name: 'tv', macAddress: 'AA-BB-CC-DD-EE-01' },
        { ruleId: 2, name: 'node-1271', macAddress: '4C-1D-96-8D-37-C7' },
    ],
});

/** Each GET returns the next list; the last one repeats. */
function setup(groupsPerRead: MacGroup[][]) {
    const get = vi.fn();
    groupsPerRead.forEach((groups, i) =>
        i === groupsPerRead.length - 1 ? get.mockResolvedValue(ok(groups)) : get.mockResolvedValueOnce(ok(groups))
    );
    const request = {
        get,
        patch: vi.fn().mockResolvedValue(ok()),
        ensureSuccess: vi.fn((r: { errorCode: number; msg?: string; result?: unknown }) => {
            if (r.errorCode !== 0) throw new Error(r.msg ?? 'error');
            return r.result;
        }),
    };
    const site = { resolveSiteId: vi.fn(() => 'site-1') } as unknown as SiteOperations;
    return { request, ops: new MacGroupOperations(request as unknown as RequestHandler, site, buildPath) };
}

describe('MacGroupOperations', () => {
    it('lists MAC groups (type 2)', async () => {
        const { request, ops } = setup([[knownWifi()]]);

        await expect(ops.listMacGroups()).resolves.toHaveLength(1);
        expect(request.get).toHaveBeenCalledWith('/openapi/v1/omadac1/sites/site-1/profiles/groups/2');
    });

    it('adds an entry, writing the whole list back with the MAC normalized', async () => {
        const { request, ops } = setup([[knownWifi()]]);

        const result = await ops.setMacGroupEntry('knownwifi', 'aa:bb:cc:dd:ee:02', 'phone');

        expect(result).toEqual({ group: { groupId: 'g-known', name: 'KnownWiFi' }, mac: 'AA-BB-CC-DD-EE-02', action: 'added', entries: { before: 2, after: 3 } });
        expect(request.patch).toHaveBeenCalledWith('/openapi/v1/omadac1/sites/site-1/profiles/groups/2/g-known', {
            name: 'KnownWiFi',
            type: 2,
            macAddressList: [
                { name: 'tv', macAddress: 'AA-BB-CC-DD-EE-01' },
                { name: 'node-1271', macAddress: '4C-1D-96-8D-37-C7' },
                { name: 'phone', macAddress: 'AA-BB-CC-DD-EE-02' },
            ],
        });
    });

    it('renames an existing entry instead of adding a duplicate', async () => {
        const { request, ops } = setup([[knownWifi()]]);

        await expect(ops.setMacGroupEntry('g-known', '4c1d968d37c7', 'son laptop')).resolves.toMatchObject({ action: 'renamed', entries: { before: 2, after: 2 } });
        expect(request.patch.mock.calls[0][1].macAddressList[1]).toEqual({ name: 'son laptop', macAddress: '4C-1D-96-8D-37-C7' });
    });

    it('does not write when nothing changes', async () => {
        const { request, ops } = setup([[knownWifi()]]);

        await expect(ops.setMacGroupEntry('KnownWiFi', '4C-1D-96-8D-37-C7', 'node-1271')).resolves.toMatchObject({ action: 'unchanged' });
        await expect(setup([[knownWifi()]]).ops.removeMacGroupEntry('KnownWiFi', 'AA-BB-CC-DD-EE-99')).resolves.toMatchObject({ action: 'not-present' });
        expect(request.patch).not.toHaveBeenCalled();
    });

    it('removes an entry', async () => {
        const { request, ops } = setup([[knownWifi()]]);

        await expect(ops.removeMacGroupEntry('KnownWiFi', '4C-1D-96-8D-37-C7')).resolves.toMatchObject({ action: 'removed', entries: { before: 2, after: 1 } });
        expect(request.patch.mock.calls[0][1].macAddressList).toEqual([{ name: 'tv', macAddress: 'AA-BB-CC-DD-EE-01' }]);
    });

    it('refuses the write if the group changed between the read and the write', async () => {
        const changed = knownWifi();
        changed.macAddressList!.push({ ruleId: 3, name: 'new', macAddress: 'AA-BB-CC-DD-EE-03' });
        const { request, ops } = setup([[knownWifi()], [knownWifi()], [changed]]);

        await expect(ops.removeMacGroupEntry('KnownWiFi', '4C-1D-96-8D-37-C7')).rejects.toThrow(/changed while preparing.*nothing was written/);
        expect(request.patch).not.toHaveBeenCalled();
    });

    it('refuses the write if the group was renamed in between', async () => {
        const { request, ops } = setup([[knownWifi()], [knownWifi()], [{ ...knownWifi(), name: 'Family' }]]);

        await expect(ops.setMacGroupEntry('KnownWiFi', 'AA-BB-CC-DD-EE-02', 'phone')).rejects.toThrow(/changed while preparing/);
        expect(request.patch).not.toHaveBeenCalled();
    });

    it('serializes concurrent changes to one group so neither is lost', async () => {
        // A controller that holds state, with GETs and PATCHes that yield in between.
        let state = knownWifi();
        const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
        const request = {
            get: vi.fn(async () => {
                await tick();
                return ok([structuredClone(state)]);
            }),
            patch: vi.fn(async (_path: string, body: { macAddressList: Array<{ name: string; macAddress: string }> }) => {
                await tick();
                state = { ...state, macAddressList: body.macAddressList };
                return ok();
            }),
            ensureSuccess: (r: { result?: unknown }) => r.result,
        };
        const site = { resolveSiteId: () => 'site-1' } as unknown as SiteOperations;
        const ops = new MacGroupOperations(request as unknown as RequestHandler, site, buildPath);

        const results = await Promise.all([
            ops.removeMacGroupEntry('KnownWiFi', 'AA-BB-CC-DD-EE-01'),
            ops.setMacGroupEntry('KnownWiFi', 'AA-BB-CC-DD-EE-02', 'phone'),
        ]);

        expect(results.map((r) => r.action)).toEqual(['removed', 'added']);
        expect(state.macAddressList!.map((e) => e.macAddress)).toEqual(['4C-1D-96-8D-37-C7', 'AA-BB-CC-DD-EE-02']);
    });

    it.each([
        ['an unknown group', [knownWifi()], 'Guests', /not found. Available: KnownWiFi \(g-known\)/],
        ['an ambiguous name', [knownWifi(), { ...knownWifi(), groupId: 'g-2' }], 'KnownWiFi', /Several MAC groups are named/],
        ['a built-in group', [{ ...knownWifi(), buildIn: true }], 'KnownWiFi', /built in and cannot be modified/],
    ])('refuses %s', async (_label, groups, group, error) => {
        const { request, ops } = setup([groups as MacGroup[]]);

        await expect(ops.setMacGroupEntry(group as string, 'AA-BB-CC-DD-EE-02', 'x')).rejects.toThrow(error as RegExp);
        expect(request.patch).not.toHaveBeenCalled();
    });

    it('refuses an incomplete MAC or empty name before any call', async () => {
        const { request, ops } = setup([]);

        await expect(ops.setMacGroupEntry('KnownWiFi', '4C-1D-96', 'x')).rejects.toThrow(/not a complete MAC address/);
        await expect(ops.setMacGroupEntry('KnownWiFi', '4C-1D-96-8D-37-C7', '   ')).rejects.toThrow(/1 to 128 characters/);
        expect(request.get).not.toHaveBeenCalled();
    });
});
