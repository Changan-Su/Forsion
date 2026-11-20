/** 压缩检查点的同毫秒邻行(through_peer_ids,11-20):与边界同一毫秒、整行进了摘要的其他行记进清单,压缩 / 回放 / /usage /
 *  窗口外惰性检查点共用 rowCoverage 这一把尺。真 SQLite(内存库)+ 真压缩,不 mock 查询。
 *  场景来源:中止一轮时半截回答 a1 与打断标记 m1 本机实测 20 次里 11 次同一毫秒(#778)。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { boundaryGrows, compactSession, getLatestSummary, normalizePeerIds, parsePeerIds, persistCheckpoint, rowCoverage, PEER_IDS_MAX } from './compaction.js';
import { rowsFromBoundary, sessionContextTokens } from '../routes/sessions.js';
import { checkpointRowsOutsideWindow, hydrateHistory } from './agentLoop.js';
import { DEFAULT_COMPACTION_SETTINGS } from './compactionSettings.js';

const TS = 1_795_000_000_000;
let home: string;
let summaryCalls = 0;

const session = (id: string) => query(
  `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, 'u1', 'tangu', ?, 'm1', 'user')`, [id, id],
);
const msg = (id: string, sessionId: string, role: 'user' | 'model', content: string, ts: number, extra: { calls?: any[]; results?: any[] } = {}) => query(
  `INSERT INTO chat_messages (id, session_id, role, content, timestamp, tool_calls, tool_results) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [id, sessionId, role, content, ts, extra.calls ? JSON.stringify(extra.calls) : null, extra.results ? JSON.stringify(extra.results) : null],
);
const call = (id: string) => ({ id, type: 'function', function: { name: 'todo_read', arguments: '{}' } });
const result = (id: string) => ({ tool_call_id: id, name: 'todo_read', content: `${id} result` });
/** 中止的那一轮:半截回答(带一个工具调用,回放出来是两条消息)落库后紧跟打断标记,两行同一毫秒 */
async function abortedTurn(sessionId: string) {
  await msg('u1', sessionId, 'user', 'Explain the plan in detail', TS);
  await msg('a1', sessionId, 'model', 'The plan has three parts. First', TS + 50, { calls: [call('c1')], results: [result('c1')] });
  await msg('m1', sessionId, 'user', '[The previous turn was interrupted by the user]', TS + 50);
}
const summaryRows = async (sessionId: string) => query<any[]>(`SELECT * FROM session_summaries WHERE session_id = ?`, [sessionId]);

beforeEach(async () => {
  summaryCalls = 0;
  home = mkdtempSync(join(tmpdir(), 'tangu-peers-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: [] }),
    brain: {
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', contextWindow: 128_000 }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
        streamProviderCompletion: async () => {
          summaryCalls++;
          return { content: `## Goal\nThe user asked a question and stopped the answer halfway (summary ${summaryCalls}).`, toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        },
      },
      users: { getUserById: async () => ({ id: 'u1', username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false },
    } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
  });
  await runMigration();
});
afterEach(() => { delete process.env.TANGU_HOME; rmSync(home, { recursive: true, force: true }); });

describe('同一毫秒的邻行进清单', () => {
  it('中止后 /compact:半截回答记成邻行 → 回放不再重复、/usage 换成压缩后的数', async () => {
    await session('S');
    await abortedTurn('S');
    expect((await compactSession('S', 'm1')).ok).toBe(true);
    const cp = await getLatestSummary('S');
    expect(cp?.throughMessageId).toBe('m1');
    expect(cp?.throughPeerIds).toEqual(['a1']);
    expect(rowCoverage({ id: 'a1', timestamp: TS + 50 }, cp)).toBe('covered');
    // 回放:只剩一条摘要,半截回答不再原样回来
    const h = await hydrateHistory('S', 'none');
    expect(h.messages.map((m: any) => String(m.content || ''))).not.toContain('The plan has three parts. First');
    expect(h.checkpointThrough.peerIds).toEqual(['a1']);
    // /usage:边界及之后的行全部已覆盖 → 报「摘要 + 固定头」的粗估
    const tail = await rowsFromBoundary('S', cp);
    expect(tail?.map((r) => r.id).sort()).toEqual(['a1', 'm1']);
    expect(sessionContextTokens({ prompt: 90_000 }, cp, tail)).toBeLessThan(90_000);
  });

  it('接着再压一次:没有没覆盖的行 → nothing to compact,锚点不换、环不翻', async () => {
    await session('S');
    await abortedTurn('S');
    await compactSession('S', 'm1');
    const r = await compactSession('S', 'm1');
    expect(r).toMatchObject({ ok: false, reason: 'nothing to compact' });
    const cp = await getLatestSummary('S');
    expect(cp?.throughMessageId).toBe('m1');
    expect(await summaryRows('S')).toHaveLength(1);
    expect(sessionContextTokens({ prompt: 90_000 }, cp, await rowsFromBoundary('S', cp))).toBeLessThan(90_000);
  });

  it('检查点落下之后才在同一毫秒落库的行(晚到的插话)不在清单里 → 照样回放,/usage 照样报实测', async () => {
    await session('S');
    await abortedTurn('S');
    await compactSession('S', 'm1');
    // 回放出来两条消息(带工具调用的一段),这样下面再压一次时够「两条」的门槛
    await msg('late', 'S', 'model', 'Actually focus on part two', TS + 50, { calls: [call('c9')], results: [result('c9')] });
    const cp = await getLatestSummary('S');
    expect(rowCoverage({ id: 'late', timestamp: TS + 50 }, cp)).toBe('uncovered');
    const h = await hydrateHistory('S', 'none');
    expect(h.messages.map((m: any) => m.content)).toContain('Actually focus on part two');
    expect(sessionContextTokens({ prompt: 90_000 }, cp, await rowsFromBoundary('S', cp))).toBe(90_000);
    // 再压一次:晚到的那行进摘要,同一时间戳原地扩成超集(不另插一行)
    expect((await compactSession('S', 'm1')).ok).toBe(true);
    const next = await getLatestSummary('S');
    expect(await summaryRows('S')).toHaveLength(1);
    expect(next?.throughTimestamp).toBe(TS + 50);
    expect(new Set([next!.throughMessageId, ...(next!.throughPeerIds ?? [])])).toEqual(new Set(['a1', 'm1', 'late']));
  });

  it('老检查点(没有清单)照旧:同毫秒邻行判没覆盖、原样回放', async () => {
    await session('S');
    await abortedTurn('S');
    await query(`INSERT INTO session_summaries (id, session_id, summary, through_timestamp, through_message_id) VALUES ('old', 'S', 'old summary', ?, 'm1')`, [TS + 50]);
    const cp = await getLatestSummary('S');
    expect(cp?.throughPeerIds).toBeUndefined();
    expect(rowCoverage({ id: 'a1', timestamp: TS + 50 }, cp)).toBe('uncovered');
    expect(sessionContextTokens({ prompt: 90_000 }, cp, await rowsFromBoundary('S', cp))).toBe(90_000);
    // 坏 JSON 当空(保守),不当成「全都覆盖」
    await query(`UPDATE session_summaries SET through_peer_ids = 'not json' WHERE id = 'old'`);
    expect(rowCoverage({ id: 'a1', timestamp: TS + 50 }, await getLatestSummary('S'))).toBe('uncovered');
  });

  it('/usage:边界之后一行也查不到(没有锚点那一行)→ 报实测,不把空集合当成「全部已覆盖」', async () => {
    const cp = { id: 'x', summary: 's', throughTimestamp: TS, throughMessageId: 'gone', throughPeerIds: ['a'] };
    expect(sessionContextTokens({ prompt: 300_000 }, cp, [])).toBe(300_000);
    expect(sessionContextTokens({ prompt: 300_000 }, cp, undefined)).toBe(300_000);
    expect(sessionContextTokens({ prompt: 300_000 }, cp, [{ id: 'a', timestamp: TS }])).toBe(300_000); // 缺锚点
  });
});

describe('单调规则:同一时间戳只许原地扩成超集', () => {
  it('非超集被拒;超集原地更新;更早的时间戳被拒', async () => {
    await session('S');
    await abortedTurn('S');
    expect(await persistCheckpoint('S', 'first summary', { ts: TS + 50, messageId: 'm1', peerIds: ['a1'] })).toBe(true);
    // 换锚点却丢了 m1(11-20 之前这里会另插一行,两份轮流当最新 → 翻环)
    expect(await persistCheckpoint('S', 'flip', { ts: TS + 50, messageId: 'a1' })).toBe(false);
    // 换锚点、整行集合不减 → 原地替换
    expect(await persistCheckpoint('S', 'grown', { ts: TS + 50, messageId: 'a1', peerIds: ['m1'] })).toBe(true);
    expect(await summaryRows('S')).toHaveLength(1);
    expect((await getLatestSummary('S'))?.summary).toBe('grown');
    expect(await persistCheckpoint('S', 'older', { ts: TS, messageId: 'u1' })).toBe(false);
  });

  it('旧锚点是行内切点:新边界整行覆盖它 / 同锚点切点不前挪 → 可以;切点往前挪 / 丢掉它 → 不行', async () => {
    const ord = async (_m: string, c: string) => ['c1', 'c2', 'c3'].indexOf(c);
    const prev = { throughMessageId: 'a1', throughToolCallId: 'c2', throughPeerIds: ['u9'] };
    expect(await boundaryGrows(prev, { messageId: 'a1', peerIds: ['u9'] }, ord)).toBe(true);
    expect(await boundaryGrows(prev, { messageId: 'a1', toolCallId: 'c3', peerIds: ['u9'] }, ord)).toBe(true);
    expect(await boundaryGrows(prev, { messageId: 'a1', toolCallId: 'c1', peerIds: ['u9'] }, ord)).toBe(false);
    expect(await boundaryGrows(prev, { messageId: 'm1', peerIds: ['u9', 'a1'] }, ord)).toBe(true);
    expect(await boundaryGrows(prev, { messageId: 'm1', peerIds: ['u9'] }, ord)).toBe(false); // a1 掉回没覆盖
    expect(await boundaryGrows(prev, { messageId: 'a1', peerIds: [] }, ord)).toBe(false); // u9 掉回没覆盖
    expect(await boundaryGrows({ throughMessageId: undefined }, { messageId: 'a1', peerIds: [] }, ord)).toBe(false); // 老语义不动
  });

  it('清单:去重、去锚点、保持先后、封顶时先保住前面那张(旧集合)', () => {
    expect(normalizePeerIds('m1', ['a1', 'm1'], ['a1', 'b1'])).toEqual(['a1', 'b1']);
    const many = Array.from({ length: PEER_IDS_MAX + 10 }, (_, i) => `r${i}`);
    const out = normalizePeerIds('m1', ['old'], many);
    expect(out).toHaveLength(PEER_IDS_MAX);
    expect(out[0]).toBe('old');
    expect(parsePeerIds('["a",1,""]')).toEqual(['a']);
    expect(parsePeerIds('{}')).toBeUndefined();
    expect(parsePeerIds(null)).toBeUndefined();
  });
});

describe('窗口外惰性检查点', () => {
  it('窗口外最后一行与边界同一毫秒、邻行已在清单里 → 不再重压', async () => {
    await session('S');
    // 60 行:下个 run 的窗口起点 = 20,窗口外 = 前 20 行;第 19、20 行(下标 18、19)同一毫秒,前者带工具调用
    for (let i = 0; i < 60; i++) {
      const ts = TS + (i === 19 ? 18 : i) * 10;
      if (i === 18) await msg(`r${i}`, 'S', 'model', `answer ${i}`, ts, { calls: [call(`c${i}`)], results: [result(`c${i}`)] });
      else await msg(`r${i}`, 'S', i % 2 ? 'model' : 'user', `line ${i}`, ts);
    }
    expect(await persistCheckpoint('S', 'covers the first twenty rows', { ts: TS + 180, messageId: 'r19', peerIds: ['r18'] })).toBe(true);
    await checkpointRowsOutsideWindow('S', 'm1', 'tangu', DEFAULT_COMPACTION_SETTINGS, 'off');
    expect(summaryCalls).toBe(0);
    expect(await summaryRows('S')).toHaveLength(1);
  });
});
