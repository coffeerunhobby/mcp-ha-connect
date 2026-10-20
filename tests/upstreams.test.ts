/**
 * Startup must survive upstreams that don't answer (2026-10-17: an unreachable Home
 * Assistant made the server exit, and the container crash-looped 100 times). Uses the
 * production backoff with a simulated clock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { EnvironmentConfig } from '../src/config.js';
import type { HaClient } from '../src/haClient/index.js';
import type { LocalAIClient } from '../src/localAI/index.js';
import type { OmadaClient } from '../src/omadaClient/index.js';
import { connectUpstreams, DEFAULT_BACKOFF, OMADA_SITE_DISABLED_MESSAGE, retryInBackground, type UpstreamFactories, type Upstreams } from '../src/upstreams.js';
import { logger } from '../src/utils/logger.js';

vi.mock('../src/utils/logger.js');

const SITES = [{ siteId: 'site-home', name: 'Home' }];

const config = (overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig =>
  ({
    haPluginEnabled: true,
    baseUrl: 'http://ha.test:8123',
    token: 'tok',
    omadaPluginEnabled: true,
    omadaBaseUrl: 'https://omada.test:8043',
    omadaClientId: 'id',
    omadaClientSecret: 'secret',
    omadacId: 'omadac',
    siteId: 'site-home',
    aiPluginEnabled: true,
    aiProvider: 'ollama',
    aiUrl: 'http://ollama.test:11434',
    aiModel: 'm',
    ...overrides,
  }) as EnvironmentConfig;

const down = () => Promise.reject(new TypeError('fetch failed'));

function fakes() {
  const ha = { checkApi: vi.fn(down) };
  const omada = { listSites: vi.fn(down), disable: vi.fn() };
  const ai = { checkHealth: vi.fn(async () => false), getProviderName: () => 'ollama' };
  const factories: UpstreamFactories = {
    ha: () => ha as unknown as HaClient,
    omada: () => omada as unknown as OmadaClient,
    ai: () => ai as unknown as LocalAIClient,
  };
  return { ha, omada, ai, factories };
}

const logged = (level: 'info' | 'warn' | 'error', text: string) =>
  vi.mocked(logger[level]).mock.calls.some(([msg]) => String(msg).includes(text));

describe('connectUpstreams', () => {
  let upstreams: Upstreams | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    upstreams?.stop();
    upstreams = undefined;
    vi.useRealTimers();
  });

  it('starts with every upstream down instead of throwing, keeping all three clients', async () => {
    const { factories } = fakes();
    upstreams = await connectUpstreams(config(), factories);

    expect(upstreams.haClient).toBeDefined();
    expect(upstreams.omadaClient).toBeDefined();
    expect(upstreams.aiClient).toBeDefined();
    expect(logged('warn', 'Home Assistant not reachable')).toBe(true);
    expect(logged('warn', 'Omada controller not reachable')).toBe(true);
    expect(logged('warn', 'AI provider not reachable')).toBe(true);
  });

  it('retries Home Assistant with a doubling pause capped at the maximum, and stops once it answers', async () => {
    const { ha, factories } = fakes();
    upstreams = await connectUpstreams(config({ omadaPluginEnabled: false, aiPluginEnabled: false }), factories);
    expect(ha.checkApi).toHaveBeenCalledTimes(1);

    // 5 s, 10 s, 20 s, 40 s, then 60 s (the cap) each time.
    const pauses = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
    for (const [i, pause] of pauses.entries()) {
      await vi.advanceTimersByTimeAsync(pause - 1);
      expect(ha.checkApi).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(ha.checkApi).toHaveBeenCalledTimes(i + 2);
    }

    ha.checkApi.mockResolvedValueOnce({ message: 'API running.' });
    await vi.advanceTimersByTimeAsync(DEFAULT_BACKOFF.maxMs);
    expect(logged('info', 'Connected to Home Assistant')).toBe(true);
    const calls = ha.checkApi.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * DEFAULT_BACKOFF.maxMs);
    expect(ha.checkApi).toHaveBeenCalledTimes(calls);
  });

  it('does not probe in the background when everything answers at startup', async () => {
    const { ha, omada, ai, factories } = fakes();
    ha.checkApi.mockResolvedValue({ message: 'API running.' });
    omada.listSites.mockResolvedValue(SITES);
    ai.checkHealth.mockResolvedValue(true);
    upstreams = await connectUpstreams(config(), factories);

    await vi.advanceTimersByTimeAsync(10 * DEFAULT_BACKOFF.maxMs);
    expect(ha.checkApi).toHaveBeenCalledTimes(1);
    expect(omada.listSites).toHaveBeenCalledTimes(1);
    expect(ai.checkHealth).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('drops the Omada plugin when OMADA_SITE_ID is invalid at startup, and does not retry', async () => {
    const { omada, factories } = fakes();
    omada.listSites.mockResolvedValue(SITES);
    upstreams = await connectUpstreams(config({ siteId: 'site-gone', haPluginEnabled: false, aiPluginEnabled: false }), factories);

    expect(upstreams.omadaClient).toBeUndefined();
    expect(logged('error', 'invalid OMADA_SITE_ID')).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * DEFAULT_BACKOFF.maxMs);
    expect(omada.listSites).toHaveBeenCalledTimes(1);
  });

  it('disables the kept Omada client when the controller comes back without OMADA_SITE_ID', async () => {
    const { omada, factories } = fakes();
    upstreams = await connectUpstreams(config({ siteId: 'site-gone', haPluginEnabled: false, aiPluginEnabled: false }), factories);
    expect(upstreams.omadaClient).toBeDefined();

    omada.listSites.mockResolvedValue(SITES);
    await vi.advanceTimersByTimeAsync(DEFAULT_BACKOFF.initialMs);

    expect(omada.disable).toHaveBeenCalledWith(OMADA_SITE_DISABLED_MESSAGE);
    expect(logged('error', 'site-gone')).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * DEFAULT_BACKOFF.maxMs);
    expect(omada.listSites).toHaveBeenCalledTimes(2);
  });

  it('logs the Omada connection when the controller comes back with a valid site', async () => {
    const { omada, factories } = fakes();
    upstreams = await connectUpstreams(config({ haPluginEnabled: false, aiPluginEnabled: false }), factories);

    omada.listSites.mockResolvedValue(SITES);
    await vi.advanceTimersByTimeAsync(DEFAULT_BACKOFF.initialMs);

    expect(omada.disable).not.toHaveBeenCalled();
    expect(logged('info', 'Connected to Omada controller')).toBe(true);
  });

  it('disables Omada when its client cannot even be built', async () => {
    const { factories } = fakes();
    factories.omada = () => {
      throw new Error('Invalid URL');
    };
    upstreams = await connectUpstreams(config({ haPluginEnabled: false, aiPluginEnabled: false }), factories);
    expect(upstreams.omadaClient).toBeUndefined();
  });

  it('keeps the AI client and logs when the provider becomes healthy', async () => {
    const { ai, factories } = fakes();
    upstreams = await connectUpstreams(config({ haPluginEnabled: false, omadaPluginEnabled: false }), factories);
    expect(upstreams.aiClient).toBeDefined();

    ai.checkHealth.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(DEFAULT_BACKOFF.initialMs);
    expect(logged('info', 'Connected to AI provider')).toBe(true);
  });

  it('builds no client for a plugin that is off or missing its settings', async () => {
    const { factories } = fakes();
    upstreams = await connectUpstreams(
      config({ token: undefined, omadacId: undefined, aiProvider: 'none' as EnvironmentConfig['aiProvider'] }),
      factories
    );
    expect(upstreams.haClient).toBeUndefined();
    expect(upstreams.omadaClient).toBeUndefined();
    expect(upstreams.aiClient).toBeUndefined();

    upstreams = await connectUpstreams(config({ haPluginEnabled: false, omadaPluginEnabled: false, aiPluginEnabled: false }), factories);
    expect(upstreams.haClient).toBeUndefined();
    expect(upstreams.omadaClient).toBeUndefined();
    expect(upstreams.aiClient).toBeUndefined();
  });

  it('stop() ends every background probe', async () => {
    const { ha, omada, ai, factories } = fakes();
    upstreams = await connectUpstreams(config(), factories);
    upstreams.stop();

    await vi.advanceTimersByTimeAsync(10 * DEFAULT_BACKOFF.maxMs);
    expect(ha.checkApi).toHaveBeenCalledTimes(1);
    expect(omada.listSites).toHaveBeenCalledTimes(1);
    expect(ai.checkHealth).toHaveBeenCalledTimes(1);
  });
});

describe('retryInBackground', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not run a try that is already scheduled once stopped mid-attempt', async () => {
    let release: () => void = () => {};
    const attempt = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          release = () => reject(new Error('down'));
        })
    );
    const probe = retryInBackground('test', attempt, { initialMs: 1_000, maxMs: 4_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    probe.stop();
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
