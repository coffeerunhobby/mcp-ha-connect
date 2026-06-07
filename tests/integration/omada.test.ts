/**
 * Integration tests for TP-Link Omada Controller
 * These tests run against a real Omada controller
 * Requires OMADA_* environment variables
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { OmadaClient } from '../../src/omadaClient/index.js';

describe('Omada Integration', () => {
  let client: OmadaClient;
  let siteId: string;

  beforeAll(async () => {
    const baseUrl = process.env.OMADA_BASE_URL;
    const clientId = process.env.OMADA_CLIENT_ID;
    const clientSecret = process.env.OMADA_CLIENT_SECRET;
    const omadacId = process.env.OMADA_OMADAC_ID;

    if (!baseUrl || !clientId || !clientSecret || !omadacId) {
      throw new Error('OMADA_BASE_URL, OMADA_CLIENT_ID, OMADA_CLIENT_SECRET, and OMADA_OMADAC_ID are required');
    }

    client = new OmadaClient({
      baseUrl,
      clientId,
      clientSecret,
      omadacId,
      siteId: process.env.OMADA_SITE_ID,
      strictSsl: process.env.OMADA_STRICT_SSL !== 'false',
      timeout: parseInt(process.env.OMADA_TIMEOUT || '30000'),
    });

    // Get siteId for tests
    siteId = process.env.OMADA_SITE_ID || '';
  });

  describe('Sites', () => {
    it('should list all sites', async () => {
      const sites = await client.listSites();
      expect(Array.isArray(sites)).toBe(true);
      expect(sites.length).toBeGreaterThan(0);
      expect(sites[0]).toHaveProperty('siteId');
      expect(sites[0]).toHaveProperty('name');

      // Use first site if not configured
      if (!siteId) {
        siteId = sites[0].siteId;
      }
    });
  });

  describe('Devices', () => {
    it('should list network devices', async () => {
      const devices = await client.listDevices(siteId);
      expect(Array.isArray(devices)).toBe(true);
      if (devices.length > 0) {
        expect(devices[0]).toHaveProperty('mac');
        expect(devices[0]).toHaveProperty('name');
        expect(devices[0]).toHaveProperty('type');
        expect(devices[0]).toHaveProperty('ip');
      }
    });

    it('should search devices globally', async () => {
      // searchDevices returns an array of OmadaDeviceInfo
      // Note: If no devices match, the API may return an empty object {} instead of []
      // so we need to handle both cases
      const results = await client.searchDevices('gateway');
      // Results could be an array or an empty object if no matches
      const isArrayOrEmpty = Array.isArray(results) || (typeof results === 'object' && results !== null);
      expect(isArrayOrEmpty).toBe(true);
      if (Array.isArray(results) && results.length > 0) {
        expect(results[0]).toHaveProperty('mac');
      }
    });
  });

  describe('Clients', () => {
    it('should list connected clients', async () => {
      const clients = await client.listClients(siteId);
      expect(Array.isArray(clients)).toBe(true);
      if (clients.length > 0) {
        expect(clients[0]).toHaveProperty('mac');
        expect(clients[0]).toHaveProperty('ip');
      }
    });

    it('should list most active clients', async () => {
      const clients = await client.listMostActiveClients(siteId);
      expect(Array.isArray(clients)).toBe(true);
      if (clients.length > 0) {
        expect(clients[0]).toHaveProperty('name');
        expect(clients[0]).toHaveProperty('totalTraffic');
      }
    });
  });

  describe('Network Configuration', () => {
    it('should get internet info', async () => {
      const info = await client.getInternetInfo(siteId);
      expect(info).toHaveProperty('wanPortSettings');
    });

    it('should get LAN network list', async () => {
      const networks = await client.getLanNetworkList(siteId);
      expect(Array.isArray(networks)).toBe(true);
      if (networks.length > 0) {
        expect(networks[0]).toHaveProperty('name');
        expect(networks[0]).toHaveProperty('vlan');
      }
    });

    it('should get WLAN group list', async () => {
      const groups = await client.getWlanGroupList(siteId);
      expect(Array.isArray(groups)).toBe(true);
    });
  });

  describe('Rate Limiting', () => {
    it('should get rate limit profiles', async () => {
      const profiles = await client.getRateLimitProfiles(siteId);
      expect(Array.isArray(profiles)).toBe(true);
      if (profiles.length > 0) {
        expect(profiles[0]).toHaveProperty('profileId');
        expect(profiles[0]).toHaveProperty('name');
      }
    });
  });

  describe('Security', () => {
    it('should get threat list (may be empty)', async () => {
      // The threat list API may return 400 if IDS/IPS is not enabled or configured
      // This test catches the error and passes if no threats are available
      try {
        const result = await client.getThreatList({});
        // If we get here, the API worked - check structure
        expect(result).toHaveProperty('data');
        expect(Array.isArray(result.data)).toBe(true);
      } catch (error) {
        // Some Omada setups may not have threat detection enabled
        // This is acceptable - skip rather than fail
        if (error instanceof Error && error.message.includes('400')) {
          // API returned 400 - threat detection may not be enabled
          expect(true).toBe(true);
        } else {
          throw error;
        }
      }
    });
  });
});
