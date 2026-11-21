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

import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { createMultiAccountApp } from './multiAccount.js';

const TOKEN = 'host-secret';
const seenAccounts: Array<string | undefined> = [];
let holdRun: Promise<void> | null = null; // 用户消息带 HOLD_RUN 的那轮模型调用等它
const brain: any = {
  llm: {
    resolveModelAndKey: async () => ({ model: { provider: 'test', context_window: 128000 }, apiKey: '', baseUrl: '', apiModelId: 'test' }),
    buildProviderPayload: async (opts: any) => ({ messages: structuredClone(opts.messages), tools: opts.tools }),
    streamProviderCompletion: async (opts: any) => {
      const { currentAccountId } = await import('../core/accountScope.js');
      seenAccounts.push(currentAccountId());
      // 脚本:用户消息里带 CALL_FORBIDDEN_TOOL 的那轮,第一次先叫一个白名单外的工具
      const msgs: any[] = Array.isArray(opts.payload?.messages) ? opts.payload.messages : [];
      if (holdRun && JSON.stringify(msgs).includes('HOLD_RUN')) await holdRun;
      if (JSON.stringify(msgs).includes('CALL_FORBIDDEN_TOOL') && !msgs.some((m) => m?.role === 'tool')) {
        return { content: '', reasoning: '', toolCalls: [{ id: 'call_forbidden_0', type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command: 'echo forbidden' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'tool_calls' };
      }
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

  it('decides the allowlist on the raw method before reading the body or opening the account', async () => {
    const hdr = { Authorization: `Bearer ${TOKEN}`, 'X-Forsion-User': 'frank', 'Content-Type': 'application/json' };
    // HEAD 不当 GET、OPTIONS 不自动应答
    expect((await fetch(`${base}/agent/sessions`, { method: 'HEAD', headers: hdr })).status).toBe(403);
    expect((await fetch(`${base}/agent/sessions`, { method: 'OPTIONS', headers: hdr })).status).toBe(403);
    // 名单外的路径:坏 JSON 也是 403(没解析请求体),也没给 frank 开户
    expect((await fetch(`${base}/agent/tools`, { method: 'POST', headers: hdr, body: '{not json' })).status).toBe(403);
    expect((await fetch(`${base}/agent/sessions/x/nope`, { method: 'GET', headers: hdr })).status).toBe(403);
    expect(existsSync(join(env.home, 'accounts', 'frank'))).toBe(false);
    // 名单里的照常
    expect((await fetch(`${base}/agent/sessions`, { headers: hdr })).status).toBe(200);
    expect(existsSync(join(env.home, 'accounts', 'frank', 'state.db'))).toBe(true);
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

  it('refuses to queue a run on a session id registered to another account, whatever path queues it', async () => {
    const { enqueueRun, isRunLive } = await import('../services/agentLoop.js');
    const { claimSessionForCurrentAccount, runWithAccount } = await import('../core/accountScope.js');
    const aliceSid = (await call('POST', '/agent/sessions', { as: 'alice', body: { title: 'queue-owner' } })).json.session.id as string;
    expect(() => runWithAccount('bob', () => enqueueRun(aliceSid, 'run-from-another-account'))).toThrow(/another account/);
    expect(isRunLive('run-from-another-account')).toBe(false);
    expect(() => enqueueRun(aliceSid, 'run-without-account')).toThrow(/no account in context/);
    // 没登记过的 id:入队前当场替当前账号认领,之后别的账号拿它就是 404
    const fresh = '44444444-5555-4666-8777-888888888888';
    expect(runWithAccount('bob', () => claimSessionForCurrentAccount(fresh))).toBe(true);
    expect(runWithAccount('alice', () => claimSessionForCurrentAccount(fresh))).toBe(false);
    expect((await call('POST', '/agent/runs', { as: 'alice', body: { session_id: fresh, model_id: 'test-model', message: 'x' } })).status).toBe(404);
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

  it('registers the session ids already in an account database when the account is opened', async () => {
    const taken = (await call('POST', '/agent/sessions', { as: 'alice', body: { title: 'alice-owned' } })).json.session.id as string;
    const mine = '22222222-3333-4444-8555-666666666666';
    const dir = join(env.home, 'accounts', 'dave');
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, 'state.db'));
    db.exec(toSqliteDDL(STANDALONE_SCHEMA));
    const ins = db.prepare(`INSERT INTO chat_sessions (id, user_id, title) VALUES (?, 'dave', ?)`);
    ins.run(mine, 'dave-old');
    ins.run(taken, 'dave-copy-of-a-taken-id');
    db.close();
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    try {
      expect((await call('GET', '/agent/sessions', { as: 'dave' })).status).toBe(200);
    } finally { spy.mockRestore(); }
    // 自己库里的 id 补登给了 dave:别人拿它起 run 是 404
    expect((await call('POST', '/agent/runs', { as: 'bob', body: { session_id: mine, model_id: 'test-model', message: 'x' } })).status).toBe(404);
    // 已是 alice 的那个:登记不动、开户不断,日志写清是哪个 id
    expect(errors.some((e) => e.includes(taken) && e.includes('dave'))).toBe(true);
    expect((await call('GET', `/agent/sessions/${taken}/detail`, { as: 'alice' })).status).toBe(200);
    expect((await call('POST', '/agent/runs', { as: 'dave', body: { session_id: taken, model_id: 'test-model', message: 'x' } })).status).toBe(404);
  });

  it('marks runs left queued or running by the previous engine as failed when the account is opened, without re-running them', async () => {
    const dir = join(env.home, 'accounts', 'erin');
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, 'state.db'));
    db.exec(toSqliteDDL(STANDALONE_SCHEMA));
    db.exec(`CREATE TABLE agent_runs (id VARCHAR(36) PRIMARY KEY, session_id VARCHAR(36) NOT NULL, user_id VARCHAR(36) NOT NULL,
      app_id VARCHAR(50) NOT NULL DEFAULT 'ai-studio', status VARCHAR(16) NOT NULL DEFAULT 'queued', current_step INTEGER NOT NULL DEFAULT 0,
      model_id VARCHAR(128), sandbox_id VARCHAR(36), assistant_message_id VARCHAR(36), input JSONB, result JSONB, error TEXT,
      tokens_total INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    const sid = '33333333-4444-4555-8666-777777777777';
    db.prepare(`INSERT INTO chat_sessions (id, user_id, title) VALUES (?, 'erin', 't')`).run(sid);
    const run = db.prepare(`INSERT INTO agent_runs (id, session_id, user_id, status, model_id) VALUES (?, ?, 'erin', ?, 'test-model')`);
    run.run('run-q', sid, 'queued'); run.run('run-r', sid, 'running'); run.run('run-d', sid, 'completed');
    db.close();
    const before = seenAccounts.length;
    expect((await call('GET', '/agent/sessions', { as: 'erin' })).status).toBe(200);
    const after = new Database(join(dir, 'state.db'), { readonly: true });
    const rows = Object.fromEntries((after.prepare('SELECT id, status, error FROM agent_runs').all() as any[]).map((r) => [r.id, [r.status, r.error]]));
    after.close();
    expect(rows).toEqual({ 'run-q': ['failed', 'engine restarted'], 'run-r': ['failed', 'engine restarted'], 'run-d': ['completed', null] });
    const listed = (await call('GET', `/agent/runs?session_id=${sid}`, { as: 'erin' })).json.runs as Array<{ status: string }>;
    expect(listed.filter((r) => r.status === 'queued' || r.status === 'running')).toEqual([]);
    expect(seenAccounts.length).toBe(before); // 没有重新入队去调模型
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

  it('honours the remote lock like single-user standalone: remote writes 423, reads pass', async () => {
    const lockFile = join(mkdtempSync(join(tmpdir(), 'ma-lock-')), 'remote-lock.json');
    writeFileSync(lockFile, JSON.stringify({ v: 1, lock: { locked: true, at: Date.now() } }));
    const prev = process.env.FORSION_REMOTE_LOCK_FILE;
    process.env.FORSION_REMOTE_LOCK_FILE = lockFile;
    try {
      const remote = { 'X-Forsion-Remote': 'tunnel' };
      const hdr = { Authorization: `Bearer ${TOKEN}`, 'X-Forsion-User': 'alice', 'Content-Type': 'application/json', ...remote };
      const w = await fetch(`${base}/agent/sessions`, { method: 'POST', headers: hdr, body: JSON.stringify({ title: 'remote' }) });
      expect(w.status).toBe(423);
      const r = await fetch(`${base}/agent/sessions`, { headers: hdr });
      expect(r.status).toBe(200);
      // 本机来的(没有远程头)不受影响
      expect((await call('POST', '/agent/sessions', { as: 'alice', body: { title: 'local' } })).status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.FORSION_REMOTE_LOCK_FILE; else process.env.FORSION_REMOTE_LOCK_FILE = prev;
    }
  });

  it('refuses a turn whose default workspace is a link out of the account, and reads no project docs outside it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ma-ws-out-'));
    mkdirSync(join(outside, '.git'));
    writeFileSync(join(outside, 'AGENTS.md'), 'OUTSIDE_PROJECT_DOC');
    expect((await call('GET', '/agent/sessions', { as: 'gina' })).status).toBe(200); // 开户(建 workspace)
    const ws = join(env.home, 'accounts', 'gina', 'workspace');
    rmSync(ws, { recursive: true, force: true });
    symlinkSync(outside, ws);
    const sid = (await call('POST', '/agent/sessions', { as: 'gina', body: { title: 'ws' } })).json.session.id as string;
    seenAccounts.length = 0;
    const run = await call('POST', '/agent/runs', { as: 'gina', body: { session_id: sid, model_id: 'test-model', message: 'hi' } });
    expect(run.status).toBe(200);
    const sse = await (await fetch(`${base}/agent/runs/${run.json.runId}/events`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Forsion-User': 'gina' } })).text();
    expect(sse).not.toMatch(/"type":"done"/);
    expect(sse).toMatch(/outside your account folder|you can only write inside your account folder/);
    expect(seenAccounts).toEqual([]); // 没走到模型调用
    // 项目文档的入口:账号域外的目录(含经软链指出去的)一律不读
    const { projectDocPaths } = await import('../services/projectDoc.js');
    const { runWithAccount } = await import('../core/accountScope.js');
    expect(runWithAccount('gina', () => projectDocPaths(ws))).toEqual([]);
    expect(runWithAccount('gina', () => projectDocPaths(outside))).toEqual([]);
    const inside = join(env.home, 'accounts', 'gina', 'proj');
    mkdirSync(join(inside, '.git'), { recursive: true });
    writeFileSync(join(inside, 'AGENTS.md'), 'INSIDE');
    expect(runWithAccount('gina', () => projectDocPaths(inside))).toEqual([join(inside, 'AGENTS.md')]);
  });

  it('seeds plugin package personas without following links, and refuses package folders that overlap the accounts', async () => {
    const { assertBundleDirsOutsideAccounts, setMultiAccountBundleDirs } = await import('../plugins/bundles.js');
    const secret = join(mkdtempSync(join(tmpdir(), 'ma-secret-')), 'secret.txt');
    writeFileSync(secret, 'PACKAGE_LINK_TARGET');
    const pkg = mkdtempSync(join(tmpdir(), 'ma-pkg-'));
    writeFileSync(join(pkg, 'manifest.json'), JSON.stringify({ id: 'ma-test-pkg' }));
    const agentSrc = join(pkg, 'agents', 'pkg-persona');
    mkdirSync(join(agentSrc, 'skills', 'pkg-skill'), { recursive: true });
    writeFileSync(join(agentSrc, 'config.toml'), 'name = "Pkg persona"\n');
    writeFileSync(join(agentSrc, 'skills', 'pkg-skill', 'SKILL.md'), '---\nname: pkg-skill\ndescription: d\n---\nbody\n');
    symlinkSync(secret, join(agentSrc, 'linked.txt'));
    symlinkSync(secret, join(agentSrc, 'skills', 'pkg-skill', 'linked.md'));
    try {
      setMultiAccountBundleDirs([pkg]);
      expect((await call('GET', '/agent/sessions', { as: 'hank' })).status).toBe(200); // 开户时播种
      const seeded = join(env.home, 'accounts', 'hank', 'agents', 'pkg-persona');
      expect(existsSync(join(seeded, 'config.toml'))).toBe(true);
      expect(existsSync(join(seeded, 'linked.txt'))).toBe(false);
      expect(existsSync(join(seeded, 'skills', 'pkg-skill', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(seeded, 'skills', 'pkg-skill', 'linked.md'))).toBe(false);
      // 包目录与账号文件夹重叠:装配时抛;运行期也不当只读根
      const inside = join(env.home, 'accounts', 'hank', 'pkg');
      mkdirSync(inside, { recursive: true });
      writeFileSync(join(inside, 'manifest.json'), '{}');
      writeFileSync(join(env.home, 'manifest.json'), '{}'); // 引擎根当插件包目录(它包着 accounts/)
      for (const bad of [inside, env.home]) {
        setMultiAccountBundleDirs([bad]);
        expect(() => assertBundleDirsOutsideAccounts()).toThrow(/must not overlap/);
        await expect(createMultiAccountApp({ localToken: TOKEN, brain, bundleDirs: [bad] })).rejects.toThrow(/must not overlap/);
      }
      const { bundleDirs } = await import('../plugins/bundles.js');
      setMultiAccountBundleDirs([inside, pkg]);
      expect(bundleDirs()).toEqual([pkg]);
    } finally {
      setMultiAccountBundleDirs(null);
      rmSync(join(env.home, 'manifest.json'), { force: true });
    }
  });

  it('skips linked entries when listing an account skills and agents, and refuses writes through links', async () => {
    expect((await call('GET', '/agent/sessions', { as: 'ivy' })).status).toBe(200); // 开户
    const acc = join(env.home, 'accounts', 'ivy');
    const out = mkdtempSync(join(tmpdir(), 'ma-links-'));
    // 技能:整个文件夹是软链 / SKILL.md 是软链
    mkdirSync(join(out, 'sk'), { recursive: true });
    writeFileSync(join(out, 'sk', 'SKILL.md'), '---\nname: outside-skill\ndescription: OUTSIDE_SKILL\n---\nbody\n');
    mkdirSync(join(acc, 'skills'), { recursive: true });
    symlinkSync(join(out, 'sk'), join(acc, 'skills', 'linked-skill'));
    mkdirSync(join(acc, 'skills', 'half-skill'), { recursive: true });
    symlinkSync(join(out, 'sk', 'SKILL.md'), join(acc, 'skills', 'half-skill', 'SKILL.md'));
    // Agent:整个文件夹是软链 / config.toml 是软链
    mkdirSync(join(out, 'ag'), { recursive: true });
    writeFileSync(join(out, 'ag', 'config.toml'), 'name = "OUTSIDE_AGENT"\n');
    expect((await call('GET', '/agent/agents', { as: 'ivy' })).status).toBe(200); // 建出 agents/
    symlinkSync(join(out, 'ag'), join(acc, 'agents', 'linked-agent'));
    mkdirSync(join(acc, 'agents', 'half-agent'), { recursive: true });
    symlinkSync(join(out, 'ag', 'config.toml'), join(acc, 'agents', 'half-agent', 'config.toml'));
    const skills = JSON.stringify((await call('GET', '/agent/skills', { as: 'ivy' })).json);
    expect(skills).not.toContain('OUTSIDE_SKILL');
    expect(skills).not.toContain('linked-skill');
    expect(skills).not.toContain('half-skill');
    const agents = JSON.stringify((await call('GET', '/agent/agents', { as: 'ivy' })).json);
    expect(agents).not.toContain('OUTSIDE_AGENT');
    expect(agents).not.toContain('linked-agent');
    expect(agents).not.toContain('half-agent');
    // 写入:目标已存在且是软链 → 拒
    const { runWithAccount } = await import('../core/accountScope.js');
    const { saveAgent } = await import('../agents/agentRegistry.js');
    await expect(runWithAccount('ivy', () => saveAgent({ slug: 'half-agent', name: 'Half', systemPrompt: 'p' } as any))).rejects.toThrow(/symbolic link/);
    const { manageSkillProvider } = await import('../tools/builtin/manageSkill.js');
    const tool = (manageSkillProvider.tools as any)().find((t: any) => t.name === 'manage_skill');
    const r = await runWithAccount('ivy', () => tool.execute({ action: 'update', slug: 'half-skill', instructions: 'NEW BODY' }, {}));
    expect(String(r)).toMatch(/symbolic link/);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(out, 'sk', 'SKILL.md'), 'utf8')).not.toContain('NEW BODY');
    expect(readFileSync(join(out, 'ag', 'config.toml'), 'utf8')).toBe('name = "OUTSIDE_AGENT"\n');
  });

  it('list_dir reports links as links, without the metadata of what they point to', async () => {
    const acc = join(env.home, 'accounts', 'ivy');
    const out = mkdtempSync(join(tmpdir(), 'ma-ls-'));
    writeFileSync(join(out, 'big.bin'), Buffer.alloc(4321));
    const d = join(acc, 'workspace', 'ls');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'own.txt'), 'abc');
    symlinkSync(join(out, 'big.bin'), join(d, 'pointer.bin'));
    const { HOST_TOOLS } = await import('../tools/hostExec.js');
    const { runWithAccount } = await import('../core/accountScope.js');
    const listing = String(await runWithAccount('ivy', () => HOST_TOOLS.list_dir.execute({ path: d }, { cwd: d } as any)));
    expect(listing).toContain('[file] own.txt (3 bytes)');
    expect(listing).toContain('[link] pointer.bin');
    expect(listing).not.toContain('4321');
  });

  it('refuses a tool outside the allowlist before approval: no approval card, the session is not held', async () => {
    const s = await call('POST', '/agent/sessions', { as: 'alice', body: { title: 'forbidden-tool' } });
    const run = await call('POST', '/agent/runs', { as: 'alice', body: { session_id: s.json.session.id, model_id: 'test-model', message: 'CALL_FORBIDDEN_TOOL', agent_config: { approvalMode: 'ask' } } });
    expect(run.status).toBe(200);
    const sse = await (await fetch(`${base}/agent/runs/${run.json.runId}/events`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Forsion-User': 'alice' } })).text();
    expect(sse).toMatch(/not available in multi-account mode/);
    expect(sse).not.toMatch(/"type":"approval/);
    expect(sse).toMatch(/"type":"done"/);
  });

  it('forgets the owner of a run cancelled while queued, through the same delayed cleanup as started runs', async () => {
    const { __runOwnerForTests } = await import('../services/agentLoop.js');
    let release!: () => void;
    holdRun = new Promise<void>((r) => { release = r; });
    const sid = (await call('POST', '/agent/sessions', { as: 'alice', body: { title: 'queue-cancel' } })).json.session.id as string;
    const a = (await call('POST', '/agent/runs', { as: 'alice', body: { session_id: sid, model_id: 'test-model', message: 'HOLD_RUN first' } })).json.runId as string;
    const b = (await call('POST', '/agent/runs', { as: 'alice', body: { session_id: sid, model_id: 'test-model', message: 'second' } })).json.runId as string;
    expect(__runOwnerForTests(b)).toBe('alice');
    const timers: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 30_000) timers.push(fn);
      return (realSetTimeout as any)(fn, ms, ...rest);
    }) as any);
    try {
      expect((await call('POST', `/agent/runs/${b}/abort`, { as: 'alice' })).status).toBe(200);
      for (let i = 0; i < 50 && !timers.length; i++) await new Promise((r) => realSetTimeout(r, 20));
    } finally { spy.mockRestore(); }
    expect(timers.length).toBeGreaterThan(0);
    for (const fn of timers) fn(); // 保留期到了
    expect(__runOwnerForTests(b)).toBeUndefined();
    expect(__runOwnerForTests(a)).toBe('alice'); // 还在跑的那条不动
    release(); holdRun = null;
    const sse = await (await fetch(`${base}/agent/runs/${a}/events`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Forsion-User': 'alice' } })).text();
    expect(sse).toMatch(/"type":"done"/);
  });

  it('keys the agent write lock by account and slug', async () => {
    const { agentLockKey } = await import('../agents/agentRegistry.js');
    const { runWithAccount } = await import('../core/accountScope.js');
    const a = runWithAccount('alice', () => agentLockKey('xyra'));
    const b = runWithAccount('bob', () => agentLockKey('xyra'));
    expect(a).not.toBe(b);
    expect(a).toContain('alice');
    expect(runWithAccount('alice', () => agentLockKey('xyra'))).toBe(a);
    expect(() => agentLockKey('xyra')).toThrow(/no account in context/);
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
