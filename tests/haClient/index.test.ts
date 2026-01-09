/**
 * HaClient aggregator tests
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentConfig } from '../../src/config.js';

// Mock all operation modules
const statesModule = vi.hoisted(() => {
  const instance = {
    getStates: vi.fn().mockResolvedValue([{ entity_id: 'light.test' }]),
    getState: vi.fn().mockResolvedValue({ entity_id: 'light.test' }),
    getAllSensors: vi.fn().mockResolvedValue([{ entity_id: 'sensor.test' }]),
  };
  const StateOperations = vi.fn(() => instance);
  return { instance, StateOperations };
});

const servicesModule = vi.hoisted(() => {
  const instance = {
    callService: vi.fn().mockResolvedValue({ context: { id: 'ctx-1' } }),
    restartServer: vi.fn().mockResolvedValue(undefined),
  };
  const ServiceOperations = vi.fn(() => instance);
  return { instance, ServiceOperations };
});

const entitiesModule = vi.hoisted(() => {
  const instance = {
    getEntitiesByDomain: vi.fn().mockResolvedValue([{ entity_id: 'light.test' }]),
    searchEntities: vi.fn().mockResolvedValue([{ entity_id: 'light.test' }]),
    getDomainSummary: vi.fn().mockResolvedValue({ domain: 'light', count: 1 }),
    listEntities: vi.fn().mockResolvedValue([{ entity_id: 'light.test' }]),
  };
  const EntityOperations = vi.fn(() => instance);
  return { instance, EntityOperations };
});

const automationsModule = vi.hoisted(() => {
  const instance = {
    getAutomations: vi.fn().mockResolvedValue([{ id: 'automation.test' }]),
  };
  const AutomationOperations = vi.fn(() => instance);
  return { instance, AutomationOperations };
});

const historyModule = vi.hoisted(() => {
  const instance = {
    getHistory: vi.fn().mockResolvedValue([[{ entity_id: 'sensor.test' }]]),
    getSystemLog: vi.fn().mockResolvedValue([{ when: '2026-01-08T10:00:00Z' }]),
  };
  const HistoryOperations = vi.fn(() => instance);
  return { instance, HistoryOperations };
});

const updatesModule = vi.hoisted(() => {
  const instance = {
    getAvailableUpdates: vi.fn().mockResolvedValue({ updates: [], entities: [] }),
  };
  const UpdateOperations = vi.fn(() => instance);
  return { instance, UpdateOperations };
});

const configModule = vi.hoisted(() => {
  const instance = {
    getConfig: vi.fn().mockResolvedValue({ version: '2026.1.0' }),
    checkApi: vi.fn().mockResolvedValue({ message: 'API running.' }),
    getVersion: vi.fn().mockResolvedValue({ version: '2026.1.0' }),
  };
  const ConfigOperations = vi.fn(() => instance);
  return { instance, ConfigOperations };
});

const requestModule = vi.hoisted(() => {
  const instance = {
    request: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  };
  const RequestHandler = vi.fn(() => instance);
  return { instance, RequestHandler };
});

// Apply mocks
vi.mock('../../src/haClient/states.js', () => ({ StateOperations: statesModule.StateOperations }));
vi.mock('../../src/haClient/services.js', () => ({ ServiceOperations: servicesModule.ServiceOperations }));
vi.mock('../../src/haClient/entities.js', () => ({ EntityOperations: entitiesModule.EntityOperations }));
vi.mock('../../src/haClient/automations.js', () => ({ AutomationOperations: automationsModule.AutomationOperations }));
vi.mock('../../src/haClient/history.js', () => ({ HistoryOperations: historyModule.HistoryOperations }));
vi.mock('../../src/haClient/updates.js', () => ({ UpdateOperations: updatesModule.UpdateOperations }));
vi.mock('../../src/haClient/config.js', () => ({ ConfigOperations: configModule.ConfigOperations }));
vi.mock('../../src/haClient/request.js', () => ({ RequestHandler: requestModule.RequestHandler }));

const baseConfig: EnvironmentConfig = {
  baseUrl: 'http://homeassistant.local:8123',
  token: 'test-token',
  strictSsl: false,
  timeout: 30000,
  aiProvider: 'ollama',
  aiUrl: 'http://localhost:11434',
  aiModel: 'phi4:14b',
  aiTimeout: 60000,
  logLevel: 'error',
  logFormat: 'plain',
  useHttp: false,
  stateful: false,
  httpTransport: 'stream',
  httpEnableHealthcheck: true,
  httpAllowCors: true,
};

describe('HaClient aggregator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes all operation modules', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    expect(requestModule.RequestHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://homeassistant.local:8123',
        token: 'test-token',
      })
    );
    expect(statesModule.StateOperations).toHaveBeenCalledWith(requestModule.instance);
    expect(servicesModule.ServiceOperations).toHaveBeenCalledWith(requestModule.instance);
    expect(entitiesModule.EntityOperations).toHaveBeenCalledWith(statesModule.instance);
    expect(automationsModule.AutomationOperations).toHaveBeenCalledWith(statesModule.instance);
    expect(historyModule.HistoryOperations).toHaveBeenCalledWith(requestModule.instance);
    expect(updatesModule.UpdateOperations).toHaveBeenCalledWith(entitiesModule.instance);
    expect(configModule.ConfigOperations).toHaveBeenCalledWith(requestModule.instance);
  });

  it('proxies state operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    await expect(client.getStates()).resolves.toEqual([{ entity_id: 'light.test' }]);
    await expect(client.getState('light.test')).resolves.toEqual({ entity_id: 'light.test' });
    await expect(client.getAllSensors()).resolves.toEqual([{ entity_id: 'sensor.test' }]);

    expect(statesModule.instance.getStates).toHaveBeenCalled();
    expect(statesModule.instance.getState).toHaveBeenCalledWith('light.test');
    expect(statesModule.instance.getAllSensors).toHaveBeenCalled();
  });

  it('proxies service operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    const serviceData = { domain: 'light', service: 'turn_on' };
    await expect(client.callService(serviceData)).resolves.toEqual({ context: { id: 'ctx-1' } });
    await expect(client.restartServer()).resolves.toBeUndefined();

    expect(servicesModule.instance.callService).toHaveBeenCalledWith(serviceData);
    expect(servicesModule.instance.restartServer).toHaveBeenCalled();
  });

  it('proxies entity operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    await expect(client.getEntitiesByDomain('light')).resolves.toEqual([{ entity_id: 'light.test' }]);
    await expect(client.searchEntities('test')).resolves.toEqual([{ entity_id: 'light.test' }]);
    await expect(client.getDomainSummary('light')).resolves.toEqual({ domain: 'light', count: 1 });
    await expect(client.listEntities({ domain: 'light' })).resolves.toEqual([{ entity_id: 'light.test' }]);

    expect(entitiesModule.instance.getEntitiesByDomain).toHaveBeenCalledWith('light');
    expect(entitiesModule.instance.searchEntities).toHaveBeenCalledWith('test');
    expect(entitiesModule.instance.getDomainSummary).toHaveBeenCalledWith('light');
    expect(entitiesModule.instance.listEntities).toHaveBeenCalledWith({ domain: 'light' });
  });

  it('proxies automation operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    await expect(client.getAutomations()).resolves.toEqual([{ id: 'automation.test' }]);

    expect(automationsModule.instance.getAutomations).toHaveBeenCalled();
  });

  it('proxies history operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    await expect(client.getHistory('sensor.test', 24)).resolves.toEqual([[{ entity_id: 'sensor.test' }]]);
    await expect(client.getSystemLog({ hours: 24 })).resolves.toEqual([{ when: '2026-01-08T10:00:00Z' }]);

    expect(historyModule.instance.getHistory).toHaveBeenCalledWith('sensor.test', 24);
    expect(historyModule.instance.getSystemLog).toHaveBeenCalledWith({ hours: 24 });
  });

  it('proxies update operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    await expect(client.getAvailableUpdates()).resolves.toEqual({ updates: [], entities: [] });

    expect(updatesModule.instance.getAvailableUpdates).toHaveBeenCalled();
  });

  it('proxies config operations', async () => {
    const { HaClient } = await import('../../src/haClient/index.js');
    const client = new HaClient(baseConfig);

    await expect(client.getConfig()).resolves.toEqual({ version: '2026.1.0' });
    await expect(client.checkApi()).resolves.toEqual({ message: 'API running.' });
    await expect(client.getVersion()).resolves.toEqual({ version: '2026.1.0' });

    expect(configModule.instance.getConfig).toHaveBeenCalled();
    expect(configModule.instance.checkApi).toHaveBeenCalled();
    expect(configModule.instance.getVersion).toHaveBeenCalled();
  });
});
