/**
 * search_sessions 纯函数面:LIKE 转义、分词、片段截取、日期/布尔方言归一、行格式、合并去重。
 * SQL 本体两方言(sqlite/PG)共用一条,正确性依赖这些辅助函数——它们碎了检索就碎。
 */
import { describe, it, expect } from 'vitest';
import { splitTerms, likePattern, snippetAround, fmtDate, dayArg, tsDate, formatHit, type SessionHit } from './searchSessions.js';

describe('splitTerms', () => {
  it('空白拆分并裁剪', () => {
    expect(splitTerms('  foo   bar ')).toEqual(['foo', 'bar']);
    expect(splitTerms('')).toEqual([]);
    expect(splitTerms('   ')).toEqual([]);
  });
  it('最多 5 个词', () => {
    expect(splitTerms('a b c d e f g')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('likePattern', () => {
  it('小写 + 通配包裹', () => {
    expect(likePattern('Plugin')).toBe('%plugin%');
  });
  it('转义 % _ \\(配 SQL 端 ESCAPE)', () => {
    expect(likePattern('A%_')).toBe('%a\\%\\_%');
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
  });
});

describe('snippetAround', () => {
  it('围绕命中词截取并折叠空白', () => {
    const content = 'x'.repeat(200) + '\n\n  Forsion 插件开发  咨询 ' + 'y'.repeat(200);
    const s = snippetAround(content, '插件开发');
    expect(s).toContain('插件开发');
    expect(s).not.toMatch(/\n| {2}/);
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
  });
  it('命中词大小写不敏感', () => {
    expect(snippetAround('short MemoFlow note', 'memoflow')).toContain('MemoFlow');
  });
  it('未命中时回退开头截断', () => {
    expect(snippetAround('abc', 'zzz')).toBe('abc');
  });
});

describe('fmtDate', () => {
  it('PG Date → ISO 日期', () => {
    expect(fmtDate(new Date('2026-08-05T12:34:56Z'))).toBe('2026-08-05');
  });
  it('sqlite 字符串 → 前 10 位', () => {
    expect(fmtDate('2026-08-05 09:00:00')).toBe('2026-08-05');
  });
  it('空值容忍', () => {
    expect(fmtDate(null)).toBe('');
  });
});

describe('dayArg', () => {
  it('接受 YYYY-MM-DD 与 ISO 延长形,归一成日期', () => {
    expect(dayArg('2026-08-05')).toBe('2026-08-05');
    expect(dayArg('2026-08-05T10:00:00Z')).toBe('2026-08-05');
    expect(dayArg('2026-08-05 10:00:00')).toBe('2026-08-05');
  });
  it('非法/空 → null(乱串直传 PG 会在 timestamp cast 上炸)', () => {
    for (const bad of ['昨天', '08-05', '2026/08/05', '', null]) expect(dayArg(bad)).toBeNull();
  });
});

describe('formatHit', () => {
  const base: SessionHit = { id: 's1', title: '插件咨询', summary: '聊了插件的两类形态', archived: 0, updated_at: '2026-08-05 09:00:00' };
  it('产出 [[session:id|标题]] 引用行', () => {
    expect(formatHit(base)).toBe('- [[session:s1|插件咨询]] — 2026-08-05 — 聊了插件的两类形态');
  });
  it('标题里的 | [ ] 被清洗,空标题回退', () => {
    expect(formatHit({ ...base, title: 'a|b[[c]]' })).toContain('[[session:s1|a b c]]');
    expect(formatHit({ ...base, title: '' })).toContain('|(untitled)]]');
  });
  it('归档打标(sqlite 1 / PG true 都认)', () => {
    expect(formatHit({ ...base, archived: 1 })).toContain('[archived]');
    expect(formatHit({ ...base, archived: true })).toContain('[archived]');
  });
  it('内容命中片段优先于摘要;超长摘要截断', () => {
    expect(formatHit({ ...base, match: 'user: "问了插件"' })).toContain('user: "问了插件"');
    const long = formatHit({ ...base, summary: 'x'.repeat(300) });
    expect(long).toContain('x'.repeat(150) + '…');
  });
});

describe('tsDate', () => {
  it('BIGINT 毫秒(数字/PG 字符串形)→ ISO 日期;非法给空', () => {
    const ms = Date.UTC(2026, 7, 5, 4, 0, 0);
    expect(tsDate(ms)).toBe('2026-08-05');
    expect(tsDate(String(ms))).toBe('2026-08-05');
    for (const bad of [null, '', 'x', 0, -5]) expect(tsDate(bad)).toBe('');
  });
});

// ── 真 sqlite 方言冒烟:SQL 本体(ESCAPE '\' / `||` 拼接 / JOIN 租户隔离 / COALESCE 空壳排除)
//    跑在 node:sqlite 内存库上。node:sqlite 需 Node ≥22.5,老 Node(CI node20)自动跳过。──
// @ts-ignore 仓内 @types/node 尚无 node:sqlite 声明(需 ≥22.5);运行时 catch 已兜底老 Node
const sqliteMod: any = await import('node:sqlite').catch(() => null);

describe.skipIf(!sqliteMod)('search_sessions execute × 真 sqlite', async () => {
  const { configureTangu } = await import('../../seams/runtime.js');
  const { searchSessionsProvider } = await import('./searchSessions.js');
  const db = new sqliteMod.DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, user_id TEXT, app_id TEXT, title TEXT, summary TEXT,
      archived INTEGER DEFAULT 0, kind TEXT DEFAULT 'user', updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp INTEGER);`);
  const ins = db.prepare('INSERT INTO chat_sessions (id,user_id,app_id,title,summary,archived,kind,updated_at) VALUES (?,?,?,?,?,?,?,?)');
  ins.run('s-plugin', 'u1', 'tangu', 'Forsion插件开发咨询', '聊了两类插件形态', 0, 'user', '2026-08-05 10:00:00');
  ins.run('s-game', 'u1', 'tangu', '3D卡丁车游戏', '做了个小游戏', 1, 'user', '2026-07-31 09:00:00');
  ins.run('s-plain', 'u1', 'tangu', '问候', '', 0, 'user', '2026-08-05 12:00:00');
  ins.run('s-empty', 'u1', 'tangu', '', '', 0, 'user', '2026-08-09 08:00:00'); // 空壳:不进最近列表
  ins.run('s-muse', 'u1', 'tangu', 'Muse 内部', 'x', 0, 'muse', '2026-08-09 09:00:00'); // 内部 kind:永不出现
  ins.run('s-other', 'u2', 'tangu', 'Forsion插件 别人的', 'x', 0, 'user', '2026-08-09 09:00:00'); // 他人:永不出现
  ins.run('cur', 'u1', 'tangu', '当前会话', '正在聊', 0, 'user', '2026-08-09 10:00:00'); // 当前:服务端排除
  const im = db.prepare('INSERT INTO chat_messages (id,session_id,role,content,timestamp) VALUES (?,?,?,?,?)');
  const T = Date.UTC(2026, 7, 5, 4, 0, 0); // 2026-08-05
  im.run('m0', 's-plain', 'user', '帮我看看 MemoFlow 背单词网站', T - 1000);
  im.run('m1', 's-plain', 'model', '看了,localStorage 初始化有问题', T);
  im.run('m2', 's-other', 'user', 'localStorage 别人的话题', T + 1000);
  im.run('m3', 's-game', 'user', '100%_progress 这种字面量', T + 2000);
  // 话痨会话:s-plugin 塞一堆同词消息,验证 LIMIT 按会话计、不挤占别人(旧版按消息池截会被刷屏)
  for (let i = 0; i < 30; i++) im.run(`flood${i}`, 's-plugin', 'user', `torrent 刷屏消息 ${i}`, T + 10_000 + i);
  im.run('mq', 's-game', 'user', 'torrent 安静会话只提一次', T + 3000);

  const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any;
  configureTangu({
    host: { query: async (sql: string, params?: any[]) => db.prepare(sql).all(...(params ?? [])), getDbType: () => 'sqlite' } as any,
    brain: stub, billing: stub, profile: stub,
  });
  const tool = searchSessionsProvider.tools()[0];
  const run = (args: Record<string, any>) => tool.execute(args, { userId: 'u1', sessionId: 'cur', appId: 'tangu' } as any);

  it('无 query:最近列表降序,排除空壳/内部 kind/他人/当前会话,产出可点击引用+归档标', async () => {
    const out = String(await run({}));
    expect(out.indexOf('s-plain')).toBeLessThan(out.indexOf('s-plugin'));
    for (const bad of ['s-empty', 's-muse', 's-other', '当前会话']) expect(out).not.toContain(bad);
    expect(out).toContain('[[session:s-plugin|Forsion插件开发咨询]]');
    expect(out).toContain('[archived]');
  });
  it('before/after 时间窗;非法日期被拒(护 PG cast)', async () => {
    const out = String(await run({ before: '2026-08-01' }));
    expect(out).toContain('s-game'); // 07-31
    expect(out).not.toContain('s-plugin'); // 08-05 被 before 排除
    const out2 = String(await run({ after: '2026-08-05' }));
    expect(out2).toContain('s-plugin');
    expect(out2).not.toContain('s-game');
    expect(String(await run({ before: '昨天' }))).toContain('must be a YYYY-MM-DD');
  });
  it('CJK 多词 AND 命中标题/摘要,租户隔离', async () => {
    const out = String(await run({ query: '插件 咨询' }));
    expect(out).toContain('s-plugin');
    expect(out).not.toContain('s-other');
  });
  it('仅正文命中:租户隔离 + 角色归一 + 片段带命中消息日期', async () => {
    const out = String(await run({ query: 'localStorage' }));
    expect(out).toContain('s-plain');
    expect(out).not.toContain('s-other');
    expect(out).toMatch(/assistant 2026-08-05: ".*localStorage.*"/);
  });
  it('跨消息 AND:两个词分散在同会话两条消息里也算命中', async () => {
    const out = String(await run({ query: 'localStorage MemoFlow' }));
    expect(out).toContain('s-plain');
  });
  it('话痨会话不挤占:LIMIT 按会话计,刷屏会话与安静会话都在', async () => {
    const out = String(await run({ query: 'torrent', limit: 5 }));
    expect(out).toContain('s-plugin');
    expect(out).toContain('s-game');
  });
  it('LIKE 通配转义:% _ 是字面量', async () => {
    expect(String(await run({ query: '100%_progress' }))).toContain('s-game');
    expect(String(await run({ query: '100%X' }))).toMatch(/No past sessions matched/);
  });
});
