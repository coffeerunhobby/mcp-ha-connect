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

  // Full config response from HA (includes sensitive fields)
  const mockFullConfig = {
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
    allowlist_external_dirs: ['/media'],
    allowlist_external_urls: [],
  };

  // Sanitized version (only safe, public info)
  const expectedSanitizedVersion: HaVersion = {
    version: '2026.1.0',
    location_name: 'Home',
    time_zone: 'Europe/London',
    unit_system: {
      length: 'km',
      mass: 'kg',
      temperature: '°C',
      volume: 'L',
    },
  };

  beforeEach(() => {
    mockRequest = {
      get: vi.fn(),
    } as unknown as RequestHandler;

    configOps = new ConfigOperations(mockRequest);
  });

  describe('getConfig', () => {
    it('should fetch configuration', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockFullConfig);

      const config = await configOps.getConfig();

      expect(config).toEqual(mockFullConfig);
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
    it('should return sanitized version information', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockFullConfig);

      const version = await configOps.getVersion();

      expect(version).toEqual(expectedSanitizedVersion);
      expect(version.version).toBe('2026.1.0');
      expect(mockRequest.get).toHaveBeenCalledWith('/config');
    });

    it('should filter out sensitive config fields', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockFullConfig);

      const version = await configOps.getVersion();

      // Should include safe fields
      expect(version.location_name).toBe('Home');
      expect(version.time_zone).toBe('Europe/London');

      // Should NOT include sensitive fields
      expect((version as Record<string, unknown>).config_dir).toBeUndefined();
      expect((version as Record<string, unknown>).state).toBeUndefined();
      expect((version as Record<string, unknown>).components).toBeUndefined();
      expect((version as Record<string, unknown>).allowlist_external_dirs).toBeUndefined();
      expect((version as Record<string, unknown>).allowlist_external_urls).toBeUndefined();
    });

    it('should include unit_system', async () => {
      (mockRequest.get as ReturnType<typeof vi.fn>).mockResolvedValue(mockFullConfig);

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
