/**
 * 标题 / 摘要跟随对话本身的语言(10-20:英文对话被 Historian 写成中文;判官输入一个汉字都没有也会,提示词压不住模型的先验)。
 * 钉:① offScript 的判据(混写放行、没字母不判);② 首帧标题:先给中文 → 改写成英文再落库,两次都中文 → 不落;
 * ③ done 判官:中文标题 / 摘要 → 各改写一次落英文;中文对话照旧中文、不多调用。真 SQLite + 逐调用脚本化的假模型。
 * 真模型那半:live 台架 `--only titlelang`。
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
import { createRun, updateRunStatus } from '../src/services/runStore.js';
import { onUserRunDone, onUserRunStart, resetHistorianConsolidationState } from '../src/services/localHistorian.js';
import { offScript } from '../src/core/scriptCheck.js';

const USER = 'u1';
const EN = "I'm making a notebook for my travel photos and want them to look consistent. What's a simple editing workflow for a beginner? ".repeat(2);
const ZH = '我在给旅行照片做一本笔记,想让它们风格统一。新手有什么简单的修图流程?'.repeat(3);
let home: string;
let script: string[];
let payloads: any[];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-title-lang-'));
  process.env.TANGU_HOME = home;
  script = [];
  payloads = [];
  resetHistorianConsolidationState();
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const brain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages, thinkingLevel: o.thinkingLevel }),
      streamProviderCompletion: async (o: any) => { payloads.push(o.payload); return { content: script.shift() || '', usage: { prompt_tokens: 1, completion_tokens: 1 } }; },
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

const row = async (id = 'S') => (await query<any[]>(`SELECT title, summary FROM chat_sessions WHERE id = ?`, [id]))[0];

async function seedDoneRound(user: string, reply: string): Promise<void> {
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('m1', 'S', 'user', ?, 1000), ('m2', 'S', 'model', ?, 2000)`, [user, reply]);
  await createRun({ id: 'R1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1', input: { message: 'x', userMessageId: 'U1', attachments: [], agentConfig: {} } });
  await updateRunStatus('R1', 'done');
}

describe('offScript', () => {
  it('英文对话出中文 / 俄语 = 写错;同一书写系统、混写、没字母都放行', () => {
    expect(offScript('旅行照片编辑流程', EN)).toBe(true);
    expect(offScript('Получила простой workflow', EN)).toBe(true);
    expect(offScript('Travel photo workflow', EN)).toBe(false);
    expect(offScript('SQLite WAL 模式介绍', '讲讲 SQLite 的 WAL 模式')).toBe(false); // 中文里夹英文术语
    expect(offScript('Slogan ideas', '帮我想几个 slogan')).toBe(false);
    expect(offScript('旅行修图', ZH)).toBe(false);
    expect(offScript('Photo', '👍👍')).toBe(false); // 用户没写字
  });
});

describe('首帧标题', () => {
  // 每条用自己的会话:首帧那一路按「会话:轮」记在模块级表里,同一个 S 会让后面判官那组以为标题已经起过了
  let sid = '';
  beforeEach(async () => {
    sid = `E${Math.random().toString(36).slice(2)}`;
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, 'tangu', 'New Chat', 'm1', 'user')`, [sid, USER]);
  });
  const start = (message: string) => new Promise<string | null>((resolve) => {
    onUserRunStart(sid, USER, message, undefined, (t) => resolve(t));
    setTimeout(() => resolve(null), 1500);
  });

  it('先给中文 → 照用户原话改写一次,落英文', async () => {
    script = ['旅行照片编辑流程', 'Travel Photo Editing Workflow'];
    expect(await start(EN)).toBe('Travel Photo Editing Workflow');
    expect((await row(sid)).title).toBe('Travel Photo Editing Workflow');
    expect(payloads).toHaveLength(2);
    expect(payloads[1].thinkingLevel).toBe('low');
    expect(payloads[1].messages[1].content).toContain("[User's own words]");
  });

  it('改写后还是中文 → 不落,留给 done 判官', async () => {
    script = ['旅行照片编辑流程', '旅行照片编辑'];
    expect(await start(EN)).toBeNull();
    expect((await row(sid)).title).toBe('New Chat');
    expect(payloads).toHaveLength(2);
  });

  it('中文对话出中文标题:不改写', async () => {
    script = ['旅行照片修图流程'];
    expect(await start(ZH)).toBe('旅行照片修图流程');
    expect(payloads).toHaveLength(1);
  });
});

describe('done 判官', () => {
  it('英文对话:中文标题与摘要各改写一次,落英文;判官提示带用户原话当语言参照', async () => {
    await seedDoneRound(EN, 'Edit one reference photo first, then reuse those settings across the rest of the notebook. '.repeat(3));
    script = [
      JSON.stringify({ title: '旅行照片编辑流程', summary: '为旅行照片整理了一套新手编辑流程。', log: '', memory_candidates: [] }),
      'Travel Photo Editing Workflow',
      'Set up a beginner workflow for editing travel photos consistently.',
    ];
    await onUserRunDone('S', USER);
    expect(await row()).toEqual({ title: 'Travel Photo Editing Workflow', summary: 'Set up a beginner workflow for editing travel photos consistently.' });
    expect(payloads).toHaveLength(3);
    expect(payloads[0].messages.at(-1).content).toContain("Language reference — the user's own words: «");
  });

  it('英文对话:改写失败 → 标题 / 摘要都不写', async () => {
    await seedDoneRound(EN, 'Edit one reference photo first, then reuse those settings across the rest of the notebook. '.repeat(3));
    script = [JSON.stringify({ title: '旅行照片编辑流程', summary: '为旅行照片整理了一套新手编辑流程。', log: '', memory_candidates: [] }), '还是中文', '还是中文的摘要内容'];
    await onUserRunDone('S', USER);
    expect(await row()).toEqual({ title: 'New Chat', summary: null });
  });

  it('中文对话照旧中文,不多调用', async () => {
    await seedDoneRound(ZH, '先修一张参考照,再把同样的参数套到其余照片上,最后整页检查一遍色调是否协调。'.repeat(2));
    script = [JSON.stringify({ title: '旅行照片修图流程', summary: '为旅行照片整理了一套新手修图流程。', log: '', memory_candidates: [] })];
    await onUserRunDone('S', USER);
    expect(await row()).toEqual({ title: '旅行照片修图流程', summary: '为旅行照片整理了一套新手修图流程。' });
    expect(payloads).toHaveLength(1);
  });
});
