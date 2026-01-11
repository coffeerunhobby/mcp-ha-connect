/**
 * BDD tests for Device Control
 * Uses vitest-cucumber for Gherkin syntax
 */

import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { expect, vi } from 'vitest';
import { DeviceOperations } from '../../src/haClient/devices.js';
import type { ServiceOperations } from '../../src/haClient/services.js';
import type { StateOperations } from '../../src/haClient/states.js';

const feature = await loadFeature('tests/features/device-control.feature');

describeFeature(feature, ({ Scenario }) => {
  // Shared test state
  let mockServiceOps: ServiceOperations;
  let mockStateOps: StateOperations;
  let deviceOps: DeviceOperations;
  let entityId: string;
  let lastServiceCall: { domain: string; service: string; data: Record<string, unknown> } | null;

  function setupMocks() {
    lastServiceCall = null;
    mockServiceOps = {
      callService: vi.fn().mockImplementation(async (data) => {
        lastServiceCall = {
          domain: data.domain,
          service: data.service,
          data: { ...data.service_data, entity_id: data.target?.entity_id },
        };
        return { context: { id: 'test-ctx' } };
      }),
    } as unknown as ServiceOperations;

    mockStateOps = {
      getState: vi.fn().mockResolvedValue({
        entity_id: entityId,
        state: 'off',
        attributes: {},
      }),
    } as unknown as StateOperations;

    deviceOps = new DeviceOperations(mockServiceOps, mockStateOps);
  }

  // ===== Light Control =====

  Scenario('Turn on a light', ({ Given, When, Then, And }) => {
    Given('a light entity "light.living_room" that is "off"', () => {
      entityId = 'light.living_room';
      setupMocks();
    });

    When('I turn on the light', async () => {
      await deviceOps.turnOnLight(entityId);
    });

    Then('the light service "turn_on" should be called', () => {
      expect(lastServiceCall?.domain).toBe('light');
      expect(lastServiceCall?.service).toBe('turn_on');
    });

    And('the target should be "light.living_room"', () => {
      expect(lastServiceCall?.data.entity_id).toBe('light.living_room');
    });
  });

  Scenario('Turn on a light with brightness', ({ Given, When, Then, And }) => {
    Given('a light entity "light.bedroom"', () => {
      entityId = 'light.bedroom';
      setupMocks();
    });

    When('I turn on the light with brightness 75%', async () => {
      await deviceOps.setLightBrightness(entityId, 75);
    });

    Then('the light service "turn_on" should be called', () => {
      expect(lastServiceCall?.service).toBe('turn_on');
    });

    And('the service data should include brightness_pct 75', () => {
      expect(lastServiceCall?.data.brightness_pct).toBe(75);
    });
  });

  Scenario('Set light color temperature', ({ Given, When, Then, And }) => {
    Given('a light entity "light.kitchen"', () => {
      entityId = 'light.kitchen';
      setupMocks();
    });

    When('I set the color temperature to 4000K', async () => {
      await deviceOps.setLightColorTemp(entityId, 4000);
    });

    Then('the light service "turn_on" should be called', () => {
      expect(lastServiceCall?.service).toBe('turn_on');
    });

    And('the service data should include color_temp_kelvin 4000', () => {
      expect(lastServiceCall?.data.color_temp_kelvin).toBe(4000);
    });
  });

  Scenario('Set light RGB color', ({ Given, When, Then, And }) => {
    Given('a light entity "light.office"', () => {
      entityId = 'light.office';
      setupMocks();
    });

    When('I set the RGB color to red (255, 0, 0)', async () => {
      await deviceOps.setLightColor(entityId, [255, 0, 0]);
    });

    Then('the light service "turn_on" should be called', () => {
      expect(lastServiceCall?.service).toBe('turn_on');
    });

    And('the service data should include rgb_color [255, 0, 0]', () => {
      expect(lastServiceCall?.data.rgb_color).toEqual([255, 0, 0]);
    });
  });

  // ===== Climate Control =====

  Scenario('Set thermostat temperature', ({ Given, When, Then, And }) => {
    Given('a climate entity "climate.living_room"', () => {
      entityId = 'climate.living_room';
      setupMocks();
    });

    When('I set the temperature to 22 degrees', async () => {
      await deviceOps.setClimateTemperature(entityId, 22);
    });

    Then('the climate service "set_temperature" should be called', () => {
      expect(lastServiceCall?.domain).toBe('climate');
      expect(lastServiceCall?.service).toBe('set_temperature');
    });

    And('the service data should include temperature 22', () => {
      expect(lastServiceCall?.data.temperature).toBe(22);
    });
  });

  Scenario('Set HVAC mode to heat', ({ Given, When, Then, And }) => {
    Given('a climate entity "climate.bedroom"', () => {
      entityId = 'climate.bedroom';
      setupMocks();
    });

    When('I set the HVAC mode to "heat"', async () => {
      await deviceOps.setClimateMode(entityId, 'heat');
    });

    Then('the climate service "set_hvac_mode" should be called', () => {
      expect(lastServiceCall?.service).toBe('set_hvac_mode');
    });

    And('the service data should include hvac_mode "heat"', () => {
      expect(lastServiceCall?.data.hvac_mode).toBe('heat');
    });
  });

  Scenario('Set climate preset mode', ({ Given, When, Then, And }) => {
    Given('a climate entity "climate.office"', () => {
      entityId = 'climate.office';
      setupMocks();
    });

    When('I set the preset mode to "eco"', async () => {
      await deviceOps.setClimatePreset(entityId, 'eco');
    });

    Then('the climate service "set_preset_mode" should be called', () => {
      expect(lastServiceCall?.service).toBe('set_preset_mode');
    });

    And('the service data should include preset_mode "eco"', () => {
      expect(lastServiceCall?.data.preset_mode).toBe('eco');
    });
  });

  // ===== Media Player Control =====

  Scenario('Play media player', ({ Given, When, Then }) => {
    Given('a media player entity "media_player.living_room"', () => {
      entityId = 'media_player.living_room';
      setupMocks();
    });

    When('I play the media player', async () => {
      await deviceOps.mediaPlay(entityId);
    });

    Then('the media_player service "media_play" should be called', () => {
      expect(lastServiceCall?.domain).toBe('media_player');
      expect(lastServiceCall?.service).toBe('media_play');
    });
  });

  Scenario('Pause media player', ({ Given, When, Then }) => {
    Given('a media player entity "media_player.bedroom"', () => {
      entityId = 'media_player.bedroom';
      setupMocks();
    });

    When('I pause the media player', async () => {
      await deviceOps.mediaPause(entityId);
    });

    Then('the media_player service "media_pause" should be called', () => {
      expect(lastServiceCall?.service).toBe('media_pause');
    });
  });

  Scenario('Set media player volume', ({ Given, When, Then, And }) => {
    Given('a media player entity "media_player.kitchen"', () => {
      entityId = 'media_player.kitchen';
      setupMocks();
    });

    When('I set the volume to 50%', async () => {
      await deviceOps.setMediaVolume(entityId, 0.5);
    });

    Then('the media_player service "volume_set" should be called', () => {
      expect(lastServiceCall?.service).toBe('volume_set');
    });

    And('the service data should include volume_level 0.5', () => {
      expect(lastServiceCall?.data.volume_level).toBe(0.5);
    });
  });

  // ===== Cover Control =====

  Scenario('Open a cover', ({ Given, When, Then }) => {
    Given('a cover entity "cover.garage_door"', () => {
      entityId = 'cover.garage_door';
      setupMocks();
    });

    When('I open the cover', async () => {
      await deviceOps.openCover(entityId);
    });

    Then('the cover service "open_cover" should be called', () => {
      expect(lastServiceCall?.domain).toBe('cover');
      expect(lastServiceCall?.service).toBe('open_cover');
    });
  });

  Scenario('Close a cover', ({ Given, When, Then }) => {
    Given('a cover entity "cover.blinds"', () => {
      entityId = 'cover.blinds';
      setupMocks();
    });

    When('I close the cover', async () => {
      await deviceOps.closeCover(entityId);
    });

    Then('the cover service "close_cover" should be called', () => {
      expect(lastServiceCall?.service).toBe('close_cover');
    });
  });

  Scenario('Set cover position', ({ Given, When, Then, And }) => {
    Given('a cover entity "cover.living_room_blinds"', () => {
      entityId = 'cover.living_room_blinds';
      setupMocks();
    });

    When('I set the cover position to 50%', async () => {
      await deviceOps.setCoverPosition(entityId, 50);
    });

    Then('the cover service "set_cover_position" should be called', () => {
      expect(lastServiceCall?.service).toBe('set_cover_position');
    });

    And('the service data should include position 50', () => {
      expect(lastServiceCall?.data.position).toBe(50);
    });
  });

  // ===== Fan Control =====

  Scenario('Turn on a fan', ({ Given, When, Then }) => {
    Given('a fan entity "fan.bedroom"', () => {
      entityId = 'fan.bedroom';
      setupMocks();
    });

    When('I turn on the fan', async () => {
      await deviceOps.turnOnFan(entityId);
    });

    Then('the fan service "turn_on" should be called', () => {
      expect(lastServiceCall?.domain).toBe('fan');
      expect(lastServiceCall?.service).toBe('turn_on');
    });
  });

  Scenario('Set fan speed', ({ Given, When, Then, And }) => {
    Given('a fan entity "fan.living_room"', () => {
      entityId = 'fan.living_room';
      setupMocks();
    });

    When('I set the fan speed to 75%', async () => {
      await deviceOps.setFanSpeed(entityId, 75);
    });

    Then('the fan service "set_percentage" should be called', () => {
      expect(lastServiceCall?.service).toBe('set_percentage');
    });

    And('the service data should include percentage 75', () => {
      expect(lastServiceCall?.data.percentage).toBe(75);
    });
  });

  Scenario('Toggle fan oscillation', ({ Given, When, Then, And }) => {
    Given('a fan entity "fan.office"', () => {
      entityId = 'fan.office';
      setupMocks();
    });

    When('I enable oscillation', async () => {
      await deviceOps.setFanOscillation(entityId, true);
    });

    Then('the fan service "oscillate" should be called', () => {
      expect(lastServiceCall?.service).toBe('oscillate');
    });

    And('the service data should include oscillating true', () => {
      expect(lastServiceCall?.data.oscillating).toBe(true);
    });
  });
});
