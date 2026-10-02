/**
 * Hot-path benchmarks. Run: `npm run bench`.
 *
 * The server is stateless: EVERY /mcp request builds a fresh McpServer, registers all
 * tools, connects a transport and answers. These benchmarks track that per-request
 * cost plus the other things every request pays for (JWT verify, argument validation),
 * so dependency upgrades (zod, MCP SDK) can be compared against a recorded baseline.
 */

import { bench, describe, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server/common.js';
import { createJwt, verifyJwt } from '../../src/utils/jwt.js';
import { controlLightSchema, sendNotificationSchema } from '../../src/tools/common.js';
import { Role } from '../../src/permissions/index.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Registration never calls the plugin clients; stubs are enough.
const deps = { haClient: {} as never, omadaClient: {} as never, toolRegistrationMode: 'graph' as const };

describe('per-request server construction (stateless /mcp)', () => {
  bench('createServer: register all tools', () => {
    createServer(deps);
  });

  bench('createServer + filter for a READONLY caller', () => {
    createServer({ ...deps, callerPermissions: Role.READONLY });
  });

  bench('full round trip: createServer + connect + tools/list', async () => {
    const server = createServer(deps);
    const client = new Client({ name: 'bench', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    await client.listTools();
    await client.close();
    await server.close();
  });
});

describe('per-request auth', () => {
  const secret = 'bench-secret-0123456789-0123456789';
  const token = createJwt({ sub: 'bench', exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
  bench('verifyJwt (HS256)', () => {
    verifyJwt(token, secret);
  });
});

describe('tool argument validation (zod)', () => {
  const light = { entity_id: 'light.living_room', action: 'turn_on', brightness_pct: 75, rgb_color: [255, 120, 0] };
  const notify = {
    message: 'Front door opened',
    title: 'Security',
    target: 'mobile_app_phone',
    priority: 'high',
    actions: [{ action: 'ACK', title: 'OK' }],
    data: { tag: 'door' },
  };
  bench('parse controlLight args', () => {
    controlLightSchema.parse(light);
  });
  bench('parse sendNotification args', () => {
    sendNotificationSchema.parse(notify);
  });
});
