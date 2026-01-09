/**
 * ConfigOperations tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigOperations } from '../../src/haClient/config.js';
import type { RequestHandler } from '../../src/haClient/request.js';
import type { HaVersion } from '../../src/types/index.js';

describe('ConfigOperations', () => {
  let mockRequest: RequestHandler;
  let configOps: ConfigOperations;

  const mockConfig: HaVersion = {
    version: '2026.1.0',
    config_dir: '/config',
    location_name: 'Home',
    time_zone: 'Europe/London',
    unit_system: {
      length: 'km',
      mass: 'kg',
      temperature: '°C',
      volume: 'L',
    },
    components: ['homeassistant', 'frontend', 'light', 'switch', 'sensor', 'automation'],
    state: 'RUNNING',
  };

  beforeEach(() => {
    mockRequest = {
      get: vi.fn(),
    } as unknown as RequestHandler;

    configOps = new ConfigOperations(mockRequest);
  });

  describe('getConfig', () => {
    it('should fetch configuration', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockConfig);

      const config = await configOps.getConfig();

      expect(config).toEqual(mockConfig);
      expect(mockRequest.get).toHaveBeenCalledWith('/config');
    });
  });

  describe('checkApi', () => {
    it('should return API health status', async () => {
      const mockApiResponse = { message: 'API running.' };
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockApiResponse);

      const result = await configOps.checkApi();

      expect(result).toEqual(mockApiResponse);
      expect(mockRequest.get).toHaveBeenCalledWith('/');
    });
  });

  describe('getVersion', () => {
    it('should return version information', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockConfig);

      const version = await configOps.getVersion();

      expect(version).toEqual(mockConfig);
      expect(version.version).toBe('2026.1.0');
      expect(mockRequest.get).toHaveBeenCalledWith('/config');
    });

    it('should include all config fields', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockConfig);

      const version = await configOps.getVersion();

      expect(version.config_dir).toBe('/config');
      expect(version.location_name).toBe('Home');
      expect(version.time_zone).toBe('Europe/London');
      expect(version.state).toBe('RUNNING');
      expect(version.components).toContain('homeassistant');
    });

    it('should include unit_system', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockConfig);

      const version = await configOps.getVersion();

      expect(version.unit_system).toEqual({
        length: 'km',
        mass: 'kg',
        temperature: '°C',
        volume: 'L',
      });
    });
  });
});
