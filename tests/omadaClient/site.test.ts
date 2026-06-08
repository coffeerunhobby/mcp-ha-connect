import { describe, it, expect } from 'vitest';

import { checkConfiguredSite } from '../../src/omadaClient/site.js';
import type { OmadaSiteSummary } from '../../src/types/index.js';

const site = (siteId: string, name: string): OmadaSiteSummary => ({ siteId, name });

const SITES: OmadaSiteSummary[] = [site('69bbeb9fa83b077caff61fee', 'Home'), site('ab12cd34', 'Office')];

describe('checkConfiguredSite', () => {
  it('returns null when no OMADA_SITE_ID is configured (no default)', () => {
    expect(checkConfiguredSite(undefined, SITES)).toBeNull();
    expect(checkConfiguredSite('', SITES)).toBeNull();
  });

  it('returns null when the configured site exists on the controller', () => {
    expect(checkConfiguredSite('69bbeb9fa83b077caff61fee', SITES)).toBeNull();
    expect(checkConfiguredSite('ab12cd34', SITES)).toBeNull();
  });

  it('returns an actionable error when the configured site is not on the controller', () => {
    const err = checkConfiguredSite('stale-old-id', SITES);
    expect(err).not.toBeNull();
    // Names the bad value...
    expect(err).toContain('stale-old-id');
    // ...and lists the valid choices (name + id) so the operator can fix .env.
    expect(err).toContain('Home (69bbeb9fa83b077caff61fee)');
    expect(err).toContain('Office (ab12cd34)');
  });

  it('still flags a stale id when the controller returns no sites', () => {
    const err = checkConfiguredSite('stale-old-id', []);
    expect(err).not.toBeNull();
    expect(err).toContain('stale-old-id');
    expect(err).toContain('(controller returned no sites)');
  });
});
