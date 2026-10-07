/**
 * Owner question tools: askOwner / getOwnerAnswer / cancelOwnerQuestion.
 * See src/ownerQuestions/service.ts for the design.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { LIMITS, type OwnerQuestionService } from '../../ownerQuestions/service.js';
import { validatePlainText } from '../../utils/plainText.js';
import { toToolResult, wrapToolHandler, Permission, type ToolExtra } from '../common.js';

const plainText = (field: string, maxLength: number, allowNewlines = false) =>
    z.string().transform((value, ctx) => {
        try {
            return validatePlainText(value, { field, maxLength, allowNewlines });
        } catch (error) {
            ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) });
            return z.NEVER;
        }
    });

export const askOwnerSchema = z.object({
    question: plainText('question', LIMITS.questionChars, true).describe(
        `The question, plain text only (no emoji), at most ${LIMITS.questionChars} characters; longer text is refused, not cut`
    ),
    title: plainText('title', LIMITS.titleChars).optional().describe(`Notification title, at most ${LIMITS.titleChars} characters (default "Approval needed")`),
    buttons: z
        .array(plainText('button label', LIMITS.buttonChars))
        .min(1)
        .max(LIMITS.maxButtons)
        .refine((labels) => new Set(labels.map((l) => l.toLowerCase())).size === labels.length, 'Button labels must be unique')
        .optional()
        .describe('1-3 button labels; default ["Approve", "Deny"]. The answer reports the tapped index (0 = first).'),
    target: z
        .string()
        .regex(/^mobile_app_[a-z0-9_]{1,64}$/, 'target must be a mobile app notify service, e.g. "mobile_app_pixel_7"')
        .describe('The phone to ask: its notify service name, e.g. "mobile_app_pixel_7"'),
    timeoutSeconds: z
        .number()
        .int()
        .min(LIMITS.minTimeoutSeconds)
        .max(LIMITS.maxTimeoutSeconds)
        .optional()
        .describe(`How long the question stays open (default ${LIMITS.defaultTimeoutSeconds} s, max 7 days). No answer by then = timeout, treat as NO.`),
    channel: plainText('channel', 40).optional().describe('Android notification channel name'),
    importance: z.enum(['high', 'default', 'low', 'min']).optional().describe('Android notification channel importance'),
});

const requestIdSchema = z.string().min(1).max(4096).describe('The requestId returned by askOwner');

export const getOwnerAnswerSchema = z.object({
    requestId: requestIdSchema,
    waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(LIMITS.maxWaitSeconds)
        .optional()
        .describe(`Wait up to this many seconds for an answer before returning "pending" (default 25, max ${LIMITS.maxWaitSeconds})`),
});

export const cancelOwnerQuestionSchema = z.object({ requestId: requestIdSchema });

/** The token `sub` of the caller; stdio (local trust) has none. */
function callerOf(extra: ToolExtra): string {
    return extra.http?.authInfo?.clientId ?? 'local';
}

export function registerOwnerQuestionTools(server: McpServer, service: OwnerQuestionService): number {
    server.registerTool(
        'askOwner',
        {
            description:
                "Ask the owner a question on their phone with up to 3 buttons (default Approve / Deny) and return immediately with a requestId. " +
                'Then call getOwnerAnswer(requestId) until the status is not "pending". ' +
                'Anything except an explicit approving answer must be treated as NO: deny, timeout, cancelled and unknown. ' +
                'The owner may be away from the phone for hours; use a timeout that fits.',
            inputSchema: askOwnerSchema,
        },
        wrapToolHandler(
            'askOwner',
            async (args: z.infer<typeof askOwnerSchema>, extra: ToolExtra) =>
                toToolResult(
                    await service.ask(
                        {
                            question: args.question,
                            title: args.title ?? 'Approval needed',
                            buttons: args.buttons ?? ['Approve', 'Deny'],
                            target: args.target,
                            timeoutSeconds: args.timeoutSeconds ?? LIMITS.defaultTimeoutSeconds,
                            channel: args.channel,
                            importance: args.importance,
                        },
                        callerOf(extra)
                    )
                ),
            Permission.NOTIFY
        )
    );

    server.registerTool(
        'getOwnerAnswer',
        {
            description:
                'Get the answer to an askOwner question, waiting up to waitSeconds. Status: "answered" (with index, button, answeredAt, answeredBy), ' +
                '"pending" (ask again), "timeout", "cancelled" or "unknown". Only the client that asked can read the answer.',
            inputSchema: getOwnerAnswerSchema,
        },
        wrapToolHandler(
            'getOwnerAnswer',
            async (args: z.infer<typeof getOwnerAnswerSchema>, extra: ToolExtra) =>
                toToolResult(await service.getAnswer(args.requestId, callerOf(extra), args.waitSeconds ?? 25)),
            Permission.NOTIFY
        )
    );

    server.registerTool(
        'cancelOwnerQuestion',
        {
            description: 'Withdraw an open askOwner question; the phone notification changes to "Cancelled". Returns the final status.',
            inputSchema: cancelOwnerQuestionSchema,
        },
        wrapToolHandler(
            'cancelOwnerQuestion',
            async (args: z.infer<typeof cancelOwnerQuestionSchema>, extra: ToolExtra) =>
                toToolResult(await service.cancel(args.requestId, callerOf(extra))),
            Permission.NOTIFY
        )
    );

    return 3;
}
