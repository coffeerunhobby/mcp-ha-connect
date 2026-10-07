/**
 * The Home Assistant WebSocket connections follow HA_STRICT_SSL like the REST
 * client: certificate verification is skipped only when strictSsl is false.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const constructed: Array<{ url: string; options: Record<string, unknown> | undefined }> = [];

vi.mock('ws', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ws')>();
    class RecordingWebSocket extends actual.WebSocket {
        constructor(url: string, options?: Record<string, unknown>) {
            constructed.push({ url, options });
            super(url, options as never);
            this.on('error', () => undefined);
        }
    }
    return { ...actual, default: RecordingWebSocket, WebSocket: RecordingWebSocket };
});

const { EventSubscriber } = await import('../../src/haClient/events.js');
const { createHaWebSocketCommand } = await import('../../src/haClient/wsCommand.js');

// Port 9 (discard) on localhost: the connection fails fast; only the options matter.
const HTTPS_HA = 'https://127.0.0.1:9';

describe('WebSocket TLS policy', () => {
    beforeEach(() => {
        constructed.length = 0;
    });

    it.each([
        [undefined, true],
        [true, true],
        [false, false],
    ])('strictSsl=%s -> rejectUnauthorized=%s (event subscriber)', async (strictSsl, expected) => {
        const subscriber = new EventSubscriber({ baseUrl: HTTPS_HA, token: 't', strictSsl, maxReconnectAttempts: 0, connectTimeout: 500 });
        await subscriber.connect().catch(() => undefined);
        subscriber.disconnect();

        expect(constructed[0].url).toBe('wss://127.0.0.1:9/api/websocket');
        expect(constructed[0].options).toMatchObject({ rejectUnauthorized: expected });
    });

    it('the one-shot command used for traces passes the policy through', async () => {
        const command = createHaWebSocketCommand({ baseUrl: HTTPS_HA, token: 't', strictSsl: false, timeoutMs: 500 });
        await command({ type: 'trace/list' }).catch(() => undefined);

        expect(constructed[0].options).toMatchObject({ rejectUnauthorized: false });
    });
});
