// Configuration types
export type { HaConfig } from './haConfig.js';
export type { HaVersion } from './config.js';

// State types
export type { Entity, EntityListResponse } from './states.js';

// Automation types
export type {
  Automation,
  AutomationConfig,
  AutomationTrigger,
  AutomationCondition,
  AutomationAction,
} from './automations.js';

// Entity summary types
export type { DomainSummary } from './entities.js';

// History types
export type { LogbookEntry } from './history.js';

// Update types
export type {
  UpdateInfo,
  SupervisorCoreInfo,
  SupervisorInfo,
  SupervisorOsInfo,
} from './updates.js';

// Calendar types
export type { CalendarEvent, Calendar } from './calendars.js';

// Service call types
export type { ServiceCallData, ServiceCallResponse } from './serviceCall.js';

// Request types
export type { RequestOptions } from './request.js';

// Error types
export { HaError, AuthenticationError, ApiError, ConfigurationError } from './errors.js';
