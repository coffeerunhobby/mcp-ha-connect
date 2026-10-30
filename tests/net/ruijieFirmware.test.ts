/**
 * Ruijie firmware (2.5.1): what the router runs and is offered (system getVersion, recorded on a
 * RG-EG105G-V3 offered ReyeeOS 2.430 on 2026-10-24), and the upgrade as a planned change: only to
 * the version the router was offered, only from Ruijie's own download server, every LAN device
 * counted as cut off while it restarts, refused when anything changed since the dry run.
 */

import { readFileSync } from 'node:fs';

import type { McpServer } from '@modelcontextprotocol/server';
import { describe, it, expect, vi } from 'vitest';

import { RuijieNetworkController, isRuijieDownload, toOffer } from '../../src/net/adapters/ruijie.js';
import { NetError, type Change, type Plan } from '../../src/net/model.js';
import { Permission } from '../../src/permissions/index.js';
import { RuijieError, type RuijieClient } from '../../src/ruijieClient/index.js';
import { registerNetTools } from '../../src/tools/net/index.js';

type Raw = Record<string, unknown>;
const fixture = (name: string): Raw => (JSON.parse(readFileSync(new URL(`./fixtures/ruijie/${name}.json`, import.meta.url), 'utf8')) as { data: Raw }).data;
const VERSION = fixture('getVersion');
const OFFERED = 'ReyeeOS 2.430.1.2128;EG_3.0(1)B11P430,Release(13212809)';
const CURRENT = 'ReyeeOS 2.324.0.1521;EG_3.0(1)B11P324,Release(12152110)';
const URL_TAR = ((VERSION.new as Raw).firmwareList as Raw[])[0].downloadUrlTar as string;

function controller(over: { version?: Raw; upgrade?: () => unknown; readOnly?: boolean; firmwareUpgrade?: boolean } = {}) {
    const state = { version: over.version ?? structuredClone(VERSION) };
    const calls: Array<[string, unknown]> = [];
    const answers: Record<string, Raw> = {
        'devConfig.get network': fixture('network'),
        'devSta.get dhcp_lease': fixture('dhcp_lease'),
        'devSta.get arp': fixture('arp'),
        'devSta.get sysinfo': fixture('sysinfo'),
    };
    const client = {
        host: '192.168.110.1',
        ...(over.readOnly !== undefined ? { readOnly: over.readOnly } : {}),
        ...(over.firmwareUpgrade !== undefined ? { firmwareUpgrade: over.firmwareUpgrade } : {}),
        config: async (module: string) => answers[`devConfig.get ${module}`],
        status: async (module: string) => answers[`devSta.get ${module}`],
        system: async (method: string, params?: unknown) => {
            calls.push([method, params]);
            if (method === 'getVersion') return structuredClone(state.version);
            if (method === 'upgradeConfirm') return over.upgrade ? over.upgrade() : { ok: true };
            throw new Error(`unexpected ${method}`);
        },
    } as unknown as RuijieClient;
    return { net: new RuijieNetworkController(client), calls, state, answers };
}

const upgrade: Change = { op: 'upgrade', kind: 'firmware' };
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof NetError ? e.code : `not a NetError: ${String(e)}`));
const upgrades = (calls: Array<[string, unknown]>) => calls.filter(([m]) => m === 'upgradeConfirm');

describe('the offered firmware', () => {
    it('reads what runs and what is offered, trimmed, with notes and size', () => {
        expect(toOffer(VERSION)).toEqual({ current: CURRENT, version: OFFERED, notes: expect.stringContaining('DNS blocklist'), sizeBytes: 20877643, url: URL_TAR, md5: expect.stringMatching(/^[0-9a-f]{32}$/) });
    });

    it('offers nothing when the list is empty, the version is the running one, or it is unreadable', () => {
        expect(toOffer({ cur: 'v1\n', new: { totalCount: 0, firmwareList: [] } })).toEqual({ current: 'v1' });
        expect(toOffer({ cur: 'v1', new: { firmwareList: [{ versionCode: ' v1 ' }] } })).toEqual({ current: 'v1' });
        expect(toOffer({ cur: 'v1', new: { firmwareList: [{ versionCode: '' }] } })).toEqual({ current: 'v1' });
        expect(toOffer({ cur: 'v1' })).toEqual({ current: 'v1' });
        expect(toOffer({ cur: 'v1', new: { firmwareList: [{ versionCode: 'v2', fileSize: 'x', releaseNotes: '  ', downloadUrlTar: 'u' }] } })).toEqual({ current: 'v1', version: 'v2', url: 'u' });
    });

    it('trusts only Ruijie\'s own download servers, by host', () => {
        expect(isRuijieDownload(URL_TAR)).toBe(true);
        expect(isRuijieDownload('https://devicecdn-eu.ruijienetworks.com/x.tar.gz')).toBe(true);
        expect(isRuijieDownload('https://ruijienetworks.com/x')).toBe(true);
        expect(isRuijieDownload('https://ruijienetworks.com.evil.example/x')).toBe(false);
        expect(isRuijieDownload('https://evilruijienetworks.com/x')).toBe(false);
        expect(isRuijieDownload('https://user:pw@devicecdn-eu.ruijienetworks.com/x')).toBe(false);
        expect(isRuijieDownload('ftp://devicecdn-eu.ruijienetworks.com/x')).toBe(false);
        expect(isRuijieDownload('file:///etc/passwd')).toBe(false);
        expect(isRuijieDownload('not a url')).toBe(false);
        expect(isRuijieDownload(undefined)).toBe(false);
    });

    it('lists the router\'s firmware: running, offered, upgradable', async () => {
        const { net } = controller();
        expect(await net.listFirmware()).toEqual([
            {
                device: { mac: '02-00-00-00-00-02' },
                model: 'EG105G-V3',
                current: CURRENT,
                available: { version: OFFERED, notes: expect.stringContaining('Turbo Mode'), sizeBytes: 20877643 },
                upgradable: true,
            },
        ]);
        expect((await net.capabilities()).firmware).toBe('native');
    });

    it('lists the latest firmware as not upgradable, and an offer from elsewhere as not upgradable', async () => {
        const latest = controller({ version: { cur: CURRENT, new: { totalCount: 0, firmwareList: [] } } });
        expect(await latest.net.listFirmware()).toEqual([{ device: { mac: '02-00-00-00-00-02' }, model: 'EG105G-V3', current: CURRENT, upgradable: false }]);

        const elsewhere = controller({ version: { cur: CURRENT, new: { firmwareList: [{ versionCode: OFFERED, downloadUrlTar: 'http://mirror.example/fw.tar.gz' }] } } });
        expect((await elsewhere.net.listFirmware())[0]).toMatchObject({ available: { version: OFFERED }, upgradable: false });

        const blank = controller({ version: { cur: '', new: {} } });
        expect((await blank.net.listFirmware())[0].current).toBe('ReyeeOS 2.324.0.1521;EG_3.0(1)B11P324,Release(12152110)');
    });
});

describe('upgrading the firmware', () => {
    it('plans the upgrade to the offered version: steps, what happens, and every LAN device cut off meanwhile', async () => {
        const { net, calls } = controller();
        const plan = await net.plan(upgrade);

        expect(plan.steps).toEqual([{ action: 'update', object: 'ruijie.firmware', name: 'EG105G-V3 02-00-00-00-00-02', detail: `${CURRENT} → ${OFFERED}` }]);
        expect(plan.effects[0]).toBe(`The router downloads ${OFFERED} from Ruijie (21 MB) and installs it, keeping its settings.`);
        expect(plan.effects[1]).toBe("It restarts: for several minutes every device on its LAN is offline and the router can't be reached.");
        expect(plan.effects[2]).toMatch(/^Release notes: Resolved issue/);
        expect(plan.wouldLockOut.map((c) => c.name)).toEqual(['pc-1']);
        expect(plan.basis).toMatch(/^[0-9a-f]{16}$/);
        expect(upgrades(calls)).toEqual([]);
    });

    it('needs allowLockout, then sends the router\'s own download address and keeps the settings', async () => {
        const { net, calls } = controller();
        const plan = await net.plan(upgrade);

        expect(await code(net.apply(plan))).toBe('LOCKOUT');
        expect(upgrades(calls)).toEqual([]);

        const result = await net.apply(plan, { allowLockout: true });
        expect(upgrades(calls)).toEqual([['upgradeConfirm', { path: URL_TAR, isPersist: true }]]);
        expect(result).toEqual({
            applied: true,
            object: { device: { mac: '02-00-00-00-00-02' }, model: 'EG105G-V3', current: CURRENT, available: { version: OFFERED }, upgradable: true },
            owned: [],
            warnings: ['The router is downloading and installing the firmware and will restart; check net_listFirmware in about five minutes.'],
        });
    });

    it('refuses with CONFLICT when the offer or the devices changed after the dry run, sending nothing', async () => {
        const offer = controller();
        const plan = await offer.net.plan(upgrade);
        ((offer.state.version.new as Raw).firmwareList as Raw[])[0].md5 = '0'.repeat(32);
        expect(await code(offer.net.apply(plan, { allowLockout: true }))).toBe('CONFLICT');
        expect(upgrades(offer.calls)).toEqual([]);

        const joined = controller();
        const planned = await joined.net.plan(upgrade);
        const arp = joined.answers['devSta.get arp'];
        (arp.arpList as Raw[]).push({ hardware: '02:00:00:00:00:44', intf: 'br-lan', address: '192.168.110.44' });
        expect(await code(joined.net.apply(planned, { allowLockout: true }))).toBe('CONFLICT');
        expect(upgrades(joined.calls)).toEqual([]);

        const other = controller();
        const before = await other.net.plan(upgrade);
        expect(await code(other.net.apply({ ...before, change: { op: 'upgrade', kind: 'firmware', device: { name: 'router' } } }, { allowLockout: true }))).toBe('CONFLICT');
        expect(upgrades(other.calls)).toEqual([]);
    });

    it('never reports an unanswered upgrade as done: unknown when it may have arrived, a plain failure when it was not sent', async () => {
        const unanswered = controller({ upgrade: () => Promise.reject(new RuijieError('The Ruijie router timed out', 'unreachable')) });
        await expect(unanswered.net.apply(await unanswered.net.plan(upgrade), { allowLockout: true })).rejects.toThrow(
            'The router stopped answering while the upgrade request was being sent: it may be restarting into the upgrade, or the request may not have arrived. Check net_listFirmware in about five minutes before trying again.'
        );

        const notSent = controller({ upgrade: () => Promise.reject(new RuijieError('The Ruijie router is not reachable', 'unreachable', true)) });
        await expect(notSent.net.apply(await notSent.net.plan(upgrade), { allowLockout: true })).rejects.toThrow(/^The Ruijie router is not reachable$/);

        const refused = controller({ upgrade: () => Promise.reject(new RuijieError('The Ruijie router refused system upgradeConfirm (code 5)')) });
        await expect(refused.net.apply(await refused.net.plan(upgrade), { allowLockout: true })).rejects.toThrow('refused system upgradeConfirm');
    });

    it('refuses the latest firmware, an offer from elsewhere, another device and other changes, sending nothing', async () => {
        const latest = controller({ version: { cur: CURRENT, new: { firmwareList: [] } } });
        await expect(latest.net.plan(upgrade)).rejects.toMatchObject({ code: 'INVALID', message: `The router already runs the newest firmware it is offered (${CURRENT})` });
        const unknown = controller({ version: { cur: '', new: {} } });
        await expect(unknown.net.plan(upgrade)).rejects.toThrow('the newest firmware it is offered (unknown)');

        const elsewhere = controller({ version: { cur: CURRENT, new: { firmwareList: [{ versionCode: OFFERED, downloadUrlTar: 'http://mirror.example/fw.tar.gz' }] } } });
        await expect(elsewhere.net.plan(upgrade)).rejects.toMatchObject({ code: 'UNSUPPORTED', details: { capability: 'firmware' } });

        const { net, calls } = controller();
        expect(await code(net.plan({ op: 'upgrade', kind: 'firmware', device: { mac: '02:00:00:00:00:99' } }))).toBe('NOT_FOUND');
        expect(await code(net.plan({ op: 'upgrade', kind: 'firmware', device: { name: 'EG105G-V3' } }))).toBe('ok');
        await expect(net.plan({ op: 'delete', kind: 'rule', ref: { name: 'x' } })).rejects.toMatchObject({ code: 'UNSUPPORTED', details: { capability: 'rule' } });
        expect(await code(net.apply({ change: { op: 'delete', kind: 'rule', ref: { name: 'x' } } } as Plan))).toBe('UNSUPPORTED');
        expect(upgrades(calls)).toEqual([]);
        expect(elsewhere.calls.filter(([m]) => m === 'upgradeConfirm')).toEqual([]);
    });

    it('names the router in the basis: another router behind the same address is a CONFLICT, one without a MAC is refused', async () => {
        const swapped = controller();
        const plan = await swapped.net.plan(upgrade);
        const info = swapped.answers['devSta.get sysinfo'];
        info.sys_mac = '02:00:00:00:00:99';
        expect(await code(swapped.net.apply(plan, { allowLockout: true }))).toBe('CONFLICT');
        expect(upgrades(swapped.calls)).toEqual([]);

        delete info.sys_mac;
        await expect(swapped.net.plan(upgrade)).rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining("doesn't report its MAC address") });
    });

    it('always needs allowLockout and the basis, even when no device is seen on the LAN', async () => {
        const nobody = controller();
        (nobody.answers['devSta.get arp'].arpList as Raw[]).length = 0;
        const plan = await nobody.net.plan(upgrade);
        expect(plan.wouldLockOut).toEqual([]);
        await expect(nobody.net.apply(plan)).rejects.toMatchObject({ code: 'LOCKOUT', message: "The upgrade would make the router unreachable while it restarts. Nothing was changed; repeat with allowLockout and the dry run's basis if that is intended." });

        const handlers = new Map<string, (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>>();
        registerNetTools({ registerTool: vi.fn((name: string, _c: unknown, h: never) => handlers.set(name, h)) } as unknown as McpServer, nobody.net);
        const tool = (args: Raw) => handlers.get('net_upgradeFirmware')!(args, { sessionId: 's', http: { authInfo: { extra: { permissions: Permission.ADMIN } } } });

        for (const args of [{}, { allowLockout: true }, { basis: plan.basis }]) {
            const answer = await tool(args);
            expect(answer.isError).toBe(true);
            expect(answer.content[0].text).toContain('run it with dryRun first');
        }
        expect(upgrades(nobody.calls)).toEqual([]);

        const dry = JSON.parse((await tool({ dryRun: true })).content[0].text) as { basis: string };
        expect(dry.basis).toBe(plan.basis);
        expect((await tool({ allowLockout: true, basis: dry.basis })).isError).toBeFalsy();
        expect(upgrades(nobody.calls)).toHaveLength(1);
    });

    it('leaves out the size when the router doesn\'t give it, and keeps working after a refused apply', async () => {
        const noSize = structuredClone(VERSION);
        delete ((noSize.new as Raw).firmwareList as Raw[])[0].fileSize;
        delete ((noSize.new as Raw).firmwareList as Raw[])[0].releaseNotes;
        const { net, calls } = controller({ version: noSize });
        const plan = await net.plan(upgrade);
        expect(plan.effects).toEqual([`The router downloads ${OFFERED} from Ruijie and installs it, keeping its settings.`, "It restarts: for several minutes every device on its LAN is offline and the router can't be reached."]);

        expect(await code(net.apply(plan))).toBe('LOCKOUT');
        await net.apply(plan, { allowLockout: true });
        expect(upgrades(calls)).toHaveLength(1);
    });
});

describe('switching changes off on this server (2.5.2)', () => {
    it('RUIJIE_FIRMWARE_UPGRADE=false: firmware still listed, not upgradable, the upgrade refused before anything is read or sent', async () => {
        const { net, calls } = controller({ firmwareUpgrade: false });
        expect((await net.listFirmware())[0]).toMatchObject({ available: { version: OFFERED }, upgradable: false });
        expect((await net.capabilities()).firmware).toBe('unsupported');
        calls.length = 0;
        await expect(net.plan(upgrade)).rejects.toMatchObject({ code: 'UNSUPPORTED', message: 'Firmware upgrades on the Ruijie router are switched off on this server (RUIJIE_FIRMWARE_UPGRADE=false)', details: { capability: 'firmware' } });
        expect(calls).toEqual([]);
    });

    it('RUIJIE_READ_ONLY=true: every change refused, firmware included, reads unchanged', async () => {
        const { net, calls } = controller({ readOnly: true });
        expect((await net.listFirmware())[0].upgradable).toBe(false);
        expect((await net.capabilities()).firmware).toBe('unsupported');
        calls.length = 0;
        for (const change of [upgrade, { op: 'delete', kind: 'reservation', mac: '02:00:00:00:00:03' } as Change]) {
            await expect(net.plan(change)).rejects.toMatchObject({ code: 'UNSUPPORTED', message: 'Changes to the Ruijie router are switched off on this server (RUIJIE_READ_ONLY=true)', details: { capability: change.kind } });
        }
        expect(calls).toEqual([]);
        expect(await net.listNetworks()).not.toEqual([]);
    });

    it('both on (the defaults): upgradable as before', async () => {
        const { net } = controller({ readOnly: false, firmwareUpgrade: true });
        expect((await net.listFirmware())[0].upgradable).toBe(true);
        expect(await code(net.plan(upgrade))).toBe('ok');
    });
});
