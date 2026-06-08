/**
 * Unit tests for the Omada resource-graph namespace manifest.
 */

import { describe, it, expect } from 'vitest';
import {
  OMADA_RESOURCES,
  childrenOf,
  getResourceNode,
  normalizePath,
  resolveLogWindowMs,
  resolveUsageWindowSec,
  type ReadArgs,
} from '../../../src/tools/omada/namespace.js';
import { Permission } from '../../../src/permissions/index.js';

/** A minimal OmadaClient stand-in that records the last readResource() call. */
function makeRecordingClient(): { client: any; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    readResource: (opts: Record<string, unknown>) => {
      calls.push(opts);
      return Promise.resolve({ ok: true });
    },
  };
  return { client, calls };
}

async function fetchOpts(path: string, args: ReadArgs = {}): Promise<Record<string, unknown>> {
  const node = getResourceNode(path);
  if (!node?.fetch) {
    throw new Error(`no fetch for ${path}`);
  }
  const { client, calls } = makeRecordingClient();
  await node.fetch(client, args);
  return calls[0];
}

describe('Omada namespace - normalizePath', () => {
  it('maps empty / root to "/"', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/')).toBe('/');
  });

  it('adds a leading slash', () => {
    expect(normalizePath('gateway')).toBe('/gateway');
    expect(normalizePath('gateway/wan')).toBe('/gateway/wan');
  });

  it('strips a trailing slash', () => {
    expect(normalizePath('/gateway/')).toBe('/gateway');
    expect(normalizePath('/clients/active/')).toBe('/clients/active');
  });

  it('trims whitespace', () => {
    expect(normalizePath('  /gateway  ')).toBe('/gateway');
  });
});

describe('Omada namespace - getResourceNode', () => {
  it('resolves a known node and normalizes input', () => {
    expect(getResourceNode('/gateway/wan')?.path).toBe('/gateway/wan');
    expect(getResourceNode('gateway/wan/')?.path).toBe('/gateway/wan');
  });

  it('returns undefined for unknown paths', () => {
    expect(getResourceNode('/does/not/exist')).toBeUndefined();
  });

  it('resolves the root container', () => {
    const root = getResourceNode('/');
    expect(root?.kind).toBe('container');
    expect(root?.fetch).toBeUndefined();
  });
});

describe('Omada namespace - childrenOf', () => {
  it('lists top-level children at root', () => {
    const paths = childrenOf('/').map((n) => n.path);
    expect(paths).toContain('/sites');
    expect(paths).toContain('/devices');
    expect(paths).toContain('/clients');
    expect(paths).toContain('/gateway');
    expect(paths).toContain('/network');
    expect(paths).toContain('/wifi');
    expect(paths).toContain('/events');
    expect(paths).toContain('/dashboard');
    expect(paths).toContain('/firmware');
  });

  it('does not include grandchildren at root', () => {
    const paths = childrenOf('/').map((n) => n.path);
    expect(paths).not.toContain('/gateway/wan');
    expect(paths).not.toContain('/clients/active');
  });

  it('lists direct children of a container', () => {
    const paths = childrenOf('/gateway').map((n) => n.path);
    expect(paths).toEqual(expect.arrayContaining(['/gateway/wan', '/gateway/health']));
  });

  it('returns no children for a leaf', () => {
    expect(childrenOf('/network/firewall')).toEqual([]);
  });
});

describe('Omada namespace - manifest invariants', () => {
  it('every node has a unique, normalized path', () => {
    const seen = new Set<string>();
    for (const node of OMADA_RESOURCES) {
      expect(node.path).toBe(normalizePath(node.path));
      expect(seen.has(node.path)).toBe(false);
      seen.add(node.path);
    }
  });

  it('containers are browse-only (no fetch); collections/leaves are readable', () => {
    for (const node of OMADA_RESOURCES) {
      if (node.kind === 'container') {
        expect(node.fetch).toBeUndefined();
      } else {
        expect(typeof node.fetch).toBe('function');
      }
    }
  });

  it('every non-root node has an existing parent in the manifest', () => {
    const byPath = new Map(OMADA_RESOURCES.map((n) => [n.path, n]));
    for (const node of OMADA_RESOURCES) {
      if (node.path === '/') {
        continue;
      }
      const idx = node.path.lastIndexOf('/');
      const parent = idx <= 0 ? '/' : node.path.slice(0, idx);
      expect(byPath.has(parent)).toBe(true);
    }
  });

  it('every readable node declares a non-zero permission bit (fail-closed)', () => {
    for (const node of OMADA_RESOURCES) {
      if (node.fetch) {
        expect(node.permission).toBeGreaterThan(0);
      }
    }
  });

  it('reads are QUERY except the ADMIN-gated security subtree', () => {
    for (const node of OMADA_RESOURCES) {
      if (!node.fetch) {
        continue;
      }
      if (node.path.startsWith('/security')) {
        expect(node.permission).toBe(Permission.ADMIN);
      } else {
        expect((node.permission & Permission.QUERY) === Permission.QUERY).toBe(true);
      }
    }
  });

  it('the /security container is also ADMIN-gated', () => {
    expect(getResourceNode('/security')?.permission).toBe(Permission.ADMIN);
  });

  it('paginated nodes declare a default page size', () => {
    for (const node of OMADA_RESOURCES) {
      if (node.paginated) {
        expect(typeof node.defaultPageSize).toBe('number');
      }
    }
  });
});

describe('Omada namespace - time-window helpers', () => {
  const NOW_MS = 1_700_000_000_000;

  describe('resolveLogWindowMs (epoch ms, default 7 days)', () => {
    it('defaults to the last 7 days when no params are given', () => {
      const { timeStart, timeEnd } = resolveLogWindowMs(undefined, NOW_MS);
      expect(timeEnd).toBe(NOW_MS);
      expect(timeStart).toBe(NOW_MS - 7 * 24 * 60 * 60 * 1000);
    });

    it('honours explicit startTime/endTime params', () => {
      const { timeStart, timeEnd } = resolveLogWindowMs({ startTime: '111', endTime: '222' }, NOW_MS);
      expect(timeStart).toBe(111);
      expect(timeEnd).toBe(222);
    });

    it('defaults only the missing bound', () => {
      const { timeStart, timeEnd } = resolveLogWindowMs({ endTime: '500' }, NOW_MS);
      expect(timeEnd).toBe(500);
      expect(timeStart).toBe(500 - 7 * 24 * 60 * 60 * 1000);
    });
  });

  describe('resolveUsageWindowSec (epoch seconds, default 24h)', () => {
    it('defaults to the last 24h in seconds when no params are given', () => {
      const { start, end } = resolveUsageWindowSec(undefined, NOW_MS);
      expect(end).toBe(Math.floor(NOW_MS / 1000));
      expect(start).toBe(Math.floor(NOW_MS / 1000) - 24 * 60 * 60);
    });

    it('honours explicit startTime/endTime params (seconds)', () => {
      const { start, end } = resolveUsageWindowSec({ startTime: '1000', endTime: '2000' }, NOW_MS);
      expect(start).toBe(1000);
      expect(end).toBe(2000);
    });
  });
});

describe('Omada namespace - fixed node wiring', () => {
  it('/events forwards a default millisecond window as filters.timeStart/timeEnd', async () => {
    const opts = await fetchOpts('/events');
    expect(opts.pathTemplate).toBe('/sites/{siteId}/logs/events');
    expect(opts.paginated).toBe(true);
    const query = opts.query as Record<string, number>;
    expect(query['filters.timeStart']).toBeTypeOf('number');
    expect(query['filters.timeEnd']).toBeTypeOf('number');
    expect(query['filters.timeEnd']).toBeGreaterThan(query['filters.timeStart']);
    // 13-digit epoch-ms, not seconds.
    expect(String(query['filters.timeEnd']).length).toBeGreaterThanOrEqual(13);
  });

  it('/events passes an optional module filter through', async () => {
    const opts = await fetchOpts('/events', { params: { module: 'Device' } });
    expect((opts.query as Record<string, unknown>)['filters.module']).toBe('Device');
  });

  it('/events/alerts forwards filters.resolved only for valid boolean strings', async () => {
    const resolved = await fetchOpts('/events/alerts', { params: { resolved: 'true' } });
    expect((resolved.query as Record<string, unknown>)['filters.resolved']).toBe('true');
    const ignored = await fetchOpts('/events/alerts', { params: { resolved: 'maybe' } });
    expect((ignored.query as Record<string, unknown>)['filters.resolved']).toBeUndefined();
  });

  it('/dashboard/cpu and /dashboard/memory forward a second-precision window', async () => {
    for (const path of ['/dashboard/cpu', '/dashboard/memory']) {
      const opts = await fetchOpts(path);
      const query = opts.query as Record<string, number>;
      expect(query.start).toBeTypeOf('number');
      expect(query.end).toBeTypeOf('number');
      expect(query.end).toBeGreaterThan(query.start);
      // 10-digit epoch-seconds, not ms.
      expect(String(query.end).length).toBeLessThanOrEqual(11);
    }
  });

  it('/devices/pending, /wifi/rogue, /wifi/wids are paginated single-page reads', async () => {
    for (const path of ['/devices/pending', '/wifi/rogue', '/wifi/wids']) {
      const opts = await fetchOpts(path, { page: 2, pageSize: 25 });
      expect(opts.paginated).toBe(true);
      expect(opts.page).toBe(2);
      expect(opts.pageSize).toBe(25);
    }
  });
});
