/**
 * P1 · M1A(K10b openIssues):两条远端 allow 的只读路由对远程来源只回渲染层远端调用点真用得到的字段。
 * 真 express + 真 special / agents 路由 + 临时 TANGU_HOME(Agent 定义经 saveAgent 落盘,与桌面保存同一条路)。
 *   GET /agent/special/muse/status:远端不回 libraryDir / spaceDir(本机绝对路径)、hasModel、次数预算、lastError;
 *     回 MuseView / 自动化详情 / Muse Space 的 ctx.agent.status() 要的字段(对照 remoteMuseStatusView 头注逐个对到调用点)。
 *   GET /agent/agents:远端不回 soul(SOUL.md)与 developer_instructions(systemPrompt 置空串);approvalMode 按远程上限钳
 *     (缺省 auto-edit:full-auto → auto-edit,readonly 原样,未设原样);其余名册字段(聊天面选 Agent / 私聊入口要的)照旧。
 * 本机请求(没有 x-forsion-remote)两条都照旧整份回。
 * 负对照:删掉两条路由里的 `if (parseRemoteOrigin(req.headers))` 分支 → 远端组全红(哨兵串出现在回包里)。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/remoteProjectionRoutes.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import specialRouter from '../src/routes/special.js';
import agentsRouter from '../src/routes/agents.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { saveSpecialAgentsConfig } from '../src/services/specialAgentsConfig.js';

let srv: Server;
let base: string;
let home: string;
const prevHome = process.env.TANGU_HOME;

const SECRET_SOUL = 'M1A-SECRET-SOUL-TEXT';
const SECRET_DI = 'M1A-SECRET-DEVELOPER-INSTRUCTIONS';
const REMOTE = { 'x-forsion-remote': 'tunnel' };

const get = async (p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw: string }> => {
  const r = await fetch(`${base}${p}`, { headers: { Authorization: 'Bearer x', ...headers } });
  const raw = await r.text();
  let body: any = null;
  try { body = JSON.parse(raw); } catch { /* keep raw */ }
  return { status: r.status, body, raw };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-m1a-proj-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  saveSpecialAgentsConfig({ muse: { enabled: true, mode: 'auto', heartbeatMinutes: 45, maxRestartsPerWindow: 9 } } as any);
  await saveAgent({ slug: 'm1a-wide', name: 'Wide', description: 'probe', systemPrompt: SECRET_DI, soul: SECRET_SOUL, approvalMode: 'full-auto' } as any);
  await saveAgent({ slug: 'm1a-tight', name: 'Tight', description: 'probe', systemPrompt: SECRET_DI, soul: SECRET_SOUL, approvalMode: 'readonly' } as any);
  await saveAgent({ slug: 'm1a-unset', name: 'Unset', description: 'probe', systemPrompt: SECRET_DI, soul: SECRET_SOUL } as any);
  const app = express(); app.use(express.json()); app.use(specialRouter); app.use(agentsRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => srv.close(r));
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('GET /agent/special/muse/status', () => {
  it('本机:整份(含 libraryDir / spaceDir / 次数预算)', async () => {
    const r = await get('/agent/special/muse/status');
    expect(r.status).toBe(200);
    expect(r.body.remote).toBeUndefined();
    expect(r.body.status).toMatchObject({ enabled: true, mode: 'auto', heartbeatMinutes: 45, maxRestartsPerWindow: 9 });
    expect(typeof r.body.status.libraryDir).toBe('string');
    expect(typeof r.body.status.spaceDir).toBe('string');
  });
  it('远程:只回渲染层远端调用点读的字段,不带本机绝对路径 / 预算 / lastError', async () => {
    const r = await get('/agent/special/muse/status', REMOTE);
    expect(r.status).toBe(200);
    expect(r.body.remote).toBe(true);
    expect(Object.keys(r.body.status).sort()).toEqual(['enabled', 'heartbeatMinutes', 'lastCycleAt', 'mode', 'pendingApprovals', 'running', 'sessionId', 'sleepReason', 'sleepUntil', 'spaceStamp'].sort());
    expect(r.body.status).toMatchObject({ enabled: true, mode: 'auto', heartbeatMinutes: 45 });
    expect(r.raw).not.toContain(home); // 家目录下的任何绝对路径都不许出现
  });
  it('头值不在契约内也按远程(fail-closed)', async () => {
    const r = await get('/agent/special/muse/status', { 'x-forsion-remote': 'weird' });
    expect(r.body.remote).toBe(true);
    expect(r.body.status.libraryDir).toBeUndefined();
  });
});

describe('GET /agent/agents', () => {
  const byslug = (body: any) => Object.fromEntries((body.agents as any[]).map((a) => [a.slug, a]));
  it('本机:整份定义(人格 / 指令 / 原审批档)', async () => {
    const r = await get('/agent/agents');
    expect(r.status).toBe(200);
    expect(r.body.remote).toBeUndefined();
    const a = byslug(r.body);
    expect(a['m1a-wide']).toMatchObject({ systemPrompt: SECRET_DI, soul: SECRET_SOUL, approvalMode: 'full-auto' });
  });
  it('远程:不回人格与开发指令,审批档按远程上限钳;名册字段照旧', async () => {
    const r = await get('/agent/agents', REMOTE);
    expect(r.status).toBe(200);
    expect(r.body.remote).toBe(true);
    expect(r.raw).not.toContain(SECRET_SOUL);
    expect(r.raw).not.toContain(SECRET_DI);
    const a = byslug(r.body);
    for (const slug of ['m1a-wide', 'm1a-tight', 'm1a-unset']) {
      expect(a[slug].systemPrompt, slug).toBe('');
      expect('soul' in a[slug], slug).toBe(false);
      expect(a[slug]).toMatchObject({ name: expect.any(String), description: 'probe', createdBy: expect.any(String) });
      expect(typeof a[slug].libraryDir, `${slug}:私聊入口靠它`).toBe('string');
    }
    expect(a['m1a-wide'].approvalMode, '完全通行 → 远程上限(缺省 auto-edit)').toBe('auto-edit');
    expect(a['m1a-tight'].approvalMode).toBe('readonly');
    expect(a['m1a-unset'].approvalMode ?? '').toBe('');
    // 本机名册里的每一个 Agent 远端都还在(只是字段收窄)
    const local = await get('/agent/agents');
    expect((r.body.agents as any[]).map((x) => x.slug)).toEqual((local.body.agents as any[]).map((x) => x.slug));
  });
});
