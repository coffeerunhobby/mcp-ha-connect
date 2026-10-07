/**
 * One-shot Home Assistant WebSocket command: connect, authenticate, send one
 * command, return its result, disconnect. For the few HA APIs that exist only
 * over WebSocket (e.g. automation traces), usable in every transport mode.
 */

import { EventSubscriber } from './events.js';

export type HaWebSocketCommand = <T = unknown>(command: { type: string; [key: string]: unknown }) => Promise<T>;

export function createHaWebSocketCommand(config: {
    baseUrl: string;
    token: string;
    strictSsl?: boolean;
    /** One deadline for connecting, authenticating and the command (ms). Default 30 s. */
    timeoutMs?: number;
}): HaWebSocketCommand {
    const timeoutMs = config.timeoutMs ?? 30000;
    return async <T>(command: { type: string; [key: string]: unknown }): Promise<T> => {
        const connection = new EventSubscriber({
            baseUrl: config.baseUrl,
            token: config.token,
            strictSsl: config.strictSsl,
            maxReconnectAttempts: 0,
            connectTimeout: timeoutMs,
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Home Assistant command '${command.type}' timed out`)), timeoutMs);
        });
        const work = (async () => {
            await connection.connect();
            return await connection.sendCommand<T>(command, timeoutMs);
        })();
        // If the deadline wins, the abandoned attempt still settles later: observe it.
        work.catch(() => undefined);
        try {
            return await Promise.race([work, deadline]);
        } finally {
            clearTimeout(timer);
            connection.disconnect();
        }
    };
}
