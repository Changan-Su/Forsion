/**
 * 私聊(Agent 轨道)端点集成测试(新工作区 × 轨道体系 P2):真 SQLite(内存)+ 真 express。
 * 钉的是:open 幂等(先查后建、第二次拿同一条);会话形状 = kind user + projectless + agent_config{soloAgentSlug|soloEngineId, execMode host, cwd Library, preset null};
 * rotate:活动 run → 409;否则归档旧会话、建新会话;Agent 私聊 memory ∈ queued/skipped,引擎私聊 memory=none 且 cwd=engineLibDir;
 * 未知 agent / 引擎 404;非 host 形态 404;返回的 agent_config 能过 validSessionFacts。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile, createAiStudioProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { saveAgent, libDirOf } from '../src/agents/agentRegistry.js';
import { engineLibDir } from '../src/core/tanguHome.js';
import { validSessionFacts } from '../src/routes/sessions.js';
import soloRouter from '../src/routes/solo.js';

const USER = 'u1';
let srv: Server;
let base: string;
let home: string;
const engines: any = {
  has: (id: string) => id === 'codex',
  list: () => [{ id: 'codex', name: 'Codex', available: true, status: 'available' }],
};
const post = async (path: string): Promise<any> => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: '{}' });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const row = async (id: string): Promise<any> => (await query<any[]>(`SELECT * FROM chat_sessions WHERE id = ?`, [id]))[0];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-solo-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }), engines });
  await runMigration();
  await saveAgent({ slug: 'ario', name: 'Tangu Ario', description: 'x', systemPrompt: 'You are Ario.' });
  const app = express();
  app.use(express.json());
  app.use(soloRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => srv.close(r));
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('POST /agent/solo/:kind/:id/open', () => {
  it('Agent:首次建会话(形状 §5.1,Library 目录已建),第二次拿同一条', async () => {
    const a = await post('/agent/solo/agent/ario/open');
    expect(a.status).toBe(200);
    expect(a.body.created).toBe(true);
    const s = a.body.session;
    expect(s.projectless).toBe(true);
    expect(s.title).toBe('Tangu Ario');
    expect(s.agent_config).toEqual({ soloAgentSlug: 'ario', agentSlug: 'ario', execMode: 'host', cwd: libDirOf('ario'), preset: null });
    expect(validSessionFacts(s.agent_config)).toBeNull();
    expect(existsSync(libDirOf('ario'))).toBe(true);
    expect((await row(s.id)).kind).toBe('user');
    const b = await post('/agent/solo/agent/ario/open');
    expect(b.body.created).toBe(false);
    expect(b.body.session.id).toBe(s.id);
  });

  it('引擎:视作特殊独立 Agent,cwd = engines/<id>/Library,agent_config 带 soloEngineId + engineId', async () => {
    const a = await post('/agent/solo/engine/codex/open');
    expect(a.status).toBe(200);
    expect(a.body.session.agent_config).toEqual({ soloEngineId: 'codex', engineId: 'codex', execMode: 'host', cwd: engineLibDir('codex'), preset: null });
    expect(a.body.session.title).toBe('Codex');
    expect(existsSync(engineLibDir('codex'))).toBe(true);
  });

  it('未知 agent / 未注册引擎 / 非法 kind → 404', async () => {
    expect((await post('/agent/solo/agent/nope/open')).status).toBe(404);
    expect((await post('/agent/solo/engine/claude/open')).status).toBe(404);
    expect((await post('/agent/solo/team/ario/open')).status).toBe(404);
    expect((await post('/agent/solo/agent/..%2Fetc/open')).status).toBe(404);
  });
});

describe('POST /agent/solo/:kind/:id/rotate', () => {
  it('旧会话有排队/运行中的 run → 409 run_active,不归档不建新', async () => {
    const cur = (await post('/agent/solo/agent/ario/open')).body.session;
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES ('r1', ?, ?, 'running', '{}')`, [cur.id, USER]);
    const r = await post('/agent/solo/agent/ario/rotate');
    expect(r.status).toBe(409);
    expect(r.body.detail).toBe('run_active');
    expect((await row(cur.id)).archived).toBeFalsy();
    await query(`UPDATE agent_runs SET status = 'done' WHERE id = 'r1'`);
  });

  it('Agent:归档旧会话、建新会话(同形状、不同 id),memory 为 queued 或 skipped;之后 open 拿到的是新会话', async () => {
    const cur = (await post('/agent/solo/agent/ario/open')).body.session;
    const r = await post('/agent/solo/agent/ario/rotate');
    expect(r.status).toBe(200);
    expect(['queued', 'skipped']).toContain(r.body.memory);
    expect(r.body.session.id).not.toBe(cur.id);
    expect(r.body.session.agent_config.soloAgentSlug).toBe('ario');
    expect(!!(await row(cur.id)).archived).toBe(true);
    expect(!!(await row(r.body.session.id)).archived).toBe(false);
    expect((await post('/agent/solo/agent/ario/open')).body.session.id).toBe(r.body.session.id);
  });

  it('引擎:没有 Tangu 记忆 → memory=none,仍归档 + 建新', async () => {
    const cur = (await post('/agent/solo/engine/codex/open')).body.session;
    const r = await post('/agent/solo/engine/codex/rotate');
    expect(r.status).toBe(200);
    expect(r.body.memory).toBe('none');
    expect(r.body.session.id).not.toBe(cur.id);
    expect(!!(await row(cur.id)).archived).toBe(true);
  });

  it('没有活动会话时 rotate 直接建一条(memory=none)', async () => {
    await query(`UPDATE chat_sessions SET archived = 1`);
    const r = await post('/agent/solo/agent/ario/rotate');
    expect(r.status).toBe(200);
    expect(r.body.memory).toBe('none');
  });
});

describe('非 host 形态', () => {
  it('云端 profile(hostExec=false)→ 404', async () => {
    const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
    db.exec(toSqliteDDL(STANDALONE_SCHEMA));
    configureTangu({ host, brain: {} as any, billing: {} as any, profile: createAiStudioProfile() });
    expect((await post('/agent/solo/agent/ario/open')).status).toBe(404);
    configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }), engines });
  });
});
