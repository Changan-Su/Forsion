import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSyncDefault, cloudAccountScope, registerAgentSyncIdentity, setAgentSyncDefault } from '../services/cloudSyncAccount.js';
import type { AgentFilesBrain } from '../seams/cloudBrain.js';

const state = vi.hoisted(() => ({ hostExec: true, brain: {} as AgentFilesBrain, mirror: vi.fn(async () => {}) }));
vi.mock('../core/http.js', () => ({
  authMiddleware: (req: express.Request & { user?: { userId: string } }, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 'local' }; next();
  },
}));
vi.mock('../seams/runtime.js', () => ({
  deps: () => ({ profile: { capabilities: { hostExec: state.hostExec } }, brain: { agentFiles: state.brain } }),
}));
vi.mock('../agents/humanFolder.js', () => ({ mirrorLegacyHuman: state.mirror }));
vi.mock('../services/memorySyncService.js', () => ({ syncNow: vi.fn(), getSyncStatus: vi.fn() }));
vi.mock('../agents/agentRegistry.js', () => ({}));
const { default: router } = await import('./memory.js');

const origin = 'http://127.0.0.1:9/cloud';
const alpha = cloudAccountScope(origin, 'alpha');
const beta = cloudAccountScope(origin, 'beta');
let url: string, server: Server, home: string;
const token = (id: string) => `header.${Buffer.from(JSON.stringify({ userId: id })).toString('base64url')}.signature`;
let currentToken = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing fixture listener');
  url = `http://127.0.0.1:${address.port}/agent/sync/content-owner`;
});
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forsion-content-owner-'));
  vi.stubEnv('TANGU_HOME', home);
  state.brain = {} as AgentFilesBrain;
  state.hostExec = true;
  state.mirror.mockClear();
  currentToken = token('alpha');
  registerAgentSyncIdentity(state.brain, origin + '/', () => currentToken);
  setAgentSyncDefault(alpha, true);
  setAgentSyncDefault(beta, true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const put = (body: Record<string, unknown>) => fetch(url, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

it('rejects an old account claim when the engine now resolves a different cloud account', async () => {
  currentToken = token('beta');
  const response = await put({ enabled: true, expectedAccount: origin + '::alpha' });
  expect(response.status).toBe(409);
  expect(agentSyncDefault(alpha)).toBe(true);
  expect(agentSyncDefault(beta)).toBe(true);
  expect(state.mirror).not.toHaveBeenCalled();
});

it('claims only the matching account and retains compatibility with an old desktop request', async () => {
  const response = await put({ enabled: true, expectedAccount: origin + '::alpha' });
  expect(response.status).toBe(200);
  expect(agentSyncDefault(alpha)).toBe(false);
  expect(agentSyncDefault(beta)).toBe(true);
  currentToken = token('beta');
  expect((await put({ enabled: true })).status).toBe(200);
  expect(agentSyncDefault(beta)).toBe(false);
  expect(state.mirror).toHaveBeenCalledTimes(2);
});
