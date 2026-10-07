/**
 * Unblocking clients the controller no longer treats as current, the blocked
 * list, and deleting a client record (for orphaned blocks).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';

import { ClientOperations, CLIENT_DOES_NOT_EXIST, normalizeMac } from '../../src/omadaClient/client.js';
import { OmadaApiError, RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';
import type { OmadaClient } from '../../src/omadaClient/index.js';
import { registerDeleteClientTool } from '../../src/tools/omada/deleteClient.js';
import { registerListBlockedClientsTool } from '../../src/tools/omada/listBlockedClients.js';
import { Permission } from '../../src/permissions/index.js';

const buildPath = (p: string): string => `/openapi/v1/omadac1${p}`;
const MAC = '02-1A-2B-3C-4D-5E';

function setup(knownClients: unknown[] = []) {
    const request = {
        post: vi.fn(),
        request: vi.fn(),
        fetchPaginated: vi.fn().mockResolvedValue(knownClients),
        // Mirrors the real ensureSuccess: a typed error carrying the controller's errorCode.
        ensureSuccess: vi.fn((response: { errorCode: number; msg?: string; result?: unknown }) => {
            if (response.errorCode !== 0) throw new OmadaApiError(response.msg ?? 'Omada error', response.errorCode);
            return response.result;
        }),
    };
    const site = { resolveSiteId: vi.fn(() => 'site-1') } as unknown as SiteOperations;
    return { request, ops: new ClientOperations(request as unknown as RequestHandler, site, buildPath) };
}

const doesNotExist = { errorCode: CLIENT_DOES_NOT_EXIST, msg: 'This client does not exist.' };

describe('normalizeMac', () => {
    it('treats colon, dash and bare formats as the same MAC', () => {
        expect(normalizeMac('02:1a:2b:3c:4d:5e')).toBe(normalizeMac(MAC));
        expect(normalizeMac('021a2b3c4d5e')).toBe('021A2B3C4D5E');
    });
});

describe('ClientOperations.unblockClient', () => {
    it('unblocks normally when the controller knows the client', async () => {
        const { request, ops } = setup();
        request.post.mockResolvedValue({ errorCode: 0 });

        await expect(ops.unblockClient(MAC)).resolves.toEqual({ mac: MAC, siteId: 'site-1', blocked: false });
        expect(request.fetchPaginated).not.toHaveBeenCalled();
    });

    it('reports success when the client is known and no longer blocked (e.g. unblocked in the web UI)', async () => {
        const { request, ops } = setup([{ mac: '02:1a:2b:3c:4d:5e', name: 'laptop-1', block: false }]);
        request.post.mockResolvedValue(doesNotExist);

        await expect(ops.unblockClient(MAC)).resolves.toEqual({ mac: MAC, siteId: 'site-1', blocked: false });
        expect(request.fetchPaginated).toHaveBeenCalledWith('/openapi/v1/omadac1/sites/site-1/insight/clients');
    });

    it('explains the controller limitation when the known client is still blocked', async () => {
        const { request, ops } = setup([{ mac: MAC, name: 'laptop-1', block: true }]);
        request.post.mockResolvedValue(doesNotExist);

        await expect(ops.unblockClient(MAC)).rejects.toThrow(/cannot unblock .* offline.*Known Clients.*omada_deleteClient/);
    });

    it('a known record without block state is not proof of an unblock', async () => {
        const { request, ops } = setup([{ mac: MAC, name: 'laptop-1' }]);
        request.post.mockResolvedValue(doesNotExist);

        await expect(ops.unblockClient(MAC)).rejects.toThrow(/cannot unblock/);
    });

    it('never reports success when the controller has no record at all (an orphaned block may remain)', async () => {
        const { request, ops } = setup([{ mac: 'AA-BB-CC-DD-EE-FF', block: false }]);
        request.post.mockResolvedValue(doesNotExist);

        await expect(ops.unblockClient(MAC)).rejects.toThrow(/no record of .*orphaned block.*omada_deleteClient/);
    });

    it('other controller errors are passed through as before', async () => {
        const { request, ops } = setup();
        request.post.mockResolvedValue({ errorCode: -1, msg: 'General error' });

        await expect(ops.unblockClient(MAC)).rejects.toThrow('General error');
        expect(request.fetchPaginated).not.toHaveBeenCalled();
    });
});

describe('unblockClient through the real request handler', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('handles "client does not exist" sent with an HTTP error status, too', async () => {
        const fetchMock = vi.fn(async (url: string) => {
            if (url.includes('/unblock')) {
                return new Response(JSON.stringify({ errorCode: CLIENT_DOES_NOT_EXIST, msg: 'This client does not exist.' }), { status: 400 });
            }
            // Known clients: present and no longer blocked.
            return new Response(JSON.stringify({ errorCode: 0, result: { totalRows: 1, data: [{ mac: MAC, block: false }] } }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);
        const auth = { getAccessToken: vi.fn().mockResolvedValue('t'), clearToken: vi.fn() };
        const request = new RequestHandler({ baseUrl: 'https://omada.test', strictSsl: true }, auth as never);
        const site = { resolveSiteId: vi.fn(() => 'site-1') } as unknown as SiteOperations;
        const ops = new ClientOperations(request, site, buildPath);

        await expect(ops.unblockClient(MAC)).resolves.toEqual({ mac: MAC, siteId: 'site-1', blocked: false });
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/insight/clients'))).toBe(true);
    });
});

describe('ClientOperations.listBlockedClients / deleteClient', () => {
    it('lists only blocked known clients, offline ones included', async () => {
        const { ops } = setup([
            { mac: MAC, name: 'laptop-1', block: true, lastSeen: 1 },
            { mac: 'AA-BB-CC-DD-EE-FF', name: 'tv', block: false },
            { mac: '11-22-33-44-55-66', name: 'old' },
        ]);

        await expect(ops.listBlockedClients()).resolves.toEqual([{ mac: MAC, name: 'laptop-1', block: true, lastSeen: 1 }]);
    });

    it('deletes the client record with DELETE /clients/{mac}, encoding the MAC', async () => {
        const { request, ops } = setup();
        request.request.mockResolvedValue({ errorCode: 0 });

        await expect(ops.deleteClient(MAC)).resolves.toEqual({ mac: MAC, siteId: 'site-1', deleted: true });
        expect(request.request).toHaveBeenCalledWith({ method: 'DELETE', url: `/openapi/v1/omadac1/sites/site-1/clients/${MAC}` });
    });

    it('surfaces a failed delete', async () => {
        const { request, ops } = setup();
        request.request.mockResolvedValue(doesNotExist);

        await expect(ops.deleteClient(MAC)).rejects.toThrow('This client does not exist.');
    });
});

describe('client block tools: permissions', () => {
    const extra = (permissions: number) => ({ sessionId: 's', http: { authInfo: { extra: { permissions } } } });

    function register() {
        const handlers = new Map<string, (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }>>();
        const server = { registerTool: vi.fn((name, _c, h) => handlers.set(name, h)) } as unknown as McpServer;
        const client = { deleteClient: vi.fn().mockResolvedValue({ deleted: true }), listBlockedClients: vi.fn().mockResolvedValue([]) };
        registerDeleteClientTool(server, client as unknown as OmadaClient);
        registerListBlockedClientsTool(server, client as unknown as OmadaClient);
        return { handlers, client };
    }

    let tools: ReturnType<typeof register>;
    beforeEach(() => {
        tools = register();
    });

    it('omada_deleteClient needs CONFIGURE (CONTROL is not enough)', async () => {
        const denied = await tools.handlers.get('omada_deleteClient')!({ clientMac: MAC }, extra(Permission.QUERY | Permission.CONTROL));
        expect(JSON.parse(denied.content[0].text)).toMatchObject({ error: 'Permission denied' });
        expect(tools.client.deleteClient).not.toHaveBeenCalled();

        await tools.handlers.get('omada_deleteClient')!({ clientMac: MAC }, extra(Permission.CONFIGURE));
        expect(tools.client.deleteClient).toHaveBeenCalledWith(MAC, undefined);
    });

    it('omada_listBlockedClients needs only QUERY', async () => {
        await tools.handlers.get('omada_listBlockedClients')!({}, extra(Permission.QUERY));
        expect(tools.client.listBlockedClients).toHaveBeenCalled();
    });
});
