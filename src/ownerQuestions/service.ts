/**
 * Owner questions: ask the owner a yes/no-style question as an actionable phone
 * notification and collect the button they tap.
 *
 * Stateless by design: everything needed to recognise a question travels in
 * signed identifiers, so a server restart does not lose open questions.
 *  - The requestId given to the caller carries the question, title, buttons,
 *    target, expiry, the asking token's `sub` and a random nonce, signed with a
 *    key derived from the server secret.
 *  - Each button's action id carries the nonce, the button index, the expiry,
 *    the target and its own signature, so a tap that arrives after a restart is
 *    still verified and attributed. The secret never leaves the server, and the
 *    requestId is not enough to forge a button id.
 * Only answers (and cancellations) are kept in memory until they are read. A tap
 * that lands while the server is down is lost; the question then expires as NO.
 *
 * A tap counts only if Home Assistant reports it as coming from a mobile app
 * webhook (origin REMOTE, with a user), so an automation that fires a fake
 * `mobile_app_notification_action` event (origin LOCAL) cannot approve anything.
 * With `allowedUserIds` (MCP_OWNER_QUESTIONS_HA_USERS) only those HA users can answer.
 *
 * Known limit, accepted: cancellations and answers are remembered in memory
 * only, while a button's signed id stays valid until the question expires. After
 * a restart, re-sending an old button id through Home Assistant's own API (which
 * needs an HA login, and the id from HA's history) could answer a question that
 * had been cancelled or denied. The phone itself no longer shows the buttons.
 * Anyone with that access can already control the house directly.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { logger } from '../utils/logger.js';

export const ACTION_EVENT = 'mobile_app_notification_action';

export const LIMITS = {
    questionChars: 256,
    titleChars: 60,
    buttonChars: 20,
    maxButtons: 3,
    minTimeoutSeconds: 60,
    maxTimeoutSeconds: 7 * 24 * 60 * 60,
    defaultTimeoutSeconds: 600,
    maxWaitSeconds: 50,
    maxOpenPerCaller: 3,
    maxPerCallerPerHour: 30,
} as const;

const REQUEST_PREFIX = 'q1';
const ACTION_PREFIX = 'MCPASK';
/** How long the confirmation that replaces an answered question stays on the phone. */
const CONFIRMATION_SECONDS = 300;
/** Outcomes stay readable this long after their question expired. */
const OUTCOME_RETENTION_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface AskOwnerInput {
    question: string;
    title: string;
    buttons: string[];
    target: string;
    timeoutSeconds: number;
    channel?: string;
    importance?: 'high' | 'default' | 'low' | 'min';
}

export type OwnerAnswer =
    | {
          status: 'answered';
          index: number;
          button: string;
          answeredAt: string;
          answeredBy: string;
          question: string;
          buttons: string[];
      }
    | { status: 'pending'; expiresAt: string; question: string; buttons: string[] }
    | { status: 'timeout'; expiredAt: string; question: string; buttons: string[] }
    | { status: 'cancelled'; cancelledAt: string; question: string; buttons: string[] }
    | { status: 'unknown'; reason: string };

/** Signed contents of a requestId. */
interface QuestionPayload {
    v: 1;
    n: string;
    s: string;
    t: string;
    e: number;
    b: string[];
    q: string;
    ti: string;
}

type Outcome =
    | { status: 'answered'; index: number; answeredAt: number; answeredBy: string }
    | { status: 'cancelled'; cancelledAt: number };

export interface OwnerQuestionDeps {
    /** Calls `notify.<target>`. */
    notify: (target: string, serviceData: Record<string, unknown>) => Promise<unknown>;
    /**
     * Subscribes to a Home Assistant event type. Rejects if Home Assistant refuses
     * it now; `onRejected` reports a refusal seen later (e.g. after a reconnect).
     */
    subscribe: (
        eventType: string,
        callback: (event: ActionEvent) => void,
        onRejected: (error: Error) => void
    ) => Promise<unknown>;
    /** Key material for signing (the server's auth secret); a random key is used when absent. */
    secret?: string;
    /** HA user ids allowed to answer; empty or absent = any HA user. */
    allowedUserIds?: string[];
    now?: () => number;
}

export interface ActionEvent {
    event_type: string;
    data: { action?: unknown; [key: string]: unknown };
    origin: string;
    time_fired?: string;
    context: { user_id: string | null };
}

const b64url = (buffer: Buffer): string => buffer.toString('base64url');

export class OwnerQuestionService {
    private readonly key: Buffer;
    private readonly now: () => number;
    /** Final outcomes by nonce, until the question's expiry passes. */
    private readonly outcomes = new Map<string, Outcome & { expiresAt: number }>();
    /** Open questions per caller sub: nonce -> expiry (ms). */
    private readonly open = new Map<string, Map<string, number>>();
    /** Ask timestamps per caller sub, for the hourly cap. */
    private readonly asked = new Map<string, number[]>();
    /** Pollers waiting for an outcome, by nonce. */
    private readonly waiters = new Map<string, Set<() => void>>();
    /** Expiry timers by nonce (best effort: lost on restart; the phone also times out on its own). */
    private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Labels and target of open questions, for nicer confirmations while the server stays up. */
    private readonly known = new Map<string, { target: string; title: string; buttons: string[]; expiresAt: number }>();
    private sweepTimer: ReturnType<typeof setInterval> | undefined;
    /** Why questions cannot be answered right now (Home Assistant refused the tap subscription). */
    private unavailable: string | undefined;

    constructor(private readonly deps: OwnerQuestionDeps) {
        this.now = deps.now ?? Date.now;
        if (deps.secret) {
            this.key = createHmac('sha256', deps.secret).update('mcp-ha-connect/owner-questions/v1').digest();
        } else {
            this.key = randomBytes(32);
            logger.warn('Owner questions: no server secret configured; open questions will not survive a restart');
        }
    }

    async start(): Promise<void> {
        await this.deps.subscribe(
            ACTION_EVENT,
            (event) => this.handleActionEvent(event),
            () => {
                this.unavailable =
                    'Home Assistant refused the subscription to notification taps (the server needs an admin Home Assistant token)';
                logger.error(`Owner questions unavailable: ${this.unavailable}`);
            }
        );
        this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
        this.sweepTimer.unref?.();
        logger.info('Owner questions: listening for notification taps');
        if (!this.deps.allowedUserIds?.length) {
            logger.warn('Owner questions: any Home Assistant user can answer; set MCP_OWNER_QUESTIONS_HA_USERS to restrict it');
        }
    }

    stop(): void {
        clearInterval(this.sweepTimer);
        for (const timer of this.expiryTimers.values()) clearTimeout(timer);
        this.expiryTimers.clear();
    }

    async ask(input: AskOwnerInput, caller: string): Promise<{ requestId: string; expiresAt: string }> {
        if (this.unavailable) {
            throw new Error(`Owner questions are unavailable: ${this.unavailable}`);
        }
        const now = this.now();
        this.enforceRateLimits(caller, now);

        const nonce = b64url(randomBytes(16));
        const expiresAtSec = Math.floor(now / 1000) + input.timeoutSeconds;
        const payload: QuestionPayload = {
            v: 1,
            n: nonce,
            s: caller,
            t: input.target,
            e: expiresAtSec,
            b: input.buttons,
            q: input.question,
            ti: input.title,
        };
        const requestId = this.signRequest(payload);

        const data: Record<string, unknown> = {
            tag: this.tagFor(nonce),
            actions: input.buttons.map((title, index) => ({
                action: this.actionId(nonce, index, expiresAtSec, input.target),
                title,
            })),
            // Stays until answered: not dismissed by tapping the body (sticky) or by
            // swiping (persistent, needs the tag); the phone removes it at expiry.
            sticky: true,
            persistent: true,
            priority: 'high',
            ttl: 0,
            timeout: input.timeoutSeconds,
        };
        if (input.channel) data.channel = input.channel;
        if (input.importance) data.importance = input.importance;

        // Reserve the slot before sending, so concurrent calls cannot all pass the limits.
        this.reserve(caller, nonce, expiresAtSec * 1000, now);
        try {
            await this.deps.notify(input.target, { title: input.title, message: input.question, data });
        } catch {
            // The underlying error can carry request details; neither the caller
            // nor this log gets its text.
            this.release(caller, nonce, now);
            logger.warn('Owner questions: sending the notification failed', { target: input.target });
            throw new Error(`Could not send the notification through Home Assistant (is '${input.target}' a valid notify target?)`);
        }

        this.known.set(nonce, { target: input.target, title: input.title, buttons: input.buttons, expiresAt: expiresAtSec * 1000 });
        // Count from now, after delivery: the signed expiry is what matters.
        this.scheduleExpiry(nonce, Math.max(expiresAtSec * 1000 - this.now(), 0));
        logger.info('Owner question sent', { caller, target: input.target, buttons: input.buttons.length, expiresAt: expiresAtSec });

        return { requestId, expiresAt: new Date(expiresAtSec * 1000).toISOString() };
    }

    async getAnswer(requestId: string, caller: string, waitSeconds: number): Promise<OwnerAnswer> {
        const payload = this.verifyRequest(requestId);
        if (!payload) {
            return { status: 'unknown', reason: 'Not a valid question id from this server (or the server secret changed)' };
        }
        this.assertOwner(payload, caller);

        const settled = this.settledAnswer(payload);
        if (settled || waitSeconds <= 0) {
            return settled ?? this.pendingAnswer(payload);
        }

        const untilExpiry = payload.e * 1000 - this.now();
        await this.waitForOutcome(payload.n, Math.min(waitSeconds * 1000, Math.max(untilExpiry, 0)));
        return this.settledAnswer(payload) ?? this.pendingAnswer(payload);
    }

    async cancel(requestId: string, caller: string): Promise<OwnerAnswer> {
        const payload = this.verifyRequest(requestId);
        if (!payload) {
            return { status: 'unknown', reason: 'Not a valid question id from this server (or the server secret changed)' };
        }
        this.assertOwner(payload, caller);

        const settled = this.settledAnswer(payload);
        if (settled) {
            return settled;
        }
        this.settle(payload.n, { status: 'cancelled', cancelledAt: this.now() }, payload.e * 1000);
        await this.replaceNotification(payload.n, payload.t, payload.ti, 'Cancelled - no answer needed');
        return this.settledAnswer(payload)!;
    }

    /** Handle a `mobile_app_notification_action` event. Exposed for tests. */
    handleActionEvent(event: ActionEvent): void {
        const parsed = this.parseActionId(event.data.action);
        if (!parsed) {
            return; // not one of ours
        }
        if (event.origin !== 'REMOTE' || !event.context.user_id) {
            logger.warn('Owner questions: ignored a tap not coming from a mobile app', { origin: event.origin });
            return;
        }
        if (this.deps.allowedUserIds?.length && !this.deps.allowedUserIds.includes(event.context.user_id)) {
            logger.warn('Owner questions: ignored a tap from a Home Assistant user that may not answer');
            return;
        }
        const { nonce, index, expiresAtSec, target } = parsed;
        const known = this.known.get(nonce);
        if (this.now() >= expiresAtSec * 1000) {
            logger.info('Owner questions: ignored a tap after expiry');
            void this.replaceNotification(nonce, target, known?.title ?? 'Question', 'Expired - the answer was not recorded');
            return;
        }
        if (this.outcomes.has(nonce)) {
            return; // first tap wins
        }
        this.settle(nonce, { status: 'answered', index, answeredAt: this.now(), answeredBy: event.context.user_id }, expiresAtSec * 1000);
        logger.info('Owner question answered', { index });
        const label = known?.buttons[index];
        void this.replaceNotification(nonce, target, known?.title ?? 'Question', label ? `Answered: ${label}` : 'Answer recorded');
    }

    // ---- internals -------------------------------------------------------

    private signRequest(payload: QuestionPayload): string {
        const body = `${REQUEST_PREFIX}.${b64url(Buffer.from(JSON.stringify(payload), 'utf8'))}`;
        return `${body}.${b64url(this.hmac(`request|${body}`))}`;
    }

    private verifyRequest(requestId: string): QuestionPayload | null {
        const parts = typeof requestId === 'string' ? requestId.split('.') : [];
        if (parts.length !== 3 || parts[0] !== REQUEST_PREFIX) {
            return null;
        }
        const body = `${parts[0]}.${parts[1]}`;
        if (!this.safeEqual(parts[2], b64url(this.hmac(`request|${body}`)))) {
            return null;
        }
        try {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as QuestionPayload;
            return payload.v === 1 ? payload : null;
        } catch {
            return null;
        }
    }

    private actionId(nonce: string, index: number, expiresAtSec: number, target: string): string {
        const sig = b64url(this.hmac(`action|${nonce}|${index}|${expiresAtSec}|${target}`)).slice(0, 22);
        return `${ACTION_PREFIX}.${nonce}.${index}.${expiresAtSec}.${target}.${sig}`;
    }

    private parseActionId(action: unknown): { nonce: string; index: number; expiresAtSec: number; target: string } | null {
        if (typeof action !== 'string' || !action.startsWith(`${ACTION_PREFIX}.`)) {
            return null;
        }
        const match = /^MCPASK\.([A-Za-z0-9_-]{22})\.([0-2])\.(\d{1,12})\.(mobile_app_[a-z0-9_]{1,64})\.([A-Za-z0-9_-]{22})$/.exec(action);
        if (!match) {
            logger.warn('Owner questions: ignored a malformed action id');
            return null;
        }
        const [, nonce, index, expires, target, sig] = match;
        const expected = b64url(this.hmac(`action|${nonce}|${index}|${expires}|${target}`)).slice(0, 22);
        if (!this.safeEqual(sig, expected)) {
            logger.warn('Owner questions: ignored a tap with an invalid signature');
            return null;
        }
        return { nonce, index: Number(index), expiresAtSec: Number(expires), target };
    }

    private hmac(message: string): Buffer {
        return createHmac('sha256', this.key).update(message).digest();
    }

    private safeEqual(a: string, b: string): boolean {
        const left = Buffer.from(a);
        const right = Buffer.from(b);
        return left.length === right.length && timingSafeEqual(left, right);
    }

    private tagFor(nonce: string): string {
        return `mcpask-${nonce}`;
    }

    private assertOwner(payload: QuestionPayload, caller: string): void {
        if (payload.s !== caller) {
            throw new Error('This question was asked by a different client');
        }
    }

    private settledAnswer(payload: QuestionPayload): OwnerAnswer | null {
        const base = { question: payload.q, buttons: payload.b };
        const outcome = this.outcomes.get(payload.n);
        if (outcome?.status === 'answered') {
            return {
                status: 'answered',
                index: outcome.index,
                button: payload.b[outcome.index] ?? `#${outcome.index}`,
                answeredAt: new Date(outcome.answeredAt).toISOString(),
                answeredBy: outcome.answeredBy,
                ...base,
            };
        }
        if (outcome?.status === 'cancelled') {
            return { status: 'cancelled', cancelledAt: new Date(outcome.cancelledAt).toISOString(), ...base };
        }
        if (this.now() >= payload.e * 1000) {
            return { status: 'timeout', expiredAt: new Date(payload.e * 1000).toISOString(), ...base };
        }
        return null;
    }

    private pendingAnswer(payload: QuestionPayload): OwnerAnswer {
        return { status: 'pending', expiresAt: new Date(payload.e * 1000).toISOString(), question: payload.q, buttons: payload.b };
    }

    private settle(nonce: string, outcome: Outcome, expiresAtMs: number): void {
        this.outcomes.set(nonce, { ...outcome, expiresAt: expiresAtMs });
        this.known.delete(nonce);
        for (const questions of this.open.values()) {
            questions.delete(nonce);
        }
        const timer = this.expiryTimers.get(nonce);
        if (timer) {
            clearTimeout(timer);
            this.expiryTimers.delete(nonce);
        }
        this.wake(nonce);
    }

    private wake(nonce: string): void {
        for (const resolve of this.waiters.get(nonce) ?? []) {
            resolve();
        }
        this.waiters.delete(nonce);
    }

    private waitForOutcome(nonce: string, ms: number): Promise<void> {
        return new Promise((resolve) => {
            const waiters = this.waiters.get(nonce) ?? new Set<() => void>();
            this.waiters.set(nonce, waiters);
            const done = () => {
                clearTimeout(timer);
                waiters.delete(done);
                if (waiters.size === 0 && this.waiters.get(nonce) === waiters) {
                    this.waiters.delete(nonce);
                }
                resolve();
            };
            const timer = setTimeout(done, ms);
            waiters.add(done);
        });
    }

    private scheduleExpiry(nonce: string, ms: number): void {
        // Node timers overflow above ~24.8 days; questions last at most 7 days.
        const timer = setTimeout(() => {
            this.expiryTimers.delete(nonce);
            if (this.outcomes.has(nonce)) {
                return;
            }
            for (const questions of this.open.values()) {
                questions.delete(nonce);
            }
            this.wake(nonce);
            const known = this.known.get(nonce);
            this.known.delete(nonce);
            if (known) {
                void this.replaceNotification(nonce, known.target, known.title, 'Expired - treated as no');
            }
        }, ms);
        timer.unref?.();
        this.expiryTimers.set(nonce, timer);
    }

    private async replaceNotification(nonce: string, target: string, title: string, message: string): Promise<void> {
        try {
            // Same tag replaces the question; no actions, dismissible, gone after a while.
            await this.deps.notify(target, {
                title,
                message,
                data: { tag: this.tagFor(nonce), sticky: false, persistent: false, timeout: CONFIRMATION_SECONDS },
            });
        } catch {
            logger.warn('Owner questions: could not update the notification', { target });
        }
    }

    private enforceRateLimits(caller: string, now: number): void {
        const open = this.open.get(caller);
        if (open) {
            for (const [nonce, expiresAt] of open) {
                if (expiresAt <= now) open.delete(nonce);
            }
            if (open.size >= LIMITS.maxOpenPerCaller) {
                throw new Error(`Too many open questions (${open.size}); answer, cancel or wait for one to expire first`);
            }
        }
        const recent = (this.asked.get(caller) ?? []).filter((t) => t > now - 60 * 60 * 1000);
        if (recent.length >= LIMITS.maxPerCallerPerHour) {
            throw new Error(`Too many questions in the last hour (limit ${LIMITS.maxPerCallerPerHour})`);
        }
        this.asked.set(caller, recent);
    }

    private reserve(caller: string, nonce: string, expiresAtMs: number, now: number): void {
        const open = this.open.get(caller) ?? new Map<string, number>();
        open.set(nonce, expiresAtMs);
        this.open.set(caller, open);
        const asked = this.asked.get(caller) ?? [];
        asked.push(now);
        this.asked.set(caller, asked);
    }

    private release(caller: string, nonce: string, now: number): void {
        this.open.get(caller)?.delete(nonce);
        const asked = this.asked.get(caller);
        const index = asked?.lastIndexOf(now) ?? -1;
        if (asked && index >= 0) asked.splice(index, 1);
    }

    /**
     * Periodic cleanup, independent of new activity: outcomes a day after their
     * question expired (a caller polling that late sees "timeout"), labels of
     * expired questions, and rate-limit entries that no longer count.
     * Exposed for tests.
     */
    sweep(): void {
        const now = this.now();
        for (const [nonce, outcome] of this.outcomes) {
            if (outcome.expiresAt + OUTCOME_RETENTION_MS < now) this.outcomes.delete(nonce);
        }
        for (const [nonce, known] of this.known) {
            if (known.expiresAt < now) this.known.delete(nonce);
        }
        for (const [caller, open] of this.open) {
            for (const [nonce, expiresAt] of open) {
                if (expiresAt <= now) open.delete(nonce);
            }
            if (open.size === 0) this.open.delete(caller);
        }
        for (const [caller, asked] of this.asked) {
            const recent = asked.filter((t) => t > now - 60 * 60 * 1000);
            if (recent.length === 0) this.asked.delete(caller);
            else this.asked.set(caller, recent);
        }
    }

    /** Sizes of the in-memory state, for tests and diagnostics. */
    stateSize(): { outcomes: number; known: number; open: number; asked: number; waiters: number } {
        return {
            outcomes: this.outcomes.size,
            known: this.known.size,
            open: this.open.size,
            asked: this.asked.size,
            waiters: this.waiters.size,
        };
    }
}
