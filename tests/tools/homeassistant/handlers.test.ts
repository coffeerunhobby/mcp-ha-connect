/**
 * Unit tests for HomeAssistant tool handlers
 * Tests the handler logic by invoking registered handlers with mocked clients
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import registration functions
import { registerGetStatesTool } from '../../../src/tools/homeassistant/getStates.js';
import { registerGetStateTool } from '../../../src/tools/homeassistant/getState.js';
import { registerControlLightTool } from '../../../src/tools/homeassistant/controlLight.js';
import { registerControlClimateTool } from '../../../src/tools/homeassistant/controlClimate.js';
import { registerControlFanTool } from '../../../src/tools/homeassistant/controlFan.js';
import { registerControlCoverTool } from '../../../src/tools/homeassistant/controlCover.js';
import { registerControlMediaPlayerTool } from '../../../src/tools/homeassistant/controlMediaPlayer.js';
import { registerGetEntitiesByDomainTool } from '../../../src/tools/homeassistant/getEntitiesByDomain.js';
import { registerSearchEntitiesTool } from '../../../src/tools/homeassistant/searchEntities.js';
import { registerGetAllSensorsTool } from '../../../src/tools/homeassistant/getAllSensors.js';
import { registerGetDomainSummaryTool } from '../../../src/tools/homeassistant/getDomainSummary.js';
import { registerListEntitiesTool } from '../../../src/tools/homeassistant/listEntities.js';
import { registerGetHistoryTool } from '../../../src/tools/homeassistant/getHistory.js';
import { registerGetVersionTool } from '../../../src/tools/homeassistant/getVersion.js';
import { registerCallServiceTool } from '../../../src/tools/homeassistant/callService.js';
import { registerEntityActionTool } from '../../../src/tools/homeassistant/entityAction.js';
import { registerListAutomationsTool } from '../../../src/tools/homeassistant/listAutomations.js';
import { registerTriggerAutomationTool } from '../../../src/tools/homeassistant/triggerAutomation.js';
import { registerCreateAutomationTool } from '../../../src/tools/homeassistant/createAutomation.js';
import { registerDeleteAutomationTool } from '../../../src/tools/homeassistant/deleteAutomation.js';
import { registerGetAutomationTraceTool } from '../../../src/tools/homeassistant/getAutomationTrace.js';
import {
  registerEnableAutomationTool,
  registerDisableAutomationTool,
  registerToggleAutomationTool,
  registerReloadAutomationsTool
} from '../../../src/tools/homeassistant/automationControls.js';
import { registerActivateSceneTool, registerRunScriptTool } from '../../../src/tools/homeassistant/sceneAndScript.js';
import { registerSendNotificationTool, registerListNotificationTargetsTool } from '../../../src/tools/homeassistant/sendNotification.js';
import { registerListCalendarsTool, registerGetCalendarEventsTool } from '../../../src/tools/homeassistant/calendar.js';
import {
  registerRestartHomeAssistantTool,
  registerGetSystemLogTool,
  registerCheckUpdatesTool
} from '../../../src/tools/homeassistant/systemTools.js';
import { registerListPersonsTool } from '../../../src/tools/homeassistant/listPersons.js';

// Mock HaClient
function createMockClient() {
  return {
    getStates: vi.fn(),
    getState: vi.fn(),
    callService: vi.fn(),
    getEntitiesByDomain: vi.fn(),
    searchEntities: vi.fn(),
    getAllSensors: vi.fn(),
    getDomainSummary: vi.fn(),
    listEntities: vi.fn(),
    getHistory: vi.fn(),
    getVersion: vi.fn(),
    getAutomations: vi.fn(),
    getAutomation: vi.fn(),
    triggerAutomation: vi.fn(),
    createAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
    getAutomationTrace: vi.fn(),
    enableAutomation: vi.fn(),
    disableAutomation: vi.fn(),
    toggleAutomation: vi.fn(),
    reloadAutomations: vi.fn(),
    getCalendars: vi.fn(),
    getCalendarEvents: vi.fn(),
    getAllCalendarEvents: vi.fn(),
    restartServer: vi.fn(),
    getSystemLog: vi.fn(),
    getAvailableUpdates: vi.fn(),
  };
}

// Helper to parse JSON result
function parseResult(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

// Mock server that captures registered handlers
function createMockServer() {
  const handlers: Map<string, Function> = new Map();
  return {
    registerTool: vi.fn((name: string, _config: any, handler: Function) => {
      handlers.set(name, handler);
    }),
    getHandler: (name: string) => handlers.get(name),
  };
}

// Mock extra object required by wrapToolHandler
const mockExtra = {
  sessionId: 'test-session',
  authInfo: {
    extra: {
      permissions: 0xFF, // All permissions
    },
  },
};

describe('HomeAssistant Tool Handlers', () => {
  let server: ReturnType<typeof createMockServer>;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    mockClient = createMockClient();
  });

  describe('getStates', () => {
    it('should return all entity states', async () => {
      const states = [
        { entity_id: 'light.living_room', state: 'on' },
        { entity_id: 'sensor.temperature', state: '22.5' },
      ];
      mockClient.getStates.mockResolvedValue(states);
      registerGetStatesTool(server as any, mockClient as any);

      const handler = server.getHandler('getStates')!;
      const result = await handler({}, mockExtra);

      expect(mockClient.getStates).toHaveBeenCalled();
      const parsed = parseResult(result) as { count: number };
      expect(parsed.count).toBe(2);
    });
  });

  describe('getState', () => {
    it('should return state for existing entity', async () => {
      const state = { entity_id: 'light.living_room', state: 'on', attributes: { brightness: 255 } };
      mockClient.getState.mockResolvedValue(state);
      registerGetStateTool(server as any, mockClient as any);

      const handler = server.getHandler('getState')!;
      const result = await handler({ entity_id: 'light.living_room' }, mockExtra);

      expect(mockClient.getState).toHaveBeenCalledWith('light.living_room');
      expect(result.content[0].text).toContain('light.living_room');
    });

    it('should return error for non-existent entity', async () => {
      mockClient.getState.mockResolvedValue(null);
      registerGetStateTool(server as any, mockClient as any);

      const handler = server.getHandler('getState')!;
      const result = await handler({ entity_id: 'light.nonexistent' }, mockExtra);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Entity not found');
    });
  });

  describe('controlLight', () => {
    it('should turn on light with brightness', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerControlLightTool(server as any, mockClient as any);

      const handler = server.getHandler('controlLight')!;
      const result = await handler({
        entity_id: 'light.living_room',
        action: 'turn_on',
        brightness_pct: 75,
      }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'light',
        service: 'turn_on',
        target: { entity_id: 'light.living_room' },
        service_data: { brightness_pct: 75 },
      });
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('should turn off light', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerControlLightTool(server as any, mockClient as any);

      const handler = server.getHandler('controlLight')!;
      await handler({ entity_id: 'light.living_room', action: 'turn_off' }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'light',
        service: 'turn_off',
        target: { entity_id: 'light.living_room' },
        service_data: undefined,
      });
    });

    it('should set RGB color', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerControlLightTool(server as any, mockClient as any);

      const handler = server.getHandler('controlLight')!;
      await handler({
        entity_id: 'light.living_room',
        action: 'turn_on',
        rgb_color: [255, 0, 0],
      }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'light',
        service: 'turn_on',
        target: { entity_id: 'light.living_room' },
        service_data: { rgb_color: [255, 0, 0] },
      });
    });
  });

  describe('controlClimate', () => {
    it('should set HVAC mode', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerControlClimateTool(server as any, mockClient as any);

      const handler = server.getHandler('controlClimate')!;
      const result = await handler({ entity_id: 'climate.thermostat', hvac_mode: 'heat' }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'climate',
        service: 'set_hvac_mode',
        target: { entity_id: 'climate.thermostat' },
        service_data: { hvac_mode: 'heat' },
      });
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('should set temperature', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerControlClimateTool(server as any, mockClient as any);

      const handler = server.getHandler('controlClimate')!;
      await handler({ entity_id: 'climate.thermostat', temperature: 22 }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'climate',
        service: 'set_temperature',
        target: { entity_id: 'climate.thermostat' },
        service_data: { temperature: 22 },
      });
    });

    it('should set multiple climate settings', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerControlClimateTool(server as any, mockClient as any);

      const handler = server.getHandler('controlClimate')!;
      const result = await handler({
        entity_id: 'climate.thermostat',
        hvac_mode: 'heat',
        temperature: 22,
        fan_mode: 'low',
        preset_mode: 'away',
      }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledTimes(4);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.actions.length).toBe(4);
    });
  });

  describe('controlFan', () => {
    it('should turn on fan', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerControlFanTool(server as any, mockClient as any);

      const handler = server.getHandler('controlFan')!;
      const result = await handler({ entity_id: 'fan.bedroom', action: 'turn_on' }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'fan',
        service: 'turn_on',
        target: { entity_id: 'fan.bedroom' },
        service_data: undefined,
      });
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('should set fan speed', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerControlFanTool(server as any, mockClient as any);

      const handler = server.getHandler('controlFan')!;
      const result = await handler({ entity_id: 'fan.bedroom', action: 'set_speed', percentage: 50 }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'fan',
        service: 'set_percentage',
        target: { entity_id: 'fan.bedroom' },
        service_data: { percentage: 50 },
      });
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });
  });

  describe('controlCover', () => {
    it('should open cover', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerControlCoverTool(server as any, mockClient as any);

      const handler = server.getHandler('controlCover')!;
      const result = await handler({ entity_id: 'cover.garage', action: 'open_cover' }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'cover',
        service: 'open_cover',
        target: { entity_id: 'cover.garage' },
        service_data: undefined,
      });
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('should set cover position', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerControlCoverTool(server as any, mockClient as any);

      const handler = server.getHandler('controlCover')!;
      const result = await handler({ entity_id: 'cover.blinds', action: 'set_position', position: 50 }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'cover',
        service: 'set_cover_position',
        target: { entity_id: 'cover.blinds' },
        service_data: { position: 50 },
      });
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });
  });

  describe('controlMediaPlayer', () => {
    it('should play media', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerControlMediaPlayerTool(server as any, mockClient as any);

      const handler = server.getHandler('controlMediaPlayer')!;
      await handler({ entity_id: 'media_player.tv', action: 'media_play' }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'media_player',
        service: 'media_play',
        target: { entity_id: 'media_player.tv' },
        service_data: undefined,
      });
    });

    it('should set volume', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerControlMediaPlayerTool(server as any, mockClient as any);

      const handler = server.getHandler('controlMediaPlayer')!;
      await handler({ entity_id: 'media_player.tv', action: 'volume_set', volume_level: 0.5 }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'media_player',
        service: 'volume_set',
        target: { entity_id: 'media_player.tv' },
        service_data: { volume_level: 0.5 },
      });
    });
  });

  describe('query tools', () => {
    it('getEntitiesByDomain should return entities', async () => {
      mockClient.getEntitiesByDomain.mockResolvedValue([{ entity_id: 'light.test', state: 'on' }]);
      registerGetEntitiesByDomainTool(server as any, mockClient as any);

      const handler = server.getHandler('getEntitiesByDomain')!;
      const result = await handler({ domain: 'light' }, mockExtra);

      expect(mockClient.getEntitiesByDomain).toHaveBeenCalledWith('light');
      const parsed = parseResult(result) as { count: number };
      expect(parsed.count).toBe(1);
    });

    it('searchEntities should search entities', async () => {
      mockClient.searchEntities.mockResolvedValue([{ entity_id: 'light.living_room', state: 'on' }]);
      registerSearchEntitiesTool(server as any, mockClient as any);

      const handler = server.getHandler('searchEntities')!;
      const result = await handler({ query: 'living' }, mockExtra);

      expect(mockClient.searchEntities).toHaveBeenCalledWith('living');
      expect(result.content[0].text).toContain('light.living_room');
    });

    it('getAllSensors should return sensors', async () => {
      const sensors = { count: 1, sensors: [{ entity_id: 'sensor.temp', state: '22' }] };
      mockClient.getAllSensors.mockResolvedValue(sensors);
      registerGetAllSensorsTool(server as any, mockClient as any);

      const handler = server.getHandler('getAllSensors')!;
      const result = await handler({}, mockExtra);

      expect(mockClient.getAllSensors).toHaveBeenCalled();
      const parsed = parseResult(result) as { count: number };
      expect(parsed.count).toBe(1);
    });

    it('getDomainSummary should return summary', async () => {
      mockClient.getDomainSummary.mockResolvedValue({ total: 5, on: 3, off: 2 });
      registerGetDomainSummaryTool(server as any, mockClient as any);

      const handler = server.getHandler('getDomainSummary')!;
      const result = await handler({ domain: 'light' }, mockExtra);

      expect(mockClient.getDomainSummary).toHaveBeenCalledWith('light');
      const parsed = parseResult(result) as { total: number };
      expect(parsed.total).toBe(5);
    });

    it('listEntities should list entities', async () => {
      mockClient.listEntities.mockResolvedValue([{ entity_id: 'light.test', state: 'on' }]);
      registerListEntitiesTool(server as any, mockClient as any);

      const handler = server.getHandler('listEntities')!;
      const result = await handler({ domain: 'light', state: 'on' }, mockExtra);

      expect(mockClient.listEntities).toHaveBeenCalledWith({ domain: 'light', state: 'on' });
      expect(result.content[0].text).toContain('light.test');
    });

    it('getHistory should return history', async () => {
      const history = { entity_id: 'light.test', count: 1, history: [{ state: 'on', last_changed: '2026-01-17T10:00:00Z' }] };
      mockClient.getHistory.mockResolvedValue(history);
      registerGetHistoryTool(server as any, mockClient as any);

      const handler = server.getHandler('getHistory')!;
      const result = await handler({ entity_id: 'light.test', hours: 24 }, mockExtra);

      expect(mockClient.getHistory).toHaveBeenCalledWith('light.test', 24);
      const parsed = parseResult(result) as { count: number };
      expect(parsed.count).toBe(1);
    });

    it('getVersion should return version', async () => {
      mockClient.getVersion.mockResolvedValue({ version: '2026.1.0' });
      registerGetVersionTool(server as any, mockClient as any);

      const handler = server.getHandler('getVersion')!;
      const result = await handler({}, mockExtra);

      expect(mockClient.getVersion).toHaveBeenCalled();
      expect(result.content[0].text).toContain('2026.1.0');
    });
  });

  describe('service tools', () => {
    it('callService should call service', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerCallServiceTool(server as any, mockClient as any);

      const handler = server.getHandler('callService')!;
      const result = await handler({
        domain: 'light',
        service: 'turn_on',
        target: { entity_id: 'light.test' },
        service_data: { brightness: 255 },
      }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalled();
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('entityAction should perform action', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerEntityActionTool(server as any, mockClient as any);

      const handler = server.getHandler('entityAction')!;
      const result = await handler({ entity_id: 'switch.lamp', action: 'toggle' }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalled();
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });
  });

  describe('automation tools', () => {
    it('listAutomations should return automations', async () => {
      mockClient.getAutomations.mockResolvedValue([{ id: '1', alias: 'Test', state: 'on' }]);
      registerListAutomationsTool(server as any, mockClient as any);

      const handler = server.getHandler('listAutomations')!;
      const result = await handler({}, mockExtra);

      expect(mockClient.getAutomations).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Test');
    });

    it('triggerAutomation should trigger', async () => {
      mockClient.triggerAutomation.mockResolvedValue({ context: { id: '123' } });
      registerTriggerAutomationTool(server as any, mockClient as any);

      const handler = server.getHandler('triggerAutomation')!;
      const result = await handler({ entity_id: 'automation.test' }, mockExtra);

      expect(mockClient.triggerAutomation).toHaveBeenCalledWith('automation.test', undefined);
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('createAutomation should create', async () => {
      mockClient.createAutomation.mockResolvedValue({ id: 'new-id' });
      registerCreateAutomationTool(server as any, mockClient as any);

      const handler = server.getHandler('createAutomation')!;
      const result = await handler({
        alias: 'Test',
        trigger: [{ platform: 'state' }],
        action: [{ service: 'light.turn_on' }],
      }, mockExtra);

      expect(mockClient.createAutomation).toHaveBeenCalled();
      expect(result.content[0].text).toContain('new-id');
    });

    it('deleteAutomation should delete', async () => {
      mockClient.deleteAutomation.mockResolvedValue({});
      registerDeleteAutomationTool(server as any, mockClient as any);

      const handler = server.getHandler('deleteAutomation')!;
      const result = await handler({ automation_id: 'test-id' }, mockExtra);

      expect(mockClient.deleteAutomation).toHaveBeenCalledWith('test-id');
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('getAutomationTrace should get trace', async () => {
      mockClient.getAutomationTrace.mockResolvedValue([{ run_id: '123' }]);
      registerGetAutomationTraceTool(server as any, mockClient as any);

      const handler = server.getHandler('getAutomationTrace')!;
      const result = await handler({ entity_id: 'automation.test' }, mockExtra);

      expect(mockClient.getAutomationTrace).toHaveBeenCalledWith('automation.test');
      expect(result.content[0].text).toContain('trace_count');
    });
  });

  describe('automation controls', () => {
    it('enableAutomation should enable', async () => {
      mockClient.enableAutomation.mockResolvedValue({ context: { id: '123' } });
      registerEnableAutomationTool(server as any, mockClient as any);

      const handler = server.getHandler('enableAutomation')!;
      const result = await handler({ entity_id: 'automation.test' }, mockExtra);

      expect(mockClient.enableAutomation).toHaveBeenCalledWith('automation.test');
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('disableAutomation should disable', async () => {
      mockClient.disableAutomation.mockResolvedValue({ context: { id: '123' } });
      registerDisableAutomationTool(server as any, mockClient as any);

      const handler = server.getHandler('disableAutomation')!;
      const result = await handler({ entity_id: 'automation.test' }, mockExtra);

      expect(mockClient.disableAutomation).toHaveBeenCalledWith('automation.test');
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('toggleAutomation should toggle', async () => {
      mockClient.toggleAutomation.mockResolvedValue({ context: { id: '123' } });
      registerToggleAutomationTool(server as any, mockClient as any);

      const handler = server.getHandler('toggleAutomation')!;
      const result = await handler({ entity_id: 'automation.test' }, mockExtra);

      expect(mockClient.toggleAutomation).toHaveBeenCalledWith('automation.test');
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('reloadAutomations should reload', async () => {
      mockClient.reloadAutomations.mockResolvedValue({});
      registerReloadAutomationsTool(server as any, mockClient as any);

      const handler = server.getHandler('reloadAutomations')!;
      const result = await handler({}, mockExtra);

      expect(mockClient.reloadAutomations).toHaveBeenCalled();
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });
  });

  describe('scene and script tools', () => {
    it('activateScene should activate', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerActivateSceneTool(server as any, mockClient as any);

      const handler = server.getHandler('activateScene')!;
      const result = await handler({ entity_id: 'scene.movie' }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'scene',
        service: 'turn_on',
        target: { entity_id: 'scene.movie' },
      });
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('runScript should run script', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerRunScriptTool(server as any, mockClient as any);

      const handler = server.getHandler('runScript')!;
      const result = await handler({ entity_id: 'script.test' }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'script',
        service: 'turn_on',
        target: { entity_id: 'script.test' },
        service_data: undefined,
      });
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('runScript should pass variables', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerRunScriptTool(server as any, mockClient as any);

      const handler = server.getHandler('runScript')!;
      const result = await handler({ entity_id: 'script.test', variables: { brightness: 50 } }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'script',
        service: 'turn_on',
        target: { entity_id: 'script.test' },
        service_data: { brightness: 50 },
      });
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });
  });

  describe('notification tools', () => {
    it('sendNotification should send', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerSendNotificationTool(server as any, mockClient as any);

      const handler = server.getHandler('sendNotification')!;
      const result = await handler({
        message: 'Test message',
        title: 'Test Title',
        target: 'mobile_app_phone',
      }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'notify',
        service: 'mobile_app_phone',
        service_data: { message: 'Test message', title: 'Test Title' },
      });
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('sendNotification should include actions', async () => {
      mockClient.callService.mockResolvedValue({ context: { id: '123' } });
      registerSendNotificationTool(server as any, mockClient as any);

      const handler = server.getHandler('sendNotification')!;
      await handler({
        message: 'Doorbell',
        target: 'mobile_app_phone',
        actions: [{ action: 'OPEN', title: 'Open Door' }],
      }, mockExtra);

      expect(mockClient.callService).toHaveBeenCalledWith({
        domain: 'notify',
        service: 'mobile_app_phone',
        service_data: {
          message: 'Doorbell',
          data: {
            actions: [{ action: 'OPEN', title: 'Open Door' }],
          },
        },
      });
    });

    it('listNotificationTargets should list', async () => {
      mockClient.getStates.mockResolvedValue([
        { entity_id: 'device_tracker.phone', state: 'home', attributes: { source_type: 'gps', friendly_name: 'Phone' } },
      ]);
      registerListNotificationTargetsTool(server as any, mockClient as any);

      const handler = server.getHandler('listNotificationTargets')!;
      const result = await handler({}, mockExtra);

      expect(mockClient.getStates).toHaveBeenCalled();
      expect(result.content[0].text).toContain('persistent_notification');
    });
  });

  describe('calendar tools', () => {
    it('listCalendars should list', async () => {
      mockClient.getCalendars.mockResolvedValue([{ entity_id: 'calendar.test', name: 'Test' }]);
      registerListCalendarsTool(server as any, mockClient as any);

      const handler = server.getHandler('listCalendars')!;
      const result = await handler({}, mockExtra);

      expect(mockClient.getCalendars).toHaveBeenCalled();
      const parsed = parseResult(result) as { count: number };
      expect(parsed.count).toBe(1);
    });

    it('getCalendarEvents should get events from calendar', async () => {
      mockClient.getCalendarEvents.mockResolvedValue([
        { summary: 'Meeting', start: { dateTime: '2026-01-17T10:00:00Z' }, end: { dateTime: '2026-01-17T11:00:00Z' } },
      ]);
      registerGetCalendarEventsTool(server as any, mockClient as any);

      const handler = server.getHandler('getCalendarEvents')!;
      const result = await handler({ entity_id: 'calendar.work', days: 7 }, mockExtra);

      expect(mockClient.getCalendarEvents).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Meeting');
    });

    it('getCalendarEvents should get all events', async () => {
      mockClient.getAllCalendarEvents.mockResolvedValue([
        { calendar: 'calendar.work', events: [{ summary: 'Meeting', start: { dateTime: '2026-01-17T10:00:00Z' }, end: { dateTime: '2026-01-17T11:00:00Z' } }] },
      ]);
      registerGetCalendarEventsTool(server as any, mockClient as any);

      const handler = server.getHandler('getCalendarEvents')!;
      const result = await handler({}, mockExtra);

      expect(mockClient.getAllCalendarEvents).toHaveBeenCalled();
      expect(result.content[0].text).toContain('total_count');
    });
  });

  describe('system tools', () => {
    it('restartHomeAssistant should restart', async () => {
      mockClient.restartServer.mockResolvedValue({});
      registerRestartHomeAssistantTool(server as any, mockClient as any);

      const handler = server.getHandler('restartHomeAssistant')!;
      const result = await handler({}, mockExtra);

      expect(mockClient.restartServer).toHaveBeenCalled();
      const parsed = parseResult(result) as { success: boolean };
      expect(parsed.success).toBe(true);
    });

    it('getSystemLog should get log', async () => {
      mockClient.getSystemLog.mockResolvedValue([{ timestamp: '2026-01-17T10:00:00Z', level: 'ERROR', message: 'Test error' }]);
      registerGetSystemLogTool(server as any, mockClient as any);

      const handler = server.getHandler('getSystemLog')!;
      const result = await handler({ hours: 24 }, mockExtra);

      expect(mockClient.getSystemLog).toHaveBeenCalledWith({ hours: 24, entity_id: undefined, limit: 100 });
      expect(result.content[0].text).toContain('Test error');
    });

    it('checkUpdates should check updates', async () => {
      mockClient.getAvailableUpdates.mockResolvedValue({ available: [{ name: 'core', version: '2026.2.0' }] });
      registerCheckUpdatesTool(server as any, mockClient as any);

      const handler = server.getHandler('checkUpdates')!;
      const result = await handler({}, mockExtra);

      expect(mockClient.getAvailableUpdates).toHaveBeenCalled();
      expect(result.content[0].text).toContain('2026.2.0');
    });
  });

  describe('listPersons', () => {
    it('should list persons', async () => {
      mockClient.getEntitiesByDomain.mockResolvedValue([
        { entity_id: 'person.john', state: 'home', attributes: { friendly_name: 'John' } },
      ]);
      registerListPersonsTool(server as any, mockClient as any);

      const handler = server.getHandler('listPersons')!;
      const result = await handler({}, mockExtra);

      expect(mockClient.getEntitiesByDomain).toHaveBeenCalledWith('person');
      expect(result.content[0].text).toContain('John');
    });

    it('should show persons count', async () => {
      mockClient.getEntitiesByDomain.mockResolvedValue([
        { entity_id: 'person.john', state: 'home', attributes: { friendly_name: 'John' } },
        { entity_id: 'person.jane', state: 'not_home', attributes: { friendly_name: 'Jane' } },
      ]);
      registerListPersonsTool(server as any, mockClient as any);

      const handler = server.getHandler('listPersons')!;
      const result = await handler({}, mockExtra);

      const parsed = parseResult(result) as { count: number; onsite: number; away: number };
      expect(parsed.count).toBe(2);
      expect(parsed.onsite).toBe(1);
      expect(parsed.away).toBe(1);
    });
  });
});
