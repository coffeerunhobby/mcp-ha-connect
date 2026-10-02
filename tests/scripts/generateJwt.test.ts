/**
 * Output contract of scripts/generate-jwt.ts: stdout is exactly one bare JWT.
 *
 * Callers capture it with `TOKEN=$(npm run -s generate:jwt -- ...)`. A banner or a
 * second copy of the token on stdout (the pre-1.7.5 behavior) corrupts that capture,
 * so this test runs the real script as a subprocess and checks both streams.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { verifyJwt } from '../../src/utils/jwt.js';

const ROOT = resolve(__dirname, '../..');
const TSX_CLI = resolve(ROOT, 'node_modules/tsx/dist/cli.mjs');
const SCRIPT = resolve(ROOT, 'scripts/generate-jwt.ts');
const SECRET = 'dummy-secret-for-generate-jwt-test-0123456789';

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    cwd: ROOT,
    // Never inherit a real secret from the developer's environment.
    env: { ...process.env, MCP_AUTH_SECRET: '' },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('generate-jwt output contract', () => {
  it('prints exactly one valid JWT on stdout; details go to stderr', () => {
    const { status, stdout, stderr } = run(['--sub', 'contract-test', '--exp', '5m', '--secret', SECRET]);
    expect(status).toBe(0);

    const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(1);

    const result = verifyJwt(lines[0], SECRET);
    expect(result.valid).toBe(true);
    expect(result.payload?.sub).toBe('contract-test');

    expect(stderr).toContain('Subject: contract-test');
    expect(stderr).not.toContain(lines[0]);
  }, 30_000);
});
