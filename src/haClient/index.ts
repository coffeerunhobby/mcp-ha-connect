/**
 * Home Assistant API Client
 * Main client class that composes all operation modules
 */

import type {
  Entity,
  ServiceCallData,
  ServiceCallResponse,
  Automation,
  AutomationConfig,
  DomainSummary,
  HaVersion,
  LogbookEntry,
  UpdateInfo,
  Calendar,
  CalendarEvent,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

import { AutomationOperations } from './automations.js';
import { ConfigOperations } from './config.js';
import { DeviceOperations } from './devices.js';
import { EntityOperations } from './entities.js';
import { HistoryOperations } from './history.js';
import { RequestHandler } from './request.js';
import { ServiceOperations } from './services.js';
import { StateOperations } from './states.js';
import { UpdateOperations } from './updates.js';
import { CalendarOperations } from './calendars.js';

export interface HaClientOptions {
  baseUrl: string;
  token: string;
  timeout: number;
  strictSsl: boolean;
}

/**
 * Main client for interacting with the Home Assistant API.
 * Organized with dedicated operation classes for each domain.
 */
export class HaClient {
  private readonly request: RequestHandler;
  private readonly stateOps: StateOperations;
  private readonly serviceOps: ServiceOperations;
  private readonly entityOps: EntityOperations;
  private readonly automationOps: AutomationOperations;
  private readonly historyOps: HistoryOperations;
  private readonly updateOps: UpdateOperations;
  private readonly configOps: ConfigOperations;
  private readonly calendarOps: CalendarOperations;
  public readonly devices: DeviceOperations;

  constructor(config: HaClientOptions) {
    logger.debug('Initializing HaClient');

    // Initialize request handler
    this.request = new RequestHandler({
      baseUrl: config.baseUrl,
      token: config.token,
      timeout: config.timeout,
      strictSsl: config.strictSsl,
    });

    // Initialize operation modules with dependencies
    this.stateOps = new StateOperations(this.request);
    this.serviceOps = new ServiceOperations(this.request);
    this.entityOps = new EntityOperations(this.stateOps);
    this.automationOps = new AutomationOperations(this.stateOps, this.serviceOps, this.request);
    this.historyOps = new HistoryOperations(this.request);
    this.updateOps = new UpdateOperations(this.entityOps);
    this.configOps = new ConfigOperations(this.request);
    this.calendarOps = new CalendarOperations(this.request);
    this.devices = new DeviceOperations(this.serviceOps, this.stateOps);

    logger.info('HaClient initialized');
  }

  // ===== State Operations =====

  /**
   * Get all states (entities)
   */
  async getStates(): Promise<Entity[]> {
    return this.stateOps.getStates();
  }

  /**
   * Get state of a specific entity
   */
  async getState(entityId: string): Promise<Entity | null> {
    return this.stateOps.getState(entityId);
  }

  /**
   * Get all sensors (sensor.* and binary_sensor.* entities)
   */
  async getAllSensors(): Promise<Entity[]> {
    return this.stateOps.getAllSensors();
  }

  // ===== Service Operations =====

  /**
   * Call a service
   */
  async callService(data: ServiceCallData): Promise<ServiceCallResponse> {
    return this.serviceOps.callService(data);
  }

  /**
   * Restart Home Assistant
   */
  async restartServer(): Promise<void> {
    return this.serviceOps.restartServer();
  }

  // ===== Entity Operations =====

  /**
   * Get entities filtered by domain
   */
  async getEntitiesByDomain(domain: string): Promise<Entity[]> {
    return this.entityOps.getEntitiesByDomain(domain);
  }

  /**
   * Search entities by name or entity_id
   */
  async searchEntities(query: string): Promise<Entity[]> {
    return this.entityOps.searchEntities(query);
  }

  /**
   * Get domain summary with entity counts and state breakdown
   */
  async getDomainSummary(domain: string): Promise<DomainSummary> {
    return this.entityOps.getDomainSummary(domain);
  }

  /**
   * List entities with optional filtering
   */
  async listEntities(options: {
    domain?: string;
    search?: string;
    limit?: number;
    state?: string;
  } = {}): Promise<Entity[]> {
    return this.entityOps.listEntities(options);
  }

  // ===== Automation Operations =====

  /**
   * Get all automations
   */
  async getAutomations(): Promise<Automation[]> {
    return this.automationOps.getAutomations();
  }

  /**
   * Get a single automation by entity_id
   */
  async getAutomation(entityId: string): Promise<Automation | null> {
    return this.automationOps.getAutomation(entityId);
  }

  /**
   * Trigger an automation manually
   */
  async triggerAutomation(entityId: string, variables?: Record<string, unknown>): Promise<ServiceCallResponse> {
    return this.automationOps.triggerAutomation(entityId, variables);
  }

  /**
   * Enable an automation
   */
  async enableAutomation(entityId: string): Promise<ServiceCallResponse> {
    return this.automationOps.enableAutomation(entityId);
  }

  /**
   * Disable an automation
   */
  async disableAutomation(entityId: string): Promise<ServiceCallResponse> {
    return this.automationOps.disableAutomation(entityId);
  }

  /**
   * Toggle an automation
   */
  async toggleAutomation(entityId: string): Promise<ServiceCallResponse> {
    return this.automationOps.toggleAutomation(entityId);
  }

  /**
   * Reload all automations from configuration
   */
  async reloadAutomations(): Promise<void> {
    return this.automationOps.reloadAutomations();
  }

  /**
   * Create a new automation
   */
  async createAutomation(config: AutomationConfig): Promise<{ id: string }> {
    return this.automationOps.createAutomation(config);
  }

  /**
   * Update an existing automation
   */
  async updateAutomation(automationId: string, config: Partial<AutomationConfig>): Promise<void> {
    return this.automationOps.updateAutomation(automationId, config);
  }

  /**
   * Delete an automation
   */
  async deleteAutomation(automationId: string): Promise<void> {
    return this.automationOps.deleteAutomation(automationId);
  }

  /**
   * Get automation execution trace
   */
  async getAutomationTrace(entityId: string): Promise<unknown[]> {
    return this.automationOps.getAutomationTrace(entityId);
  }

  // ===== History Operations =====

  /**
   * Get historical data for an entity
   */
  async getHistory(entityId: string, hours: number = 24): Promise<Entity[][]> {
    return this.historyOps.getHistory(entityId, hours);
  }

  /**
   * Get system log entries from the logbook
   */
  async getSystemLog(options: {
    hours?: number;
    entity_id?: string;
    limit?: number;
  } = {}): Promise<LogbookEntry[]> {
    return this.historyOps.getSystemLog(options);
  }

  // ===== Update Operations =====

  /**
   * Get available updates by checking update.* entities
   */
  async getAvailableUpdates(): Promise<{
    updates: UpdateInfo[];
    entities: Entity[];
  }> {
    return this.updateOps.getAvailableUpdates();
  }

  // ===== Config Operations =====

  /**
   * Get config
   */
  async getConfig(): Promise<Record<string, unknown>> {
    return this.configOps.getConfig();
  }

  /**
   * Check API (health check)
   */
  async checkApi(): Promise<{ message: string }> {
    return this.configOps.checkApi();
  }

  /**
   * Get Home Assistant version and configuration info
   */
  async getVersion(): Promise<HaVersion> {
    return this.configOps.getVersion();
  }

  // ===== Calendar Operations =====

  /**
   * Get all calendar entities
   */
  async getCalendars(): Promise<Calendar[]> {
    return this.calendarOps.getCalendars();
  }

  /**
   * Get events from a calendar
   */
  async getCalendarEvents(
    entityId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<CalendarEvent[]> {
    return this.calendarOps.getCalendarEvents(entityId, startDate, endDate);
  }

  /**
   * Get events from all calendars
   */
  async getAllCalendarEvents(
    startDate?: Date,
    endDate?: Date
  ): Promise<Array<{ calendar: string; events: CalendarEvent[] }>> {
    return this.calendarOps.getAllCalendarEvents(startDate, endDate);
  }
}

// Re-export operation classes for testing
export { RequestHandler } from './request.js';
export { StateOperations } from './states.js';
export { ServiceOperations } from './services.js';
export { EntityOperations } from './entities.js';
export { AutomationOperations } from './automations.js';
export { HistoryOperations } from './history.js';
export { UpdateOperations } from './updates.js';
export { ConfigOperations } from './config.js';
export { DeviceOperations } from './devices.js';
export { CalendarOperations } from './calendars.js';
export type { LightControlOptions, ClimateControlOptions, MediaPlayerControlOptions, CoverControlOptions, FanControlOptions } from './devices.js';
