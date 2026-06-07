/**
 * Integration tests for Home Assistant
 * These tests run against a real Home Assistant instance
 * Requires HA_URL and HA_TOKEN environment variables
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { HaClient } from '../../src/haClient/index.js';

describe('Home Assistant Integration', () => {
  let client: HaClient;

  beforeAll(() => {
    const baseUrl = process.env.HA_URL;
    const token = process.env.HA_TOKEN;

    if (!baseUrl || !token) {
      throw new Error('HA_URL and HA_TOKEN environment variables are required for integration tests');
    }

    client = new HaClient({
      baseUrl,
      token,
      strictSsl: process.env.HA_STRICT_SSL !== 'false',
      timeout: parseInt(process.env.HA_TIMEOUT || '30000'),
    });
  });

  describe('API Connection', () => {
    it('should connect to Home Assistant API', async () => {
      const result = await client.checkApi();
      expect(result.message).toBe('API running.');
    });

    it('should get Home Assistant version', async () => {
      const version = await client.getVersion();
      expect(version).toHaveProperty('version');
      expect(version.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('Entity States', () => {
    it('should get all states', async () => {
      const states = await client.getStates();
      expect(Array.isArray(states)).toBe(true);
      expect(states.length).toBeGreaterThan(0);
    });

    it('should get state of a specific entity', async () => {
      // First get all states to find a valid entity_id
      const states = await client.getStates();
      expect(states.length).toBeGreaterThan(0);

      const entity = await client.getState(states[0].entity_id);
      expect(entity).not.toBeNull();
      expect(entity).toHaveProperty('entity_id');
      expect(entity).toHaveProperty('state');
      expect(entity).toHaveProperty('attributes');
    });
  });

  describe('Entity Search', () => {
    it('should search entities by query', async () => {
      const results = await client.searchEntities('sensor');
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('Domain Operations', () => {
    it('should get entities by domain', async () => {
      const entities = await client.getEntitiesByDomain('sensor');
      expect(Array.isArray(entities)).toBe(true);
      entities.forEach((entity) => {
        expect(entity.entity_id).toMatch(/^sensor\./);
      });
    });

    it('should get domain summary', async () => {
      const result = await client.getDomainSummary('sensor');
      expect(result).toHaveProperty('domain');
      expect(result).toHaveProperty('count');
      expect(result).toHaveProperty('states');
      expect(result.domain).toBe('sensor');
      expect(result.count).toBeGreaterThan(0);
    });
  });

  describe('Sensors', () => {
    it('should get all sensors', async () => {
      const sensors = await client.getAllSensors();
      expect(Array.isArray(sensors)).toBe(true);
      sensors.forEach((entity) => {
        expect(entity.entity_id).toMatch(/^(sensor|binary_sensor)\./);
      });
    });
  });

  describe('Persons', () => {
    it('should get person entities via domain lookup', async () => {
      // The HaClient doesn't have a getPersons method directly
      // Persons are accessed via getEntitiesByDomain('person')
      const persons = await client.getEntitiesByDomain('person');
      expect(Array.isArray(persons)).toBe(true);
      persons.forEach((person) => {
        expect(person.entity_id).toMatch(/^person\./);
      });
    });
  });

  describe('Automations', () => {
    it('should list automations', async () => {
      const result = await client.getAutomations();
      expect(Array.isArray(result)).toBe(true);
      if (result.length > 0) {
        // Automation type uses 'id' not 'entity_id'
        expect(result[0]).toHaveProperty('id');
        expect(result[0]).toHaveProperty('state');
        expect(result[0]).toHaveProperty('alias');
      }
    });
  });

  describe('Calendars', () => {
    it('should list calendars', async () => {
      const result = await client.getCalendars();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('System', () => {
    it('should get system log', async () => {
      const result = await client.getSystemLog({ hours: 1, limit: 10 });
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
