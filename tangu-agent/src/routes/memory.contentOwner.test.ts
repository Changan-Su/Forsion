import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentSyncDefault, cloudAccountScope, contentSyncOwnership, registerAgentSyncIdentity, setAgentSyncDefault } from '../services/cloudSyncAccount.js';
import { agentsDir } from '../core/tanguHome.js';
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

const call = (method: string, path: string, body?: Record<string, unknown>) => fetch(url.replace('/agent/sync/content-owner', path), {
  method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

it('GET reads both bits back; the new body changes only the bit it names; the old body still changes both', async () => {
  expect(await (await call('GET', '/agent/sync/content-owner')).json()).toEqual({ human: false, agents: false });
  expect((await put({ human: true, expectedAccount: origin + '::alpha' })).status).toBe(200);
  expect(await (await call('GET', '/agent/sync/content-owner')).json()).toEqual({ human: true, agents: false });
  expect(agentSyncDefault(alpha)).toBe(false);
  expect((await put({ agents: true })).status).toBe(200);
  expect((await put({ human: false })).status).toBe(200);
  expect(contentSyncOwnership(alpha)).toEqual({ human: false, agents: true });
  expect(agentSyncDefault(alpha)).toBe(true); // human 还给引擎:总闸的同意照旧有效
  expect((await put({ enabled: false })).status).toBe(200);
  expect(contentSyncOwnership(alpha)).toEqual({ human: false, agents: false });
  expect((await put({ enabled: true, human: false })).status).toBe(400);
  expect((await put({})).status).toBe(400);
  expect(contentSyncOwnership(beta)).toEqual({ human: false, agents: false });
});

it('GET refuses a stale account and does not report a corrupt owner file as "nobody owns it"', async () => {
  expect((await call('GET', '/agent/sync/content-owner?expectedAccount=' + encodeURIComponent(origin + '::beta'))).status).toBe(409);
  writeFileSync(join(agentsDir(), '.cloudsync-default.json'), '{"accounts":');
  expect((await call('GET', '/agent/sync/content-owner')).status).toBe(500);
  expect((await put({ human: true })).status).toBe(500);
  expect(readFileSync(join(agentsDir(), '.cloudsync-default.json'), 'utf8')).toBe('{"accounts":');
});

it('a wrongly typed owner bit is unreadable, never read as "the engine owns human/"', async () => {
  for (const entry of [{ contentOwns: { human: 'true', agents: false } }, { contentOwns: { human: 1 } }, { contentOwns: 'content' }, { owner: 5 }, 'x']) {
    const body = JSON.stringify({ accounts: { [alpha]: entry } });
    writeFileSync(join(agentsDir(), '.cloudsync-default.json'), body);
    expect(() => contentSyncOwnership(alpha), JSON.stringify(entry)).toThrow('malformed');
    expect((await call('GET', '/agent/sync/content-owner')).status).toBe(500);
    expect(readFileSync(join(agentsDir(), '.cloudsync-default.json'), 'utf8')).toBe(body);
  }
});

it('content-touched never writes the owner and mirrors human/ only while content owns it', async () => {
  const file = join(agentsDir(), '.cloudsync-default.json');
  const before = readFileSync(file, 'utf8');
  expect((await call('POST', '/agent/sync/content-touched', {})).status).toBe(200);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(state.mirror).not.toHaveBeenCalled();
  expect((await put({ human: true })).status).toBe(200);
  state.mirror.mockClear();
  const owned = readFileSync(file, 'utf8');
  expect((await call('POST', '/agent/sync/content-touched', {})).status).toBe(200);
  expect(readFileSync(file, 'utf8')).toBe(owned);
  expect(state.mirror).toHaveBeenCalledTimes(1);
});

it('the old body keeps the old file shape and the old answer: owner only, no contentOwns, {ok:true}', async () => {
  const file = join(agentsDir(), '.cloudsync-default.json');
  const on = await put({ enabled: true, expectedAccount: origin + '::alpha' });
  expect(on.status).toBe(200);
  expect(await on.json()).toEqual({ ok: true });
  const entry = JSON.parse(readFileSync(file, 'utf8')).accounts[alpha];
  expect(entry).toMatchObject({ enabled: true, owner: 'content' });
  expect(entry).not.toHaveProperty('contentOwns');
  expect(contentSyncOwnership(alpha)).toEqual({ human: true, agents: true }); // 老文件读作两位
  const off = await put({ enabled: false });
  expect(await off.json()).toEqual({ ok: true });
  const after = JSON.parse(readFileSync(file, 'utf8')).accounts[alpha];
  expect(after).not.toHaveProperty('owner');
  expect(after).not.toHaveProperty('contentOwns');
});

it('a new-body change already on disk is not reported as failed when only the mirror step fails', async () => {
  state.mirror.mockRejectedValueOnce(new Error('mirror down'));
  const r = await put({ human: true });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ ok: true, human: true, agents: false });
  expect(contentSyncOwnership(alpha)).toEqual({ human: true, agents: false });
});
