/**
 * Where the net_ tools' Omada adapter learns what it must never cut off: the controller's
 * host (from OMADA_BASE_URL) and this server's addresses (MCP_SERVER_ADDRESSES), from the
 * environment through the config and the Omada client.
 */

import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';

import { loadConfig } from '../../src/config.js';
import { OmadaClient } from '../../src/omadaClient/index.js';
import { registerAllTools } from '../../src/tools/index.js';
import { defaultFactories } from '../../src/upstreams.js';
import { RuijieClient as RealRuijieClient } from '../../src/ruijieClient/index.js';
import type { RuijieClient } from '../../src/ruijieClient/index.js';

const adapter = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('../../src/net/adapters/omada.js', () => ({
    OmadaNetworkController: vi.fn(function (this: object, _client: unknown, options: unknown) {
        adapter.options.push(options);
        Object.assign(this, { id: 'omada:default', vendor: 'omada' });
    }),
}));

const env = { OMADA_BASE_URL: 'https://omada.home.test:8043/', OMADA_CLIENT_ID: 'id', OMADA_CLIENT_SECRET: 'x', OMADA_OMADAC_ID: 'c1' };

describe('net_ protection settings', () => {
    it('reads MCP_SERVER_ADDRESSES as a trimmed list (empty when unset)', () => {
        expect(loadConfig(env).serverAddresses).toEqual([]);
        expect(loadConfig({ ...env, MCP_SERVER_ADDRESSES: ' 10.0.0.18 , nas.home.test ,' }).serverAddresses).toEqual(['10.0.0.18', 'nas.home.test']);
    });

    it('hands the controller host and this server\'s addresses to the adapter', () => {
        const client = defaultFactories.omada(loadConfig({ ...env, MCP_SERVER_ADDRESSES: '10.0.0.18' }));
        expect(client).toBeInstanceOf(OmadaClient);
        expect(client.serverAddresses).toEqual(['10.0.0.18']);
        expect(new OmadaClient({ baseUrl: 'https://x.test', clientId: 'a', clientSecret: 'b', omadacId: 'c', strictSsl: true }).serverAddresses).toEqual([]);

        registerAllTools({ server: new McpServer({ name: 't', version: '0' }), omadaClient: client });

        expect(adapter.options).toEqual([{ controllerHost: 'omada.home.test', serverHosts: ['10.0.0.18'] }]);
    });

    it('registers the net_ tools for a Ruijie router alone (no Omada)', () => {
        const names: string[] = [];
        const server = { registerTool: vi.fn((name: string) => names.push(name)) } as unknown as McpServer;

        registerAllTools({ server, ruijieClient: { host: '192.0.2.1' } as unknown as RuijieClient });

        expect(names.filter((n) => n.startsWith('net_'))).toHaveLength(26);
        expect(names).toHaveLength(26); // nothing else: no Omada tools, no analyzeSensors without an AI client
    });

    it('builds the Ruijie client with the pin and the switches from the settings', () => {
        const env = { HA_URL: 'http://ha.test:8123', HA_TOKEN: 't', RUIJIE_BASE_URL: 'https://192.0.2.1', RUIJIE_PASSWORD: 'pw' };
        const plain = defaultFactories.ruijie(loadConfig(env));
        expect(plain).toBeInstanceOf(RealRuijieClient);
        expect(plain).toMatchObject({ readOnly: false, firmwareUpgrade: true, host: '192.0.2.1' });
        const pinned = defaultFactories.ruijie(loadConfig({ ...env, RUIJIE_CERT_SHA256: 'ab'.repeat(32), RUIJIE_READ_ONLY: 'true', RUIJIE_FIRMWARE_UPGRADE: 'false' }));
        expect(pinned).toMatchObject({ readOnly: true, firmwareUpgrade: false });
        expect((pinned as unknown as { dispatcher: unknown }).dispatcher).toBeDefined();
        expect((plain as unknown as { dispatcher: unknown }).dispatcher).toBeUndefined();
    });
});
