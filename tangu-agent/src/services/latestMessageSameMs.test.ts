/** 「本会话最新的那条」几处查询在同一毫秒并列时要认最后落库的那条(#762 的同类):timestamp 只到毫秒,
 *  只按它排时并列先后没有保证(现在的索引下 SQLite 实测把同毫秒里最早落库的那条排在 DESC 最前面)。真 SQLite(内存库)+ 真压缩,不 mock 查询。
 *  本机文件库实测:中止一轮时半截回答与打断标记 20 次里 11 次同毫秒 —— /usage 那处是真能走到的。 */
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
import { compactSession, getLatestSummary } from './compaction.js';
import { lastMessageRow, listMessagesPage, sessionContextTokens } from '../routes/sessions.js';
import { recentTranscript } from './localHistorian.js';
import { TURN_INTERRUPTED_MARKER } from './agentLoop.js';
import { saveAside } from './aside.js';
import { branchesSection } from './branchContext.js';
import { branchSession } from './sessionBranch.js';

const TS = 1_795_000_000_000;
let home: string;

const session = (id: string, extra: { parent?: string; fork?: string; title?: string } = {}) => query(
  `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, parent_session_id, fork_message_id) VALUES (?, 'u1', 'tangu', ?, 'm1', 'user', ?, ?)`,
  [id, extra.title ?? id, extra.parent ?? null, extra.fork ?? null],
);
const msg = (id: string, sessionId: string, role: 'user' | 'model', content: string, ts: number) => query(
  `INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)`, [id, sessionId, role, content, ts],
);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-same-ms-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, profile: createTanguProfile({ sandboxMode: 'none', toolBuiltins: [] }),
    brain: {
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', contextWindow: 128_000 }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
        streamProviderCompletion: async () => ({ content: '## Goal\nThe user asked a question and stopped the answer halfway.', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' }),
      },
      users: { getUserById: async () => ({ id: 'u1', username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false },
    } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
  });
  await runMigration();
});
afterEach(() => { delete process.env.TANGU_HOME; rmSync(home, { recursive: true, force: true }); });

describe('同一毫秒落库的几行:认最后落库的那条', () => {
  it('/usage:中止后手动压缩 → 环按压缩后的数显示(检查点边界与「最后一行」认的是同一条)', async () => {
    await session('S');
    await msg('u1', 'S', 'user', 'Explain the plan in detail', TS);
    // 中止的那一轮:半截回答落库后紧跟一条打断标记,两行同一毫秒
    await msg('a1', 'S', 'model', 'The plan has three parts. First', TS + 50);
    await msg('m1', 'S', 'user', '[The previous turn was interrupted by the user]', TS + 50);
    const r = await compactSession('S', 'm1');
    expect(r.ok).toBe(true);
    const cp = await getLatestSummary('S');
    expect(cp?.throughMessageId).toBe('m1'); // 压缩按升序走到的最后一行 = 同毫秒里最后落库的那条
    const last = await lastMessageRow('S');
    const lastUsage = { prompt: 90_000 }; // 压缩前那次 run 的实测占用
    expect(sessionContextTokens(lastUsage, cp, last)).toBeLessThan(90_000); // 认错成 a1 → 判成没覆盖 → 回落 90000
    expect(last?.id).toBe('m1');
  });

  it('旁注没给挂哪条:挂在最后落库的那条回答上,不挂同毫秒里更早的那条', async () => {
    await session('S');
    await msg('u1', 'S', 'user', 'q', TS);
    await msg('a1', 'S', 'model', 'first answer', TS + 1);
    await msg('a2', 'S', 'model', 'second answer', TS + 1);
    const saved = await saveAside({ sessionId: 'S', userId: 'u1', turn: { question: 'why?', answer: 'because' }, thread: [] });
    expect(saved?.messageId).toBe('a2');
  });

  it('分支只复制最近 N 条(Historian 协助讨论 lastN=30):名额给最后落库的,同毫秒几行在新会话里先后不变', async () => {
    await session('S');
    await msg('u1', 'S', 'user', 'q', TS);
    await msg('x1', 'S', 'model', 'x1', TS + 5);
    await msg('x2', 'S', 'user', 'x2', TS + 5);
    await msg('x3', 'S', 'model', 'x3', TS + 5);
    const b = await branchSession({ sourceSessionId: 'S', userId: 'u1', appId: 'tangu', messageId: 'x3', kind: 'discussion', lastN: 2, parentSessionId: 'S' });
    const copied = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = ? ORDER BY rowid`, [b!.id]);
    expect(copied.map((r) => r.content)).toEqual(['x2', 'x3']);
  });

  it('分支段:别的支「最后一句」取最后落库的那条回答', async () => {
    await session('root');
    await msg('r-u', 'root', 'user', 'start', TS);
    await msg('r-a', 'root', 'model', 'root answer', TS + 1);
    await session('B', { parent: 'root', fork: 'r-a', title: 'Side' });
    await msg('b-u', 'B', 'user', 'go on', TS + 10);
    await msg('b-a1', 'B', 'model', 'older reply on the branch', TS + 20);
    await msg('b-a2', 'B', 'model', 'newest reply on the branch', TS + 20);
    const section = await branchesSection('root', 'u1');
    expect(section).toContain('newest reply on the branch');
    expect(section).not.toContain('older reply on the branch');
  });
});

describe('同一毫秒落库的几行:按时间正序列出时保持落库先后', () => {
  it('消息列表:中止那轮的半截回答排在打断标记前面', async () => {
    await session('S');
    await msg('u1', 'S', 'user', 'Explain the plan in detail', TS);
    await msg('a1', 'S', 'model', 'The plan has three parts. First', TS + 50);
    await msg('m1', 'S', 'user', TURN_INTERRUPTED_MARKER, TS + 50);
    expect((await listMessagesPage('S', 200)).map((r) => r.id)).toEqual(['u1', 'a1', 'm1']);
  });

  it('消息列表翻页(照 desktop listAllMessages:游标 = 最早一条 +1、按 id 去重):同毫秒组跨页也不乱序、不漏行', async () => {
    await session('S');
    await msg('u0', 'S', 'user', 'Zero', TS - 10);
    await msg('u1', 'S', 'user', 'One', TS);
    await msg('s1', 'S', 'user', 'Steer one', TS + 20);
    await msg('s2', 'S', 'user', 'Steer two', TS + 20);
    await msg('a1', 'S', 'model', 'Answer one', TS + 30);
    await msg('a2', 'S', 'model', 'Answer two', TS + 40);
    const PAGE = 3; // 同毫秒组(2 行)小于一页:整页同毫秒是客户端已知的「游标走不动」,另说
    let all: any[] = [];
    for (let i = 0; i < 10; i++) {
      const before = Number(all[0]?.timestamp) + 1 || 0;
      const batch = await listMessagesPage('S', PAGE, before);
      const seen = new Set(all.map((m) => m.id));
      all = [...batch.filter((m) => !seen.has(m.id)), ...all];
      if (batch.length < PAGE) break;
    }
    expect(all.map((m) => m.id)).toEqual(['u0', 'u1', 's1', 's2', 'a1', 'a2']);
  });

  it('Historian 判官读的近况:半截回答在前、打断标记在后', async () => {
    await session('S');
    await msg('u1', 'S', 'user', 'Explain the plan in detail', TS);
    await msg('a1', 'S', 'model', 'The plan has three parts. First', TS + 50);
    await msg('m1', 'S', 'user', 'Actually, stop', TS + 50);
    const t = await recentTranscript('S');
    expect(t.text).toBe('User: Explain the plan in detail\nAssistant: The plan has three parts. First\nUser: Actually, stop');
    expect(t.anchorMessageId).toBe('m1');
  });
});

describe('chat history windows', () => {
  it('checks for a steer on the next page before restoring a failed answer', async () => {
    const { chatHistoryPage } = await import('./chatHistoryPage.js');
    await session('S');
    await msg('u', 'S', 'user', 'question', TS);
    await msg('a', 'S', 'model', 'partial', TS + 1);
    await query(`INSERT INTO agent_runs (id, session_id, user_id, status, assistant_message_id, input)
      VALUES ('r', 'S', 'u1', 'failed', 'a', ?)`, [JSON.stringify({ userMessageId: 'u' })]);
    expect((await chatHistoryPage('S', 1, {})).failed[0]?.assistant_message_id).toBe('a');
    await msg('steer', 'S', 'user', 'wait', TS + 2);
    expect((await chatHistoryPage('S', 1, { beforeId: 'a' })).failed).toEqual([]);
  });
  it('opens the tail, pages in both directions and anchors inside same-millisecond siblings', async () => {
    const { chatHistoryPage } = await import('./chatHistoryPage.js');
    await session('S');
    await session('other');
    for (let i = 0; i < 260; i++) await msg('m' + i, 'S', i % 2 ? 'model' : 'user', 'row ' + i, TS);
    const tail = await chatHistoryPage('S', 24, {});
    expect(tail.page.ids).toEqual(Array.from({ length: 24 }, (_, i) => 'm' + (236 + i)));
    const older = await chatHistoryPage('S', 24, { beforeId: 'm236' });
    expect(older.page.ids[0]).toBe('m212');
    const around = await chatHistoryPage('S', 24, { aroundId: 'm31' });
    expect(around.page.ids[12]).toBe('m31');
    expect((await chatHistoryPage('S', 24, { afterId: around.page.ids.at(-1) })).page.ids[0]).toBe('m43');
    expect((await chatHistoryPage('other', 24, { aroundId: 'm31' })).page.missing).toBe(true);
    expect((await chatHistoryPage('S', 24, { known: tail.page.versions })).rows).toEqual([]);
    await query('UPDATE chat_messages SET content = ? WHERE id = ?', ['ROW 258', 'm258']);
    await query('DELETE FROM chat_messages WHERE id = ?', ['m240']);
    await msg('new', 'S', 'model', 'next reply', TS);
    const changed = await chatHistoryPage('S', 24, { known: tail.page.versions });
    expect(changed.rows.map(m => m.id)).toEqual(['m258', 'new']);
    expect(changed.page.removed).toEqual(['m240']);
  });
});
