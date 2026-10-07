/**
 * Release image publishing, run by the CI `publish-image` job on a `v*` tag,
 * after the image has been built and boot-tested (scripts/ci/smoke.sh):
 *
 *   1. the tag must match package.json's version;
 *   2. vulnerability scan (Trivy, pinned) — fixable HIGH/CRITICAL findings stop
 *      the release BEFORE anything is pushed;
 *   3. push `<image>:<version>`;
 *   4. move `<image>:latest` only for a final release (vX.Y.Z, no pre-release
 *      suffix) that is the newest final release by version number, so neither a
 *      release candidate nor re-running an old release ever moves `latest`.
 *
 * Usage (Node >= 22.18 runs TypeScript directly): IMAGE=ghcr.io/owner/name node scripts/ci/publish-image.ts
 * Expects the image built and `docker login` done by the workflow.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface RunResult {
    status: number;
    stdout: string;
}

/** Runs a command; injected so the decisions can be tested without Docker or git. */
export type Run = (command: string, args: string[]) => RunResult;

export const TRIVY_IMAGE = 'aquasec/trivy:0.75.0';

const TRIVY = ['run', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock', TRIVY_IMAGE, 'image', '--scanners', 'vuln', '--no-progress'];

export function publishImage(options: {
    tag: string;
    version: string;
    image: string;
    run: Run;
    log?: (message: string) => void;
}): { pushedLatest: boolean } {
    const { tag, version, image, run } = options;
    const log = options.log ?? ((message: string) => console.log(message));
    const must = (command: string, args: string[], what: string): RunResult => {
        const result = run(command, args);
        if (result.status !== 0) {
            throw new Error(`${what} failed (exit ${result.status})`);
        }
        return result;
    };

    if (tag !== `v${version}`) {
        throw new Error(`Tag ${tag} does not match package.json version ${version}`);
    }
    const versioned = `${image}:${version}`;

    // Full report for the log (informational), then the gate.
    run('docker', [...TRIVY, versioned]);
    must('docker', [...TRIVY, '--quiet', '--exit-code', '1', '--severity', 'HIGH,CRITICAL', '--ignore-unfixed', versioned], 'Vulnerability scan');

    must('docker', ['push', versioned], `Pushing ${versioned}`);

    if (!parseRelease(tag)) {
        log(`${tag} is a pre-release: latest left unchanged`);
        return { pushedLatest: false };
    }
    must('git', ['fetch', '--quiet', '--tags', '--force'], 'Fetching tags');
    const tags = must('git', ['tag', '--list', 'v*'], 'Listing tags').stdout.split('\n').map((t) => t.trim());
    const newest = newestRelease(tags);
    if (newest !== tag) {
        log(`${tag} is not the newest release (${newest ?? 'none'}): latest left unchanged`);
        return { pushedLatest: false };
    }
    must('docker', ['tag', versioned, `${image}:latest`], 'Tagging latest');
    must('docker', ['push', `${image}:latest`], 'Pushing latest');
    log(`Published ${versioned} and moved latest`);
    return { pushedLatest: true };
}

/** [major, minor, patch] of a final release tag (vX.Y.Z), or null for anything else (e.g. v2.3.0-rc.1). */
export function parseRelease(tag: string): [number, number, number] | null {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** The highest final release among the tags, compared by version number; pre-releases are ignored. */
export function newestRelease(tags: string[]): string | undefined {
    let best: { tag: string; version: [number, number, number] } | undefined;
    for (const tag of tags) {
        const version = parseRelease(tag);
        if (!version) continue;
        const diff = best ? version.map((part, i) => part - best!.version[i]).find((d) => d !== 0) ?? 0 : 1;
        if (diff > 0) best = { tag, version };
    }
    return best?.tag;
}

function main(): void {
    const image = process.env.IMAGE;
    const tag = process.env.GITHUB_REF_NAME;
    if (!image || !tag) {
        throw new Error('IMAGE and GITHUB_REF_NAME must be set');
    }
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    const run: Run = (command, args) => {
        const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
        if (result.stdout) process.stdout.write(result.stdout);
        return { status: result.status ?? 1, stdout: result.stdout ?? '' };
    };
    publishImage({ tag, version, image, run });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main();
    } catch (error) {
        console.error(`publish-image: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
