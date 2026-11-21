/**
 * createMultiAccountApp 的骨架冒烟:身份闸(401 / 400)、白名单外 403、两个账号各一个库、别人的会话 / run id 当不存在、
 * 工作目录钳在账号文件夹里、一轮对话在自己的账号上下文里跑完。串号的系统性用例在 test/multiAccountLeak*。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const env = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-app-'));
  process.env.TANGU_MULTI_ACCOUNT = '1';
  process.env.TANGU_HOME = home;
  delete process.env.TANGU_BUNDLE_DIRS;
  return { home };
});

import { existsSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMultiAccountApp } from './multiAccount.js';

const TOKEN = 'host-secret';
const seenAccounts: Array<string | undefined> = [];
const brain: any = {
  llm: {
    resolveModelAndKey: async () => ({ model: { provider: 'test', context_window: 128000 }, apiKey: '', baseUrl: '', apiModelId: 'test' }),
    buildProviderPayload: async (opts: any) => ({ messages: structuredClone(opts.messages), tools: opts.tools }),
    streamProviderCompletion: async (opts: any) => {
      const { currentAccountId } = await import('../core/accountScope.js');
      seenAccounts.push(currentAccountId());
      opts.onToken?.('hi');
      return { content: 'hi', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  },
  models: { listGlobalModels: async () => [], hasDirectModel: () => false },
};

let server: Server;
let base = '';
let dispose: () => Promise<void>;
let routes: ReadonlyArray<{ method: string; path: string }>;
let tools: ReadonlyArray<string>;

const call = async (method: string, path: string, opts: { as?: string | null; token?: string; body?: unknown } = {}) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token !== '') headers.Authorization = `Bearer ${opts.token ?? TOKEN}`;
  if (opts.as !== null) headers['X-Forsion-User'] = opts.as ?? 'alice';
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

beforeAll(async () => {
  const made = await createMultiAccountApp({ localToken: TOKEN, brain, defaultModelId: 'test-model' });
  dispose = made.dispose;
  routes = made.routeAllowlist;
  tools = made.toolAllowlist;
  server = made.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await dispose();
});

describe('createMultiAccountApp', () => {
  it('exports its allowlists', () => {
    expect(routes.some((r) => r.method === 'POST' && r.path === '/agent/runs')).toBe(true);
    expect(tools).toContain('read_file');
    expect(tools).not.toContain('run_bash');
  });

  it('answers /health without credentials', async () => {
    const r = await call('GET', '/health', { token: '', as: null });
    expect(r.status).toBe(200);
  });

  it('rejects a wrong host credential or a missing account with 401, a malformed id with 400', async () => {
    expect((await call('GET', '/agent/sessions', { token: 'nope' })).status).toBe(401);
    expect((await call('GET', '/agent/sessions', { token: '' })).status).toBe(401);
    expect((await call('GET', '/agent/sessions', { as: null })).status).toBe(401);
    expect((await call('GET', '/agent/sessions', { as: 'Alice' })).status).toBe(400);
    expect((await call('GET', '/agent/sessions', { as: '../bob' })).status).toBe(400);
  });

  it('closes everything outside the route allowlist with 403', async () => {
    for (const [m, p] of [['GET', '/agent/tools'], ['GET', '/agent/models'], ['GET', '/agent/workspace/list?sessionId=x'], ['GET', '/agent/approvals/pending'], ['PUT', '/agent/compaction'], ['GET', '/agent/human/CALENDAR.db'], ['GET', '/agent/plugins'], ['GET', '/agent/nope']]) {
      expect((await call(m, p)).status, `${m} ${p}`).toBe(403);
    }
  });

  it('gives each account its own database file and hides the other account sessions', async () => {
    const a = await call('POST', '/agent/sessions', { as: 'alice', body: { title: 'alice-secret-title' } });
    expect(a.status).toBe(200);
    const sid = a.json.session.id;
    expect(existsSync(join(env.home, 'accounts', 'alice', 'state.db'))).toBe(true);
    const listB = await call('GET', '/agent/sessions', { as: 'bob' });
    expect(listB.status).toBe(200);
    expect(JSON.stringify(listB.json)).not.toContain('alice-secret-title');
    expect(existsSync(join(env.home, 'accounts', 'bob', 'state.db'))).toBe(true);
    for (const p of [`/agent/sessions/${sid}/messages`, `/agent/sessions/${sid}/config`, `/agent/sessions/${sid}/detail`]) {
      expect((await call('GET', p, { as: 'bob' })).status, p).toBe(404);
    }
    // B 拿 A 的会话 id 起 run:当不存在,也不会在 B 的库里建一个同 id 的会话
    expect((await call('POST', '/agent/runs', { as: 'bob', body: { session_id: sid, model_id: 'test-model', message: 'hi' } })).status).toBe(404);
    // 客户端给的新会话 id 必须是 UUID
    for (const bad of ['shared', 'not-a-uuid-0000', 42]) {
      expect((await call('POST', '/agent/runs', { as: 'bob', body: { session_id: bad, model_id: 'test-model', message: 'hi' } })).status, String(bad)).toBe(400);
    }
    // 不新建东西的接口:A 的会话 id 和一个没人用过的 id,B 拿到的状态码和响应体一模一样
    const unknown = '00000000-0000-4000-8000-000000000000';
    const same = async (method: string, path: (id: string) => string, body?: unknown) => {
      const a = await call(method, path(sid), { as: 'bob', body });
      const u = await call(method, path(unknown), { as: 'bob', body });
      expect({ status: a.status, json: a.json }, `${method} ${path(':id')}`).toEqual({ status: u.status, json: u.json });
    };
    await same('GET', (id) => `/agent/runs?session_id=${id}`);
    await same('GET', (id) => `/agent/sessions/${id}/detail`);
    await same('GET', (id) => `/agent/sessions/${id}/messages`);
    await same('GET', (id) => `/agent/sessions/${id}/config`);
    await same('PATCH', (id) => `/agent/sessions/${id}`, { title: 'x' });
    await same('PATCH', (id) => `/agent/sessions/${id}`, { project_path: env.home });
    await same('PUT', (id) => `/agent/sessions/${id}/config`, { cwd: env.home });
    await same('PATCH', (id) => `/agent/sessions/${id}/config`, { approvalMode: 'ask' });
    await same('DELETE', (id) => `/agent/sessions/${id}`);
    // A 的会话还在
    expect((await call('GET', `/agent/sessions/${sid}/detail`, { as: 'alice' })).status).toBe(200);
  });

  it('two accounts racing on one new session id: one gets it, the other a plain 404', async () => {
    const fresh = '11111111-2222-4333-8444-555555555555';
    const [a, b] = await Promise.all(['alice', 'bob'].map((as) =>
      call('POST', '/agent/runs', { as, body: { session_id: fresh, model_id: 'test-model', message: 'race' } })));
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    const winner = a.status === 200 ? a : b;
    const who = a.status === 200 ? 'alice' : 'bob';
    const sse = await fetch(`${base}/agent/runs/${winner.json.runId}/events`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Forsion-User': who } });
    expect(await sse.text()).toMatch(/"type":"done"/);
  });

  it('refuses to open an account whose folder or database is a link to somewhere else', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'ma-elsewhere-'));
    // 账号 home 是软链
    symlinkSync(elsewhere, join(env.home, 'accounts', 'mallory'));
    expect((await call('GET', '/agent/sessions', { as: 'mallory' })).status).toBe(500);
    expect(existsSync(join(elsewhere, 'state.db'))).toBe(false);
    // home 是真目录,state.db 是软链 / 硬链接
    mkdirSync(join(env.home, 'accounts', 'eve'), { recursive: true });
    writeFileSync(join(elsewhere, 'other.db'), '');
    symlinkSync(join(elsewhere, 'other.db'), join(env.home, 'accounts', 'eve', 'state.db'));
    expect((await call('GET', '/agent/sessions', { as: 'eve' })).status).toBe(500);
    mkdirSync(join(env.home, 'accounts', 'trent'), { recursive: true });
    linkSync(join(elsewhere, 'other.db'), join(env.home, 'accounts', 'trent', 'state.db'));
    const r = await call('GET', '/agent/sessions', { as: 'trent' });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.json)).not.toContain(elsewhere); // 路径只进日志
  });

  it('clamps working directories to the account folder', async () => {
    const outside = await call('POST', '/agent/sessions', { as: 'alice', body: { project_path: env.home } });
    expect(outside.status).toBe(400);
    const other = await call('POST', '/agent/sessions', { as: 'alice', body: { agent_config: { cwd: join(env.home, 'accounts', 'bob') } } });
    expect(other.status).toBe(400);
    const own = await call('POST', '/agent/sessions', { as: 'alice', body: { project_path: join(env.home, 'accounts', 'alice', 'workspace', 'p') } });
    expect(own.status).toBe(200);
  });

  it('runs a turn inside the owner account and hides the run from others', async () => {
    seenAccounts.length = 0;
    const s = await call('POST', '/agent/sessions', { as: 'alice', body: { title: 't' } });
    const run = await call('POST', '/agent/runs', { as: 'alice', body: { session_id: s.json.session.id, model_id: 'test-model', message: 'hello' } });
    expect(run.status).toBe(200);
    const runId = run.json.runId;
    expect((await call('GET', `/agent/runs/${runId}/events`, { as: 'bob' })).status).toBe(404);
    expect((await call('POST', `/agent/runs/${runId}/abort`, { as: 'bob' })).status).toBe(404);
    expect((await call('POST', `/agent/runs/${runId}/steer`, { as: 'bob', body: { message: 'x' } })).status).toBe(404);
    // 等它跑完(读 SSE 到 done / error)
    const res = await fetch(`${base}/agent/runs/${runId}/events`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Forsion-User': 'alice' } });
    const text = await res.text();
    expect(text).toMatch(/"type":"done"/);
    expect(seenAccounts.length).toBeGreaterThan(0);
    expect(seenAccounts.every((a) => a === 'alice')).toBe(true);
    const msgs = await call('GET', `/agent/sessions/${s.json.session.id}/messages`, { as: 'alice' });
    expect(JSON.stringify(msgs.json)).toContain('hello');
  });
});
