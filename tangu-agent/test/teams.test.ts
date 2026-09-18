/**
 * 独立团队(Agent 轨道的持久团队实体,新工作区 × 轨道体系 P5c):
 * 注册表 —— config.toml 解析/序列化往返(数组表尾置、旧 mode/max_rounds 键忽略、去重、lead 兜底)、buildTeamDef 校验(≥2 成员)、列表顺序按 .meta.json;
 * 路由 —— CRUD、POST slug 唯一化、name 可省(缺省 = 成员名相连)、中文名 slug 兜底、session/open 幂等与形状(teamSlug + groupAgents + cwd=团队 Library,无模式/轮数字段)、云端 404;
 * loop —— 存值 teamSlug 的会话:run 不带 groupAgents 也按成员表进群聊分叉,TEAM.md 与 role 进每位成员 system。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile, createAiStudioProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { parseTeamConfig, serializeTeamConfig, buildTeamDef, listTeams, saveTeam, writeTeamsMeta, teamLibDirOf } from '../src/agents/teamRegistry.js';
import { PROJECT_ROOT_MARKERS } from '../src/services/projectDoc.js';
import { validSessionFacts } from '../src/routes/sessions.js';
import teamsRouter from '../src/routes/teams.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';

describe('teamRegistry(纯函数)', () => {
  it('解析:旧 mode / max_rounds 键被忽略(不再有运行模式与轮数);成员去重 + 非法 slug 剔除;lead 不在成员表 → 第一位;TEAM.md 截 16KB', () => {
    const toml = `name = "Team abc"\nmode = "chaos"\nmax_rounds = 99\nlead = "nobody"\n[[members]]\nslug = "ario"\nrole = "Architect"\n[[members]]\nslug = "ario"\n[[members]]\nslug = "Bad Slug"\n[[members]]\nslug = "bo"\n`;
    const def = parseTeamConfig('abc', toml, 'x'.repeat(20000));
    expect(def).toMatchObject({ slug: 'abc', name: 'Team abc', lead: 'ario', members: [{ slug: 'ario', role: 'Architect' }, { slug: 'bo', role: '' }] });
    expect('mode' in def).toBe(false);
    expect('maxRounds' in def).toBe(false);
    expect(def.doc.length).toBe(16 * 1024);
    expect(def.libraryDir).toBe(teamLibDirOf('abc'));
  });
  it('序列化:标量在前、[[members]] 尾置,往返不丢', () => {
    const def = buildTeamDef('abc', null, { name: 'Team abc', lead: 'bo', avatar: '🛰️', members: [{ slug: 'ario', role: 'API' }, { slug: 'bo' }], doc: '# T' });
    const toml = serializeTeamConfig(def);
    expect(toml.indexOf('[[members]]')).toBeGreaterThan(toml.indexOf('created_at'));
    expect(toml.lastIndexOf('created_at')).toBeLessThan(toml.indexOf('[[members]]'));
    expect(toml).not.toMatch(/max_rounds|^mode/m);
    const back = parseTeamConfig('abc', toml, '# T');
    expect(back).toMatchObject({ name: 'Team abc', lead: 'bo', avatar: '🛰️', members: [{ slug: 'ario', role: 'API' }, { slug: 'bo', role: '' }], doc: '# T' });
  });
  it('buildTeamDef:少于 2 名有效成员 / 无名 / 非法 slug 抛错;members 未传保留既有', () => {
    expect(() => buildTeamDef('t', null, { name: 'T', members: [{ slug: 'a' }] })).toThrow(/2 members/);
    expect(() => buildTeamDef('t', null, { name: '', members: [{ slug: 'a' }, { slug: 'b' }] })).toThrow(/name/);
    expect(() => buildTeamDef('Bad Slug', null, { name: 'T', members: [{ slug: 'a' }, { slug: 'b' }] })).toThrow(/slug/);
    const ex = buildTeamDef('t', null, { name: 'T', members: [{ slug: 'a' }, { slug: 'b' }], lead: 'b' });
    expect(buildTeamDef('t', ex, { name: 'T2' })).toMatchObject({ name: 'T2', lead: 'b', members: ex.members });
  });
  it("'teams' / .tangu / .forsion 绝不进 PROJECT_ROOT_MARKERS(负对照)", () => {
    for (const m of ['teams', '.tangu', '.forsion']) expect((PROJECT_ROOT_MARKERS as readonly string[]).includes(m)).toBe(false);
  });
});

const USER = 'u1';
let srv: Server;
let base: string;
let home: string;
const call = async (method: string, path: string, body?: any): Promise<any> => {
  const r = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let llmPayloads: any[] = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-teams-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools, toolChoice: o.toolChoice, cacheKey: o.cacheKey }),
    streamProviderCompletion: async (o: any) => {
      llmPayloads.push(o.payload);
      const usage = { prompt_tokens: 5, completion_tokens: 5 };
      return { content: 'ok\nDONE', reasoning: '', toolCalls: [], usage, finishReason: 'stop' };
    },
  };
  const fakeBrain: any = { llm: fakeLlm, users: { getUserById: async () => ({ id: USER, username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false } };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await saveAgent({ slug: 'ario', name: 'Ario', description: 'x', systemPrompt: 'You are Ario.' });
  await saveAgent({ slug: 'bo', name: 'Bo', description: 'x', systemPrompt: 'You are Bo.' });
  const app = express();
  app.use(express.json());
  app.use(teamsRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => srv.close(r));
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('routes /agent/teams', () => {
  it('POST 建团队(落盘 config.toml + TEAM.md + Library/)、同名再建 slug 递增、GET 列表按 .meta.json 顺序、PATCH 逐字段、DELETE', async () => {
    const a = await call('POST', '/agent/teams', { name: 'Team abc', members: [{ slug: 'ario', role: 'API' }, { slug: 'bo' }], doc: '# Team abc\nAlpha owns API.' });
    expect(a.status).toBe(200);
    expect(a.body.team).toMatchObject({ slug: 'team-abc', members: [{ slug: 'ario', role: 'API' }, { slug: 'bo', role: '' }] });
    expect(existsSync(join(home, 'teams', 'team-abc', 'config.toml'))).toBe(true);
    expect(readFileSync(join(home, 'teams', 'team-abc', 'TEAM.md'), 'utf8')).toContain('Alpha owns API.');
    expect(existsSync(join(home, 'teams', 'team-abc', 'Library'))).toBe(true);
    const b = await call('POST', '/agent/teams', { name: 'Team abc', members: [{ slug: 'ario' }, { slug: 'bo' }] });
    expect(b.body.team.slug).toBe('team-abc-2');
    expect((await call('POST', '/agent/teams', { name: 'Solo', members: [{ slug: 'ario' }] })).status).toBe(400);
    await writeTeamsMeta({ order: ['team-abc-2', 'team-abc'] });
    expect((await call('GET', '/agent/teams')).body.teams.map((t: any) => t.slug)).toEqual(['team-abc-2', 'team-abc']);
    const p = await call('PATCH', '/agent/teams/team-abc', { description: 'd2', name: '   ' });
    expect(p.body.team).toMatchObject({ description: 'd2', name: 'Team abc', members: a.body.team.members }); // 空白 name = 不改名
    expect((await call('DELETE', '/agent/teams/team-abc-2')).body.ok).toBe(true);
    expect((await call('GET', '/agent/teams/team-abc-2')).status).toBe(404);
    expect((await listTeams()).map((t) => t.slug)).toEqual(['team-abc']);
    // 成员必须本地可解析:云端 / 已删 agent 不能进成员表(否则首条消息 group_needs_2_agents)
    const bad = await call('POST', '/agent/teams', { name: 'Ghosts', members: [{ slug: 'ario' }, { slug: 'nobody' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toMatch(/nobody/);
    expect((await call('PATCH', '/agent/teams/team-abc', { members: [{ slug: 'ario' }, { slug: 'nobody' }] })).status).toBe(400);
  });

  it('name 可省:缺省 = 成员名相连(有 project 再 @ 项目);中文名 slugify 为空 → 基名 team 加序号,不是 400', async () => {
    const d = await call('POST', '/agent/teams', { members: [{ slug: 'bo' }, { slug: 'ario' }] });
    expect(d.status).toBe(200);
    expect(d.body.team).toMatchObject({ name: 'Bo & Ario', slug: 'bo-ario' });
    const dp = await call('POST', '/agent/teams', { name: '', project: 'Forsion', members: [{ slug: 'ario' }, { slug: 'bo' }] });
    expect(dp.body.team.name).toBe('Ario & Bo @ Forsion');
    const zh = await call('POST', '/agent/teams', { name: '发布小组', members: [{ slug: 'ario' }, { slug: 'bo' }] });
    expect(zh.status).toBe(200);
    expect(zh.body.team).toMatchObject({ name: '发布小组', slug: 'team' });
    const zh2 = await call('POST', '/agent/teams', { name: '评审小组', members: [{ slug: 'ario' }, { slug: 'bo' }] });
    expect(zh2.body.team.slug).toBe('team-2');
    for (const s of ['bo-ario', 'ario-bo', 'team', 'team-2']) await call('DELETE', `/agent/teams/${s}`);
  });

  it('session/open:幂等;形状 = projectless + teamSlug + groupChat + 成员表 + cwd=团队 Library + preset null(无模式 / 轮数字段);过 validSessionFacts', async () => {
    const a = await call('POST', '/agent/teams/team-abc/session/open');
    expect(a.status).toBe(200);
    expect(a.body.created).toBe(true);
    const s = a.body.session;
    expect(s.projectless).toBe(true);
    expect(s.title).toBe('Team abc');
    expect(s.agent_config).toEqual({ teamSlug: 'team-abc', groupChat: true, groupAgents: ['ario', 'bo'], execMode: 'host', cwd: teamLibDirOf('team-abc'), preset: null });
    expect(validSessionFacts(s.agent_config)).toBeNull();
    expect((await call('POST', '/agent/teams/team-abc/session/open')).body.session.id).toBe(s.id);
    expect((await call('POST', '/agent/teams/nope/session/open')).status).toBe(404);
  });

  it('loop:存值 teamSlug 的会话,run 不带 groupAgents 也按成员表进群聊;TEAM.md + role 进每位成员 system;成员 DONE 即收场', async () => {
    const s = (await call('POST', '/agent/teams/team-abc/session/open')).body.session;
    llmPayloads = [];
    await createRun({ id: 'TR1', sessionId: s.id, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'TR1-a',
      input: { message: 'go', userMessageId: 'TR1-u', attachments: [], agentConfig: { execMode: 'host', cwd: s.agent_config.cwd, groupNoSummary: true, groupSeedHistory: false } } });
    enqueueRun(s.id, 'TR1');
    const t0 = Date.now();
    for (;;) {
      const r = await getRun('TR1');
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) { expect(r.status).toBe('done'); break; }
      if (Date.now() - t0 > 8000) throw new Error('run 未结束');
      await new Promise((res) => setTimeout(res, 25));
    }
    const ev = await query<any[]>(`SELECT type, payload FROM agent_run_events WHERE run_id = 'TR1' AND type IN ('group_speaker','group_ended')`);
    const speakers = ev.filter((e) => e.type === 'group_speaker').map((e) => (typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload)).filter((p) => p.phase === 'start').map((p) => p.slug);
    expect([...speakers].sort()).toEqual(['ario', 'bo']); // 并行完成的先后不固定;每人一条 DONE → 全员收场
    const ended = ev.find((e) => e.type === 'group_ended');
    expect(JSON.parse(ended!.payload)).toMatchObject({ reason: 'done', steps: 2 });
    // 09-16 第四轮:成员在各自的工作会话里跑子 run(真 agentLoop),团队段拼在成员自己的 system 里(teamMemberSection 的 You are "<Name>" 行认人)。
    const sysOf = (name: string): string => String(llmPayloads.map((p) => String(p.messages?.[0]?.content || '')).find((c) => c.includes(`You are "${name}"`)) || '');
    const arioSys = sysOf('Ario');
    expect(arioSys).toContain('## Team Mode');
    expect(arioSys).toContain('## Team\n# Team abc\nAlpha owns API.');
    expect(arioSys).toContain('## Your role\nAPI');
    // 09-18:当前名字 / 简介经身份段进 system(改名即生效的接线;agentLoop 删掉那一行注入这里就红)。
    expect(arioSys).toContain('## Identity\n- Name: Ario\n- Description (shown to the user): x\n');
    const boSys = sysOf('Bo');
    expect(boSys).toContain('## Team\n');
    expect(boSys).not.toContain('## Your role');
    // 成员的工作会话:一人一条,隐藏(kind=teamwork),父链接 = 团队会话
    const work = await query<any[]>(`SELECT kind, agent_config FROM chat_sessions WHERE parent_session_id = ? ORDER BY created_at`, [s.id]);
    expect(work.map((w) => [w.kind, JSON.parse(w.agent_config).agentSlug])).toEqual([['teamwork', 'ario'], ['teamwork', 'bo']]);
    // 会话里的发言归属:agent_slug 落列
    const msgs = await query<any[]>(`SELECT agent_slug FROM chat_messages WHERE session_id = ? AND role = 'model' ORDER BY timestamp`, [s.id]);
    expect(msgs.map((m) => m.agent_slug)).toEqual(['ario', 'bo']);
  });

  it('DELETE:有活动 run → 409 不删;无活动 run → 删定义并归档该团队的历史会话', async () => {
    const mk = await call('POST', '/agent/teams', { name: 'Del me', members: [{ slug: 'ario' }, { slug: 'bo' }] });
    const slug = mk.body.team.slug;
    const s = (await call('POST', `/agent/teams/${slug}/session/open`)).body.session;
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, input) VALUES ('tr-del', ?, ?, 'running', '{}')`, [s.id, USER]);
    const busy = await call('DELETE', `/agent/teams/${slug}`);
    expect(busy.status).toBe(409);
    expect((await call('GET', `/agent/teams/${slug}`)).status).toBe(200);
    await query(`UPDATE agent_runs SET status = 'done' WHERE id = 'tr-del'`);
    const ok = await call('DELETE', `/agent/teams/${slug}`);
    expect(ok.status).toBe(200);
    expect((await call('GET', `/agent/teams/${slug}`)).status).toBe(404);
    expect(!!(await query<any[]>(`SELECT archived FROM chat_sessions WHERE id = ?`, [s.id]))[0].archived).toBe(true);
  });

  it('云端 profile → 404', async () => {
    const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
    db.exec(toSqliteDDL(STANDALONE_SCHEMA));
    configureTangu({ host, brain: {} as any, billing: {} as any, profile: createAiStudioProfile() });
    expect((await call('GET', '/agent/teams')).status).toBe(404);
  });
});
