#!/usr/bin/env node
/**
 * Home Assistant MCP Server
 * Entry point for the Model Context Protocol server
 * Supports multiple transport modes: stdio, HTTP+SSE, HTTP+Stream
 */

import { loadConfig } from './config.js';
import { HaClient } from './haClient/index.js';
import { LocalAIClient } from './localAI/index.js';
import { startHttpServer } from './server/http.js';
import { startStdioServer } from './server/stdio.js';
import { initLogger, logger } from './utils/logger.js';

async function main(): Promise<void> {
  try {
    // Load and validate configuration
    const config = loadConfig();

    // When running in stdio mode, logs must go to stderr to avoid interfering with MCP protocol on stdout
    const useStderr = !config.useHttp;

    // Initialize logger with configured level, format, and output stream
    initLogger(config.logLevel, config.logFormat, useStderr);

    logger.info('Loaded Home Assistant configuration', {
      baseUrl: config.baseUrl,
      hasToken: !!config.token,
      strictSsl: config.strictSsl,
      timeout: config.timeout,
      useHttp: config.useHttp,
      httpTransport: config.useHttp ? config.httpTransport : undefined,
      aiProvider: config.aiProvider,
      aiUrl: config.aiUrl,
      aiModel: config.aiModel,
    });

    // Create Home Assistant client
    const client = new HaClient(config);

    // Test Home Assistant connection
    const apiCheck = await client.checkApi();
    logger.info('Connected to Home Assistant', { message: apiCheck.message });

    // Create Local AI client for AI analysis (unless explicitly disabled)
    let aiClient: LocalAIClient | undefined;
    if (config.aiProvider === 'none') {
      logger.info('AI features disabled (AI_PROVIDER=none)');
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

    // Start server in appropriate mode
    if (config.useHttp) {
      await startHttpServer(client, config, aiClient);
    } else {
      await startStdioServer(client, aiClient);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start Home Assistant MCP server', {
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
