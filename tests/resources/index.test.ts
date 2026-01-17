/**
 * Unit tests for MCP resources
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaClient } from '../../src/haClient/index.js';
import { registerAllResources } from '../../src/resources/index.js';

// Create mock server that captures registered resources
function createMockServer() {
  const resources = new Map<string, { config: unknown; handler: Function }>();
  return {
    resource: vi.fn((name: string, uriOrTemplate: unknown, config: unknown, handler: Function) => {
      resources.set(name, { config, handler });
    }),
    resources,
  } as unknown as McpServer & { resources: Map<string, { config: unknown; handler: Function }> };
}

// Create mock HaClient
function createMockClient() {
  return {
    getStates: vi.fn(),
    getState: vi.fn(),
    getEntitiesByDomain: vi.fn(),
    searchEntities: vi.fn(),
  } as unknown as HaClient;
}

describe('MCP Resources', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    vi.clearAllMocks();
  });

  describe('Registration', () => {
    it('should register all 5 resources', () => {
      registerAllResources(server, client);
      expect(server.resource).toHaveBeenCalledTimes(5);
    });

    it('should register All Entities resource', () => {
      registerAllResources(server, client);
      expect(server.resources.has('All Entities')).toBe(true);
    });

    it('should register Entity State resource', () => {
      registerAllResources(server, client);
      expect(server.resources.has('Entity State')).toBe(true);
    });

    it('should register Entity Detailed resource', () => {
      registerAllResources(server, client);
      expect(server.resources.has('Entity Detailed')).toBe(true);
    });

    it('should register Domain Entities resource', () => {
      registerAllResources(server, client);
      expect(server.resources.has('Domain Entities')).toBe(true);
    });

    it('should register Search Entities resource', () => {
      registerAllResources(server, client);
      expect(server.resources.has('Search Entities')).toBe(true);
    });
  });

  describe('All Entities Resource', () => {
    it('should return entities grouped by domain', async () => {
      const mockEntities = [
        { entity_id: 'light.living_room', state: 'on', attributes: { friendly_name: 'Living Room Light' } },
        { entity_id: 'light.bedroom', state: 'off', attributes: { friendly_name: 'Bedroom Light' } },
        { entity_id: 'sensor.temperature', state: '22', attributes: { friendly_name: 'Temperature' } },
      ];
      (client.getStates as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntities);

      registerAllResources(server, client);
      const handler = server.resources.get('All Entities')!.handler;
      const result = await handler();

      expect(client.getStates).toHaveBeenCalled();
      expect(result.contents).toHaveLength(1);

      const content = JSON.parse(result.contents[0].text);
      expect(content.total).toBe(3);
      expect(content.domains).toBe(2);
      expect(content.entities.light).toHaveLength(2);
      expect(content.entities.sensor).toHaveLength(1);
    });

    it('should handle empty entity list', async () => {
      (client.getStates as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      registerAllResources(server, client);
      const handler = server.resources.get('All Entities')!.handler;
      const result = await handler();

      const content = JSON.parse(result.contents[0].text);
      expect(content.total).toBe(0);
      expect(content.domains).toBe(0);
      expect(content.entities).toEqual({});
    });
  });

  describe('Entity State Resource', () => {
    it('should return entity state', async () => {
      const mockEntity = {
        entity_id: 'light.living_room',
        state: 'on',
        attributes: { friendly_name: 'Living Room Light', brightness: 255 },
        last_changed: '2024-01-01T00:00:00Z',
      };
      (client.getState as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntity);

      registerAllResources(server, client);
      const handler = server.resources.get('Entity State')!.handler;
      const uri = new URL('hass://entities/light.living_room');
      const result = await handler(uri, { entity_id: 'light.living_room' });

      expect(client.getState).toHaveBeenCalledWith('light.living_room');
      expect(result.contents).toHaveLength(1);

      const content = JSON.parse(result.contents[0].text);
      expect(content.entity_id).toBe('light.living_room');
      expect(content.state).toBe('on');
      expect(content.friendly_name).toBe('Living Room Light');
    });

    it('should return error for non-existent entity', async () => {
      (client.getState as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      registerAllResources(server, client);
      const handler = server.resources.get('Entity State')!.handler;
      const uri = new URL('hass://entities/light.nonexistent');
      const result = await handler(uri, { entity_id: 'light.nonexistent' });

      const content = JSON.parse(result.contents[0].text);
      expect(content.error).toBe('Entity not found');
      expect(content.entity_id).toBe('light.nonexistent');
    });
  });

  describe('Entity Detailed Resource', () => {
    it('should return detailed entity info', async () => {
      const mockEntity = {
        entity_id: 'light.living_room',
        state: 'on',
        attributes: { friendly_name: 'Living Room Light', brightness: 255, supported_features: 1 },
        last_changed: '2024-01-01T00:00:00Z',
        last_updated: '2024-01-01T00:00:01Z',
        context: { id: 'abc123', parent_id: null, user_id: null },
      };
      (client.getState as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntity);

      registerAllResources(server, client);
      const handler = server.resources.get('Entity Detailed')!.handler;
      const uri = new URL('hass://entities/light.living_room/detailed');
      const result = await handler(uri, { entity_id: 'light.living_room' });

      const content = JSON.parse(result.contents[0].text);
      expect(content.entity_id).toBe('light.living_room');
      expect(content.attributes).toHaveProperty('brightness');
      expect(content.attributes).toHaveProperty('supported_features');
      expect(content.last_updated).toBeDefined();
      expect(content.context).toBeDefined();
    });

    it('should return error for non-existent entity', async () => {
      (client.getState as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      registerAllResources(server, client);
      const handler = server.resources.get('Entity Detailed')!.handler;
      const uri = new URL('hass://entities/light.nonexistent/detailed');
      const result = await handler(uri, { entity_id: 'light.nonexistent' });

      const content = JSON.parse(result.contents[0].text);
      expect(content.error).toBe('Entity not found');
    });
  });

  describe('Domain Entities Resource', () => {
    it('should return all entities for a domain', async () => {
      const mockEntities = [
        { entity_id: 'light.living_room', state: 'on', attributes: { friendly_name: 'Living Room' } },
        { entity_id: 'light.bedroom', state: 'off', attributes: { friendly_name: 'Bedroom' } },
      ];
      (client.getEntitiesByDomain as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntities);

      registerAllResources(server, client);
      const handler = server.resources.get('Domain Entities')!.handler;
      const uri = new URL('hass://entities/domain/light');
      const result = await handler(uri, { domain: 'light' });

      expect(client.getEntitiesByDomain).toHaveBeenCalledWith('light');

      const content = JSON.parse(result.contents[0].text);
      expect(content.domain).toBe('light');
      expect(content.count).toBe(2);
      expect(content.entities).toHaveLength(2);
    });

    it('should handle domain with no entities', async () => {
      (client.getEntitiesByDomain as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      registerAllResources(server, client);
      const handler = server.resources.get('Domain Entities')!.handler;
      const uri = new URL('hass://entities/domain/vacuum');
      const result = await handler(uri, { domain: 'vacuum' });

      const content = JSON.parse(result.contents[0].text);
      expect(content.domain).toBe('vacuum');
      expect(content.count).toBe(0);
      expect(content.entities).toEqual([]);
    });
  });

  describe('Search Entities Resource', () => {
    it('should search entities with query and limit', async () => {
      const mockEntities = [
        { entity_id: 'light.living_room', state: 'on', attributes: { friendly_name: 'Living Room Light' } },
        { entity_id: 'light.living_lamp', state: 'off', attributes: { friendly_name: 'Living Lamp' } },
      ];
      (client.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntities);

      registerAllResources(server, client);
      const handler = server.resources.get('Search Entities')!.handler;
      const uri = new URL('hass://search/living/10');
      const result = await handler(uri, { query: 'living', limit: '10' });

      expect(client.searchEntities).toHaveBeenCalledWith('living');

      const content = JSON.parse(result.contents[0].text);
      expect(content.query).toBe('living');
      expect(content.limit).toBe(10);
      expect(content.count).toBe(2);
    });

    it('should apply limit to search results', async () => {
      const mockEntities = Array.from({ length: 100 }, (_, i) => ({
        entity_id: `sensor.test_${i}`,
        state: 'on',
        attributes: { friendly_name: `Test ${i}` },
      }));
      (client.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue(mockEntities);

      registerAllResources(server, client);
      const handler = server.resources.get('Search Entities')!.handler;
      const uri = new URL('hass://search/test/5');
      const result = await handler(uri, { query: 'test', limit: '5' });

      const content = JSON.parse(result.contents[0].text);
      expect(content.count).toBe(5);
      expect(content.entities).toHaveLength(5);
    });

    it('should decode URL-encoded query', async () => {
      (client.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      registerAllResources(server, client);
      const handler = server.resources.get('Search Entities')!.handler;
      const uri = new URL('hass://search/living%20room/50');
      const result = await handler(uri, { query: 'living%20room', limit: '50' });

      expect(client.searchEntities).toHaveBeenCalledWith('living room');

      const content = JSON.parse(result.contents[0].text);
      expect(content.query).toBe('living room');
    });

    it('should use default limit when not specified', async () => {
      (client.searchEntities as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      registerAllResources(server, client);
      const handler = server.resources.get('Search Entities')!.handler;
      const uri = new URL('hass://search/test/50');
      // Simulate undefined limit
      const result = await handler(uri, { query: 'test', limit: undefined });

      const content = JSON.parse(result.contents[0].text);
      expect(content.limit).toBe(50);
    });
  });
});
