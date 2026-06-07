/**
 * Stdio transport for MCP server
 * Used for Claude Desktop and other stdio-based clients
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { HaClient } from '../haClient/index.js';
import type { LocalAIClient } from '../localAI/index.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { logger } from '../utils/logger.js';
import { setLocalFullTrust } from '../tools/common.js';
import type { OmadaRegistrationMode } from '../tools/omada/index.js';
import { createServer } from './common.js';

export interface StdioServerOptions {
  haClient?: HaClient;
  omadaClient?: OmadaClient;
  aiClient?: LocalAIClient;
  /** Tool registration strategy for the Omada plugin (default 'eager'). */
  toolRegistrationMode?: OmadaRegistrationMode;
}

export async function startStdioServer(options: StdioServerOptions): Promise<void> {
  logger.info('Starting stdio server');

  // L3: stdio has no per-request auth; the local process owner is trusted. Grant
  // full permissions to tool calls that arrive without an explicit mask. HTTP
  // transports never enable this — they fail closed on a missing mask.
  setLocalFullTrust(true);

  const server = createServer(options);
  const transport = new StdioServerTransport();

  logger.info('Connecting stdio server');
  await server.connect(transport);

  logger.info('Stdio server connected and ready');
}
