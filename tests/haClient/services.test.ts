/**
 * ServiceOperations tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceOperations } from '../../src/haClient/services.js';
import type { RequestHandler } from '../../src/haClient/request.js';

describe('ServiceOperations', () => {
  let mockRequest: RequestHandler;
  let serviceOps: ServiceOperations;

  beforeEach(() => {
    mockRequest = {
      post: vi.fn(),
    } as unknown as RequestHandler;

    serviceOps = new ServiceOperations(mockRequest);
  });

  describe('callService', () => {
    it('should call service with domain and service name', async () => {
      const mockResponse = {
        context: { id: 'ctx-123', parent_id: null, user_id: 'user-456' },
      };
      (mockRequest.post as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await serviceOps.callService({
        domain: 'light',
        service: 'turn_on',
      });

      expect(result).toEqual(mockResponse);
      expect(mockRequest.post).toHaveBeenCalledWith('/services/light/turn_on', {});
    });

    it('should include target entity_id', async () => {
      const mockResponse = {
        context: { id: 'ctx-123', parent_id: null, user_id: null },
      };
      (mockRequest.post as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await serviceOps.callService({
        domain: 'light',
        service: 'turn_on',
        target: { entity_id: 'light.living_room' },
      });

      expect(mockRequest.post).toHaveBeenCalledWith('/services/light/turn_on', {
        entity_id: 'light.living_room',
      });
    });

    it('should include service_data', async () => {
      const mockResponse = {
        context: { id: 'ctx-123', parent_id: null, user_id: null },
      };
      (mockRequest.post as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await serviceOps.callService({
        domain: 'light',
        service: 'turn_on',
        target: { entity_id: 'light.living_room' },
        service_data: { brightness: 255, color_temp: 370 },
      });

      expect(mockRequest.post).toHaveBeenCalledWith('/services/light/turn_on', {
        entity_id: 'light.living_room',
        brightness: 255,
        color_temp: 370,
      });
    });

    it('should handle multiple entity targets', async () => {
      const mockResponse = {
        context: { id: 'ctx-123', parent_id: null, user_id: null },
      };
      (mockRequest.post as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await serviceOps.callService({
        domain: 'light',
        service: 'turn_off',
        target: { entity_id: ['light.living_room', 'light.bedroom'] },
      });

      expect(mockRequest.post).toHaveBeenCalledWith('/services/light/turn_off', {
        entity_id: ['light.living_room', 'light.bedroom'],
      });
    });

    it('should call climate service with temperature', async () => {
      const mockResponse = {
        context: { id: 'ctx-123', parent_id: null, user_id: null },
      };
      (mockRequest.post as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await serviceOps.callService({
        domain: 'climate',
        service: 'set_temperature',
        target: { entity_id: 'climate.living_room' },
        service_data: { temperature: 22 },
      });

      expect(mockRequest.post).toHaveBeenCalledWith('/services/climate/set_temperature', {
        entity_id: 'climate.living_room',
        temperature: 22,
      });
    });
  });

  describe('restartServer', () => {
    it('should call homeassistant restart service', async () => {
      (mockRequest.post as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await serviceOps.restartServer();

      expect(mockRequest.post).toHaveBeenCalledWith('/services/homeassistant/restart', {});
    });
  });
});
