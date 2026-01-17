/**
 * HaClient aggregator tests
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Create mock instances
const statesInstance = {
  getStates: vi.fn().mockResolvedValue([{ entity_id: 'light.test' }]),
  getState: vi.fn().mockResolvedValue({ entity_id: 'light.test' }),
  getAllSensors: vi.fn().mockResolvedValue([{ entity_id: 'sensor.test' }]),
};

const servicesInstance = {
  callService: vi.fn().mockResolvedValue({ context: { id: 'ctx-1' } }),
  restartServer: vi.fn().mockResolvedValue(undefined),
};

const entitiesInstance = {
  getEntitiesByDomain: vi.fn().mockResolvedValue([{ entity_id: 'light.test' }]),
  searchEntities: vi.fn().mockResolvedValue([{ entity_id: 'light.test' }]),
  getDomainSummary: vi.fn().mockResolvedValue({ domain: 'light', count: 1 }),
  listEntities: vi.fn().mockResolvedValue([{ entity_id: 'light.test' }]),
};

const automationsInstance = {
  getAutomations: vi.fn().mockResolvedValue([{ id: 'automation.test' }]),
};

const historyInstance = {
  getHistory: vi.fn().mockResolvedValue([[{ entity_id: 'sensor.test' }]]),
  getSystemLog: vi.fn().mockResolvedValue([{ when: '2026-01-08T10:00:00Z' }]),
};

const updatesInstance = {
  getAvailableUpdates: vi.fn().mockResolvedValue({ updates: [], entities: [] }),
};

const configInstance = {
  getConfig: vi.fn().mockResolvedValue({ version: '2026.1.0' }),
  checkApi: vi.fn().mockResolvedValue({ message: 'API running.' }),
  getVersion: vi.fn().mockResolvedValue({ version: '2026.1.0' }),
};

const requestInstance = {
  request: vi.fn().mockResolvedValue({}),
  get: vi.fn().mockResolvedValue({}),
  post: vi.fn().mockResolvedValue({}),
};

// Mock classes for vitest 4.x compatibility
const StateOperationsMock = vi.fn().mockImplementation(() => statesInstance);
const ServiceOperationsMock = vi.fn().mockImplementation(() => servicesInstance);
const EntityOperationsMock = vi.fn().mockImplementation(() => entitiesInstance);
const AutomationOperationsMock = vi.fn().mockImplementation(() => automationsInstance);
const HistoryOperationsMock = vi.fn().mockImplementation(() => historyInstance);
const UpdateOperationsMock = vi.fn().mockImplementation(() => updatesInstance);
const ConfigOperationsMock = vi.fn().mockImplementation(() => configInstance);
const RequestHandlerMock = vi.fn().mockImplementation(() => requestInstance);

// Apply mocks with class-style factories
vi.mock('../../src/haClient/states.js', () => ({
  StateOperations: class {
    constructor() {
      StateOperationsMock();
      return statesInstance;
    }
  },
}));

vi.mock('../../src/haClient/services.js', () => ({
  ServiceOperations: class {
    constructor() {
      ServiceOperationsMock();
      return servicesInstance;
    }
  },
}));

vi.mock('../../src/haClient/entities.js', () => ({
  EntityOperations: class {
    constructor() {
      EntityOperationsMock();
      return entitiesInstance;
    }
  },
}));

vi.mock('../../src/haClient/automations.js', () => ({
  AutomationOperations: class {
    constructor() {
      AutomationOperationsMock();
      return automationsInstance;
    }
  },
}));

vi.mock('../../src/haClient/history.js', () => ({
  HistoryOperations: class {
    constructor() {
      HistoryOperationsMock();
      return historyInstance;
    }
  },
}));

vi.mock('../../src/haClient/updates.js', () => ({
  UpdateOperations: class {
    constructor() {
      UpdateOperationsMock();
      return updatesInstance;
    }
  },
}));

vi.mock('../../src/haClient/config.js', () => ({
  ConfigOperations: class {
    constructor() {
      ConfigOperationsMock();
      return configInstance;
    }
  },
}));

vi.mock('../../src/haClient/request.js', () => ({
  RequestHandler: class {
    constructor() {
      RequestHandlerMock();
      return requestInstance;
    }
  },
}));

import type { HaClientOptions } from '../../src/haClient/index.js';

const baseConfig: HaClientOptions = {
  baseUrl: 'http://homeassistant.10.0.0.19.nip.io:8123',
  token: 'test-token',
  strictSsl: false,
  timeout: 30000,
};

describe('HaClient aggregator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes all operation modules', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    expect(RequestHandlerMock).toHaveBeenCalled();
    expect(StateOperationsMock).toHaveBeenCalled();
    expect(ServiceOperationsMock).toHaveBeenCalled();
    expect(EntityOperationsMock).toHaveBeenCalled();
    expect(AutomationOperationsMock).toHaveBeenCalled();
    expect(HistoryOperationsMock).toHaveBeenCalled();
    expect(UpdateOperationsMock).toHaveBeenCalled();
    expect(ConfigOperationsMock).toHaveBeenCalled();
  });

  it('proxies state operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    await expect(client.getStates()).resolves.toEqual([{ entity_id: 'light.test' }]);
    await expect(client.getState('light.test')).resolves.toEqual({ entity_id: 'light.test' });
    await expect(client.getAllSensors()).resolves.toEqual([{ entity_id: 'sensor.test' }]);

    expect(statesInstance.getStates).toHaveBeenCalled();
    expect(statesInstance.getState).toHaveBeenCalledWith('light.test');
    expect(statesInstance.getAllSensors).toHaveBeenCalled();
  });

  it('proxies service operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    const serviceData = { domain: 'light', service: 'turn_on' };
    await expect(client.callService(serviceData)).resolves.toEqual({ context: { id: 'ctx-1' } });
    await expect(client.restartServer()).resolves.toBeUndefined();

    expect(servicesInstance.callService).toHaveBeenCalledWith(serviceData);
    expect(servicesInstance.restartServer).toHaveBeenCalled();
  });

  it('proxies entity operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    await expect(client.getEntitiesByDomain('light')).resolves.toEqual([{ entity_id: 'light.test' }]);
    await expect(client.searchEntities('test')).resolves.toEqual([{ entity_id: 'light.test' }]);
    await expect(client.getDomainSummary('light')).resolves.toEqual({ domain: 'light', count: 1 });
    await expect(client.listEntities({ domain: 'light' })).resolves.toEqual([{ entity_id: 'light.test' }]);

    expect(entitiesInstance.getEntitiesByDomain).toHaveBeenCalledWith('light');
    expect(entitiesInstance.searchEntities).toHaveBeenCalledWith('test');
    expect(entitiesInstance.getDomainSummary).toHaveBeenCalledWith('light');
    expect(entitiesInstance.listEntities).toHaveBeenCalledWith({ domain: 'light' });
  });

  it('proxies automation operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    await expect(client.getAutomations()).resolves.toEqual([{ id: 'automation.test' }]);

    expect(automationsInstance.getAutomations).toHaveBeenCalled();
  });

  it('proxies history operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    await expect(client.getHistory('sensor.test', 24)).resolves.toEqual([[{ entity_id: 'sensor.test' }]]);
    await expect(client.getSystemLog({ hours: 24 })).resolves.toEqual([{ when: '2026-01-08T10:00:00Z' }]);

    expect(historyInstance.getHistory).toHaveBeenCalledWith('sensor.test', 24);
    expect(historyInstance.getSystemLog).toHaveBeenCalledWith({ hours: 24 });
  });

  it('proxies update operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    await expect(client.getAvailableUpdates()).resolves.toEqual({ updates: [], entities: [] });

    expect(updatesInstance.getAvailableUpdates).toHaveBeenCalled();
  });

  it('proxies config operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    await expect(client.getConfig()).resolves.toEqual({ version: '2026.1.0' });
    await expect(client.checkApi()).resolves.toEqual({ message: 'API running.' });
    await expect(client.getVersion()).resolves.toEqual({ version: '2026.1.0' });

    expect(configInstance.getConfig).toHaveBeenCalled();
    expect(configInstance.checkApi).toHaveBeenCalled();
    expect(configInstance.getVersion).toHaveBeenCalled();
  });
});
