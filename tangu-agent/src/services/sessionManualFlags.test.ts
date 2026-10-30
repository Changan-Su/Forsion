/**
 * 用户亲手改过的标题 / 图标:PATCH 怎么判来源、Historian 写图标的守卫、分支时标记跟着值走。真 sqlite + 真路由 + 真 schema。
 * Historian 写标题那几处要真模型,在 live 台架 titlemanual。node:sqlite 需 Node ≥22.5,老 Node 跳过(同 sessionSearch.test.ts)。
 */
import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';

// @ts-ignore 仓内 @types/node 尚无 node:sqlite 声明(需 ≥22.5)
const sqliteMod: any = await import('node:sqlite').catch(() => null);

if (!sqliteMod) describe.skip('手动标记 × 真 sqlite(需 Node ≥22.5,本环境跳过)', () => {
  it('node:sqlite 不可用', () => {});
});
else describe('手动标记 × 真 sqlite', async () => {
  const { configureTangu } = await import('../seams/runtime.js');
  const { createTanguProfile } = await import('../profiles/index.js');
  const { STANDALONE_SCHEMA } = await import('../db/schemaStandalone.js');
  const { default: sessionsRouter } = await import('../routes/sessions.js');
  const { applyHistorianEmoji } = await import('./sessionEmoji.js');
  const { branchSession } = await import('./sessionBranch.js');

  const db = new sqliteMod.DatabaseSync(':memory:');
  db.exec(STANDALONE_SCHEMA);
  const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any;
  configureTangu({
    host: {
      query: async (sql: string, params?: any[]) => db.prepare(sql).all(...(params ?? []).map((p) => (typeof p === 'boolean' ? Number(p) : p))),
      getDbType: () => 'sqlite',
      authMiddleware: (req: any, _res: any, next: any) => { req.user = { userId: 'u1' }; next(); },
    } as any,
    brain: stub, billing: stub, profile: createTanguProfile({ sandboxMode: 'none' }),
  });
  const app = express();
  app.use(express.json());
  app.use(sessionsRouter);
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  afterAll(() => { srv.close(); });

  let n = 0;
  const mk = (over: { emoji?: string | null } = {}): string => {
    const id = `s${++n}`;
    db.prepare(`INSERT INTO chat_sessions (id, user_id, app_id, title, emoji) VALUES (?, 'u1', 'tangu', 'New Chat', ?)`).run(id, over.emoji ?? null);
    return id;
  };
  const flags = (id: string): any => db.prepare('SELECT title, title_manual, emoji, emoji_manual FROM chat_sessions WHERE id = ?').get(id);
  const patch = async (id: string, body: object): Promise<void> => {
    const r = await fetch(`${base}/agent/sessions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(r.status).toBe(200);
  };

  it('占位标题不带来源:不算手动,不解已有标记', async () => {
    const id = mk();
    await patch(id, { title: '发出去的前 30 字' });
    expect(flags(id)).toMatchObject({ title: '发出去的前 30 字', title_manual: 0 });
    await patch(id, { title: '亲手改的', title_source: 'user' });
    await patch(id, { title: '别的来源' });
    expect(flags(id).title_manual).toBe(1);
  });

  it('用户改名 = 手动;用户清空 = 交还;不认别的来源值', async () => {
    const id = mk();
    await patch(id, { title: '亲手改的', title_source: 'user' });
    expect(flags(id)).toMatchObject({ title: '亲手改的', title_manual: 1 });
    await patch(id, { title: '   ', title_source: 'user' });
    expect(flags(id)).toMatchObject({ title: '', title_manual: 0 });
    await patch(id, { title: '客户端写错的', title_source: 'bot' });
    expect(flags(id).title_manual).toBe(0);
  });

  it('清空图标算手动,Historian 不再填;没动过的照常填', async () => {
    const cleared = mk({ emoji: '🌱' });
    await patch(cleared, { emoji: null });
    expect(flags(cleared)).toMatchObject({ emoji: null, emoji_manual: 1 });
    expect(await applyHistorianEmoji(cleared, 'u1', '🔥')).toBeNull();
    expect(flags(cleared).emoji).toBeNull();

    const untouched = mk();
    expect(await applyHistorianEmoji(untouched, 'u1', '🔥')).toBe('🔥');
  });

  it('分支:图标标记原样带;标题标记只在沿用源标题时带(缺省 New Chat 要由 Historian 起名)', async () => {
    const src = mk();
    await patch(src, { title: '亲手改的', title_source: 'user' });
    await patch(src, { emoji: null });
    db.prepare(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('m-${src}', ?, 'user', 'hi', 1)`).run(src);
    const fork = async (title?: string): Promise<any> => {
      const r = await branchSession({ sourceSessionId: src, userId: 'u1', appId: 'tangu', messageId: `m-${src}`, title });
      return flags(r!.id);
    };
    expect(await fork('New Chat')).toMatchObject({ title: 'New Chat', title_manual: 0, emoji_manual: 1 });
    expect(await fork()).toMatchObject({ title: '亲手改的', title_manual: 1, emoji_manual: 1 });
  });
});
