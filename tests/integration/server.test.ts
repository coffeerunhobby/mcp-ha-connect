/**
 * Integration tests for MCP Server
 * Tests server initialization with real clients
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HaClient } from '../../src/haClient/index.js';
import { OmadaClient } from '../../src/omadaClient/index.js';
import { createServer } from '../../src/server/common.js';
import { generateInstructions } from '../../src/server/instructions.js';

describe('Server Integration', () => {
  let haClient: HaClient | undefined;
  let omadaClient: OmadaClient | undefined;

  beforeAll(async () => {
    // Initialize HA client if configured
    if (process.env.HA_URL && process.env.HA_TOKEN) {
      haClient = new HaClient({
        baseUrl: process.env.HA_URL,
        token: process.env.HA_TOKEN,
        strictSsl: process.env.HA_STRICT_SSL !== 'false',
        timeout: parseInt(process.env.HA_TIMEOUT || '30000'),
      });
    }

    // Initialize Omada client if configured
    if (
      process.env.OMADA_BASE_URL &&
      process.env.OMADA_CLIENT_ID &&
      process.env.OMADA_CLIENT_SECRET &&
      process.env.OMADA_OMADAC_ID
    ) {
      omadaClient = new OmadaClient({
        baseUrl: process.env.OMADA_BASE_URL,
        clientId: process.env.OMADA_CLIENT_ID,
        clientSecret: process.env.OMADA_CLIENT_SECRET,
        omadacId: process.env.OMADA_OMADAC_ID,
        siteId: process.env.OMADA_SITE_ID,
        strictSsl: process.env.OMADA_STRICT_SSL !== 'false',
        timeout: parseInt(process.env.OMADA_TIMEOUT || '30000'),
      });
    }
  });

  describe('Server Creation', () => {
    it('should create server with HA client', () => {
      if (!haClient) {
        console.log('Skipping: HA not configured');
        return;
      }

      const server = createServer({ haClient });
      expect(server).toBeDefined();
      expect(server.server).toBeDefined();
    });

    it('should create server with Omada client', () => {
      if (!omadaClient) {
        console.log('Skipping: Omada not configured');
        return;
      }

      const server = createServer({ omadaClient });
      expect(server).toBeDefined();
    });

    it('should create server with all clients', () => {
      const server = createServer({
        haClient,
        omadaClient,
      });
      expect(server).toBeDefined();
    });
  });

  describe('Server Instructions', () => {
    it('should generate instructions for HA only', () => {
      const instructions = generateInstructions({
        haEnabled: true,
        omadaEnabled: false,
        aiEnabled: false,
      });

      expect(instructions).toContain('MCP-HA-Connect');
      expect(instructions).toContain('ENTITY QUERIES');
      expect(instructions).not.toContain('OMADA');
    });

    it('should generate instructions for Omada only', () => {
      const instructions = generateInstructions({
        haEnabled: false,
        omadaEnabled: true,
        aiEnabled: false,
      });

      expect(instructions).toContain('MCP-HA-Connect');
      expect(instructions).toContain('OMADA');
      expect(instructions).not.toContain('ENTITY QUERIES');
    });

    it('should generate instructions for all plugins', () => {
      const instructions = generateInstructions({
        haEnabled: true,
        omadaEnabled: true,
        aiEnabled: true,
      });

      expect(instructions).toContain('MCP-HA-Connect');
      expect(instructions).toContain('ENTITY QUERIES');
      expect(instructions).toContain('OMADA');
      expect(instructions).toContain('AI ANALYSIS');
      expect(instructions).toContain('INTEGRATION');
    });

    it('should generate concise instructions under 2KB', () => {
      const instructions = generateInstructions({
        haEnabled: true,
        omadaEnabled: true,
        aiEnabled: true,
      });

      expect(instructions.length).toBeLessThan(2000);
    });
  });

  describe('Client Connectivity', () => {
    it('should verify HA connection', async () => {
      if (!haClient) {
        console.log('Skipping: HA not configured');
        return;
      }

      const result = await haClient.checkApi();
      expect(result.message).toBe('API running.');
    });

    it('should verify Omada connection', async () => {
      if (!omadaClient) {
        console.log('Skipping: Omada not configured');
        return;
      }

      const sites = await omadaClient.listSites();
      expect(sites.length).toBeGreaterThan(0);
    });
  });
});
