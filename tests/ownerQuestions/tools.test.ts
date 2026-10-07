/**
 * askOwner / getOwnerAnswer / cancelOwnerQuestion tools: input validation,
 * RBAC, caller binding, log redaction, and a real MCP round trip.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { OwnerQuestionService } from '../../src/ownerQuestions/service.js';
import { registerOwnerQuestionTools, askOwnerSchema } from '../../src/tools/homeassistant/askOwner.js';
import { createServer } from '../../src/server/common.js';
import { Permission, Role } from '../../src/permissions/index.js';
import { setLocalFullTrust } from '../../src/tools/common.js';
import { logger } from '../../src/utils/logger.js';

type Handler = (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function createMockServer() {
    const handlers = new Map<string, Handler>();
    return {
        registerTool: vi.fn((name: string, _config: unknown, handler: Handler) => handlers.set(name, handler)),
        handlers,
    } as unknown as McpServer & { handlers: Map<string, Handler> };
}

const extraFor = (sub: string, permissions: number) => ({
    sessionId: 's',
    http: { authInfo: { token: '', clientId: sub, scopes: [], extra: { permissions } } },
});

const parse = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text) as Record<string, unknown>;

const valid = { question: 'Aprinzi lumina în baie?', target: 'mobile_app_phone_user5' };

function makeService() {
    const notify = vi.fn().mockResolvedValue([]);
    const service = new OwnerQuestionService({ notify, subscribe: vi.fn().mockResolvedValue('s'), secret: 'k'.repeat(40) });
    return { service, notify };
}

describe('askOwner input validation', () => {
    it('accepts plain text including Romanian diacritics, and applies defaults', () => {
        const parsed = askOwnerSchema.parse(valid);
        expect(parsed.question).toBe('Aprinzi lumina în baie?');
        expect(parsed.buttons).toBeUndefined();
    });

    it('NFC-normalizes text (a decomposed ș becomes one character)', () => {
        expect(askOwnerSchema.parse({ ...valid, question: 'ș?' }).question).toBe('ș?');
    });

    it.each([
        ['an emoji', { question: 'Approve? 👍' }, /U\+1F44D/],
        ['a zero-width joiner', { question: 'ok‍ok' }, /U\+200D/],
        ['a right-to-left override', { question: 'pay ‮evil' }, /U\+202E/],
        ['stacked combining marks', { question: 'á́' }, /U\+0301/],
        ['a 257-character question', { question: 'x'.repeat(257) }, /257 characters; the maximum is 256/],
        ['a line break in the title', { title: 'two\nlines' }, /title contains a disallowed character U\+000A/],
        ['a 61-character title', { title: 't'.repeat(61) }, /maximum is 60/],
        ['an emoji button', { buttons: ['Yes ✅', 'No'] }, /button label/],
        ['four buttons', { buttons: ['a', 'b', 'c', 'd'] }, /3/],
        ['duplicate buttons', { buttons: ['Yes', 'yes'] }, /unique/],
        ['a non-mobile target', { target: 'persistent_notification' }, /mobile app notify service/],
        ['a timeout over 7 days', { timeoutSeconds: 7 * 24 * 3600 + 1 }, /604800/],
        ['a timeout under a minute', { timeoutSeconds: 59 }, /60/],
    ])('refuses %s', (_name, overrides, error) => {
        const result = askOwnerSchema.safeParse({ ...valid, ...overrides });
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error!.issues)).toMatch(error);
    });

    it('accepts a 256-character question with line breaks', () => {
        const question = `${'x'.repeat(100)}\n${'y'.repeat(155)}`;
        expect(askOwnerSchema.parse({ ...valid, question }).question).toBe(question);
    });
});

describe('owner question tools', () => {
    let server: ReturnType<typeof createMockServer>;
    let service: OwnerQuestionService;
    let notify: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        server = createMockServer();
        ({ service, notify } = makeService());
        registerOwnerQuestionTools(server, service);
    });

    it('registers askOwner, getOwnerAnswer and cancelOwnerQuestion', () => {
        expect([...server.handlers.keys()]).toEqual(['askOwner', 'getOwnerAnswer', 'cancelOwnerQuestion']);
    });

    it.each(['askOwner', 'getOwnerAnswer', 'cancelOwnerQuestion'])('%s requires NOTIFY', async (tool) => {
        const result = await server.handlers.get(tool)!({ ...valid, requestId: 'x' }, extraFor('reader', Role.READONLY));
        expect(parse(result)).toMatchObject({ error: 'Permission denied' });
        expect(String(parse(result).message)).toContain('NOTIFY');
        expect(notify).not.toHaveBeenCalled();
    });

    it('askOwner applies the default title, buttons and timeout', async () => {
        const result = await server.handlers.get('askOwner')!(valid, extraFor('approver', Permission.NOTIFY));

        expect(parse(result)).toHaveProperty('requestId');
        expect(notify.mock.calls[0][1]).toMatchObject({ title: 'Approval needed', data: { timeout: 600 } });
        expect(notify.mock.calls[0][1].data.actions.map((a: { title: string }) => a.title)).toEqual(['Approve', 'Deny']);
    });

    it('binds the question to the asking token sub', async () => {
        const asked = parse(await server.handlers.get('askOwner')!(valid, extraFor('approver', Permission.NOTIFY)));

        const own = await server.handlers.get('getOwnerAnswer')!({ requestId: asked.requestId, waitSeconds: 0 }, extraFor('approver', Permission.NOTIFY));
        const other = await server.handlers.get('getOwnerAnswer')!({ requestId: asked.requestId, waitSeconds: 0 }, extraFor('harvey', Permission.NOTIFY));

        expect(parse(own)).toMatchObject({ status: 'pending' });
        expect(other.isError).toBe(true);
        expect(String(parse(other).message)).toMatch(/different client/);
    });

    it('logs tool arguments (the question text) at debug level only', async () => {
        const info = vi.spyOn(logger, 'info');
        const debug = vi.spyOn(logger, 'debug');
        try {
            await server.handlers.get('askOwner')!(
                { ...valid, question: 'Secret plan: unlock the front door?' },
                extraFor('approver', Permission.NOTIFY)
            );
            expect(JSON.stringify(info.mock.calls)).not.toContain('unlock the front door');
            expect(JSON.stringify(info.mock.calls)).toContain('Tool invoked');
            expect(JSON.stringify(debug.mock.calls)).toContain('unlock the front door');
        } finally {
            info.mockRestore();
            debug.mockRestore();
        }
    });
});

describe('owner question tools over MCP', () => {
    beforeEach(() => setLocalFullTrust(true));
    afterEach(() => setLocalFullTrust(false));

    it('are listed with a JSON Schema and callable end to end', async () => {
        const { service, notify } = makeService();
        const server = createServer({ haClient: {} as never, ownerQuestions: service });
        const client = new Client({ name: 'ask-owner-test', version: '0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        try {
            const { tools } = await client.listTools();
            const askOwner = tools.find((t) => t.name === 'askOwner');
            expect(askOwner?.inputSchema.required).toEqual(['question', 'target']);
            expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['getOwnerAnswer', 'cancelOwnerQuestion']));

            const asked = await client.callTool({ name: 'askOwner', arguments: { ...valid, buttons: ['Da', 'Nu'] } });
            const { requestId } = JSON.parse((asked.content as Array<{ text: string }>)[0].text);
            expect(notify).toHaveBeenCalledTimes(1);

            const answer = await client.callTool({ name: 'getOwnerAnswer', arguments: { requestId, waitSeconds: 0 } });
            expect(JSON.parse((answer.content as Array<{ text: string }>)[0].text)).toMatchObject({
                status: 'pending',
                buttons: ['Da', 'Nu'],
            });

            const refused = await client.callTool({ name: 'askOwner', arguments: { ...valid, question: 'ok 👍' } });
            expect(refused.isError).toBe(true);
            expect(notify).toHaveBeenCalledTimes(1);
        } finally {
            await client.close();
            await server.close();
        }
    });

    it('are not registered when no owner question service is running', async () => {
        const server = createServer({ haClient: {} as never });
        const client = new Client({ name: 'ask-owner-test', version: '0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        try {
            const { tools } = await client.listTools();
            expect(tools.map((t) => t.name)).not.toContain('askOwner');
        } finally {
            await client.close();
            await server.close();
        }
    });
});
