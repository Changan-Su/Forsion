/**
 * 会话检索服务(模型工具与桌面搜索面共用):在**真 sqlite** 上跑同一条 SQL,钉住
 * 租户隔离 / kind 过滤 / LIMIT 按会话计 / 空壳排除 / LIKE 转义 / 结构化命中(带 messageId 供跳转)。
 * 工具那层的措辞与行格式另在 tools/builtin/searchSessions.test.ts。
 *
 * node:sqlite 需 Node ≥22.5;老 Node(CI node20)整份 suite 不定义(见下方注释,照抄工具测试的做法)。
 */
import { describe, it, expect } from 'vitest';

// @ts-ignore 仓内 @types/node 尚无 node:sqlite 声明(需 ≥22.5)
const sqliteMod: any = await import('node:sqlite').catch(() => null);

// ⚠️ 不能用 describe.skipIf:被跳过的 suite 其工厂函数照样在收集期执行 → 老 Node 上当场 TypeError。
if (!sqliteMod) describe.skip('sessionSearch × 真 sqlite(需 Node ≥22.5,本环境跳过)', () => {
  it('node:sqlite 不可用', () => {});
});
else describe('sessionSearch × 真 sqlite', async () => {
  const { configureTangu } = await import('../seams/runtime.js');
  const { searchSessions, splitTerms } = await import('./sessionSearch.js');
  const db = new sqliteMod.DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, user_id TEXT, app_id TEXT, title TEXT, summary TEXT,
      archived INTEGER DEFAULT 0, kind TEXT DEFAULT 'user', updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp INTEGER);`);
  const ins = db.prepare('INSERT INTO chat_sessions (id,user_id,app_id,title,summary,archived,kind,updated_at) VALUES (?,?,?,?,?,?,?,?)');
  ins.run('s-plugin', 'u1', 'tangu', 'Forsion插件开发咨询', '聊了两类插件形态', 0, 'user', '2026-08-05 10:00:00');
  ins.run('s-game', 'u1', 'tangu', '3D卡丁车游戏', '做了个小游戏', 1, 'user', '2026-07-31 09:00:00');
  ins.run('s-plain', 'u1', 'tangu', '问候', '', 0, 'user', '2026-08-05 12:00:00');
  ins.run('s-empty', 'u1', 'tangu', '', '', 0, 'user', '2026-08-09 08:00:00'); // 空壳
  ins.run('s-muse', 'u1', 'tangu', 'Muse 内部', 'x', 0, 'muse', '2026-08-09 09:00:00'); // 内部 kind
  ins.run('s-other', 'u2', 'tangu', 'Forsion插件 别人的', 'x', 0, 'user', '2026-08-09 09:00:00'); // 他人
  ins.run('s-otherapp', 'u1', 'amadeus', 'Forsion插件 别的app', 'x', 0, 'user', '2026-08-09 09:00:00'); // 他 app
  ins.run('cur', 'u1', 'tangu', '当前会话', '正在聊 localStorage', 0, 'user', '2026-08-09 10:00:00');
  const im = db.prepare('INSERT INTO chat_messages (id,session_id,role,content,timestamp) VALUES (?,?,?,?,?)');
  const T = Date.UTC(2026, 7, 5, 4, 0, 0);
  im.run('m0', 's-plain', 'user', '帮我看看 MemoFlow 背单词网站', T - 1000);
  im.run('m1', 's-plain', 'model', '看了,localStorage 初始化有问题', T);
  im.run('m2', 's-other', 'user', 'localStorage 别人的话题', T + 1000);
  im.run('m3', 's-game', 'user', '100%_progress 这种字面量', T + 2000);
  for (let i = 0; i < 30; i++) im.run(`flood${i}`, 's-plugin', 'user', `torrent 刷屏消息 ${i}`, T + 10_000 + i);
  im.run('mq', 's-game', 'user', 'torrent 安静会话只提一次', T + 3000);

  const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any;
  configureTangu({
    host: { query: async (sql: string, params?: any[]) => db.prepare(sql).all(...(params ?? [])), getDbType: () => 'sqlite' } as any,
    brain: stub, billing: stub, profile: stub,
  });

  const run = (q: string, extra: Record<string, any> = {}) =>
    searchSessions({ userId: 'u1', appId: 'tangu', terms: splitTerms(q), limit: 20, ...extra });

  it('内容命中回结构化 hit(messageId/role/时间戳/片段)——桌面据此跳到那条消息', async () => {
    const hits = await run('localStorage');
    const plain = hits.find((h) => h.id === 's-plain');
    expect(plain?.hit).toMatchObject({ messageId: 'm1', role: 'assistant', timestamp: T });
    expect(plain?.hit?.snippet).toContain('localStorage');
    expect(plain?.match).toMatch(/^assistant 2026-08-05: ".*localStorage.*"$/);
  });

  it('标题/摘要自证命中的行不带 hit(显示摘要即可)', async () => {
    const hits = await run('插件 咨询');
    expect(hits.map((h) => h.id)).toContain('s-plugin');
    expect(hits.find((h) => h.id === 's-plugin')?.hit).toBeUndefined();
  });

  it('租户隔离:他人 / 他 app / 内部 kind 一个都不出现', async () => {
    const ids = (await run('Forsion插件')).map((h) => h.id);
    expect(ids).toContain('s-plugin');
    for (const bad of ['s-other', 's-otherapp', 's-muse']) expect(ids).not.toContain(bad);
  });

  it('UI 口径:不传 excludeSessionId 时**包含**当前会话(用户可能就在找手上这段)', async () => {
    const ids = (await run('localStorage')).map((h) => h.id);
    expect(ids).toContain('cur');
  });

  it('工具口径:传 excludeSessionId 则排除它', async () => {
    const ids = (await run('localStorage', { excludeSessionId: 'cur' })).map((h) => h.id);
    expect(ids).not.toContain('cur');
    expect(ids).toContain('s-plain');
  });

  it('话痨会话不挤占名额:LIMIT 按会话计', async () => {
    const ids = (await run('torrent', { limit: 5 })).map((h) => h.id);
    expect(ids).toEqual(expect.arrayContaining(['s-plugin', 's-game']));
  });

  it('跨消息 AND:两个词分散在同会话两条消息里也算命中', async () => {
    expect((await run('localStorage MemoFlow')).map((h) => h.id)).toContain('s-plain');
  });

  it('LIKE 通配转义:% _ 当字面量', async () => {
    expect((await run('100%_progress')).map((h) => h.id)).toContain('s-game');
    expect(await run('100%X')).toEqual([]);
  });

  it('无 query = 最近列表:空壳会话不进榜,按 updated_at 降序', async () => {
    const hits = await run('');
    const ids = hits.map((h) => h.id);
    expect(ids).not.toContain('s-empty');
    expect(ids[0]).toBe('cur'); // 08-09 最新
    expect(ids.indexOf('s-plain')).toBeLessThan(ids.indexOf('s-plugin')); // 同日 12:00 > 10:00
  });

  it('before/after 时间窗', async () => {
    expect((await run('', { before: '2026-08-01' })).map((h) => h.id)).toEqual(['s-game']);
    const after = (await run('', { after: '2026-08-05' })).map((h) => h.id);
    expect(after).toContain('s-plugin');
    expect(after).not.toContain('s-game');
  });

  it('引号短语当一个词:整段连着出现才算命中', async () => {
    // 'localStorage 初始化' 在同一条消息里连着出现 → 命中;拆成两个词也命中(跨消息 AND)
    expect((await run('"localStorage 初始化"')).map((h) => h.id)).toContain('s-plain');
    // 这两个词各自都在库里,但从没连着出现过 → 短语必须落空(否则引号形同虚设)
    expect(await run('"MemoFlow localStorage"')).toEqual([]);
    expect((await run('MemoFlow localStorage')).map((h) => h.id)).toContain('s-plain');
  });

  it('引号不闭合按普通空白拆(不把裸引号当字面量,打到一半不会突然搜不到)', async () => {
    expect((await run('"localStorage')).map((h) => h.id)).toContain('s-plain');
  });

  it('⚠️超长查询词被截断而不是打爆 SQL(100KB 一个词会让 sqlite 抛 pattern too complex)', async () => {
    const huge = 'localStorage' + 'x'.repeat(100_000);
    await expect(run(huge)).resolves.toEqual([]); // 不抛、不 500
    const { splitTerms: st } = await import('./sessionSearch.js');
    expect(st(huge)[0].length).toBe(200);
    // 一句超长自由文本(多词)同样只走前几个截断词,不炸
    await expect(run(`localStorage ${'x'.repeat(100_000)}`)).resolves.toEqual([]); // AND:垃圾词匹配不到,空结果是对的
    await expect(run('"' + 'y'.repeat(100_000) + '"')).resolves.toEqual([]);       // 引号短语同样截断
  });

  it('limit 非整数/超范围被夹紧(小数直插 LIMIT 会炸 SQL)', async () => {
    expect((await run('', { limit: 1.7 })).length).toBe(1);
    expect((await run('', { limit: 0 })).length).toBeGreaterThan(0);
    expect((await run('', { limit: 999 })).length).toBeLessThanOrEqual(50);
  });
});
