/**
 * Connects to the upstreams (Home Assistant, Omada, a Ruijie router, the local AI) at startup.
 *
 * An upstream that doesn't answer at startup is not fatal: its client is kept, its
 * tools stay registered (calls fail cleanly until it answers) and a background probe
 * retries with a growing pause, logging when it answers. Before 2.4.6 an unreachable
 * Home Assistant made the server exit, and the container crash-looped (100 restarts
 * during the 2026-10-17 NAS network outage) instead of serving /health and Omada.
 *
 * What stays fatal or disabling is configuration that can never work: a missing
 * HA_URL/HA_TOKEN or Omada setting, or an OMADA_SITE_ID the controller doesn't have. A Ruijie
 * router that refuses the login is never asked again (wrong passwords lock its login): its
 * tools refuse until the setting is fixed and the server restarted.
 */

import type { EnvironmentConfig } from './config.js';
import { HaClient } from './haClient/index.js';
import { LocalAIClient } from './localAI/index.js';
import { OmadaClient } from './omadaClient/index.js';
import { checkConfiguredSite } from './omadaClient/site.js';
import { RuijieClient, RuijieError } from './ruijieClient/index.js';
import { logger } from './utils/logger.js';

export interface BackoffOptions {
  /** Pause before the first retry. */
  initialMs: number;
  /** The pause doubles after each failed try, up to this. */
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 5_000, maxMs: 60_000 };

/**
 * Runs `attempt` until it resolves, pausing initialMs, then twice that, and so on up
 * to maxMs between tries. Failures are logged at debug level only (the caller logs
 * the first one); the timer doesn't keep the process alive.
 */
export function retryInBackground(
  name: string,
  attempt: () => Promise<void>,
  backoff: BackoffOptions = DEFAULT_BACKOFF
): { stop(): void } {
  let delay = backoff.initialMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = () => {
    timer = setTimeout(() => void run(), delay);
    timer.unref?.();
  };
  const run = async () => {
    if (stopped) return;
    try {
      await attempt();
    } catch (error) {
      if (stopped) return;
      logger.debug(`${name} still not reachable; next try in ${Math.round(Math.min(delay * 2, backoff.maxMs) / 1000)}s`, {
        error: errorMessage(error),
      });
      delay = Math.min(delay * 2, backoff.maxMs);
      schedule();
    }
  };

  schedule();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export interface Upstreams {
  haClient?: HaClient;
  omadaClient?: OmadaClient;
  ruijieClient?: RuijieClient;
  aiClient?: LocalAIClient;
  /** Stops the background probes (tests; the process otherwise just exits). */
  stop(): void;
}

/** Client constructors, replaceable in tests. */
export interface UpstreamFactories {
  ha(config: EnvironmentConfig): HaClient;
  omada(config: EnvironmentConfig): OmadaClient;
  ruijie(config: EnvironmentConfig): RuijieClient;
  ai(config: EnvironmentConfig): LocalAIClient;
}

export const defaultFactories: UpstreamFactories = {
  ha: (config) =>
    new HaClient({
      baseUrl: config.baseUrl!,
      token: config.token!,
      timeout: config.timeout,
      strictSsl: config.strictSsl,
    }),
  omada: (config) =>
    new OmadaClient({
      baseUrl: config.omadaBaseUrl!,
      clientId: config.omadaClientId!,
      clientSecret: config.omadaClientSecret!,
      omadacId: config.omadacId!,
      siteId: config.siteId,
      strictSsl: config.omadaStrictSsl,
      requestTimeout: config.requestTimeout,
      serverAddresses: config.serverAddresses,
    }),
  ruijie: (config) =>
    new RuijieClient({
      baseUrl: config.ruijieBaseUrl!,
      password: config.ruijiePassword!,
      strictSsl: config.ruijieStrictSsl,
      certSha256: config.ruijieCertSha256,
      readOnly: config.ruijieReadOnly,
      firmwareUpgrade: config.ruijieFirmwareUpgrade,
      timeout: config.ruijieTimeout,
    }),
  ai: (config) => new LocalAIClient(config),
};

/** What an Omada call says once a background check found OMADA_SITE_ID missing (details in the log). */
export const OMADA_SITE_DISABLED_MESSAGE =
  'Omada tools are disabled: OMADA_SITE_ID is not a site on the controller. The server log lists the valid sites.';

export async function connectUpstreams(
  config: EnvironmentConfig,
  factories: UpstreamFactories = defaultFactories,
  backoff: BackoffOptions = DEFAULT_BACKOFF
): Promise<Upstreams> {
  const probes: Array<{ stop(): void }> = [];
  const upstreams: Upstreams = {
    stop: () => probes.forEach((p) => p.stop()),
  };

  // Home Assistant
  if (config.haPluginEnabled) {
    if (config.baseUrl && config.token) {
      const haClient = factories.ha(config);
      upstreams.haClient = haClient;
      const check = async () => {
        const apiCheck = await haClient.checkApi();
        logger.info('Connected to Home Assistant', { message: apiCheck.message });
      };
      try {
        await check();
      } catch (error) {
        logger.warn('Home Assistant not reachable; starting without it and retrying in the background', {
          error: errorMessage(error),
        });
        probes.push(retryInBackground('Home Assistant', check, backoff));
      }
    } else {
      logger.warn('HA plugin enabled but HA_URL or HA_TOKEN not set');
    }
  } else {
    logger.info('Home Assistant plugin disabled');
  }

  // Omada
  if (config.omadaPluginEnabled) {
    if (config.omadaBaseUrl && config.omadaClientId && config.omadaClientSecret && config.omadacId) {
      let omadaClient: OmadaClient | undefined;
      try {
        omadaClient = factories.omada(config);
        const client = omadaClient;
        // Omada is the source of truth: a configured OMADA_SITE_ID that isn't on the
        // controller is a deployment bug (drifted site id), not a transient outage.
        const checkSite = async (): Promise<string | null> => {
          const sites = await client.listSites();
          const siteError = checkConfiguredSite(config.siteId, sites);
          if (!siteError) logger.info('Connected to Omada controller', { siteCount: sites.length });
          return siteError;
        };
        try {
          const siteError = await checkSite();
          if (siteError) {
            // Known at startup: fail the plugin loudly (no Omada tools); HA and AI keep working.
            logger.error(`Omada plugin disabled - invalid OMADA_SITE_ID. ${siteError}`);
            omadaClient = undefined;
          }
        } catch (error) {
          logger.warn('Omada controller not reachable; Omada tools stay registered and work once it answers. Retrying in the background', {
            error: errorMessage(error),
          });
          probes.push(
            retryInBackground(
              'Omada controller',
              async () => {
                const siteError = await checkSite();
                if (siteError) {
                  // Found later: the tools are already registered, so every call now refuses.
                  logger.error(`Omada plugin disabled - invalid OMADA_SITE_ID. ${siteError}`);
                  client.disable(OMADA_SITE_DISABLED_MESSAGE);
                }
              },
              backoff
            )
          );
        }
      } catch (error) {
        // The client itself could not be built (bad URL and the like): configuration, not an outage.
        logger.warn('Omada client could not be created - Omada tools will be disabled', { error: errorMessage(error) });
        omadaClient = undefined;
      }
      upstreams.omadaClient = omadaClient;
    } else {
      logger.warn('Omada plugin enabled but required config not set (OMADA_BASE_URL, OMADA_CLIENT_ID, OMADA_CLIENT_SECRET, OMADA_OMADAC_ID)');
    }
  } else {
    logger.info('Omada plugin disabled');
  }

  // Ruijie / Reyee router
  if (config.ruijiePluginEnabled) {
    if (config.ruijieBaseUrl && config.ruijiePassword) {
      let ruijieClient: RuijieClient | undefined;
      try {
        ruijieClient = factories.ruijie(config);
        const client = ruijieClient;
        // A refused login is final (the client has switched itself off and logged why); only an
        // unreachable router is tried again.
        const check = async () => {
          try {
            const router = await client.check();
            logger.info('Connected to Ruijie router', router);
          } catch (error) {
            if (error instanceof RuijieError && (error.kind === 'refused' || error.kind === 'disabled')) return;
            throw error;
          }
        };
        try {
          await check();
        } catch (error) {
          logger.warn('Ruijie router not reachable; its net_ tools stay registered and work once it answers. Retrying in the background', {
            error: errorMessage(error),
          });
          probes.push(retryInBackground('Ruijie router', check, backoff));
        }
      } catch (error) {
        logger.warn('Ruijie client could not be created - Ruijie tools will be disabled', { error: errorMessage(error) });
        ruijieClient = undefined;
      }
      upstreams.ruijieClient = ruijieClient;
    } else {
      logger.warn('Ruijie plugin enabled but required config not set (RUIJIE_BASE_URL, RUIJIE_PASSWORD)');
    }
  } else {
    logger.info('Ruijie plugin disabled');
  }

  // Local AI
  if (config.aiPluginEnabled) {
    if (config.aiProvider === 'none') {
      logger.info('AI plugin enabled but AI_PROVIDER=none');
    } else {
      const aiClient = factories.ai(config);
      upstreams.aiClient = aiClient;
      const check = async () => {
        if (!(await aiClient.checkHealth())) throw new Error('health check failed');
        logger.info('Connected to AI provider', { provider: aiClient.getProviderName(), url: config.aiUrl, model: config.aiModel });
      };
      try {
        await check();
      } catch (error) {
        logger.warn('AI provider not reachable; the AI tool stays registered and works once it answers. Retrying in the background', {
          provider: config.aiProvider,
          url: config.aiUrl,
          error: errorMessage(error),
        });
        probes.push(retryInBackground('AI provider', check, backoff));
      }
    }
  } else {
    logger.info('AI plugin disabled');
  }

  return upstreams;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
