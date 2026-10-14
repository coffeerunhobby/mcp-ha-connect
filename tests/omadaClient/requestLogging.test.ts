/**
 * The Omada HTTP layer logs request and response bodies at debug level. Secrets in them
 * (the Wi-Fi password in an SSID detail, the one an SSID update resends) must never
 * reach the log, not even partly.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import type { AuthManager } from '../../src/omadaClient/auth.js';
import { RequestHandler } from '../../src/omadaClient/request.js';
import { logger } from '../../src/utils/logger.js';

const SECRET = 'HouseWifiPassw0rd!';

describe('Omada request logging', () => {
    afterEach(() => vi.restoreAllMocks());

    it('never logs a Wi-Fi password from a response or a request body', async () => {
        const detail = { name: 'home-wifi', pskSetting: { securityKey: SECRET, versionPsk: 4 }, radiusSecret: 'Qz7r-s3cret-K9xw', simPin: '1234' };
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ errorCode: 0, result: detail }), { status: 200, headers: { 'content-type': 'application/json' } }));
        const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(logger, level));
        const auth = { getAccessToken: vi.fn(async () => 'Tk42-token-zz88') } as unknown as AuthManager;
        const handler = new RequestHandler({ baseUrl: 'https://controller.test:8043', strictSsl: true }, auth);

        await handler.get('/openapi/v1/c/sites/s/wireless-network/wlans/w/ssids/x');
        await handler.patch('/openapi/v1/c/sites/s/wireless-network/wlans/w/ssids/x/update-basic-config', { name: 'home-wifi', pskSetting: { securityKey: SECRET } });

        const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
        expect(logged).toContain('home-wifi');
        // Not even the first or last four characters of any secret.
        expect(logged).not.toMatch(/Hous|0rd!|Qz7r|K9xw|Tk42|zz88|"1234"/);
    });
});
