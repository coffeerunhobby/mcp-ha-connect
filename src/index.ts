#!/usr/bin/env node
/**
 * Home Assistant MCP Server
 * Entry point for the Model Context Protocol server
 * Supports transport modes: stdio, HTTP (Streamable HTTP)
 */

import { loadConfig } from './config.js';
import { HaClient } from './haClient/index.js';
import { LocalAIClient } from './localAI/index.js';
import { OmadaClient } from './omadaClient/index.js';
import { startHttpServer } from './server/http.js';
import { startStdioServer } from './server/stdio.js';
import { initLogger, logger } from './utils/logger.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  try {
    // Load and validate configuration
    const config = loadConfig();

    // When running in stdio mode, logs must go to stderr to avoid interfering with MCP protocol on stdout
    const useStderr = !config.useHttp;

    // Initialize logger with configured level, format, and output stream
    initLogger(config.logLevel, config.logFormat, useStderr);

    logger.info(`mcp-ha-connect v${VERSION} starting`);
    logger.info('Loaded configuration', {
      haPluginEnabled: config.haPluginEnabled,
      aiPluginEnabled: config.aiPluginEnabled,
      omadaPluginEnabled: config.omadaPluginEnabled,
      useHttp: config.useHttp,
    });

    // Create Home Assistant client (if plugin enabled and configured)
    let haClient: HaClient | undefined;
    if (config.haPluginEnabled) {
      if (config.baseUrl && config.token) {
        haClient = new HaClient({
          baseUrl: config.baseUrl,
          token: config.token,
          timeout: config.timeout,
          strictSsl: config.strictSsl,
        });

        // Test Home Assistant connection
        const apiCheck = await haClient.checkApi();
        logger.info('Connected to Home Assistant', { message: apiCheck.message });
      } else {
        logger.warn('HA plugin enabled but HA_URL or HA_TOKEN not set');
      }
    } else {
      logger.info('Home Assistant plugin disabled');
    }

    // Create Omada client (if plugin enabled and configured)
    let omadaClient: OmadaClient | undefined;
    if (config.omadaPluginEnabled) {
      if (config.omadaBaseUrl && config.omadaClientId && config.omadaClientSecret && config.omadacId) {
        omadaClient = new OmadaClient({
          baseUrl: config.omadaBaseUrl,
          clientId: config.omadaClientId,
          clientSecret: config.omadaClientSecret,
          omadacId: config.omadacId,
          siteId: config.siteId,
          strictSsl: config.omadaStrictSsl,
          requestTimeout: config.requestTimeout,
        });

        // Test Omada connection by listing sites
        const sites = await omadaClient.listSites();
        logger.info('Connected to Omada controller', { siteCount: sites.length });
      } else {
        logger.warn('Omada plugin enabled but required config not set (OMADA_BASE_URL, OMADA_CLIENT_ID, OMADA_CLIENT_SECRET, OMADA_OMADAC_ID)');
      }
    } else {
      logger.info('Omada plugin disabled');
    }

    // Create Local AI client (if plugin enabled)
    let aiClient: LocalAIClient | undefined;
    if (config.aiPluginEnabled) {
      if (config.aiProvider === 'none') {
        logger.info('AI plugin enabled but AI_PROVIDER=none');
      } else {
        aiClient = new LocalAIClient(config);
        const aiHealthy = await aiClient.checkHealth();
        if (aiHealthy) {
          logger.info('Connected to AI provider', {
            provider: aiClient.getProviderName(),
            url: config.aiUrl,
            model: config.aiModel,
          });
        } else {
          logger.warn('AI provider not available - AI analysis tool will be disabled', {
            provider: config.aiProvider,
            url: config.aiUrl,
          });
          aiClient = undefined;
        }
      }
    } else {
      logger.info('AI plugin disabled');
    }

    // Start server in appropriate mode
    if (config.useHttp) {
      await startHttpServer({ haClient, omadaClient, aiClient, config });
    } else {
      await startStdioServer({ haClient, omadaClient, aiClient });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start MCP server', {
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exitCode = 1;
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

// Start the server
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error('Unhandled error in main', { error: message });
  process.exitCode = 1;
});
