#!/usr/bin/env node
/**
 * Home Assistant MCP Server
 * Entry point for the Model Context Protocol server
 * Supports transport modes: stdio, HTTP (Streamable HTTP)
 */

import { loadConfig } from './config.js';
import { startHttpServer } from './server/http.js';
import { startStdioServer } from './server/stdio.js';
import { connectUpstreams } from './upstreams.js';
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

    // Connect the upstreams. One that doesn't answer yet doesn't stop the server:
    // it is retried in the background (see upstreams.ts).
    const { haClient, omadaClient, aiClient } = await connectUpstreams(config);

    // Start server in appropriate mode
    if (config.useHttp) {
      await startHttpServer({ haClient, omadaClient, aiClient, config });
    } else {
      await startStdioServer({
        haClient,
        omadaClient,
        aiClient,
        restActions: config.restActions,
        toolRegistrationMode: config.toolRegistrationMode,
      });
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
