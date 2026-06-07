/**
 * Unit tests for the Omada resource-graph namespace manifest.
 */

import { describe, it, expect } from 'vitest';
import {
  OMADA_RESOURCES,
  childrenOf,
  getResourceNode,
  normalizePath,
} from '../../../src/tools/omada/namespace.js';
import { Permission } from '../../../src/permissions/index.js';

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
