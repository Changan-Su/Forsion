/**
 * 首帧标题与前端占位标题抢写(10-29:标题停在用户第一句的前 30 字)。
 * 桌面 / 网页发出第一句后,`renameSession(text.slice(0, 30))` 先给会话一个占位标题;引擎首帧那一路此前已读到 New Chat,
 * 模型起好标题后 CAS 对不上 → 当成用户手改、不写,还告诉 done 判官「标题已起过」→ 这一轮标题就停在占位。
 * 钉:占位(= 用户原话前 30 字)算没起过名,照写;用户真改成别的仍不覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { onUserRunStart, resetHistorianConsolidationState } from '../src/services/localHistorian.js';

const USER = 'u1';
const MSG = '[[/Users/me/Notes/Quantum Mechanics 3.md|QM3]] 我在复习升降算符,除了角动量还有别的吗?';
const SPACED = 'Please explain quantum theory and angular momentum'; // 前 30 字以空格结尾,PATCH 会 trim 掉
let home: string;
let midCall: (() => Promise<void>) | null;
let reply = '升降算符的推广';

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-title-race-'));
  process.env.TANGU_HOME = home;
  midCall = null;
  reply = '升降算符的推广';
  resetHistorianConsolidationState();
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const brain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages }),
      // 模型还在想的时候,前端把占位标题写进来
      streamProviderCompletion: async () => { await midCall?.(); return { content: reply, usage: { prompt_tokens: 1, completion_tokens: 1 } }; },
    },
    users: { getUserById: async () => ({ username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }), getLog: async () => ({ date: 'd', content: '' }), appendLogEntry: async () => ({ date: 'd', time: 't' }), setMemory: async () => ({}) },
  };
  const billing: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain, billing, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    specialAgents: { historian: { enabled: true, modelId: 'm1', everyRounds: 3, firstRoundTrigger: true, mode: 'independent', autoEmoji: false } },
  }), 'utf8');
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 'New Chat', 'm1', 'user')`, [USER]);
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const title = async () => (await query<any[]>(`SELECT title FROM chat_sessions WHERE id = 'S'`))[0].title;
const start = (msg = MSG) => new Promise<string | null>((resolve) => {
  onUserRunStart('S', USER, msg, undefined, (t) => resolve(t));
  setTimeout(() => resolve(null), 1500);
});
const renameTo = (t: string) => async () => { await query(`UPDATE chat_sessions SET title = ? WHERE id = 'S'`, [t]); };

describe('首帧标题 × 前端占位标题', () => {
  it('占位标题在模型起名途中写进来 → 照样换成模型起的标题', async () => {
    midCall = renameTo(MSG.slice(0, 30));
    expect(await start()).toBe('升降算符的推广');
    expect(await title()).toBe('升降算符的推广');
  });

  it('占位被 PATCH trim 过(前 30 字以空格结尾)→ 也认得', async () => {
    reply = 'Quantum angular momentum';
    midCall = renameTo(SPACED.slice(0, 30).trim());
    expect(await start(SPACED)).toBe('Quantum angular momentum');
    expect(await title()).toBe('Quantum angular momentum');
  });

  it('起点已有标题的轮次:用户途中改成与原话前 30 字相同 → 不覆盖', async () => {
    await query(`UPDATE chat_sessions SET title = '旧标题' WHERE id = 'S'`);
    midCall = renameTo(MSG.slice(0, 30));
    expect(await start()).toBeNull();
    expect(await title()).toBe(MSG.slice(0, 30));
  });

  it('用户途中真改了标题 → 不覆盖', async () => {
    midCall = renameTo('我的复习');
    expect(await start()).toBeNull();
    expect(await title()).toBe('我的复习');
  });
});
