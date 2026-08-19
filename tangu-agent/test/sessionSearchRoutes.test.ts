/**
 * GET /agent/sessions/search 路由集成测试:真 SQLite(内存)+ 真 express(listen 随机端口,fetch 直打)。
 * 覆盖:鉴权 / 租户与 app 隔离 / 正文命中回结构化 hit(messageId 供跳转)/ 最近列表口径 /
 * 非法日期 400 / limit 夹紧 / 路由不被 :id 通配吃掉 / 引号短语。
 * 语义本体在 src/services/sessionSearch.test.ts,本文件钉的是「经过 HTTP 这一层之后还对不对」。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import sessionsRouter from '../src/routes/sessions.js';

const USER = 'u1';
let srv: Server;
let base: string;

const api = async (path: string): Promise<any> => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: 'Bearer x' } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

async function session(id: string, o: { user?: string; app?: string; title?: string; summary?: string; kind?: string; at?: string }): Promise<void> {
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, summary, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, o.user ?? USER, o.app ?? 'tangu', o.title ?? '', o.summary ?? '', o.kind ?? 'user', o.at ?? '2026-08-05 10:00:00'],
  );
}
async function message(id: string, sessionId: string, role: string, content: string, ts: number): Promise<void> {
  await query(
    `INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`,
    [id, sessionId, role, content, ts],
  );
}

const T = Date.UTC(2026, 7, 5, 4, 0, 0);

beforeAll(async () => {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();

  const app = express();
  app.use(express.json());
  app.use(sessionsRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;

  await session('s-plugin', { title: 'Forsion插件开发咨询', summary: '聊了两类插件形态', at: '2026-08-05 10:00:00' });
  await session('s-plain', { title: '问候', at: '2026-08-05 12:00:00' });
  await session('s-empty', { at: '2026-08-09 08:00:00' });                       // 空壳:不进最近列表
  await session('s-muse', { title: 'Muse 内部', kind: 'muse', at: '2026-08-09 09:00:00' });
  await session('s-other', { title: 'Forsion插件 别人的', user: 'u2', at: '2026-08-09 09:00:00' });
  await session('s-otherapp', { title: 'Forsion插件 别的app', app: 'amadeus', at: '2026-08-09 09:00:00' });
  await message('m1', 's-plain', 'model', '看了,localStorage 初始化有问题', T);
  await message('m2', 's-other', 'user', 'localStorage 别人的话题', T + 1000);
  await message('m3', 's-plain', 'user', '顺带问下 MemoFlow 背单词', T - 1000);

  // ── codex 2026-08-17 两条 P2 的取证数据 ───────────────────────────────────────
  // s-meta:第一个词「问候」只在**标题**里,第二个词「Excalidraw」只在**正文**里。
  // 探针若固定用第一个词,就探不到正文 → hit 缺席 → 桌面点了跳不过去。
  await session('s-meta', { title: '问候 与画板', at: '2026-08-06 10:00:00' });
  await message('m-meta', 's-meta', 'model', 'Excalidraw 画板的锚是这样存的', T + 2000);
  // s-flood:同一个词在一个会话里有 120 条命中。全局 LIMIT 100 的老写法会被它占满,
  // 于是 s-quiet 拿不到 hit。
  await session('s-flood', { title: '洪水', at: '2026-08-07 10:00:00' });
  for (let i = 0; i < 120; i++) await message(`m-f${i}`, 's-flood', 'user', `洪水词 tabstop 第${i}条`, T + 3000 + i);
  await session('s-quiet', { title: '安静', at: '2026-08-07 09:00:00' });
  await message('m-quiet', 's-quiet', 'model', '只有一条 tabstop 的会话', T + 2500);
});

afterAll(() => { srv?.close(); });

describe('GET /agent/sessions/search', () => {
  it('未带 token → 401', async () => {
    const r = await fetch(`${base}/agent/sessions/search?q=x`);
    expect(r.status).toBe(401);
  });

  // ⚠️codex 2026-08-17 P2:片段探针原来固定用**第一个**词。多词查询里第一个词只在标题/摘要、
  // 把这个会话捞进来的是后面某个词命中正文时,拿第一个词去探正文自然探不到 → hit 缺席。
  it('多词查询:第一个词只在标题时,探针要挑「元数据里没有的那个词」', async () => {
    const r = await api('/agent/sessions/search?q=' + encodeURIComponent('问候 Excalidraw'));
    expect(r.status).toBe(200);
    const hit = r.body.hits.find((h: any) => h.id === 's-meta');
    expect(hit).toBeTruthy();
    expect(hit.hit).toBeTruthy();                       // 修之前这里是 undefined
    expect(hit.hit.messageId).toBe('m-meta');
    expect(hit.hit.snippet).toContain('Excalidraw');
  });

  // ⚠️codex 2026-08-17 P2:原来是一条 `LIMIT 100` 的全局查询,一个消息很多的会话能占满结果集,
  // 别的会话一条都拿不到 → 它们的 hit 全缺席。改成每会话各取一条(LIMIT 1)。
  it('某会话有 120 条命中时,不许把别的会话的 hit 挤掉', async () => {
    const r = await api('/agent/sessions/search?q=tabstop');
    expect(r.status).toBe(200);
    const quiet = r.body.hits.find((h: any) => h.id === 's-quiet');
    expect(quiet).toBeTruthy();
    expect(quiet.hit?.messageId).toBe('m-quiet');       // 修之前这里是 undefined
    const flood = r.body.hits.find((h: any) => h.id === 's-flood');
    expect(flood.hit).toBeTruthy();
    expect(flood.hit.messageId).toBe('m-f119');         // 且各自取的是**最新**那条
  });

  it('正文命中:回结构化 hit(messageId/role/timestamp/snippet)供跳转', async () => {
    const { status, body } = await api('/agent/sessions/search?q=localStorage');
    expect(status).toBe(200);
    const hit = body.hits.find((h: any) => h.id === 's-plain');
    expect(hit).toBeTruthy();
    expect(hit.hit).toMatchObject({ messageId: 'm1', role: 'assistant', timestamp: T });
    expect(hit.hit.snippet).toContain('localStorage');
    expect(hit.updatedAt).toBe('2026-08-05'); // 方言归一后的日期形态
    expect(hit.archived).toBe(false);         // sqlite 的 0/1 已归一成布尔
  });

  it('租户/app/kind 隔离:别人的、别的 app、内部会话都不出现', async () => {
    const { body } = await api('/agent/sessions/search?q=Forsion插件');
    const ids = body.hits.map((h: any) => h.id);
    expect(ids).toContain('s-plugin');
    for (const bad of ['s-other', 's-otherapp', 's-muse']) expect(ids).not.toContain(bad);
  });

  it('UI 口径:不排除任何会话(工具那边才排除当前会话)', async () => {
    const { body } = await api('/agent/sessions/search?q=插件');
    expect(body.hits.length).toBeGreaterThan(0);
  });

  it('空 q = 最近列表,空壳会话不进榜', async () => {
    const { body } = await api('/agent/sessions/search?q=');
    const ids = body.hits.map((h: any) => h.id);
    expect(ids).toContain('s-plain');
    expect(ids).not.toContain('s-empty');
  });

  it('非法日期 → 400(乱串直传会在 PG 的 timestamp cast 上炸整条查询)', async () => {
    const { status, body } = await api('/agent/sessions/search?q=x&before=昨天');
    expect(status).toBe(400);
    expect(String(body.detail)).toContain('YYYY-MM-DD');
  });

  it('limit 夹紧:小数/超大值都不会把非法 LIMIT 拼进 SQL', async () => {
    const a = await api('/agent/sessions/search?q=&limit=1.7');
    expect(a.status).toBe(200);
    expect(a.body.hits.length).toBe(1);
    const b = await api('/agent/sessions/search?q=&limit=9999');
    expect(b.status).toBe(200);
    expect(b.body.hits.length).toBeLessThanOrEqual(50);
  });

  it('未知 app_id → 400', async () => {
    const { status } = await api('/agent/sessions/search?q=x&app_id=nope');
    expect(status).toBe(400);
  });

  it('路由不被 /agent/sessions/:id 之类通配吃掉(search 是字面量段)', async () => {
    const { status, body } = await api('/agent/sessions/search?q=MemoFlow');
    expect(status).toBe(200);
    expect(body.hits.map((h: any) => h.id)).toContain('s-plain');
  });

  it('⚠️超长查询词不再 500(未截断时 sqlite 抛 LIKE pattern too complex,Codex 实测)', async () => {
    // 6KB:仍在 Node 的 URL/头部上限内,能真打到 handler(100KB 的 URL 会被 Node 提前 431,
    // 那是 HTTP 层的事,不是本路由的行为)。截断闸在 splitTerms,故这里必须 200 而不是 500。
    const big = encodeURIComponent('localStorage' + 'x'.repeat(6_000));
    const { status, body } = await api(`/agent/sessions/search?q=${big}`);
    expect(status).toBe(200);
    expect(Array.isArray(body.hits)).toBe(true);
  });

  it('引号短语:连着出现才命中', async () => {
    const ok = await api(`/agent/sessions/search?q=${encodeURIComponent('"localStorage 初始化"')}`);
    expect(ok.body.hits.map((h: any) => h.id)).toContain('s-plain');
    const no = await api(`/agent/sessions/search?q=${encodeURIComponent('"MemoFlow localStorage"')}`);
    expect(no.body.hits).toEqual([]);
  });
});
