/**
 * Secrets returned by Home Assistant / Omada never reach a tool response.
 */

import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';

import { redactSecrets, REDACTED } from '../../src/utils/redact.js';
import { toToolResult } from '../../src/tools/common.js';
import { registerOmadaGraphTools } from '../../src/tools/omada/graph.js';
import type { OmadaClient } from '../../src/omadaClient/index.js';

/** Shape of an Omada SSID detail (GET .../wlans/{wlanId}/ssids/{ssidId}). */
const ssidDetail = {
    ssidId: 'home-wifi',
    name: 'home-wifi',
    security: 3,
    hidePwd: true,
    pskSetting: { versionPsk: 2, encryptionPsk: 3, gikRekeyPskEnable: false, securityKey: 'HouseWifiPassw0rd!' },
    macFilterEnable: false,
};

describe('redactSecrets', () => {
    it('redacts the Wi-Fi password but keeps flags and numbers with similar names', () => {
        const out = redactSecrets(ssidDetail);

        expect(out.pskSetting.securityKey).toBe(REDACTED);
        expect(out.pskSetting.versionPsk).toBe(2);
        expect(out.pskSetting.encryptionPsk).toBe(3);
        expect(out.hidePwd).toBe(true);
        expect(out.name).toBe('home-wifi');
        expect(JSON.stringify(out)).not.toContain('HouseWifiPassw0rd!');
    });

    it.each([
        ['RADIUS profile', { authServer: [{ ip: '10.0.0.2', port: 1812, secret: 'radius-s3cret' }], accountingServerPwd: 'acct-pw', coaPassword: 'coa-pw', radiusPwd: 'rp' }],
        ['PPSK profile', { name: 'kids', ppsk: [{ name: 'tablet', password: 'ppsk-key-1', vlanId: 20 }] }],
        ['VPN', { preSharedKey: 'ipsec-psk', presharedKey: 'wg-psk', privateKey: 'wg-private', publicKey: 'wg-public' }],
        ['SNMP', { snmpV1V2CEnable: true, communityString: 'snmp-community' }],
        ['portal and hotspot', { password: 'portal-pw', authCode: 'auth-code-123', simpleKey: 'sk', md5Key: 'mk' }],
        ['SSID variants', { psk: 'override-psk', ssidPassword: 'ssid-pw', bridgeSsidPassword: 'bridge-pw', overrideSsidPassword: 'ov-pw' }],
        ['VRRP and certificates', { key: 'vrrp-key', keyPassword: 'ks-pw', trustPassword: 'trust-pw' }],
        ['webhooks and tokens', { shardedSecret: 'hook-secret', authToken: 'twilio-token', accessToken: 'at', token: 'user-token' }],
    ])('redacts every secret in a %s', (_name, input) => {
        const text = JSON.stringify(redactSecrets(input));

        for (const secret of ['radius-s3cret', 'acct-pw', 'coa-pw', 'ppsk-key-1', 'ipsec-psk', 'wg-psk', 'wg-private', 'snmp-community', 'portal-pw', 'auth-code-123', 'override-psk', 'ssid-pw', 'bridge-pw', 'ov-pw', 'vrrp-key', 'ks-pw', 'trust-pw', 'hook-secret', 'twilio-token', 'user-token']) {
            expect(text).not.toContain(secret);
        }
    });

    it('keeps public, non-secret values (public keys, ids, names)', () => {
        const out = redactSecrets({ publicKey: 'wg-public', keyId: 'k1', searchKey: 'abc', ppskProfileId: 'p1' });
        expect(out).toEqual({ publicKey: 'wg-public', keyId: 'k1', searchKey: 'abc', ppskProfileId: 'p1' });
    });

    it('redacts the SIM PIN/PUK and the dial-up account names of the internet settings (omada_read /network/internet)', () => {
        const internet = {
            wanPortSettings: [{ wanPortIpv4Setting: { ipv4Pppoe: { userName: 'isp-login-123', password: 'isp-pw', mssClampingType: 0 } } }],
            usbLteSettings: [{ pin: '1234', puk: '12345678', simPin: '4321', manuallyConfig: { apn: 'internet.example', username: 'apn-user', password: 'apn-pw' } }],
        };

        expect(redactSecrets(internet)).toEqual({
            wanPortSettings: [{ wanPortIpv4Setting: { ipv4Pppoe: { userName: '<redacted>', password: '<redacted>', mssClampingType: 0 } } }],
            usbLteSettings: [{ pin: '<redacted>', puk: '<redacted>', simPin: '<redacted>', manuallyConfig: { apn: 'internet.example', username: '<redacted>', password: '<redacted>' } }],
        });
    });

    it('inside a VPN section redacts only the account name, not the profile name or server', () => {
        expect(redactSecrets({ clientVpns: [{ name: 'Office', server: 'vpn.example', username: 'vpn-user', serviceName: 'svc' }] })).toEqual({
            clientVpns: [{ name: 'Office', server: 'vpn.example', username: '<redacted>', serviceName: 'svc' }],
        });
    });

    it('keeps ordinary user names and pin-like names outside dial-up and VPN sections', () => {
        const value = { users: [{ username: 'cristi', name: 'Cristi' }], pinned: 'yes', mapping: 'a', ping: 'ok', pinEnable: true, pinCount: 3 };

        expect(redactSecrets(value)).toEqual(value);
    });

    it('masks tokens inside URLs (Home Assistant camera image)', () => {
        const out = redactSecrets({
            entity_picture: '/api/camera_proxy/camera.door?token=0123456789abcdef&width=640',
            attributes: { access_token: 'cam-token' },
        });
        expect(out.entity_picture).toBe(`/api/camera_proxy/camera.door?token=${REDACTED}&width=640`);
        expect(out.attributes.access_token).toBe(REDACTED);
    });

    it('leaves empty secrets empty, so "is it set?" stays answerable', () => {
        expect(redactSecrets({ password: '', securityKey: 'x' })).toEqual({ password: '', securityKey: REDACTED });
    });

    it('does not modify its input', () => {
        const input = structuredClone(ssidDetail);
        redactSecrets(input);
        expect(input).toEqual(ssidDetail);
    });

    it('handles arrays, nulls and plain strings', () => {
        expect(redactSecrets([{ password: 'p' }, null, 3])).toEqual([{ password: REDACTED }, null, 3]);
        expect(redactSecrets('see /x?token=abc')).toBe(`see /x?token=${REDACTED}`);
        expect(redactSecrets(null)).toBeNull();
    });
});

describe('tool responses are redacted', () => {
    it('toToolResult never carries a secret', () => {
        const result = toToolResult(ssidDetail);
        expect(result.content[0].text).not.toContain('HouseWifiPassw0rd!');
        expect(result.content[0].text).toContain(REDACTED);
    });

    it('omada_read of a VPN resource redacts account names in an unwrapped list, but not elsewhere', async () => {
        const handlers = new Map<string, (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>>();
        const server = { registerTool: vi.fn((name, _c, h) => handlers.set(name, h)) } as unknown as McpServer;
        const vpnUsers = [{ name: 'Office', username: 'vpn-user', ip: '10.8.0.2' }];
        const client = { readResource: vi.fn().mockResolvedValue(vpnUsers), listMacGroups: vi.fn().mockResolvedValue([{ name: 'KnownWiFi', username: 'not-an-account' }]) } as unknown as OmadaClient;
        registerOmadaGraphTools(server, client);
        const extra = { sessionId: 's', http: { authInfo: { extra: { permissions: 0xff } } } };

        const vpn = JSON.parse((await handlers.get('omada_read')!({ path: '/vpn/client-to-site/clients' }, extra)).content[0].text);
        const groups = JSON.parse((await handlers.get('omada_read')!({ path: '/profiles/mac-groups' }, extra)).content[0].text);

        expect(vpn).toEqual([{ name: 'Office', username: REDACTED, ip: '10.8.0.2' }]);
        expect(groups).toEqual([{ name: 'KnownWiFi', username: 'not-an-account' }]);
    });

    it('omada_read /wifi/ssids (SSID detail) does not return the Wi-Fi password', async () => {
        const handlers = new Map<string, (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>>();
        const server = { registerTool: vi.fn((name, _c, h) => handlers.set(name, h)) } as unknown as McpServer;
        const client = { getSsidDetail: vi.fn().mockResolvedValue(ssidDetail), getSsidList: vi.fn() } as unknown as OmadaClient;
        registerOmadaGraphTools(server, client);

        const result = await handlers.get('omada_read')!(
            { path: '/wifi/ssids', params: { wlanId: 'w1', ssidId: 'home-wifi' } },
            { sessionId: 's', http: { authInfo: { extra: { permissions: 0xff } } } }
        );

        expect(client.getSsidDetail).toHaveBeenCalled();
        expect(result.content[0].text).not.toContain('HouseWifiPassw0rd!');
        expect(JSON.parse(result.content[0].text).pskSetting.securityKey).toBe(REDACTED);
    });
});
