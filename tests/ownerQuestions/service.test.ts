/**
 * OwnerQuestionService: signed, restart-proof owner questions answered by a tap
 * on an actionable phone notification.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { OwnerQuestionService, ACTION_EVENT, LIMITS, type ActionEvent, type AskOwnerInput } from '../../src/ownerQuestions/service.js';
import { logger } from '../../src/utils/logger.js';

const SECRET = 'a'.repeat(40);
const T0 = Date.parse('2026-10-07T08:00:00Z');

const input = (overrides: Partial<AskOwnerInput> = {}): AskOwnerInput => ({
    question: 'Turn on the bathroom light?',
    title: 'Harvey asks',
    buttons: ['Approve', 'Deny'],
    target: 'mobile_app_phone_user5',
    timeoutSeconds: 600,
    ...overrides,
});

interface Harness {
    service: OwnerQuestionService;
    notify: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    /** The tap handler the service registered. */
    tap: (event: ActionEvent) => void;
}

async function harness(secret: string | null = SECRET): Promise<Harness> {
    const notify = vi.fn().mockResolvedValue([]);
    let handler: ((event: ActionEvent) => void) | undefined;
    const subscribe = vi.fn(async (_type: string, cb: (event: ActionEvent) => void) => {
        handler = cb;
        return 'sub-1';
    });
    const service = new OwnerQuestionService({ notify, subscribe, secret: secret ?? undefined, now: () => Date.now() });
    await service.start();
    return { service, notify, subscribe, tap: (event) => handler!(event) };
}

/** The action ids of the notification the service sent for a question. */
function sentActionIds(notify: ReturnType<typeof vi.fn>, call = 0): string[] {
    const data = notify.mock.calls[call][1].data as { actions: Array<{ action: string }> };
    return data.actions.map((a) => a.action);
}

const phoneTap = (action: string, overrides: Partial<ActionEvent> = {}): ActionEvent => ({
    event_type: ACTION_EVENT,
    data: { action },
    origin: 'REMOTE',
    context: { user_id: 'owner-user-id' },
    ...overrides,
});

describe('OwnerQuestionService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not start when Home Assistant refuses the tap subscription', async () => {
        const service = new OwnerQuestionService({
            notify: vi.fn(),
            subscribe: vi.fn().mockRejectedValue(new Error("Home Assistant rejected 'subscribe_events' (unauthorized)")),
            secret: SECRET,
        });

        await expect(service.start()).rejects.toThrow(/unauthorized/);
    });

    it('becomes unavailable (and says why) if the subscription is refused later', async () => {
        let onRejected!: (error: Error) => void;
        const notify = vi.fn().mockResolvedValue([]);
        const service = new OwnerQuestionService({
            notify,
            subscribe: async (_type, _cb, rejected) => (onRejected = rejected),
            secret: SECRET,
        });
        await service.start();

        onRejected(new Error('refused'));

        await expect(service.ask(input(), 'harvey')).rejects.toThrow(/unavailable.*admin Home Assistant token/);
        expect(notify).not.toHaveBeenCalled();
        service.stop();
    });

    it('subscribes to mobile_app_notification_action on start', async () => {
        const { subscribe } = await harness();
        expect(subscribe).toHaveBeenCalledWith(ACTION_EVENT, expect.any(Function), expect.any(Function));
    });

    it('sends a sticky, persistent, self-expiring notification with one signed action per button', async () => {
        const { service, notify } = await harness();

        const { requestId, expiresAt } = await service.ask(input(), 'harvey');

        expect(expiresAt).toBe('2026-10-07T08:10:00.000Z');
        expect(notify).toHaveBeenCalledTimes(1);
        const [target, serviceData] = notify.mock.calls[0];
        expect(target).toBe('mobile_app_phone_user5');
        expect(serviceData).toMatchObject({
            title: 'Harvey asks',
            message: 'Turn on the bathroom light?',
            data: { sticky: true, persistent: true, priority: 'high', timeout: 600, tag: expect.stringMatching(/^mcpask-/) },
        });
        const actions = serviceData.data.actions as Array<{ action: string; title: string }>;
        expect(actions.map((a) => a.title)).toEqual(['Approve', 'Deny']);
        for (const [index, { action }] of actions.entries()) {
            expect(action).toMatch(new RegExp(`^MCPASK\\.[A-Za-z0-9_-]{22}\\.${index}\\.\\d+\\.mobile_app_phone_user5\\.[A-Za-z0-9_-]{22}$`));
        }
        // The requestId does not contain any button's action id (it can't be used to forge a tap).
        for (const { action } of actions) {
            expect(requestId).not.toContain(action.split('.').at(-1));
        }
    });

    it('returns pending, then the tapped button with time and HA user', async () => {
        const { service, notify, tap } = await harness();
        const { requestId } = await service.ask(input(), 'harvey');

        await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'pending' });

        vi.setSystemTime(T0 + 42_000);
        tap(phoneTap(sentActionIds(notify)[1]));

        await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toEqual({
            status: 'answered',
            index: 1,
            button: 'Deny',
            answeredAt: '2026-10-07T08:00:42.000Z',
            answeredBy: 'owner-user-id',
            question: 'Turn on the bathroom light?',
            buttons: ['Approve', 'Deny'],
        });
        // The question on the phone is replaced (same tag, no buttons, dismissible).
        const replacement = notify.mock.calls.at(-1)!;
        expect(replacement[1]).toMatchObject({ message: 'Answered: Deny', data: { sticky: false, persistent: false } });
        expect(replacement[1].data.actions).toBeUndefined();
        expect(replacement[1].data.tag).toBe(notify.mock.calls[0][1].data.tag);
    });

    it('a waiting getAnswer returns as soon as the tap arrives', async () => {
        const { service, notify, tap } = await harness();
        const { requestId } = await service.ask(input(), 'harvey');

        const answer = service.getAnswer(requestId, 'harvey', 50);
        await vi.advanceTimersByTimeAsync(5_000);
        tap(phoneTap(sentActionIds(notify)[0]));

        await expect(answer).resolves.toMatchObject({ status: 'answered', index: 0, button: 'Approve' });
    });

    it('a waiting getAnswer returns pending after waitSeconds', async () => {
        const { service } = await harness();
        const { requestId } = await service.ask(input(), 'harvey');

        const answer = service.getAnswer(requestId, 'harvey', 30);
        await vi.advanceTimersByTimeAsync(30_000);

        await expect(answer).resolves.toMatchObject({ status: 'pending' });
    });

    it('the first tap wins', async () => {
        const { service, notify, tap } = await harness();
        const { requestId } = await service.ask(input(), 'harvey');
        const [approve, deny] = sentActionIds(notify);

        tap(phoneTap(deny));
        tap(phoneTap(approve));

        await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ index: 1, button: 'Deny' });
    });

    it('times out as its own status, and replaces the notification at expiry', async () => {
        const { service, notify } = await harness();
        const { requestId } = await service.ask(input({ timeoutSeconds: 60 }), 'harvey');

        await vi.advanceTimersByTimeAsync(60_000);

        await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({
            status: 'timeout',
            expiredAt: '2026-10-07T08:01:00.000Z',
        });
        expect(notify.mock.calls.at(-1)![1]).toMatchObject({ message: 'Expired - treated as no' });
    });

    it('ignores a tap that arrives after expiry', async () => {
        const { service, notify, tap } = await harness();
        const { requestId } = await service.ask(input({ timeoutSeconds: 60 }), 'harvey');
        const approve = sentActionIds(notify)[0];

        vi.setSystemTime(T0 + 61_000);
        tap(phoneTap(approve));

        await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'timeout' });
    });

    it('updates the phone at the signed expiry even when delivery was slow', async () => {
        const { service, notify } = await harness();
        notify.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve([]), 30_000)));

        const asking = service.ask(input({ timeoutSeconds: 60 }), 'harvey');
        await vi.advanceTimersByTimeAsync(30_000); // Home Assistant took 30 s
        await asking;
        await vi.advanceTimersByTimeAsync(30_000); // now exactly at the signed expiry

        expect(notify.mock.calls.at(-1)![1]).toMatchObject({ message: 'Expired - treated as no' });
        service.stop();
    });

    it('a tap at the exact expiry moment does not count', async () => {
        const { service, notify, tap } = await harness();
        const { requestId } = await service.ask(input({ timeoutSeconds: 60 }), 'harvey');
        const approve = sentActionIds(notify)[0];

        vi.setSystemTime(T0 + 60_000);
        await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'timeout' });
        tap(phoneTap(approve));

        await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'timeout' });
    });

    it('a getAnswer that is waiting returns timeout when the question expires', async () => {
        const { service } = await harness();
        const { requestId } = await service.ask(input({ timeoutSeconds: 60 }), 'harvey');
        await vi.advanceTimersByTimeAsync(50_000);

        const answer = service.getAnswer(requestId, 'harvey', 50);
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(answer).resolves.toMatchObject({ status: 'timeout' });
    });

    it('cancel replaces the notification, and later taps do not count', async () => {
        const { service, notify, tap } = await harness();
        const { requestId } = await service.ask(input(), 'harvey');
        const approve = sentActionIds(notify)[0];

        await expect(service.cancel(requestId, 'harvey')).resolves.toMatchObject({ status: 'cancelled' });
        expect(notify.mock.calls.at(-1)![1]).toMatchObject({ message: 'Cancelled - no answer needed' });

        tap(phoneTap(approve));
        await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'cancelled' });
    });

    it('cancel after an answer reports the answer and does not overwrite it', async () => {
        const { service, notify, tap } = await harness();
        const { requestId } = await service.ask(input(), 'harvey');
        tap(phoneTap(sentActionIds(notify)[0]));

        await expect(service.cancel(requestId, 'harvey')).resolves.toMatchObject({ status: 'answered', index: 0 });
    });

    describe('forgery and tampering', () => {
        it('ignores a tap that did not come from a mobile app (origin LOCAL, e.g. an automation)', async () => {
            const { service, notify, tap } = await harness();
            const { requestId } = await service.ask(input(), 'harvey');

            tap(phoneTap(sentActionIds(notify)[0], { origin: 'LOCAL' }));
            tap(phoneTap(sentActionIds(notify)[0], { context: { user_id: null } }));

            await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'pending' });
        });

        it('with an HA user allowlist, only those users can answer', async () => {
            const notify = vi.fn().mockResolvedValue([]);
            let tapHandler!: (event: ActionEvent) => void;
            const service = new OwnerQuestionService({
                notify,
                subscribe: async (_t, cb) => (tapHandler = cb),
                secret: SECRET,
                allowedUserIds: ['owner-user-id'],
            });
            await service.start();
            const { requestId } = await service.ask(input(), 'harvey');
            const approve = sentActionIds(notify)[0];

            tapHandler(phoneTap(approve, { context: { user_id: 'other-household-member' } }));
            await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'pending' });

            tapHandler(phoneTap(approve, { context: { user_id: 'owner-user-id' } }));
            await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'answered', answeredBy: 'owner-user-id' });
            service.stop();
        });

        it('ignores an action id with a wrong signature or a changed button index', async () => {
            const { service, notify, tap } = await harness();
            const { requestId } = await service.ask(input(), 'harvey');
            const deny = sentActionIds(notify)[1];
            const parts = deny.split('.');

            tap(phoneTap([...parts.slice(0, 5), 'A'.repeat(22)].join('.')));
            tap(phoneTap([parts[0], parts[1], '0', ...parts.slice(3)].join('.'))); // Deny's signature, Approve's index

            await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'pending' });
        });

        it('ignores an action id with an extended expiry', async () => {
            const { service, notify, tap } = await harness();
            const { requestId } = await service.ask(input({ timeoutSeconds: 60 }), 'harvey');
            const parts = sentActionIds(notify)[0].split('.');

            vi.setSystemTime(T0 + 120_000);
            tap(phoneTap([parts[0], parts[1], parts[2], String(Number(parts[3]) + 3600), ...parts.slice(4)].join('.')));

            await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'timeout' });
        });

        it('ignores unrelated notification actions', async () => {
            const { service, tap } = await harness();
            const { requestId } = await service.ask(input(), 'harvey');

            tap(phoneTap('HARVEY_OK_45abeb_91065ebabdd1'));
            tap(phoneTap(undefined as never));

            await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'pending' });
        });

        it('reports unknown for a tampered or foreign requestId', async () => {
            const { service } = await harness();
            const { requestId } = await service.ask(input(), 'harvey');
            const [prefix, body, sig] = requestId.split('.');
            const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
            const forgedBody = Buffer.from(JSON.stringify({ ...payload, e: payload.e + 86400 })).toString('base64url');

            for (const bad of [`${prefix}.${forgedBody}.${sig}`, 'q1.x.y', 'nonsense', '']) {
                await expect(service.getAnswer(bad, 'harvey', 0)).resolves.toMatchObject({ status: 'unknown' });
            }
            const other = await harness('b'.repeat(40));
            await expect(other.service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'unknown' });
        });

        it('only the asking client can read or cancel', async () => {
            const { service } = await harness();
            const { requestId } = await service.ask(input(), 'harvey');

            await expect(service.getAnswer(requestId, 'openwebui', 0)).rejects.toThrow(/different client/);
            await expect(service.cancel(requestId, 'openwebui')).rejects.toThrow(/different client/);
        });
    });

    it('survives a restart: a new instance with the same secret recognises the question and the tap', async () => {
        const first = await harness();
        const { requestId } = await first.service.ask(input(), 'harvey');
        const approve = sentActionIds(first.notify)[0];

        const second = await harness(); // same secret, empty memory
        await expect(second.service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'pending' });
        second.tap(phoneTap(approve));

        await expect(second.service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({
            status: 'answered',
            button: 'Approve',
            question: 'Turn on the bathroom light?',
        });
        expect(second.notify.mock.calls.at(-1)![0]).toBe('mobile_app_phone_user5');
        expect(second.notify.mock.calls.at(-1)![1]).toMatchObject({ message: 'Answer recorded' });
    });

    it('polling a question from before a restart leaves no state behind once it expires', async () => {
        const first = await harness();
        const { requestId } = await first.service.ask(input({ timeoutSeconds: 120 }), 'harvey');

        const second = await harness(); // no expiry timer for this question here
        const poll = second.service.getAnswer(requestId, 'harvey', 50);
        await vi.advanceTimersByTimeAsync(50_000);
        await expect(poll).resolves.toMatchObject({ status: 'pending' });
        expect(second.service.stateSize().waiters).toBe(0);

        await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
        await expect(second.service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'timeout' });
        expect(second.service.stateSize()).toEqual({ outcomes: 0, known: 0, open: 0, asked: 0, waiters: 0 });
        first.service.stop();
        second.service.stop();
    });

    it('without a secret, questions do not survive a restart', async () => {
        const first = await harness(null);
        const { requestId } = await first.service.ask(input(), 'harvey');

        const second = await harness(null);
        await expect(second.service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'unknown' });
    });

    it('cleans up in-memory state on its own, without further activity', async () => {
        const { service, notify, tap } = await harness();
        const answered = await service.ask(input({ timeoutSeconds: 60 }), 'harvey');
        const cancelled = await service.ask(input({ timeoutSeconds: 60 }), 'harvey');
        await service.ask(input({ timeoutSeconds: 60 }), 'approver'); // never answered
        tap(phoneTap(sentActionIds(notify, 0)[0]));
        await service.cancel(cancelled.requestId, 'harvey');
        expect(service.stateSize().outcomes).toBe(2);

        // Past expiry + the one-day retention + one sweep interval; nothing else happens.
        await vi.advanceTimersByTimeAsync(60_000 + 24 * 60 * 60 * 1000 + 10 * 60 * 1000);

        expect(service.stateSize()).toEqual({ outcomes: 0, known: 0, open: 0, asked: 0, waiters: 0 });
        await expect(service.getAnswer(answered.requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'timeout' });
        service.stop();
    });

    it('never passes notification error text to the caller or the logs', async () => {
        const { service, notify, tap } = await harness();
        const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(logger, level));
        try {
            notify.mockRejectedValueOnce(new Error('POST failed, Authorization: Bearer SECRET-TOKEN-1'));
            const error = await service.ask(input(), 'harvey').catch((e: Error) => e);
            expect((error as Error).message).toMatch(/Could not send the notification/);
            expect((error as Error).message).not.toContain('SECRET-TOKEN-1');

            // The replacement after an answer fails too.
            const { requestId } = await service.ask(input(), 'harvey');
            notify.mockRejectedValueOnce(new Error('Authorization: Bearer SECRET-TOKEN-2'));
            tap(phoneTap(sentActionIds(notify, 1)[0]));
            await vi.advanceTimersByTimeAsync(0);
            await expect(service.getAnswer(requestId, 'harvey', 0)).resolves.toMatchObject({ status: 'answered' });

            for (const spy of spies) {
                const logged = JSON.stringify(spy.mock.calls);
                expect(logged).not.toContain('SECRET-TOKEN-1');
                expect(logged).not.toContain('SECRET-TOKEN-2');
            }
        } finally {
            for (const spy of spies) spy.mockRestore();
        }
    });

    describe('rate limits', () => {
        it(`allows at most ${LIMITS.maxOpenPerCaller} open questions per client`, async () => {
            const { service, notify } = await harness();
            for (let i = 0; i < LIMITS.maxOpenPerCaller; i++) {
                await service.ask(input(), 'harvey');
            }

            await expect(service.ask(input(), 'harvey')).rejects.toThrow(/Too many open questions/);
            expect(notify).toHaveBeenCalledTimes(LIMITS.maxOpenPerCaller);
            await expect(service.ask(input(), 'approver')).resolves.toHaveProperty('requestId');
        });

        it('answered, cancelled and expired questions free their slot', async () => {
            const { service, notify, tap } = await harness();
            const a = await service.ask(input(), 'harvey');
            await service.ask(input(), 'harvey');
            await service.ask(input({ timeoutSeconds: 60 }), 'harvey');

            tap(phoneTap(sentActionIds(notify, 0)[0]));
            await expect(service.ask(input(), 'harvey')).resolves.toHaveProperty('requestId');
            await service.cancel(a.requestId, 'harvey'); // already answered: no extra slot
            await expect(service.ask(input(), 'harvey')).rejects.toThrow(/Too many open/);

            await vi.advanceTimersByTimeAsync(60_000);
            await expect(service.ask(input(), 'harvey')).resolves.toHaveProperty('requestId');
        });

        it(`allows at most ${LIMITS.maxPerCallerPerHour} questions per client per hour`, async () => {
            const { service } = await harness();
            for (let i = 0; i < LIMITS.maxPerCallerPerHour; i++) {
                const { requestId } = await service.ask(input(), 'harvey');
                await service.cancel(requestId, 'harvey');
            }

            await expect(service.ask(input(), 'harvey')).rejects.toThrow(/last hour/);
            vi.setSystemTime(T0 + 60 * 60 * 1000 + 1);
            await expect(service.ask(input(), 'harvey')).resolves.toHaveProperty('requestId');
        });

        it('concurrent questions cannot exceed the open-question cap', async () => {
            const { service, notify } = await harness();
            let release!: () => void;
            const gate = new Promise<void>((r) => (release = r));
            notify.mockImplementation(async () => {
                await gate; // slow Home Assistant
                return [];
            });

            const attempts = Array.from({ length: LIMITS.maxOpenPerCaller + 2 }, () => service.ask(input(), 'harvey'));
            release();
            const results = await Promise.allSettled(attempts);

            expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(LIMITS.maxOpenPerCaller);
            expect(notify).toHaveBeenCalledTimes(LIMITS.maxOpenPerCaller);
        });

        it('a failed notification does not use up a slot', async () => {
            const { service, notify } = await harness();
            notify.mockRejectedValue(new Error('HA unreachable'));

            for (let i = 0; i < LIMITS.maxOpenPerCaller + 1; i++) {
                await expect(service.ask(input(), 'harvey')).rejects.toThrow(/Could not send the notification/);
            }
        });
    });
});
