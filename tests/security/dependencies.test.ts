/**
 * SEC-DEPS — Vulnerable & Outdated Components (OWASP A06:2021)
 *
 * Finding M9: production dependency tree shipped known-vulnerable transitive
 * packages (hono / qs / path-to-regexp via the MCP SDK, plus a direct `ws`).
 *
 * These tests are the durable CI gate for that finding:
 *   1. `npm audit --omit=dev` must report ZERO high/critical advisories in the
 *      PRODUCTION dependency tree (dev-only tooling is out of scope). A small,
 *      explicitly-documented allowlist exists for unavoidable transitive advisories
 *      that have no upstream fix yet — each entry must be justified in a comment.
 *   2. After bumping the SDK/ws, re-assert the per-request transport invariant so a
 *      dependency upgrade can never silently change how transports are constructed.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Advisory IDs (GHSA / npm) we knowingly accept because there is no fixed
 * upstream release reachable through our dependency tree. MUST stay empty unless
 * a transitive advisory is genuinely unfixable — add the ID with a justification.
 */
const HIGH_CRITICAL_ALLOWLIST = new Set<string | number>([
  // (intentionally empty — all known high/critical advisories are fixed)
]);

interface AuditAdvisory {
  severity: string;
  source?: number;
  url?: string;
  title?: string;
  name?: string;
}

interface AuditReport {
  vulnerabilities?: Record<
    string,
    {
      severity: string;
      via: Array<string | AuditAdvisory>;
    }
  >;
  metadata?: {
    vulnerabilities?: Record<string, number>;
  };
}

/**
 * Run `npm audit --omit=dev --json` and return the parsed report. npm audit exits
 * NON-zero when advisories are present, so we capture stdout from the thrown error
 * too. Returns null when the registry is unreachable (offline dev) so the gate
 * skips rather than producing a false failure.
 */
function runProdAudit(): AuditReport | null {
  let stdout: string;
  try {
    stdout = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      encoding: 'utf8',
      shell: process.platform === 'win32', // npm is npm.cmd on Windows
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stdout?: string; message?: string };
    if (typeof e.stdout === 'string' && e.stdout.trim().startsWith('{')) {
      stdout = e.stdout;
    } else {
      // Could not run audit (offline / registry down) — signal skip.
      return null;
    }
  }

  try {
    return JSON.parse(stdout) as AuditReport;
  } catch {
    return null;
  }
}

describe('SEC-DEPS — Vulnerable & Outdated Components (M9)', () => {
  describe('production audit gate', () => {
    it('reports zero high/critical advisories in the production tree', () => {
      const report = runProdAudit();
      if (report === null) {
        // Registry unreachable — do not fail the suite offline.
        console.warn('SEC-DEPS: npm audit unavailable (offline?), skipping gate assertion');
        return;
      }

      const offenders: string[] = [];
      for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
        const sev = vuln.severity?.toLowerCase();
        if (sev !== 'high' && sev !== 'critical') {
          continue;
        }
        // Allow only if EVERY advisory behind this package is allowlisted.
        const advisoryIds = vuln.via
          .filter((v): v is AuditAdvisory => typeof v === 'object')
          .map((v) => v.source)
          .filter((s): s is number => typeof s === 'number');
        const allAllowlisted =
          advisoryIds.length > 0 && advisoryIds.every((id) => HIGH_CRITICAL_ALLOWLIST.has(id));
        if (!allAllowlisted) {
          offenders.push(`${pkg} (${sev}; advisories: ${advisoryIds.join(', ') || 'n/a'})`);
        }
      }

      expect(offenders, `Unfixed high/critical prod advisories:\n${offenders.join('\n')}`).toEqual(
        []
      );
    });

    it('reports zero high/critical via the audit metadata summary', () => {
      const report = runProdAudit();
      if (report === null) {
        console.warn('SEC-DEPS: npm audit unavailable (offline?), skipping metadata assertion');
        return;
      }
      const counts = report.metadata?.vulnerabilities ?? {};
      const high = counts.high ?? 0;
      const critical = counts.critical ?? 0;
      // With an empty allowlist the metadata summary must also be clean.
      if (HIGH_CRITICAL_ALLOWLIST.size === 0) {
        expect(high + critical).toBe(0);
      }
    });
  });

  describe('per-request transport invariant (post-upgrade)', () => {
    it('SDK still exposes a constructable StreamableHTTPServerTransport', () => {
      expect(typeof StreamableHTTPServerTransport).toBe('function');
    });

    it('constructs an independent transport per call (stateless mode)', () => {
      const make = (): StreamableHTTPServerTransport =>
        new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless: one transport per request
          enableDnsRebindingProtection: true,
          allowedHosts: ['localhost:3000'],
          allowedOrigins: ['http://localhost:3000'],
        });

      const a = make();
      const b = make();
      expect(a).toBeInstanceOf(StreamableHTTPServerTransport);
      expect(b).toBeInstanceOf(StreamableHTTPServerTransport);
      expect(a).not.toBe(b); // distinct instances — no shared session state
    });
  });
});
