/**
 * scripts/ci/publish-image.ts: the release decisions of the CI publish-image job,
 * with Docker, Trivy and git replaced by a recording stub.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { publishImage, newestRelease, parseRelease, TRIVY_IMAGE, type Run } from '../../scripts/ci/publish-image.js';

const IMAGE = 'ghcr.io/coffeerunhobby/mcp-ha-connect';

interface Stub {
    run: Run;
    calls: string[];
}

/** Records every command; `scanExit` is the gate scan's exit code, `tags` git's (unsorted) tag list. */
function stub(options: { scanExit?: number; tags?: string[]; failOn?: string } = {}): Stub {
    const calls: string[] = [];
    const run: Run = (command, args) => {
        const line = `${command} ${args.join(' ')}`;
        calls.push(line);
        if (options.failOn && line.includes(options.failOn)) return { status: 1, stdout: '' };
        if (command === 'docker' && args.includes('--exit-code')) return { status: options.scanExit ?? 0, stdout: '' };
        if (command === 'git' && args[0] === 'tag') return { status: 0, stdout: `${(options.tags ?? []).join('\n')}\n` };
        return { status: 0, stdout: '' };
    };
    return { run, calls };
}

const pushes = (calls: string[]) => calls.filter((c) => c.startsWith('docker push'));

describe('publishImage', () => {
    it('scans, pushes the version and moves latest when this is the newest tag', () => {
        const { run, calls } = stub({ tags: ['v2.3.0', 'v2.2.0', 'v2.1.1'] });

        const result = publishImage({ tag: 'v2.3.0', version: '2.3.0', image: IMAGE, run, log: () => undefined });

        expect(result.pushedLatest).toBe(true);
        expect(pushes(calls)).toEqual([`docker push ${IMAGE}:2.3.0`, `docker push ${IMAGE}:latest`]);
        const scan = calls.findIndex((c) => c.includes('--exit-code 1'));
        const firstPush = calls.findIndex((c) => c.startsWith('docker push'));
        expect(scan).toBeGreaterThanOrEqual(0);
        expect(scan).toBeLessThan(firstPush);
        expect(calls[scan]).toContain(TRIVY_IMAGE);
        expect(calls[scan]).toContain('--severity HIGH,CRITICAL --ignore-unfixed');
    });

    it('re-running an older tag pushes its version but leaves latest alone', () => {
        const { run, calls } = stub({ tags: ['v2.3.0', 'v2.2.0'] });
        const logs: string[] = [];

        const result = publishImage({ tag: 'v2.2.0', version: '2.2.0', image: IMAGE, run, log: (m) => logs.push(m) });

        expect(result.pushedLatest).toBe(false);
        expect(pushes(calls)).toEqual([`docker push ${IMAGE}:2.2.0`]);
        expect(calls.some((c) => c.includes(':latest'))).toBe(false);
        expect(logs.join()).toContain('not the newest release (v2.3.0)');
    });

    it('a failed vulnerability scan stops the release before anything is pushed', () => {
        const { run, calls } = stub({ scanExit: 1, tags: ['v2.3.0'] });

        expect(() => publishImage({ tag: 'v2.3.0', version: '2.3.0', image: IMAGE, run, log: () => undefined })).toThrow(
            /Vulnerability scan failed/
        );
        expect(pushes(calls)).toEqual([]);
    });

    it('refuses a tag that does not match package.json, before running anything', () => {
        const { run, calls } = stub();

        expect(() => publishImage({ tag: 'v2.3.1', version: '2.3.0', image: IMAGE, run })).toThrow(
            'Tag v2.3.1 does not match package.json version 2.3.0'
        );
        expect(calls).toEqual([]);
    });

    it('does not move latest if pushing the version failed', () => {
        const { run, calls } = stub({ tags: ['v2.3.0'], failOn: `push ${IMAGE}:2.3.0` });

        expect(() => publishImage({ tag: 'v2.3.0', version: '2.3.0', image: IMAGE, run, log: () => undefined })).toThrow(/Pushing/);
        expect(calls.some((c) => c.includes(':latest'))).toBe(false);
    });

    it('compares version numbers, so v2.10.0 is newer than v2.9.0 whatever order git lists them in', () => {
        const { run, calls } = stub({ tags: ['v2.9.0', 'v2.10.0', 'v2.2.1'] });

        publishImage({ tag: 'v2.10.0', version: '2.10.0', image: IMAGE, run, log: () => undefined });

        expect(pushes(calls)).toContain(`docker push ${IMAGE}:latest`);
    });

    it('a final release moves latest even when its release candidate exists', () => {
        const { run, calls } = stub({ tags: ['v2.3.0-rc.1', 'v2.3.0', 'v2.2.0'] });

        expect(publishImage({ tag: 'v2.3.0', version: '2.3.0', image: IMAGE, run, log: () => undefined }).pushedLatest).toBe(true);
        expect(pushes(calls)).toContain(`docker push ${IMAGE}:latest`);
    });

    it('a release candidate never moves latest, even as the newest tag or rerun later', () => {
        for (const tags of [['v2.3.0-rc.1', 'v2.2.0'], ['v2.3.0-rc.1', 'v2.3.0']]) {
            const { run, calls } = stub({ tags });
            const result = publishImage({ tag: 'v2.3.0-rc.1', version: '2.3.0-rc.1', image: IMAGE, run, log: () => undefined });
            expect(result.pushedLatest).toBe(false);
            expect(pushes(calls)).toEqual([`docker push ${IMAGE}:2.3.0-rc.1`]);
        }
    });

    it('parseRelease / newestRelease', () => {
        expect(parseRelease('v2.2.1')).toEqual([2, 2, 1]);
        for (const t of ['v2.3.0-rc.1', '2.2.1', 'v2.2', 'v2.2.1.1', '']) expect(parseRelease(t)).toBeNull();
        expect(newestRelease(['v1.10.0', 'v2.0.0-rc.2', 'v1.9.9', 'junk'])).toBe('v1.10.0');
        expect(newestRelease(['v3.0.0-beta.1'])).toBeUndefined();
    });
});

describe('publish-image CLI', () => {
    // The release job runs on Node 24; older Node lines in the test matrix cannot run .ts directly.
    const canStripTypes = Boolean((process.features as { typescript?: unknown }).typescript);

    it.skipIf(!canStripTypes)('runs under plain node (type stripping) and fails clearly without its environment', () => {
        const result = spawnSync(process.execPath, [resolve(__dirname, '../../scripts/ci/publish-image.ts')], {
            cwd: resolve(__dirname, '../..'),
            env: { PATH: process.env.PATH ?? '' },
            encoding: 'utf8',
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('publish-image: IMAGE and GITHUB_REF_NAME must be set');
    });
});
