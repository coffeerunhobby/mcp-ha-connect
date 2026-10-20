/**
 * The raw gateway ACL and group endpoints behind the net_ rules, through the real request
 * handler against a mocked fetch: HTTP method, path (ids encoded), body, and that a
 * controller error reaches the caller. Bodies and paths as verified on the live
 * controller (6.3.0.45, 2026-10-20).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import type { AuthManager } from '../../src/omadaClient/auth.js';
import { NetworkConfigOperations } from '../../src/omadaClient/networkConfig.js';
import { OmadaApiError, RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

vi.mock('../../src/utils/logger.js');

const BASE = 'https://controller.test:8043';
const SITE = '/openapi/v1/c1/sites/site-1';

function setup(answer: { errorCode: number; msg?: string; result?: unknown } = { errorCode: 0, result: [] }) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        calls.push({ method: String(init?.method), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const auth = { getAccessToken: vi.fn(async () => 'token') } as unknown as AuthManager;
    const request = new RequestHandler({ baseUrl: BASE, strictSsl: true }, auth);
    const site = { resolveSiteId: (id?: string) => id ?? 'site-1' } as unknown as SiteOperations;
    const ops = new NetworkConfigOperations(request, site, (path: string, version?: string) => `/openapi/${version ?? 'v1'}/c1${path}`);
    return { ops, calls };
}

describe('gateway ACL and group endpoints', () => {
    afterEach(() => vi.restoreAllMocks());

    it('lists IP groups (0) and IP-port groups (1) by type', async () => {
        const { ops, calls } = setup({ errorCode: 0, result: [{ groupId: 'g1', name: 'HA' }] });

        expect(await ops.listGroups(0)).toEqual([{ groupId: 'g1', name: 'HA' }]);
        await ops.listGroups(1);

        expect(calls.map((c) => [c.method, c.url])).toEqual([
            ['GET', `${BASE}${SITE}/profiles/groups/0`],
            ['GET', `${BASE}${SITE}/profiles/groups/1`],
        ]);
    });

    it('creates a group with the body as given, and deletes one by type and encoded id', async () => {
        const { ops, calls } = setup();
        const body = { name: '[net:12345678] to 0011223344556677', type: 1, ipList: [{ ip: '192.0.2.19', mask: 32 }], portType: 0, portList: ['1883', '8123'] };

        await ops.createGroup(body);
        await ops.deleteGroup(1, 'g/1?x');

        expect(calls).toEqual([
            { method: 'POST', url: `${BASE}${SITE}/profiles/groups`, body },
            { method: 'DELETE', url: `${BASE}${SITE}/profiles/groups/1/g%2F1%3Fx`, body: undefined },
        ]);
    });

    it('creates, replaces (PUT) and deletes a gateway ACL, ids encoded', async () => {
        const { ops, calls } = setup();
        const body = { description: 'IoT to Home [net:12345678]', status: true, policy: 0, protocols: [256], sourceType: 0, sourceIds: ['n1'], destinationType: 0, destinationIds: ['n2'], syslog: false, direction: { lanToWan: false, lanToLan: true, wanInIds: [], vpnInIds: [] }, stateMode: 0 };

        await ops.createGatewayAcl(body);
        await ops.updateGatewayAcl('acl/1', { ...body, status: false });
        await ops.deleteGatewayAcl('acl/1');

        expect(calls).toEqual([
            { method: 'POST', url: `${BASE}${SITE}/acls/osg-acls`, body },
            { method: 'PUT', url: `${BASE}${SITE}/acls/osg-acls/acl%2F1`, body: { ...body, status: false } },
            { method: 'DELETE', url: `${BASE}${SITE}/acls/acl%2F1`, body: undefined },
        ]);
    });

    it('reorders gateway ACLs with the gateway envelope', async () => {
        const { ops, calls } = setup();

        await ops.reorderGatewayAcls({ 'acl-2': 1, 'acl-1': 2 });

        expect(calls).toEqual([{ method: 'POST', url: `${BASE}${SITE}/acls/modifyIndex`, body: { type: 'gateway', indexes: { 'acl-2': 1, 'acl-1': 2 } } }]);
    });

    it('passes a controller refusal on as an error, for every write', async () => {
        const { ops } = setup({ errorCode: -1001, msg: 'portType should be a value as follows: 0: port range 1: port mask.' });

        for (const write of [
            () => ops.createGroup({ name: 'x', type: 1 }),
            () => ops.deleteGroup(0, 'g1'),
            () => ops.createGatewayAcl({}),
            () => ops.updateGatewayAcl('a1', {}),
            () => ops.deleteGatewayAcl('a1'),
            () => ops.reorderGatewayAcls({}),
            () => ops.listGroups(0),
        ]) {
            await expect(write()).rejects.toBeInstanceOf(OmadaApiError);
        }
    });
});
