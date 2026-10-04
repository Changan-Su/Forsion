import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { configureTangu } from '../seams/runtime.js';
import { runWithAgentSlug } from '../seams/runContext.js';
import { searchSessions, sessionToolScope } from './sessionSearch.js';
import { searchSessionsProvider } from '../tools/builtin/searchSessions.js';
import { readSessionProvider } from '../tools/builtin/readSession.js';

// @ts-ignore node:sqlite is present from Node 22.5; older CI still exercises PostgreSQL below.
const sqlite = await import('node:sqlite').catch(() => null);
for (const dialect of (sqlite ? ['sqlite', 'postgres'] : ['postgres'])) describe(`runtime history isolation (${dialect})`, () => {
  let db: any;
  let sqlCalls: Array<{ sql: string; rows: any[] }>;
  let execute: (sql: string, params?: any[]) => Promise<any[]>;
  beforeAll(async () => {
    db = dialect === 'sqlite' ? new sqlite!.DatabaseSync(':memory:') : new PGlite();
    execute = async (sql, params = []) => {
      if (dialect === 'sqlite') return db.prepare(sql).all(...params);
      let n = 0;
      return (await db.query(sql.replace(/\?/g, () => `$${++n}`), params)).rows;
    };
    for (const sql of [
      `CREATE TABLE chat_sessions(id TEXT PRIMARY KEY, user_id TEXT, app_id TEXT, kind TEXT DEFAULT 'user',
        agent_config ${dialect === 'sqlite' ? 'TEXT' : 'JSONB'}, title TEXT, summary TEXT, archived INTEGER DEFAULT 0, updated_at ${dialect === 'sqlite' ? 'TEXT' : 'TIMESTAMP'}, project_path TEXT)`,
      `CREATE TABLE chat_messages(id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp BIGINT,
        tool_calls ${dialect === 'sqlite' ? 'TEXT' : 'JSONB'})`,
      'CREATE INDEX messages_session ON chat_messages(session_id)',
    ]) await execute(sql);
  });
  afterAll(async () => { await db?.close(); });
  const session = (id: string, slug: string | null, extra: { user?: string; app?: string; config?: string; date?: string } = {}) => execute(
    'INSERT INTO chat_sessions(id,user_id,app_id,agent_config,title,summary,updated_at) VALUES(?,?,?,?,?,?,?)',
    [id, extra.user || 'u1', extra.app || 'tangu', extra.config ?? (slug ? JSON.stringify({ agentSlug: slug }) : null),
      '同名项目', 'Shared topic', extra.date || '2026-09-08 10:00:00']);
  const message = (id: string, sid: string, content = '插件发布 AlphaProject', timestamp = 1000) => execute(
    'INSERT INTO chat_messages(id,session_id,role,content,timestamp) VALUES(?,?,?,?,?)', [id, sid, 'user', content, timestamp]);
  const ctx = (agentSlug = 'alpha') => ({ userId: 'u1', appId: 'tangu', sessionId: 'current', agentSlug } as any);
  const find = (agentSlug: string, extra: any = {}) => searchSessions({ userId: 'u1', appId: 'tangu',
    toolScope: sessionToolScope(agentSlug), terms: ['插件'], limit: 20, ...extra });
  const read = (args: any, agentSlug = 'alpha') => readSessionProvider.tools()[0].execute(args, ctx(agentSlug));
  beforeEach(async () => {
    await execute('DELETE FROM chat_messages'); await execute('DELETE FROM chat_sessions');
    sqlCalls = [];
    configureTangu({ host: { getDbType: () => dialect, query: async (sql: string, params: any[]) => {
      const rows = await execute(sql, params); sqlCalls.push({ sql, rows }); return rows;
    } }, brain: {}, billing: {}, profileStore: {}, profile: {} } as any);
    for (const [id, slug, extra] of [
      ['alpha-session', 'alpha', {}], ['beta-session', 'beta', {}], ['legacy', null, {}],
      ['other-user', 'alpha', { user: 'u2' }], ['other-app', 'alpha', { app: 'amadeus' }],
      ['empty-config', null, { config: '{}' }], ['invalid-type', null, { config: '[]' }],
    ] as const) { await session(id, slug, extra); await message(`${id}-message`, id); }
  });
  it('same content cannot cross Agent, user or app; legacy belongs only to default Agent', async () => {
    expect((await find('alpha')).map((s) => s.id)).toEqual(['alpha-session']);
    expect((await find('beta')).map((s) => s.id)).toEqual(['beta-session']);
    expect((await find('xyra')).map((s) => s.id).sort()).toEqual(['empty-config', 'legacy']);
    const global = await searchSessions({ userId: 'u1', appId: 'tangu', terms: ['插件'], limit: 20 });
    expect(global.map((s) => s.id)).toEqual(expect.arrayContaining(['alpha-session', 'beta-session', 'legacy']));
  });
  // 10-04 记忆分项目级 / 全局级:自动回忆会把同一个 agent 在别的项目里说过的话带进来,后端给每条命中标上出处项目。
  it('scoped hits carry the project folder name and whether it differs from the current session\'s project', async () => {
    for (const [id, project] of [['current', '/work/pm-two'], ['in-one', '/work/pm-one'], ['in-two', '/work/pm-two'], ['loose', null]] as const) {
      await session(id, 'alpha'); await message(`${id}-message`, id);
      await execute('UPDATE chat_sessions SET project_path = ? WHERE id = ?', [project, id]);
    }
    const byId = async (extra: any) => Object.fromEntries((await find('alpha', extra)).map((s) => [s.id, { project: s.project, otherProject: s.otherProject }]));
    // 当前会话在 pm-two:pm-one 的那条标成「别的项目」;同项目只给名字;不属于项目的会话什么都不标
    expect(await byId({ excludeSessionId: 'current' })).toEqual({
      'in-one': { project: 'pm-one', otherProject: true }, 'in-two': { project: 'pm-two', otherProject: undefined },
      loose: { project: undefined, otherProject: undefined }, 'alpha-session': { project: undefined, otherProject: undefined },
    });
    // 当前会话不属于任何项目:照给名字,但没有「别的项目」这一说
    expect((await byId({ excludeSessionId: 'loose' }))['in-one']).toEqual({ project: 'pm-one', otherProject: undefined });
    // 没给当前会话(界面 / 工具的其它用法):同上
    expect((await byId({}))['in-one']).toEqual({ project: 'pm-one', otherProject: undefined });
    // 路径本身不出库
    expect(JSON.stringify(await find('alpha', { excludeSessionId: 'current' }))).not.toContain('/work/');
  });
  it('model arguments cannot override runtime scope, including guessed session and message IDs', async () => {
    const out = String(await searchSessionsProvider.tools()[0].execute({ query: '插件', agentSlug: 'beta', toolScope: { agentSlug: 'beta' } }, ctx()));
    expect(out).toContain('alpha-session'); expect(out).not.toContain('beta-session');
    for (const sid of ['beta-session', 'other-user', 'other-app', 'legacy']) {
      expect(String(await read({ session_id: sid, agentSlug: 'beta' }))).toContain('no session');
    }
    expect(String(await read({ session_id: 'alpha-session', message_id: 'beta-session-message' }))).toContain('message not found');
    expect(String(await read({ session_id: 'alpha-session', before_message_id: 'beta-session-message' }))).toContain('message not found');
    expect(String(await read({ session_id: 'beta-session' }, 'beta'))).toContain('插件发布');
  });
  it('legacy tool contexts inherit the active Agent rather than falling through to default memory', async () => {
    await runWithAgentSlug('beta', async () => {
      const legacyContext = { userId: 'u1', appId: 'tangu', sessionId: 'current' } as any;
      const output = String(await searchSessionsProvider.tools()[0].execute({ query: '插件' }, legacyContext));
      expect(output).toContain('beta-session'); expect(output).not.toContain('[[session:legacy|');
      expect(String(await readSessionProvider.tools()[0].execute({ session_id: 'legacy' }, legacyContext))).toContain('no session');
      await expect(readSessionProvider.tools()[0].execute({ session_id: 'alpha-session' }, ctx('alpha'))).rejects.toThrow('scope');
    });
  });
  it('returns original message identity, exact offset read and stable older-message pagination', async () => {
    await message('newer', 'alpha-session', '开头'.repeat(100) + '精确原文证据', 2000);
    const hit = (await find('alpha'))[0].hit!;
    expect(hit.messageId).toBe('alpha-session-message');
    const exact = String(await read({ session_id: 'alpha-session', message_id: 'newer', char_offset: 200 }));
    expect(exact).toContain('精确原文证据'); expect(exact).not.toContain('开头');
    expect(exact).toContain('message_id=newer');
    const older = String(await read({ session_id: 'alpha-session', before_message_id: 'newer' }));
    expect(older).toContain('alpha-session-message'); expect(older).not.toContain('message_id=newer;');
  });
  it('dates narrow the Agent window and a purged session never returns from a stale index', async () => {
    await session('old-alpha', 'alpha', { date: '2026-08-01 01:00:00' }); await message('old-m', 'old-alpha');
    expect((await find('alpha', { before: '2026-09-01' })).map((s) => s.id)).toEqual(['old-alpha']);
    await execute('DELETE FROM chat_sessions WHERE id = ?', ['old-alpha']);
    expect(await find('alpha', { before: '2026-09-01' })).toEqual([]);
    expect(String(await read({ session_id: 'old-alpha' }))).toContain('no session');
  });
  it('enforces session/message/body hard bounds, while exact reads can reach clipped bodies', async () => {
    for (let i = 0; i < 65; i++) await session(`window-${String(i).padStart(2, '0')}`, 'window');
    for (let i = 0; i < 65; i++) await message(`body-${i}`, 'window-64', 'x'.repeat(4000) + 'tailneedle', i);
    sqlCalls.length = 0;
    expect(await find('window', { terms: ['tailneedle'] })).toEqual([]);
    expect(sqlCalls[0].rows).toHaveLength(64);
    const bodies = sqlCalls.filter((call) => call.sql.startsWith('SELECT m.id, m.role'));
    expect(bodies).toHaveLength(64);
    expect(Math.max(...bodies.map((call) => call.rows.length))).toBe(64);
    expect(bodies.flatMap((call) => call.rows).every((row) => row.content.length <= 4000)).toBe(true);
    expect(String(await read({ session_id: 'window-64', message_id: 'body-64', char_offset: 4000 }, 'window'))).toContain('tailneedle');
  });
  it('excludeSessionsWithTool hides whole sessions whose messages called that tool (search, read, tools fail closed)', async () => {
    // alpha-session:助手调过 read_computer_history 并在后续轮复述(追问轮不再调工具,所以按会话藏,不按消息藏)
    await execute('INSERT INTO chat_messages(id,session_id,role,content,timestamp,tool_calls) VALUES(?,?,?,?,?,?)',
      ['ch-call', 'alpha-session', 'model', 'You were editing the roadmap', 2000, JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'read_computer_history', arguments: '{}' } }])]);
    // 名字里的 _ 不是通配:别的工具名(readXcomputer…)不误伤
    await session('alpha-2', 'alpha'); await message('alpha-2-message', 'alpha-2');
    await execute('INSERT INTO chat_messages(id,session_id,role,content,timestamp,tool_calls) VALUES(?,?,?,?,?,?)',
      ['near-miss', 'alpha-2', 'model', 'x', 2000, JSON.stringify([{ function: { name: 'readXcomputerXhistory' } }])]);
    const hide = { excludeSessionsWithTool: 'read_computer_history' };
    expect((await find('alpha')).map((s) => s.id).sort()).toEqual(['alpha-2', 'alpha-session']);
    expect((await find('alpha', hide)).map((s) => s.id)).toEqual(['alpha-2']);
    const direct = await (await import('../seams/runtime.js')).deps().state.readSessionTranscript({
      sessionId: 'alpha-session', userId: 'u1', appId: 'tangu', toolScope: sessionToolScope('alpha'), limit: 10, perMessageChars: 200, charOffset: 0, ...hide,
    });
    expect(direct.session).toBeNull();
    // 工具层:ctx 没有本机 profile / desktop client → 过不了电脑历史门禁 → 自动藏(默认拒)
    expect(String(await read({ session_id: 'alpha-session' }))).toContain('no session');
    expect(String(await read({ session_id: 'alpha-2' }))).toContain('插件发布');
    const out = String(await searchSessionsProvider.tools()[0].execute({ query: '插件' }, ctx()));
    expect(out).toContain('alpha-2'); expect(out).not.toContain('alpha-session');
  });
  it('sessionCalledTool (Historian skip) uses the same match as the recall hide, on both dialects', async () => {
    const { sessionCalledTool } = await import('./sessionSearchSql.js');
    await execute('INSERT INTO chat_messages(id,session_id,role,content,timestamp,tool_calls) VALUES(?,?,?,?,?,?)',
      ['ch-call', 'alpha-session', 'model', 'x', 2000, JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'READ_COMPUTER_HISTORY', arguments: '{}' } }])]);
    await execute('INSERT INTO chat_messages(id,session_id,role,content,timestamp,tool_calls) VALUES(?,?,?,?,?,?)',
      ['near-miss', 'beta-session', 'model', 'x', 2000, JSON.stringify([{ function: { name: 'readXcomputerXhistory' } }])]);
    expect(await sessionCalledTool('alpha-session', 'read_computer_history')).toBe(true);
    expect(await sessionCalledTool('beta-session', 'read_computer_history')).toBe(false); // _ 不是通配
    expect(await sessionCalledTool('legacy', 'read_computer_history')).toBe(false); // tool_calls 为 NULL
  });
  it('pre-cancelled search/read starts no query', async () => {
    const signal = AbortSignal.abort(); sqlCalls.length = 0;
    await expect(find('alpha', { signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(readSessionProvider.tools()[0].execute({ session_id: 'alpha-session' }, { ...ctx(), signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(sqlCalls).toHaveLength(0);
  });
});
