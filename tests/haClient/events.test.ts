/**
 * EventSubscriber against a fake Home Assistant WebSocket server: commands are
 * matched to results by id, each event copy reaches only its own subscription,
 * and subscriptions are restored after a reconnect.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

import { EventSubscriber, HaCommandError, type HaEvent } from '../../src/haClient/events.js';
import { logger } from '../../src/utils/logger.js';
import { createHaWebSocketCommand } from '../../src/haClient/wsCommand.js';

interface FakeHa {
    url: string;
    received: Array<Record<string, unknown>>;
    sockets: WebSocket[];
    /** Reply to a command; default: success with an empty result. */
    onCommand: (message: Record<string, unknown>, socket: WebSocket) => void;
    close: () => Promise<void>;
}

async function fakeHa(): Promise<FakeHa> {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const fake: FakeHa = {
        url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
        received: [],
        sockets: [],
        onCommand: (message, socket) => socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: null })),
        close: () =>
            new Promise((resolve) => {
                for (const socket of fake.sockets) socket.terminate();
                wss.close(() => resolve());
            }),
    };
    wss.on('connection', (socket) => {
        fake.sockets.push(socket);
        socket.send(JSON.stringify({ type: 'auth_required' }));
        socket.on('message', (raw) => {
            const message = JSON.parse(raw.toString()) as Record<string, unknown>;
            fake.received.push(message);
            if (message.type === 'auth') {
                socket.send(JSON.stringify({ type: 'auth_ok' }));
            } else {
                fake.onCommand(message, socket);
            }
        });
    });
    return fake;
}

const sendEvent = (socket: WebSocket, subscriptionId: number, eventType: string, data: Record<string, unknown> = {}) =>
    socket.send(
        JSON.stringify({
            id: subscriptionId,
            type: 'event',
            event: { event_type: eventType, data, origin: 'REMOTE', time_fired: '', context: { id: 'c', parent_id: null, user_id: 'u' } },
        })
    );

const until = async (condition: () => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((r) => setTimeout(r, 10));
    }
};

describe('EventSubscriber', () => {
    let fake: FakeHa;
    let subscriber: EventSubscriber;

    afterEach(async () => {
        subscriber?.disconnect();
        await fake?.close();
    });

    it('matches results to commands by id, even when HA answers out of order', async () => {
        fake = await fakeHa();
        const pending: Array<Record<string, unknown>> = [];
        fake.onCommand = (message, socket) => {
            pending.push(message);
            if (pending.length === 2) {
                for (const m of [...pending].reverse()) {
                    socket.send(JSON.stringify({ id: m.id, type: 'result', success: true, result: { echo: m.type } }));
                }
            }
        };
        subscriber = new EventSubscriber({ baseUrl: fake.url, token: 't' });
        await subscriber.connect();

        const [a, b] = await Promise.all([subscriber.sendCommand({ type: 'first' }), subscriber.sendCommand({ type: 'second' })]);

        expect(a).toEqual({ echo: 'first' });
        expect(b).toEqual({ echo: 'second' });
    });

    it('rejects a failed command with HA\'s error code only, never its free-text message', async () => {
        fake = await fakeHa();
        fake.onCommand = (message, socket) =>
            socket.send(
                JSON.stringify({
                    id: message.id,
                    type: 'result',
                    success: false,
                    error: { code: 'unauthorized', message: 'Denied for https://ha.internal:8123/api?token=SECRET123' },
                })
            );
        subscriber = new EventSubscriber({ baseUrl: fake.url, token: 't' });

        const error = await subscriber.sendCommand({ type: 'trace/list' }).catch((e: Error) => e);
        expect((error as Error).message).toBe("Home Assistant rejected 'trace/list' (unauthorized)");
        expect((error as Error).message).not.toContain('SECRET123');
    });

    it('never logs Home Assistant\'s free-text error message, at any level', async () => {
        fake = await fakeHa();
        fake.onCommand = (message, socket) =>
            socket.send(JSON.stringify({ id: message.id, type: 'result', success: false, error: { code: 'unauthorized', message: 'see https://ha/api?token=SECRET123' } }));
        subscriber = new EventSubscriber({ baseUrl: fake.url, token: 't' });
        const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(logger, level));
        try {
            await subscriber.sendCommand({ type: 'trace/list' }).catch(() => undefined);
            for (const spy of spies) {
                expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRET123');
            }
        } finally {
            for (const spy of spies) spy.mockRestore();
        }
    });

    it('a subscription Home Assistant refuses is reported to the caller and dropped', async () => {
        fake = await fakeHa();
        fake.onCommand = (message, socket) =>
            socket.send(JSON.stringify({ id: message.id, type: 'result', success: false, error: { code: 'unauthorized', message: 'Unauthorized' } }));
        subscriber = new EventSubscriber({ baseUrl: fake.url, token: 't' });
        await subscriber.connect();

        const error = await subscriber.subscribeEventType('mobile_app_notification_action', () => undefined).catch((e: Error) => e);

        expect(error).toBeInstanceOf(HaCommandError);
        expect((error as HaCommandError).code).toBe('unauthorized');
        expect(subscriber.getSubscriptionCount()).toBe(0);
    });

    it('a refusal seen after a reconnect goes to onRejected and drops the subscription', async () => {
        fake = await fakeHa();
        subscriber = new EventSubscriber({ baseUrl: fake.url, token: 't', reconnectInterval: 20 });
        const rejected: HaCommandError[] = [];
        await subscriber.subscribeEventType('mobile_app_notification_action', () => undefined, (e) => rejected.push(e));

        // After the reconnect the token is no longer an admin.
        fake.onCommand = (message, socket) =>
            socket.send(JSON.stringify({ id: message.id, type: 'result', success: false, error: { code: 'unauthorized', message: 'no' } }));
        fake.sockets[0].terminate();

        await until(() => rejected.length === 1);
        expect(rejected[0].code).toBe('unauthorized');
        expect(subscriber.getSubscriptionCount()).toBe(0);
    });

    it('a refusal after an offline start reaches onRejected', async () => {
        const probe = await fakeHa();
        const url = probe.url;
        const port = Number(new URL(url).port);
        await probe.close();

        subscriber = new EventSubscriber({ baseUrl: url, token: 't', reconnectInterval: 20, maxReconnectDelay: 50 });
        const rejected: HaCommandError[] = [];
        // HA is down: queued, no error.
        await subscriber.subscribeEventType('mobile_app_notification_action', () => undefined, (e) => rejected.push(e));

        // HA comes up with a non-admin token: the subscription is refused.
        const wss = new WebSocketServer({ port });
        fake = { url, received: [], sockets: [], onCommand: () => undefined, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }) };
        wss.on('connection', (socket) => {
            fake.sockets.push(socket);
            socket.send(JSON.stringify({ type: 'auth_required' }));
            socket.on('message', (raw) => {
                const m = JSON.parse(raw.toString()) as Record<string, unknown>;
                fake.received.push(m);
                socket.send(JSON.stringify(m.type === 'auth' ? { type: 'auth_ok' } : { id: m.id, type: 'result', success: false, error: { code: 'unauthorized', message: 'no' } }));
            });
        });

        await until(() => rejected.length === 1);
        expect(rejected[0].code).toBe('unauthorized');
        expect(subscriber.getSubscriptionCount()).toBe(0);
    });

    it('delivers an event HA sends right after the confirmation, in the same read', async () => {
        fake = await fakeHa();
        fake.onCommand = (message, socket) => {
            socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: null }));
            if (message.type === 'subscribe_events') {
                // Same tick, back to back: the client reads both before any promise continuation.
                sendEvent(socket, message.id as number, 'mobile_app_notification_action', { action: 'immediate' });
            }
        };
        subscriber = new EventSubscriber({ baseUrl: fake.url, token: 't' });
        const seen: HaEvent[] = [];

        await subscriber.subscribeEventType('mobile_app_notification_action', (e) => seen.push(e));

        await until(() => seen.length === 1);
        expect(seen[0].data.action).toBe('immediate');
    });

    it('a confirmation that arrives after the timeout does not leave a duplicate subscription on HA', async () => {
        fake = await fakeHa();
        const active = new Set<number>();
        let subscribeCalls = 0;
        fake.onCommand = (message, socket) => {
            const reply = () => socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: null }));
            if (message.type === 'subscribe_events') {
                active.add(message.id as number); // HA registers it at once...
                if (++subscribeCalls === 1) {
                    setTimeout(reply, 120); // ...but the first confirmation is late
                    return;
                }
            } else if (message.type === 'unsubscribe_events') {
                active.delete(message.subscription as number);
            }
            reply();
        };
        subscriber = new EventSubscriber({ baseUrl: fake.url, token: 't', commandTimeout: 40, resubscribeRetryDelay: 20 });

        await subscriber.subscribeEventType('mobile_app_notification_action', () => undefined);
        await until(() => subscribeCalls === 2);
        await new Promise((r) => setTimeout(r, 200)); // the late confirmation has arrived by now

        expect(active.size).toBe(1);
        const ids = fake.received.filter((m) => m.type === 'subscribe_events').map((m) => m.id);
        expect(fake.received.filter((m) => m.type === 'unsubscribe_events').map((m) => m.subscription)).toEqual([ids[0]]);
    });

    it('retries a subscription whose confirmation never arrived', async () => {
        fake = await fakeHa();
        let subscribeCalls = 0;
        fake.onCommand = (message, socket) => {
            if (message.type === 'subscribe_events' && ++subscribeCalls === 1) return; // lost
            socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: null }));
        };
        subscriber = new EventSubscriber({ baseUrl: fake.url, token: 't', commandTimeout: 50, resubscribeRetryDelay: 50 });
        const seen: HaEvent[] = [];
        await subscriber.subscribeEventType('mobile_app_notification_action', (e) => seen.push(e));

        await until(() => subscribeCalls === 2);
        const confirmed = fake.received.filter((m) => m.type === 'subscribe_events')[1];
        await new Promise((r) => setTimeout(r, 20));
        sendEvent(fake.sockets[0], confirmed.id as number, 'mobile_app_notification_action', { action: 'ok' });
        await until(() => seen.length === 1);
    });

    it('replaces an unexpected error code with unknown_error', async () => {
        fake = await fakeHa();
        fake.onCommand = (message, socket) =>
            socket.send(JSON.stringify({ id: message.id, type: 'result', success: false, error: { code: 'x?token=SECRET', message: 'boom' } }));
        subscriber = new EventSubscriber({ baseUrl: fake.url, token: 't' });

        await expect(subscriber.sendCommand({ type: 'trace/list' })).rejects.toThrow("Home Assistant rejected 'trace/list' (unknown_error)");
    });

    it('reports a connection failure without the internal address', async () => {
        fake = await fakeHa();
        const url = fake.url;
        await fake.close();
        subscriber = new EventSubscriber({ baseUrl: url, token: 't', maxReconnectAttempts: 0 });

        const error = await subscriber.connect().catch((e: Error) => e);
        expect((error as Error).message).toBe('Could not connect to the Home Assistant WebSocket');
        expect((error as Error).message).not.toContain('127.0.0.1');
    });

    it('unsubscribing while HA is offline forgets the subscription for good', async () => {
        fake = await fakeHa();
        subscriber = new EventSubscriber({ baseUrl: fake.url, token: 't', reconnectInterval: 20 });
        await subscriber.subscribeEventType('kept_event', () => undefined);
        const gone = await subscriber.subscribeEventType('gone_event', () => undefined);

        fake.sockets[0].terminate(); // HA goes away
        await until(() => !subscriber.isConnected());
        await expect(subscriber.unsubscribe(gone)).resolves.toBeUndefined();
        expect(subscriber.getSubscriptionCount()).toBe(1);

        // On reconnect only the remaining subscription is restored.
        await until(() => fake.sockets.length === 2 && fake.received.filter((m) => m.type === 'subscribe_events').length === 3);
        await new Promise((r) => setTimeout(r, 50));
        const restored = fake.received.filter((m) => m.type === 'subscribe_events').slice(2).map((m) => m.event_type);
        expect(restored).toEqual(['kept_event']);
    });

    it('a subscription cancelled before HA confirms it is cancelled on HA\'s side too', async () => {
        fake = await fakeHa();
        let confirm!: () => void;
        fake.onCommand = (message, socket) => {
            const reply = () => socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: null }));
            if (message.type === 'subscribe_events') confirm = reply;
            else reply();
        };
        subscriber = new EventSubscriber({ baseUrl: fake.url, token: 't' });
        await subscriber.connect();

        const subscribing = subscriber.subscribeEventType('slow_event', () => undefined);
        await until(() => fake.received.some((m) => m.type === 'subscribe_events'));
        const id = [...(subscriber as unknown as { subscriptions: Map<string, unknown> }).subscriptions.keys()][0];
        await subscriber.unsubscribe(id); // before HA confirmed
        confirm();
        await subscribing;

        const sent = fake.received.find((m) => m.type === 'subscribe_events')!;
        await until(() => fake.received.some((m) => m.type === 'unsubscribe_events'));
        expect(fake.received.find((m) => m.type === 'unsubscribe_events')).toMatchObject({ subscription: sent.id });
        expect(subscriber.getSubscriptionCount()).toBe(0);
    });

    it('delivers each event once per subscription when two subscribe to the same type', async () => {
        fake = await fakeHa();
        subscriber = new EventSubscriber({ baseUrl: fake.url, token: 't' });
        const first: HaEvent[] = [];
        const second: HaEvent[] = [];
        await subscriber.subscribeEventType('mobile_app_notification_action', (e) => first.push(e));
        await subscriber.subscribeEventType('mobile_app_notification_action', (e) => second.push(e));

        // HA sends one copy per subscription, each tagged with that subscription's id.
        const ids = fake.received.filter((m) => m.type === 'subscribe_events').map((m) => m.id as number);
        for (const id of ids) sendEvent(fake.sockets[0], id, 'mobile_app_notification_action', { action: 'X' });

        await until(() => first.length + second.length >= 2);
        await new Promise((r) => setTimeout(r, 50));
        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);
    });

    it('restores its subscriptions after the connection drops', async () => {
        fake = await fakeHa();
        subscriber = new EventSubscriber({ baseUrl: fake.url, token: 't', reconnectInterval: 20 });
        const seen: HaEvent[] = [];
        await subscriber.subscribeEventType('mobile_app_notification_action', (e) => seen.push(e));

        fake.sockets[0].terminate(); // HA restarts
        await until(() => fake.received.filter((m) => m.type === 'subscribe_events').length === 2);

        const resubscribe = fake.received.filter((m) => m.type === 'subscribe_events')[1];
        expect(resubscribe.event_type).toBe('mobile_app_notification_action');
        sendEvent(fake.sockets[1], resubscribe.id as number, 'mobile_app_notification_action', { action: 'after-restart' });
        await until(() => seen.length === 1);
        expect(seen[0].data.action).toBe('after-restart');
    });

    it('a subscription made while HA is down goes live when HA comes up', async () => {
        // Reserve a port, then free it: HA is "down" on that port at first.
        const probe = await fakeHa();
        const url = probe.url;
        const port = Number(new URL(url).port);
        await probe.close();

        subscriber = new EventSubscriber({ baseUrl: url, token: 't', reconnectInterval: 20, maxReconnectDelay: 50 });
        await expect(subscriber.connect()).rejects.toThrow();
        const seen: HaEvent[] = [];
        await subscriber.subscribeEventType('mobile_app_notification_action', (e) => seen.push(e));

        // Home Assistant starts on the same port.
        const wss = new WebSocketServer({ port });
        fake = { url, received: [], sockets: [], onCommand: () => undefined, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }) };
        wss.on('connection', (socket) => {
            fake.sockets.push(socket);
            socket.send(JSON.stringify({ type: 'auth_required' }));
            socket.on('message', (raw) => {
                const m = JSON.parse(raw.toString()) as Record<string, unknown>;
                fake.received.push(m);
                socket.send(JSON.stringify(m.type === 'auth' ? { type: 'auth_ok' } : { id: m.id, type: 'result', success: true, result: null }));
            });
        });

        await until(() => fake.received.some((m) => m.type === 'subscribe_events'));
        const sub = fake.received.find((m) => m.type === 'subscribe_events')!;
        expect(sub.event_type).toBe('mobile_app_notification_action');
        sendEvent(fake.sockets[0], sub.id as number, 'mobile_app_notification_action', { action: 'late' });
        await until(() => seen.length === 1);
        // Sent once, not again on top of an existing subscription.
        expect(fake.received.filter((m) => m.type === 'subscribe_events')).toHaveLength(1);
    });

    it('keeps retrying with a capped delay instead of giving up', async () => {
        fake = await fakeHa();
        const url = fake.url;
        await fake.close();
        subscriber = new EventSubscriber({ baseUrl: url, token: 't', reconnectInterval: 5, maxReconnectDelay: 20 });

        await expect(subscriber.connect()).rejects.toThrow();
        // Many more attempts than the old hard limit of 10, still trying.
        await new Promise((r) => setTimeout(r, 400));
        expect((subscriber as unknown as { reconnectAttempts: number }).reconnectAttempts).toBeGreaterThan(10);
    });
});

describe('createHaWebSocketCommand', () => {
    let fake: FakeHa;
    afterEach(async () => fake?.close());

    it('fails within its deadline when Home Assistant never completes authentication', async () => {
        fake = await fakeHa();
        fake.sockets = [];
        const silent = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => silent.once('listening', () => resolve()));
        try {
            const command = createHaWebSocketCommand({
                baseUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`,
                token: 't',
                timeoutMs: 200,
            });
            const started = Date.now();
            await expect(command({ type: 'trace/list' })).rejects.toThrow(/timed out/i);
            expect(Date.now() - started).toBeLessThan(2000);
        } finally {
            for (const client of silent.clients) client.terminate();
            await new Promise<void>((resolve) => silent.close(() => resolve()));
        }
    });

    it('fails at once when Home Assistant closes the connection before authentication', async () => {
        fake = await fakeHa();
        const closing = new WebSocketServer({ port: 0 });
        await new Promise<void>((resolve) => closing.once('listening', () => resolve()));
        closing.on('connection', (socket) => socket.close());
        try {
            const command = createHaWebSocketCommand({
                baseUrl: `http://127.0.0.1:${(closing.address() as AddressInfo).port}`,
                token: 't',
                timeoutMs: 5000,
            });
            const started = Date.now();
            await expect(command({ type: 'trace/list' })).rejects.toThrow(/before authentication/);
            expect(Date.now() - started).toBeLessThan(2000);
        } finally {
            await new Promise<void>((resolve) => closing.close(() => resolve()));
        }
    });

    it('connects, sends one command, returns its result and disconnects', async () => {
        fake = await fakeHa();
        fake.onCommand = (message, socket) =>
            socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: [{ run_id: 'r1' }] }));

        const command = createHaWebSocketCommand({ baseUrl: fake.url, token: 't' });
        const result = await command({ type: 'trace/list', domain: 'automation', item_id: '1700' });

        expect(result).toEqual([{ run_id: 'r1' }]);
        expect(fake.received.find((m) => m.type === 'trace/list')).toMatchObject({ domain: 'automation', item_id: '1700' });
        await until(() => fake.sockets[0].readyState === fake.sockets[0].CLOSED);
    });
});
