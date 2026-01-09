/**
 * Enhanced Device Control Operations
 * Provides high-level device control with type-safe parameters
 */

import type { ServiceCallResponse } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { ServiceOperations } from './services.js';
import type { StateOperations } from './states.js';

export interface LightControlOptions {
  brightness?: number;      // 0-255
  brightness_pct?: number;  // 0-100
  color_temp?: number;      // Mireds
  color_temp_kelvin?: number;
  rgb_color?: [number, number, number];
  rgbw_color?: [number, number, number, number];
  rgbww_color?: [number, number, number, number, number];
  hs_color?: [number, number];  // Hue (0-360), Saturation (0-100)
  xy_color?: [number, number];
  color_name?: string;
  effect?: string;
  flash?: 'short' | 'long';
  transition?: number;      // Seconds
}

export interface ClimateControlOptions {
  temperature?: number;
  target_temp_high?: number;
  target_temp_low?: number;
  hvac_mode?: 'off' | 'heat' | 'cool' | 'heat_cool' | 'auto' | 'dry' | 'fan_only';
  fan_mode?: string;
  swing_mode?: string;
  preset_mode?: string;
  humidity?: number;
}

export interface MediaPlayerControlOptions {
  volume_level?: number;    // 0-1
  is_volume_muted?: boolean;
  media_content_id?: string;
  media_content_type?: string;
  enqueue?: 'play' | 'next' | 'add' | 'replace';
  seek_position?: number;
}

export interface CoverControlOptions {
  position?: number;        // 0-100 (0 = closed, 100 = open)
  tilt_position?: number;   // 0-100
}

export interface FanControlOptions {
  percentage?: number;      // 0-100
  preset_mode?: string;
  oscillating?: boolean;
  direction?: 'forward' | 'reverse';
}

/**
 * Enhanced device control operations
 */
export class DeviceOperations {
  constructor(
    private readonly serviceOps: ServiceOperations,
    private readonly stateOps: StateOperations
  ) {
    // stateOps reserved for future use (e.g., checking device capabilities before control)
    void this.stateOps;
  }

  // ===== Light Control =====

  /**
   * Turn on a light with optional settings
   */
  async turnOnLight(entityId: string, options?: LightControlOptions): Promise<ServiceCallResponse> {
    logger.info('Turning on light', { entityId, options });

    return this.serviceOps.callService({
      domain: 'light',
      service: 'turn_on',
      target: { entity_id: entityId },
      service_data: options as Record<string, unknown>,
    });
  }

  /**
   * Turn off a light
   */
  async turnOffLight(entityId: string, transition?: number): Promise<ServiceCallResponse> {
    logger.info('Turning off light', { entityId, transition });

    return this.serviceOps.callService({
      domain: 'light',
      service: 'turn_off',
      target: { entity_id: entityId },
      service_data: transition ? { transition } : undefined,
    });
  }

  /**
   * Toggle a light
   */
  async toggleLight(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Toggling light', { entityId });

    return this.serviceOps.callService({
      domain: 'light',
      service: 'toggle',
      target: { entity_id: entityId },
    });
  }

  /**
   * Set light brightness (percentage)
   */
  async setLightBrightness(entityId: string, brightness: number, transition?: number): Promise<ServiceCallResponse> {
    logger.info('Setting light brightness', { entityId, brightness, transition });

    return this.serviceOps.callService({
      domain: 'light',
      service: 'turn_on',
      target: { entity_id: entityId },
      service_data: {
        brightness_pct: Math.max(0, Math.min(100, brightness)),
        ...(transition ? { transition } : {}),
      },
    });
  }

  /**
   * Set light color (RGB)
   */
  async setLightColor(entityId: string, rgb: [number, number, number], brightness?: number): Promise<ServiceCallResponse> {
    logger.info('Setting light color', { entityId, rgb, brightness });

    return this.serviceOps.callService({
      domain: 'light',
      service: 'turn_on',
      target: { entity_id: entityId },
      service_data: {
        rgb_color: rgb,
        ...(brightness !== undefined ? { brightness_pct: brightness } : {}),
      },
    });
  }

  /**
   * Set light color temperature (Kelvin)
   */
  async setLightColorTemp(entityId: string, kelvin: number, brightness?: number): Promise<ServiceCallResponse> {
    logger.info('Setting light color temperature', { entityId, kelvin, brightness });

    return this.serviceOps.callService({
      domain: 'light',
      service: 'turn_on',
      target: { entity_id: entityId },
      service_data: {
        color_temp_kelvin: kelvin,
        ...(brightness !== undefined ? { brightness_pct: brightness } : {}),
      },
    });
  }

  // ===== Climate Control =====

  /**
   * Set climate temperature
   */
  async setClimateTemperature(entityId: string, temperature: number): Promise<ServiceCallResponse> {
    logger.info('Setting climate temperature', { entityId, temperature });

    return this.serviceOps.callService({
      domain: 'climate',
      service: 'set_temperature',
      target: { entity_id: entityId },
      service_data: { temperature },
    });
  }

  /**
   * Set climate HVAC mode
   */
  async setClimateMode(entityId: string, mode: ClimateControlOptions['hvac_mode']): Promise<ServiceCallResponse> {
    logger.info('Setting climate mode', { entityId, mode });

    return this.serviceOps.callService({
      domain: 'climate',
      service: 'set_hvac_mode',
      target: { entity_id: entityId },
      service_data: { hvac_mode: mode },
    });
  }

  /**
   * Set climate fan mode
   */
  async setClimateFanMode(entityId: string, fanMode: string): Promise<ServiceCallResponse> {
    logger.info('Setting climate fan mode', { entityId, fanMode });

    return this.serviceOps.callService({
      domain: 'climate',
      service: 'set_fan_mode',
      target: { entity_id: entityId },
      service_data: { fan_mode: fanMode },
    });
  }

  /**
   * Set climate preset mode
   */
  async setClimatePreset(entityId: string, preset: string): Promise<ServiceCallResponse> {
    logger.info('Setting climate preset', { entityId, preset });

    return this.serviceOps.callService({
      domain: 'climate',
      service: 'set_preset_mode',
      target: { entity_id: entityId },
      service_data: { preset_mode: preset },
    });
  }

  /**
   * Turn off climate
   */
  async turnOffClimate(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Turning off climate', { entityId });

    return this.serviceOps.callService({
      domain: 'climate',
      service: 'turn_off',
      target: { entity_id: entityId },
    });
  }

  // ===== Media Player Control =====

  /**
   * Play media
   */
  async mediaPlay(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Playing media', { entityId });

    return this.serviceOps.callService({
      domain: 'media_player',
      service: 'media_play',
      target: { entity_id: entityId },
    });
  }

  /**
   * Pause media
   */
  async mediaPause(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Pausing media', { entityId });

    return this.serviceOps.callService({
      domain: 'media_player',
      service: 'media_pause',
      target: { entity_id: entityId },
    });
  }

  /**
   * Stop media
   */
  async mediaStop(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Stopping media', { entityId });

    return this.serviceOps.callService({
      domain: 'media_player',
      service: 'media_stop',
      target: { entity_id: entityId },
    });
  }

  /**
   * Next track
   */
  async mediaNext(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Next track', { entityId });

    return this.serviceOps.callService({
      domain: 'media_player',
      service: 'media_next_track',
      target: { entity_id: entityId },
    });
  }

  /**
   * Previous track
   */
  async mediaPrevious(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Previous track', { entityId });

    return this.serviceOps.callService({
      domain: 'media_player',
      service: 'media_previous_track',
      target: { entity_id: entityId },
    });
  }

  /**
   * Set media player volume
   */
  async setMediaVolume(entityId: string, volume: number): Promise<ServiceCallResponse> {
    logger.info('Setting media volume', { entityId, volume });

    return this.serviceOps.callService({
      domain: 'media_player',
      service: 'volume_set',
      target: { entity_id: entityId },
      service_data: { volume_level: Math.max(0, Math.min(1, volume)) },
    });
  }

  /**
   * Mute/unmute media player
   */
  async setMediaMute(entityId: string, mute: boolean): Promise<ServiceCallResponse> {
    logger.info('Setting media mute', { entityId, mute });

    return this.serviceOps.callService({
      domain: 'media_player',
      service: 'volume_mute',
      target: { entity_id: entityId },
      service_data: { is_volume_muted: mute },
    });
  }

  /**
   * Play specific media content
   */
  async playMedia(entityId: string, contentId: string, contentType: string): Promise<ServiceCallResponse> {
    logger.info('Playing specific media', { entityId, contentId, contentType });

    return this.serviceOps.callService({
      domain: 'media_player',
      service: 'play_media',
      target: { entity_id: entityId },
      service_data: {
        media_content_id: contentId,
        media_content_type: contentType,
      },
    });
  }

  // ===== Cover/Blind Control =====

  /**
   * Open a cover
   */
  async openCover(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Opening cover', { entityId });

    return this.serviceOps.callService({
      domain: 'cover',
      service: 'open_cover',
      target: { entity_id: entityId },
    });
  }

  /**
   * Close a cover
   */
  async closeCover(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Closing cover', { entityId });

    return this.serviceOps.callService({
      domain: 'cover',
      service: 'close_cover',
      target: { entity_id: entityId },
    });
  }

  /**
   * Stop a cover
   */
  async stopCover(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Stopping cover', { entityId });

    return this.serviceOps.callService({
      domain: 'cover',
      service: 'stop_cover',
      target: { entity_id: entityId },
    });
  }

  /**
   * Set cover position
   */
  async setCoverPosition(entityId: string, position: number): Promise<ServiceCallResponse> {
    logger.info('Setting cover position', { entityId, position });

    return this.serviceOps.callService({
      domain: 'cover',
      service: 'set_cover_position',
      target: { entity_id: entityId },
      service_data: { position: Math.max(0, Math.min(100, position)) },
    });
  }

  /**
   * Set cover tilt position
   */
  async setCoverTilt(entityId: string, tiltPosition: number): Promise<ServiceCallResponse> {
    logger.info('Setting cover tilt', { entityId, tiltPosition });

    return this.serviceOps.callService({
      domain: 'cover',
      service: 'set_cover_tilt_position',
      target: { entity_id: entityId },
      service_data: { tilt_position: Math.max(0, Math.min(100, tiltPosition)) },
    });
  }

  // ===== Fan Control =====

  /**
   * Turn on a fan
   */
  async turnOnFan(entityId: string, options?: FanControlOptions): Promise<ServiceCallResponse> {
    logger.info('Turning on fan', { entityId, options });

    return this.serviceOps.callService({
      domain: 'fan',
      service: 'turn_on',
      target: { entity_id: entityId },
      service_data: options as Record<string, unknown>,
    });
  }

  /**
   * Turn off a fan
   */
  async turnOffFan(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Turning off fan', { entityId });

    return this.serviceOps.callService({
      domain: 'fan',
      service: 'turn_off',
      target: { entity_id: entityId },
    });
  }

  /**
   * Set fan speed percentage
   */
  async setFanSpeed(entityId: string, percentage: number): Promise<ServiceCallResponse> {
    logger.info('Setting fan speed', { entityId, percentage });

    return this.serviceOps.callService({
      domain: 'fan',
      service: 'set_percentage',
      target: { entity_id: entityId },
      service_data: { percentage: Math.max(0, Math.min(100, percentage)) },
    });
  }

  /**
   * Set fan oscillation
   */
  async setFanOscillation(entityId: string, oscillating: boolean): Promise<ServiceCallResponse> {
    logger.info('Setting fan oscillation', { entityId, oscillating });

    return this.serviceOps.callService({
      domain: 'fan',
      service: 'oscillate',
      target: { entity_id: entityId },
      service_data: { oscillating },
    });
  }

  /**
   * Set fan direction
   */
  async setFanDirection(entityId: string, direction: 'forward' | 'reverse'): Promise<ServiceCallResponse> {
    logger.info('Setting fan direction', { entityId, direction });

    return this.serviceOps.callService({
      domain: 'fan',
      service: 'set_direction',
      target: { entity_id: entityId },
      service_data: { direction },
    });
  }

  // ===== Lock Control =====

  /**
   * Lock a lock
   */
  async lock(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Locking', { entityId });

    return this.serviceOps.callService({
      domain: 'lock',
      service: 'lock',
      target: { entity_id: entityId },
    });
  }

  /**
   * Unlock a lock
   */
  async unlock(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Unlocking', { entityId });

    return this.serviceOps.callService({
      domain: 'lock',
      service: 'unlock',
      target: { entity_id: entityId },
    });
  }

  // ===== Vacuum Control =====

  /**
   * Start vacuum
   */
  async startVacuum(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Starting vacuum', { entityId });

    return this.serviceOps.callService({
      domain: 'vacuum',
      service: 'start',
      target: { entity_id: entityId },
    });
  }

  /**
   * Stop vacuum
   */
  async stopVacuum(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Stopping vacuum', { entityId });

    return this.serviceOps.callService({
      domain: 'vacuum',
      service: 'stop',
      target: { entity_id: entityId },
    });
  }

  /**
   * Pause vacuum
   */
  async pauseVacuum(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Pausing vacuum', { entityId });

    return this.serviceOps.callService({
      domain: 'vacuum',
      service: 'pause',
      target: { entity_id: entityId },
    });
  }

  /**
   * Return vacuum to base
   */
  async returnVacuumToBase(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Returning vacuum to base', { entityId });

    return this.serviceOps.callService({
      domain: 'vacuum',
      service: 'return_to_base',
      target: { entity_id: entityId },
    });
  }

  /**
   * Set vacuum fan speed
   */
  async setVacuumFanSpeed(entityId: string, fanSpeed: string): Promise<ServiceCallResponse> {
    logger.info('Setting vacuum fan speed', { entityId, fanSpeed });

    return this.serviceOps.callService({
      domain: 'vacuum',
      service: 'set_fan_speed',
      target: { entity_id: entityId },
      service_data: { fan_speed: fanSpeed },
    });
  }

  // ===== Scene Control =====

  /**
   * Activate a scene
   */
  async activateScene(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Activating scene', { entityId });

    return this.serviceOps.callService({
      domain: 'scene',
      service: 'turn_on',
      target: { entity_id: entityId },
    });
  }

  // ===== Script Control =====

  /**
   * Run a script
   */
  async runScript(entityId: string, variables?: Record<string, unknown>): Promise<ServiceCallResponse> {
    logger.info('Running script', { entityId, variables });

    return this.serviceOps.callService({
      domain: 'script',
      service: 'turn_on',
      target: { entity_id: entityId },
      service_data: variables,
    });
  }

  /**
   * Stop a running script
   */
  async stopScript(entityId: string): Promise<ServiceCallResponse> {
    logger.info('Stopping script', { entityId });

    return this.serviceOps.callService({
      domain: 'script',
      service: 'turn_off',
      target: { entity_id: entityId },
    });
  }

  // ===== Notification =====

  /**
   * Send a notification
   */
  async sendNotification(
    message: string,
    title?: string,
    target?: string,
    data?: Record<string, unknown>
  ): Promise<ServiceCallResponse> {
    logger.info('Sending notification', { title, target });

    const service = target ?? 'notify';

    return this.serviceOps.callService({
      domain: 'notify',
      service,
      service_data: {
        message,
        ...(title ? { title } : {}),
        ...(data ? { data } : {}),
      },
    });
  }
}
