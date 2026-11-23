/**
 * Multi-account leak tests — harness self-check.
 *
 * The multi-account suites (multiAccountLeak*.test.ts) pass when bob finds nothing of alice's. "Nothing found" only
 * means something if the detectors work, so this file points the same helpers at today's single-user engine, where
 * "alice" and "bob" are the same local user and bob *does* see everything: every detector here must fire.
 * Covered: canary scanning (JSON, SSE token deltas split across frames, base64 bodies), outbound recording and
 * marker attribution in the fake model, placeholder extraction from masked outbound requests, route enumeration
 * (nested routers, mount prefixes with params), file-tree diffs, and the child_process spy.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-ma-harness-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  for (const k of ['TANGU_MULTI_ACCOUNT', 'TANGU_DATABASE_URL', 'DATABASE_URL', 'TANGU_EMBED', 'TANGU_DATA_DIR', 'TANGU_BUNDLE_DIRS']) delete process.env[k];
  process.env.TANGU_HOME = home;
  return { root, home };
});

vi.mock('node:child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));
vi.mock('child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));

import express from 'express';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  Client, LOCAL_TOKEN, MODEL_ID, canary, createFakeBrain, diffSnaps, enumerateRoutes, fakeApiKey, findFilesContaining,
  leakHits, respLeaks, runToEnd, snapshotTree, steps, type FakeBrain,
} from './helpers/multiAccountHarness.js';
import { spawnLog, spawnSpyState } from './helpers/multiAccountSpawnSpy.js';

let server: Server;
let client: Client;
let fake: FakeBrain;
let app: any;
const C = {
  title: canary('alice', 'title'),
  memory: canary('alice', 'memory'),
  message: canary('alice', 'message'),
  file: canary('alice', 'file'),
  reply: canary('alice', 'reply'),
  upload: canary('alice', 'upload'),
};
const secret = fakeApiKey();
let sessionA = '';

beforeAll(async () => {
  const { createSqliteHost } = await import('../src/adapters/standalone/sqliteHost.js');
  const { toSqliteDDL } = await import('../src/core/dialectDDL.js');
  const { STANDALONE_SCHEMA } = await import('../src/db/schemaStandalone.js');
  const { createTanguModule } = await import('../src/index.js');
  const { createTanguProfile } = await import('../src/profiles/index.js');
  const { createNoopBilling } = await import('../src/adapters/standalone/noopBilling.js');
  const { createLocalMemoryBrain } = await import('../src/adapters/standalone/localMemoryBrain.js');
  const { createLocalAssets } = await import('../src/adapters/standalone/localAssetsBrain.js');
  const { withOutboundMasking } = await import('../src/llm/outboundMask.js');
  const { host, db } = createSqliteHost({ dataDir: join(env.home, 'state.db'), localToken: LOCAL_TOKEN, userId: 'local' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  fake = createFakeBrain();
  const brain = {
    ...fake.brain,
    llm: withOutboundMasking(fake.brain.llm as any),
    memory: createLocalMemoryBrain({ deviceId: 'harness-device', deviceName: null }),
    assets: createLocalAssets(fake.brain.assets as any, false),
  };
  const mod = createTanguModule({ host, brain: brain as any, billing: createNoopBilling(), profile: createTanguProfile({ sandboxMode: 'none', defaultModelId: MODEL_ID }) });
  await mod.runMigration();
  app = express();
  app.use(express.json({ limit: '25mb' }));
  app.get('/health', (_req: any, res: any) => res.json({ ok: true }));
  app.use('/', mod.userRouter);
  app.use('/', mod.dataRouter);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  client = new Client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}, 60_000);

afterAll(async () => {
  try { (server as any)?.closeAllConnections?.(); } catch { /* ignore */ }
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  try { rmSync(env.root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('multi-account leak harness: detectors fire on the single-user engine', () => {
  it('route enumeration sees nested routers and recovers mount prefixes with params', () => {
    const routes = enumerateRoutes(app);
    const keys = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const k of ['GET /agent/sessions/:id/messages', 'GET /agent/runs/:id/events', 'POST /agent/runs', 'GET /health', 'POST /agent/runs/:runId/inquiries/:inquiryId']) {
      expect(keys.has(k), k).toBe(true);
    }
    const synthetic = express();
    const inner = express.Router();
    inner.get('/a/:id', (_q, r) => r.end());
    const mid = express.Router();
    mid.use('/p/:sid', inner);
    synthetic.use('/pre', mid);
    synthetic.use('/static-ish', (_q: any, r: any) => r.end());
    const syn = enumerateRoutes(synthetic).map((r) => `${r.method} ${r.path}`);
    expect(syn).toContain('GET /pre/p/:sid/a/:id');
    expect(syn).toContain('USE /static-ish');
  });

  it('plants as alice (same local user here)', async () => {
    const s = await client.call('alice', 'POST', '/agent/sessions', { body: { title: C.title, model_id: MODEL_ID } });
    expect(s.status, s.text).toBe(200);
    sessionA = s.json.session.id;
    expect((await client.call('alice', 'POST', '/agent/memory', { body: { text: `Alice note ${C.memory}` } })).status).toBeLessThan(300);
    expect((await client.call('alice', 'POST', '/agent/workspace/upload', { body: { sessionId: sessionA, files: [{ path: 'alice-upload.txt', content: C.upload }] } })).json?.saved).toBe(1);
    const script = fake.script('alice', 'plant', steps([
      { calls: [{ name: 'write_file', args: { path: join(env.home, 'alice-notes.txt'), content: C.file } }] },
    ], `Done ${C.reply}`));
    const r = await runToEnd(client, 'alice', script, { sessionId: sessionA, text: `note ${C.message} key ${secret}`, agentConfig: { execMode: 'host' } });
    expect(r.follow?.status, r.follow?.text.slice(-400)).toBe('done');
    expect(findFilesContaining(env.home, C.file).length, 'write_file landed').toBeGreaterThan(0);

    // outbound is recorded post-mask: the key is gone, a placeholder took its place, the message canary is there
    const outA = script.requests.map((x) => x.text).join('\n');
    expect(outA).toContain(C.message);
    expect(outA).not.toContain(secret);
    expect(outA).toMatch(/\{\{API_KEY_[A-Za-z0-9]{8}\}\}/);
    expect(script.requests.every((x) => x.runAccount === 'alice' && x.main)).toBe(true);

    // the reply canary is split across two token events: only the reassembling scanner sees it in the raw stream
    const tokenFrames = r.follow!.events.filter((e) => e.type === 'token');
    expect(tokenFrames.length).toBeGreaterThanOrEqual(2);
    expect(tokenFrames.some((e) => String(e.payload?.delta).includes(C.reply))).toBe(false);
    const onlyTokens = tokenFrames.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n');
    expect(onlyTokens.includes(C.reply)).toBe(false);
    expect(leakHits(onlyTokens, [C.reply])).toEqual([C.reply]);
  }, 90_000);

  it('bob reads alice through HTTP: the scanners report every canary', async () => {
    const sessions = await client.call('bob', 'GET', '/agent/sessions');
    expect(respLeaks(sessions, [C.title])).toEqual([C.title]);
    const memory = await client.call('bob', 'GET', '/agent/memory');
    expect(respLeaks(memory, [C.memory])).toEqual([C.memory]);
    const messages = await client.call('bob', 'GET', `/agent/sessions/${sessionA}/messages`);
    expect(respLeaks(messages, [C.message, C.reply]).sort()).toEqual([C.message, C.reply].sort());
    // base64 body: invisible to a plain substring search, found by the scanner
    const read = await client.call('bob', 'GET', '/agent/workspace/read', { query: { sessionId: sessionA, path: 'alice-upload.txt' } });
    expect(read.status, read.text).toBe(200);
    expect(read.text.includes(C.upload)).toBe(false);
    expect(respLeaks(read, [C.upload])).toEqual([C.upload]);
  }, 60_000);

  it("bob's run reads alice's file: the fake model records it in bob's outbound request", async () => {
    const file = findFilesContaining(env.home, C.file)[0];
    const script = fake.script('bob', 'probe', steps([{ calls: [{ name: 'read_file', args: { path: file } }] }], 'ok'));
    const r = await runToEnd(client, 'bob', script, { text: 'read it', agentConfig: { execMode: 'host' } });
    expect(r.follow?.status, r.follow?.text.slice(-600)).toBe('done');
    const bobOut = fake.outbound.filter((x) => x.runAccount === 'bob');
    expect(bobOut.length).toBeGreaterThan(0);
    // the single-user engine also pulls alice's earlier conversation into bob's request: marker attribution alone
    // would have credited this request to alice — runs are attributed by runId instead
    expect(bobOut.every((x) => x.runId === r.runId)).toBe(true);
    expect(bobOut.some((x) => x.markerAccounts.includes('alice')), "alice's marker inside bob's request").toBe(true);
    expect(bobOut.some((x) => leakHits(x.text, [C.message]).length > 0), "alice's message (recalled context) in bob's request").toBe(true);
    expect(bobOut.some((x) => leakHits(x.text, [C.memory]).length > 0), "alice's memory in bob's system prompt").toBe(true);
    expect(bobOut.some((x) => leakHits(x.text, [C.file]).length > 0), 'leak visible in outbound').toBe(true);
    expect(script.results.find((x) => x.name === 'read_file')?.output).toContain(C.file);
  }, 90_000);

  it('file-tree diffs and the child_process spy work', async () => {
    const before = snapshotTree(env.root);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(env.home, 'diff-probe.txt'), 'x');
    expect(diffSnaps(before, snapshotTree(env.root)).added).toContain('home/diff-probe.txt');
    const cp = await import('node:child_process');
    spawnSpyState().tag = 'harness-probe';
    cp.execFileSync(process.execPath, ['-e', '0']);
    spawnSpyState().tag = undefined;
    expect(spawnLog().some((x) => x.tag === 'harness-probe' && x.fn === 'execFileSync')).toBe(true);
  });
});
