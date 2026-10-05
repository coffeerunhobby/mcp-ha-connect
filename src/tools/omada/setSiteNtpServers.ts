import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { OmadaClient } from '../../omadaClient/index.js';
import { MAX_NTP_SERVERS } from '../../omadaClient/site.js';
import { toToolResult, wrapToolHandler, Permission } from '../common.js';

export const setSiteNtpServersSchema = z.object({
    servers: z
        .array(z.string().min(1))
        .max(MAX_NTP_SERVERS)
        .describe(`NTP server addresses (hostname or IPv4), in priority order; at most ${MAX_NTP_SERVERS}. Replaces the current list.`),
    enabled: z.boolean().optional().describe('Turn the site NTP setting on (default) or off'),
    siteId: z.string().min(1).optional(),
    dryRun: z.boolean().optional().describe('If true, return the exact change without writing it'),
});

export function registerSetSiteNtpServersTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'omada_setSiteNtpServers',
        {
            description:
                "Set a site's NTP (network time) servers, replacing the current list. " +
                'Omada stores NTP in the site settings, so this re-writes the site settings with only the NTP fields changed; ' +
                'the result shows the list before and after. Use dryRun first to preview. ' +
                'Wrong time breaks certificates, logs and schedules on every network device - confirm with the user before applying.',
            inputSchema: setSiteNtpServersSchema,
        },
        wrapToolHandler(
            'omada_setSiteNtpServers',
            async ({ servers, enabled, siteId, dryRun }: z.infer<typeof setSiteNtpServersSchema>) =>
                toToolResult(await client.setSiteNtpServers(servers, { enabled, siteId, dryRun })),
            Permission.CONFIGURE
        )
    );
}
