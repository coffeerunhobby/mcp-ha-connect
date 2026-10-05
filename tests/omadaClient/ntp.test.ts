/**
 * Unit tests for the site NTP operations:
 *  - ntpAddressError / buildSiteUpdateBody (pure helpers)
 *  - SiteOperations.getSiteNtpStatus / setSiteNtpServers (read-modify-write of PUT /sites/{siteId})
 *  - the omada_getSiteNtpStatus / omada_setSiteNtpServers tools (RBAC + argument plumbing)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';

import type { OmadaClient } from '../../src/omadaClient/index.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import { SiteOperations, buildSiteUpdateBody, ntpAddressError, type OmadaSiteInfo } from '../../src/omadaClient/site.js';
import { registerGetSiteNtpStatusTool } from '../../src/tools/omada/getSiteNtpStatus.js';
import { registerSetSiteNtpServersTool } from '../../src/tools/omada/setSiteNtpServers.js';
import { Permission } from '../../src/permissions/index.js';

const buildPath = (p: string): string => `/openapi/v1/omadac1${p.startsWith('/') ? p : `/${p}`}`;

function createMockRequest() {
    return {
        get: vi.fn(),
        put: vi.fn(),
        // Mirrors the real ensureSuccess: unwrap result, throw on errorCode !== 0
        ensureSuccess: vi.fn((response: { errorCode: number; msg?: string; result?: unknown }) => {
            if (response.errorCode !== 0) {
                throw new Error(response.msg ?? `Omada error ${String(response.errorCode)}`);
            }
            return response.result;
        }),
    };
}

const ok = (result?: unknown) => ({ errorCode: 0, msg: 'Success', result });

/** A site as GET /sites/{siteId} returns it, including read-only DST fields. */
function siteFixture(overrides: Partial<OmadaSiteInfo> = {}): OmadaSiteInfo {
    return {
        siteId: 'site-1',
        name: 'Tower',
        type: 0,
        tagIds: ['tag-a'],
        region: 'RO',
        timeZone: 'Europe/Bucharest',
        scenario: 'Home',
        ntpEnable: false,
        ntpServers: ['old.example.org'],
        dst: {
            enable: true,
            mode: 1,
            start: { month: 3, serial: 5, day: 7, hour: 3, minute: 0 },
            end: { month: 10, serial: 5, day: 7, hour: 4, minute: 0 },
            offset: 3600000,
            status: true,
            startTime: 1774746000000,
            endTime: 1792890000000,
            nextStart: 1806195600000,
        },
        longitude: 25.6,
        latitude: 45.65,
        address: 'Brasov',
        supportES: true,
        supportL2: true,
        ...overrides,
    };
}

const APPROVED = ['82.76.255.14', '194.102.58.251'];

describe('ntpAddressError', () => {
    it.each(['82.76.255.14', '194.102.58.251', 'time.nipne.ro', 'ro.pool.ntp.org', '0.0.0.0'])(
        'accepts %s',
        (address) => {
            expect(ntpAddressError(address)).toBeNull();
        }
    );

    it.each([
        '999.1.1.1',
        '1.2.3',
        '1.2.3.4.5',
        '01.2.3.4',
        'localhost',
        'http://time.nipne.ro',
        'time nipne.ro',
        '-bad.example.org',
        'x',
        '',
    ])('rejects %s', (address) => {
        expect(ntpAddressError(address)).toMatch(/not a valid/);
    });
});

describe('buildSiteUpdateBody', () => {
    it('carries over every writable site field and changes only NTP', () => {
        const body = buildSiteUpdateBody(siteFixture(), APPROVED, true);

        expect(body).toEqual({
            name: 'Tower',
            region: 'RO',
            timeZone: 'Europe/Bucharest',
            scenario: 'Home',
            tagIds: ['tag-a'],
            ntpEnable: true,
            ntpServers: [{ address: '82.76.255.14' }, { address: '194.102.58.251' }],
            dst: {
                enable: true,
                mode: 1,
                start: { month: 3, serial: 5, day: 7, hour: 3, minute: 0 },
                end: { month: 10, serial: 5, day: 7, hour: 4, minute: 0 },
                offset: 3600000,
            },
            longitude: 25.6,
            latitude: 45.65,
            address: 'Brasov',
            supportES: true,
            supportL2: true,
        });
    });

    it('drops read-only fields (siteId, type, DST status/timestamps)', () => {
        const body = buildSiteUpdateBody(siteFixture(), APPROVED, true) as unknown as Record<string, unknown>;

        expect(body).not.toHaveProperty('siteId');
        expect(body).not.toHaveProperty('type');
        expect(Object.keys(body.dst as object).sort()).toEqual(['enable', 'end', 'mode', 'offset', 'start']);
    });

    it('omits optional fields the site does not have instead of sending undefined', () => {
        const site: OmadaSiteInfo = { region: 'RO', timeZone: 'Europe/Bucharest', scenario: 'Home' };
        const body = buildSiteUpdateBody(site, APPROVED, true);

        expect(Object.keys(body).sort()).toEqual(['ntpEnable', 'ntpServers', 'region', 'scenario', 'timeZone']);
    });

    it.each(['region', 'timeZone', 'scenario'] as const)('refuses to build a body when %s is missing', (field) => {
        const site = siteFixture({ [field]: undefined } as Partial<OmadaSiteInfo>);

        expect(() => buildSiteUpdateBody(site, APPROVED, true)).toThrow(new RegExp(`missing '${field}'.*refusing to write`));
    });
});

describe('SiteOperations NTP', () => {
    let request: ReturnType<typeof createMockRequest>;
    let ops: SiteOperations;

    beforeEach(() => {
        request = createMockRequest();
        ops = new SiteOperations(request as unknown as RequestHandler, buildPath, 'site-1');
    });

    it('getSiteNtpStatus GETs the site ntp setting', async () => {
        request.get.mockResolvedValue(ok({ ntpEnable: true }));

        await expect(ops.getSiteNtpStatus()).resolves.toEqual({ ntpEnable: true });
        expect(request.get).toHaveBeenCalledWith('/openapi/v1/omadac1/sites/site-1/setting/ntp');
    });

    it('dryRun returns the exact PUT body and does not write', async () => {
        request.get.mockResolvedValue(ok(siteFixture()));

        const result = await ops.setSiteNtpServers(APPROVED, { dryRun: true });

        expect(request.put).not.toHaveBeenCalled();
        expect(result.applied).toBe(false);
        expect(result.before).toEqual({ ntpEnable: false, ntpServers: ['old.example.org'] });
        expect(result.after).toEqual({ ntpEnable: true, ntpServers: APPROVED });
        expect(result.request).toEqual(buildSiteUpdateBody(siteFixture(), APPROVED, true));
    });

    it('PUTs the full site body, then reports what the controller holds afterwards', async () => {
        request.get
            .mockResolvedValueOnce(ok(siteFixture()))
            .mockResolvedValueOnce(ok(siteFixture()))
            .mockResolvedValueOnce(ok(siteFixture({ ntpEnable: true, ntpServers: APPROVED })));
        request.put.mockResolvedValue(ok());

        const result = await ops.setSiteNtpServers(APPROVED);

        expect(request.get).toHaveBeenNthCalledWith(1, '/openapi/v1/omadac1/sites/site-1');
        expect(request.put).toHaveBeenCalledWith(
            '/openapi/v1/omadac1/sites/site-1',
            buildSiteUpdateBody(siteFixture(), APPROVED, true)
        );
        expect(request.get).toHaveBeenCalledTimes(3);
        expect(result).toMatchObject({
            siteId: 'site-1',
            siteName: 'Tower',
            applied: true,
            before: { ntpEnable: false, ntpServers: ['old.example.org'] },
            after: { ntpEnable: true, ntpServers: APPROVED },
        });
    });

    it('reports the controller state, even when it differs from the request', async () => {
        request.get
            .mockResolvedValueOnce(ok(siteFixture()))
            .mockResolvedValueOnce(ok(siteFixture()))
            .mockResolvedValueOnce(ok(siteFixture({ ntpEnable: true, ntpServers: ['82.76.255.14'] })));
        request.put.mockResolvedValue(ok());

        const result = await ops.setSiteNtpServers(APPROVED);

        expect(result.after.ntpServers).toEqual(['82.76.255.14']);
    });

    it('uses an explicit siteId and encodes it', async () => {
        request.get.mockResolvedValue(ok(siteFixture()));

        await ops.setSiteNtpServers(APPROVED, { siteId: 'a/b', dryRun: true });

        expect(request.get).toHaveBeenCalledWith('/openapi/v1/omadac1/sites/a%2Fb');
    });

    it('allows turning NTP off with an empty list', async () => {
        request.get.mockResolvedValue(ok(siteFixture({ ntpEnable: true })));

        const result = await ops.setSiteNtpServers([], { enabled: false, dryRun: true });

        expect(result.request.ntpEnable).toBe(false);
        expect(result.request.ntpServers).toEqual([]);
    });

    it.each([
        { servers: [] as string[], enabled: true, error: /At least one NTP server/ },
        { servers: ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5', '6.6.6.6'], enabled: true, error: /at most 5/ },
        { servers: ['82.76.255.14', '999.1.1.1'], enabled: true, error: /'999.1.1.1' is not a valid IPv4/ },
        { servers: ['82.76.255.14', '82.76.255.14'], enabled: true, error: /duplicates/ },
    ])('rejects $servers before contacting the controller', async ({ servers, enabled, error }) => {
        await expect(ops.setSiteNtpServers(servers, { enabled })).rejects.toThrow(error);
        expect(request.get).not.toHaveBeenCalled();
        expect(request.put).not.toHaveBeenCalled();
    });

    it('propagates a controller rejection of the PUT and does not report success', async () => {
        request.get.mockResolvedValue(ok(siteFixture()));
        request.put.mockResolvedValue({ errorCode: -1, msg: 'Permission denied' });

        await expect(ops.setSiteNtpServers(APPROVED)).rejects.toThrow('Permission denied');
        expect(request.get).toHaveBeenCalledTimes(2);
    });

    it('refuses to write when a non-NTP setting changed between the read and the write', async () => {
        request.get
            .mockResolvedValueOnce(ok(siteFixture()))
            .mockResolvedValueOnce(ok(siteFixture({ timeZone: 'Europe/London' })));

        await expect(ops.setSiteNtpServers(APPROVED)).rejects.toThrow(/changed while preparing.*nothing was written/);
        expect(request.put).not.toHaveBeenCalled();
    });

    it('ignores NTP-only differences between the two reads (NTP is what is being set)', async () => {
        request.get
            .mockResolvedValueOnce(ok(siteFixture()))
            .mockResolvedValueOnce(ok(siteFixture({ ntpServers: ['someone.else.org'] })))
            .mockResolvedValueOnce(ok(siteFixture({ ntpEnable: true, ntpServers: APPROVED })));
        request.put.mockResolvedValue(ok());

        await expect(ops.setSiteNtpServers(APPROVED)).resolves.toMatchObject({ applied: true });
    });

    it('serializes concurrent writes to the same site: the second reads only after the first wrote', async () => {
        const events: string[] = [];
        let state = siteFixture();
        request.get.mockImplementation(async () => {
            events.push('get');
            await new Promise((r) => setTimeout(r, 5));
            return ok(state);
        });
        request.put.mockImplementation(async (_path: string, body: { ntpServers: Array<{ address: string }> }) => {
            events.push('put');
            await new Promise((r) => setTimeout(r, 5));
            state = { ...state, ntpEnable: true, ntpServers: body.ntpServers.map((s) => s.address) };
            return ok();
        });

        const [first, second] = await Promise.all([
            ops.setSiteNtpServers(['82.76.255.14']),
            ops.setSiteNtpServers(['194.102.58.251']),
        ]);

        expect(events).toEqual(['get', 'get', 'put', 'get', 'get', 'get', 'put', 'get']);
        expect(first.after.ntpServers).toEqual(['82.76.255.14']);
        expect(second.before.ntpServers).toEqual(['82.76.255.14']);
        expect(second.after.ntpServers).toEqual(['194.102.58.251']);
    });

    it('a failed write does not block the next one', async () => {
        request.get.mockResolvedValue(ok(siteFixture()));
        request.put.mockResolvedValueOnce({ errorCode: -1, msg: 'boom' }).mockResolvedValueOnce(ok());

        await expect(ops.setSiteNtpServers(APPROVED)).rejects.toThrow('boom');
        await expect(ops.setSiteNtpServers(APPROVED)).resolves.toMatchObject({ applied: true });
    });

    it('does not write when the site info lacks a required field', async () => {
        request.get.mockResolvedValue(ok(siteFixture({ scenario: '' })));

        await expect(ops.setSiteNtpServers(APPROVED)).rejects.toThrow(/missing 'scenario'/);
        expect(request.put).not.toHaveBeenCalled();
    });
});

// ---- Tools -------------------------------------------------------------------

type Handler = (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;

function createMockServer() {
    const handlers = new Map<string, Handler>();
    return {
        registerTool: vi.fn((name: string, _config: unknown, handler: Handler) => {
            handlers.set(name, handler);
        }),
        handlers,
    } as unknown as McpServer & { handlers: Map<string, Handler> };
}

const extraWith = (permissions: number) => ({
    sessionId: 'test-session',
    http: { authInfo: { extra: { permissions } } },
});

const parse = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text) as Record<string, unknown>;

describe('omada NTP tools', () => {
    let server: ReturnType<typeof createMockServer>;
    let client: { getSiteNtpStatus: ReturnType<typeof vi.fn>; setSiteNtpServers: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        server = createMockServer();
        client = { getSiteNtpStatus: vi.fn(), setSiteNtpServers: vi.fn() };
        registerGetSiteNtpStatusTool(server, client as unknown as OmadaClient);
        registerSetSiteNtpServersTool(server, client as unknown as OmadaClient);
    });

    it('omada_getSiteNtpStatus needs only QUERY', async () => {
        client.getSiteNtpStatus.mockResolvedValue({ ntpEnable: true });

        const result = await server.handlers.get('omada_getSiteNtpStatus')!({ siteId: 's1' }, extraWith(Permission.QUERY));

        expect(parse(result)).toEqual({ ntpEnable: true });
        expect(client.getSiteNtpStatus).toHaveBeenCalledWith('s1');
    });

    it('omada_setSiteNtpServers is denied to a CONTROL + QUERY caller (needs CONFIGURE)', async () => {
        const result = await server.handlers.get('omada_setSiteNtpServers')!(
            { servers: APPROVED },
            extraWith(Permission.QUERY | Permission.CONTROL)
        );

        expect(parse(result)).toMatchObject({ error: 'Permission denied' });
        expect(parse(result).message).toContain('CONFIGURE');
        expect(client.setSiteNtpServers).not.toHaveBeenCalled();
    });

    it('omada_setSiteNtpServers passes servers and options through for a CONFIGURE caller', async () => {
        client.setSiteNtpServers.mockResolvedValue({ applied: false });

        await server.handlers.get('omada_setSiteNtpServers')!(
            { servers: APPROVED, siteId: 's1', dryRun: true },
            extraWith(Permission.CONFIGURE)
        );

        expect(client.setSiteNtpServers).toHaveBeenCalledWith(APPROVED, { enabled: undefined, siteId: 's1', dryRun: true });
    });
});
