/**
 * SEC-CONFIG — Security Misconfiguration (OWASP API8:2023 / A05:2021).
 *
 * H5  Fail-closed bind: MCP_AUTH_METHOD=none must not be combined with a
 *     non-loopback bind address — that exposes an unauthenticated server.
 * M1  docker-compose.yml must not hard-code a wildcard `MCP_HTTP_ALLOWED_ORIGINS=*`.
 * M3  DNS-rebinding Host validation is OPT-IN via MCP_HTTP_ALLOWED_HOSTS: OFF when
 *     unset (no silent upgrade break), enforcing exactly the listed host[:port]
 *     (plus loopback) when set. Default origins stay full scheme://host:port forms
 *     so the separate Origin/CORS layer matches real Origin headers.
 * M10 Dockerfile must run as a non-root USER.
 * L4  HTTP responses must carry baseline security headers.
 * L7  .env.example must use the real var (MCP_AUTH_SECRET, not MCP_AUTH_TOKEN)
 *     and ship secure defaults.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { buildTransportSecurityOptions } from '../../src/server/stream.js';
import { applySecurityHeaders } from '../../src/server/http.js';

const repoRoot = process.cwd();
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), 'utf8');

const SECRET = 'test-secret-key-32chars-minimum!';

describe('SEC-CONFIG H5: refuse auth=none on a non-loopback bind', () => {
  it('throws when MCP_AUTH_METHOD defaults to none and bind is 0.0.0.0', () => {
    expect(() => loadConfig({ MCP_HTTP_BIND_ADDR: '0.0.0.0' } as NodeJS.ProcessEnv)).toThrow(
      /none/i
    );
  });

  it('allows none with an explicit loopback bind', () => {
    const cfg = loadConfig({ MCP_HTTP_BIND_ADDR: '127.0.0.1' } as NodeJS.ProcessEnv);
    expect(cfg.authMethod).toBe('none');
  });

  it('allows none with the default (loopback) bind', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.authMethod).toBe('none');
    expect(cfg.httpBindAddr).toBe('127.0.0.1');
  });

  it('allows bearer on a public bind when a strong secret is set', () => {
    const cfg = loadConfig({
      MCP_HTTP_BIND_ADDR: '0.0.0.0',
      MCP_AUTH_METHOD: 'bearer',
      MCP_AUTH_SECRET: SECRET,
    } as NodeJS.ProcessEnv);
    expect(cfg.authMethod).toBe('bearer');
    expect(cfg.httpBindAddr).toBe('0.0.0.0');
  });
});

describe('SEC-CONFIG M1: compose has no wildcard origin', () => {
  it('docker-compose.yml does not set MCP_HTTP_ALLOWED_ORIGINS=*', () => {
    const compose = read('docker-compose.yml');
    expect(compose).not.toMatch(/MCP_HTTP_ALLOWED_ORIGINS\s*[:=]\s*\*/);
  });
});

describe('SEC-CONFIG M3: opt-in DNS-rebinding Host validation', () => {
  const base = {
    MCP_HTTP_BIND_ADDR: '0.0.0.0',
    MCP_AUTH_METHOD: 'bearer',
    MCP_AUTH_SECRET: SECRET,
  } as NodeJS.ProcessEnv;

  it('default config origins are full scheme://host:port forms', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.httpAllowedOrigins?.some((o) => /^https?:\/\/[^/]+:\d+$/.test(o))).toBe(true);
  });

  it('leaves Host validation OFF when MCP_HTTP_ALLOWED_HOSTS is unset (no upgrade break)', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    const opts = buildTransportSecurityOptions(cfg);
    expect(opts.enableDnsRebindingProtection).toBe(false);
    expect(opts.allowedHosts).toEqual([]);
    // Origin/CORS is enforced by the HTTP layer, not the transport.
    expect(opts.allowedOrigins).toEqual([]);
  });

  it('does NOT derive Host allowlist from CORS origins', () => {
    // Origins are client/CORS addresses; the server host is frequently different.
    // Setting origins alone must not turn on (or seed) Host validation.
    const cfg = loadConfig({
      ...base,
      MCP_HTTP_ALLOWED_ORIGINS: 'https://client.example.com:5678',
    } as NodeJS.ProcessEnv);
    const opts = buildTransportSecurityOptions(cfg);
    expect(opts.enableDnsRebindingProtection).toBe(false);
    expect(opts.allowedHosts).toEqual([]);
  });

  it('enforces exactly the configured hosts (plus loopback) when MCP_HTTP_ALLOWED_HOSTS is set', () => {
    const cfg = loadConfig({
      ...base,
      MCP_HTTP_ALLOWED_HOSTS: 'mcp.example.com,192.168.0.18:3000',
    } as NodeJS.ProcessEnv);
    const opts = buildTransportSecurityOptions(cfg);
    expect(opts.enableDnsRebindingProtection).toBe(true);
    expect(opts.allowedHosts).toContain('mcp.example.com');
    expect(opts.allowedHosts).toContain('192.168.0.18:3000');
    // Loopback/bind conveniences are always added so on-box access keeps working.
    expect(opts.allowedHosts).toContain('localhost:3000');
    expect(opts.allowedHosts).toContain('0.0.0.0:3000');
    // A host the operator did NOT list is absent → the SDK 403s it.
    expect(opts.allowedHosts).not.toContain('evil.attacker.test');
  });

  it('accepts a full-URL host entry and reduces it to host[:port] form', () => {
    const cfg = loadConfig({
      ...base,
      MCP_HTTP_ALLOWED_HOSTS: 'https://mcp.example.com',
    } as NodeJS.ProcessEnv);
    const opts = buildTransportSecurityOptions(cfg);
    expect(opts.allowedHosts).toContain('mcp.example.com');
    // Origins are still not enforced at the transport.
    expect(opts.allowedOrigins).toEqual([]);
  });
});

describe('SEC-CONFIG M10: Dockerfile runs as non-root', () => {
  it('Dockerfile declares a non-root USER', () => {
    const dockerfile = read('Dockerfile');
    const userLines = dockerfile.split('\n').filter((l) => /^\s*USER\s+/i.test(l));
    expect(userLines.length).toBeGreaterThan(0);
    // The last USER directive in effect must not be root.
    const last = userLines[userLines.length - 1].trim().replace(/^USER\s+/i, '');
    expect(last).not.toMatch(/^root\b/);
    expect(last).not.toMatch(/^0\b/);
  });
});

describe('SEC-CONFIG L4: baseline security headers', () => {
  it('applySecurityHeaders sets nosniff, frame-deny, and a referrer policy', () => {
    const set: Record<string, string> = {};
    const res = {
      setHeader(name: string, value: string) {
        set[name] = value;
      },
    } as unknown as import('node:http').ServerResponse;

    applySecurityHeaders(res);

    expect(set['X-Content-Type-Options']).toBe('nosniff');
    expect(set['X-Frame-Options']).toBe('DENY');
    expect(set['Referrer-Policy']).toBeDefined();
  });
});

describe('SEC-CONFIG L7: .env.example uses correct var + secure defaults', () => {
  const env = read('.env.example');

  it('uses MCP_AUTH_SECRET, never MCP_AUTH_TOKEN', () => {
    expect(env).toMatch(/MCP_AUTH_SECRET/);
    expect(env).not.toMatch(/MCP_AUTH_TOKEN/);
  });

  it('defaults HA_STRICT_SSL to true', () => {
    expect(env).toMatch(/^HA_STRICT_SSL=true\s*$/m);
  });

  it('defaults MCP_AUTH_METHOD to bearer', () => {
    expect(env).toMatch(/^MCP_AUTH_METHOD=bearer\s*$/m);
  });
});
