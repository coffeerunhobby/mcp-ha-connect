import { describe, it, expect } from 'vitest';
import { generateInstructions } from '../../src/server/instructions.js';

describe('Server Instructions', () => {
  describe('generateInstructions', () => {
    it('should generate base instructions when no plugins enabled', () => {
      const instructions = generateInstructions({
        haEnabled: false,
        omadaEnabled: false,
        aiEnabled: false,
      });

      expect(instructions).toContain('MCP-HA-Connect');
      expect(instructions).not.toContain('ENTITY QUERIES');
      expect(instructions).not.toContain('OMADA');
      expect(instructions).not.toContain('AI ANALYSIS');
    });

    it('should include HA instructions when haEnabled is true', () => {
      const instructions = generateInstructions({
        haEnabled: true,
        omadaEnabled: false,
        aiEnabled: false,
      });

      expect(instructions).toContain('ENTITY QUERIES');
      expect(instructions).toContain('paginated');
      expect(instructions).toContain('includeAttributes');
      expect(instructions).toContain('listPersons');
      expect(instructions).toContain('CONTROL');
      expect(instructions).toContain('controlLight');
      expect(instructions).toContain('AUTOMATIONS');
      expect(instructions).toContain('NOTIFICATIONS');
      expect(instructions).toContain('listNotificationTargets');
    });

    it('should include Omada instructions when omadaEnabled is true', () => {
      const instructions = generateInstructions({
        haEnabled: false,
        omadaEnabled: true,
        aiEnabled: false,
      });

      expect(instructions).toContain('OMADA');
      expect(instructions).toContain('siteId');
      expect(instructions).toContain('omada_listSites');
      expect(instructions).toContain('CLIENTS vs DEVICES');
      expect(instructions).toContain('omada_listClients');
      expect(instructions).toContain('omada_listDevices');
      expect(instructions).toContain('RATE LIMITS');
      expect(instructions).toContain('SAFETY');
    });

    it('should include AI instructions when aiEnabled is true', () => {
      const instructions = generateInstructions({
        haEnabled: false,
        omadaEnabled: false,
        aiEnabled: true,
      });

      expect(instructions).toContain('AI ANALYSIS');
      expect(instructions).toContain('analyzeSensors');
      expect(instructions).toContain('Ollama');
    });

    it('should include cross-plugin instructions when both HA and Omada enabled', () => {
      const instructions = generateInstructions({
        haEnabled: true,
        omadaEnabled: true,
        aiEnabled: false,
      });

      expect(instructions).toContain('INTEGRATION');
      expect(instructions).toContain('device_trackers');
      expect(instructions).toContain('presence detection');
    });

    it('should not include cross-plugin instructions when only one plugin enabled', () => {
      const haOnly = generateInstructions({
        haEnabled: true,
        omadaEnabled: false,
        aiEnabled: false,
      });

      const omadaOnly = generateInstructions({
        haEnabled: false,
        omadaEnabled: true,
        aiEnabled: false,
      });

      expect(haOnly).not.toContain('INTEGRATION');
      expect(omadaOnly).not.toContain('INTEGRATION');
    });

    it('should include all sections when all plugins enabled', () => {
      const instructions = generateInstructions({
        haEnabled: true,
        omadaEnabled: true,
        aiEnabled: true,
      });

      // Base
      expect(instructions).toContain('MCP-HA-Connect');

      // HA
      expect(instructions).toContain('ENTITY QUERIES');
      expect(instructions).toContain('STATE');
      expect(instructions).toContain('CONTROL');
      expect(instructions).toContain('AUTOMATIONS');
      expect(instructions).toContain('NOTIFICATIONS');

      // Omada
      expect(instructions).toContain('OMADA');
      expect(instructions).toContain('CLIENTS vs DEVICES');
      expect(instructions).toContain('RATE LIMITS');
      expect(instructions).toContain('SAFETY');

      // AI
      expect(instructions).toContain('AI ANALYSIS');

      // Cross-plugin
      expect(instructions).toContain('INTEGRATION');
    });

    it('should return a single string with space-separated sections', () => {
      const instructions = generateInstructions({
        haEnabled: true,
        omadaEnabled: true,
        aiEnabled: true,
      });

      // Should be a single string, not contain newlines
      expect(typeof instructions).toBe('string');
      expect(instructions).not.toContain('\n');
    });

    it('should produce reasonably sized instructions', () => {
      const instructions = generateInstructions({
        haEnabled: true,
        omadaEnabled: true,
        aiEnabled: true,
      });

      // Instructions should be concise - under 2KB is a good target
      expect(instructions.length).toBeLessThan(2000);
      // But substantial enough to be useful - at least 500 chars with all plugins
      expect(instructions.length).toBeGreaterThan(500);
    });
  });
});
