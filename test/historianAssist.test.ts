/**
 * Historian 辅助模式(assist)集成测试:真 SQLite(内存)+ 真注册表(TANGU_HOME 临时目录)+ fake llm/brain,
 * mock agentLoop.enqueueRun(讨论 run 只落库不执行)。
 * 覆盖:第 3 轮触发 → branch 出 kind='discussion' 会话(继承消息)+ 群聊讨论 run 落库(旗标齐全)+
 * 活动流 assist_discussion + listAssistDiscussions 登记 + 标题仍独立更新且 LOG 不由 Historian 写;
 * 首轮(roundN=1)在 assist 配置下仍走独立模式(写 LOG、不起讨论)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { onUserRunDone } from '../src/services/localHistorian.js';

vi.mock('../src/services/agentLoop.js', () => ({ enqueueRun: vi.fn() }));

const USER = 'u1';

let home: string;
let appendedLogs: string[];

function writeConfig(mode: 'independent' | 'assist', everyRounds = 3): void {
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    specialAgents: {
      historian: { enabled: true, modelId: 'm1', everyRounds, firstRoundTrigger: true, mode },
    },
  }), 'utf8');
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-hist-assist-'));
  process.env.TANGU_HOME = home;
  appendedLogs = [];

  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));

  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages }),
    streamProviderCompletion: async () => ({
      content: JSON.stringify({ title: '新标题', log: '不该被独立写入的日志' }),
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    }),
  };
  const fakeBrain: any = {
    llm: fakeLlm,
    users: { getUserById: async () => ({ username: 'u' }) },
    memory: {
      getMemory: async () => ({ content: '旧记忆内容' }),
      getLog: async () => ({ date: 'today', content: '### 09:00\n@dev 既有日志' }),
      appendLogEntry: async (_u: string, text: string) => { appendedLogs.push(text); return { date: 'd', time: 't' }; },
      setMemory: async () => ({}),
    },
  };
  const fakeBilling: any = {
    canConsumeTokenPoints: async () => ({ ok: true }),
    consumeTokenPoints: async () => ({ ok: true }),
    calculateCost: async () => 0,
    logApiUsage: async () => {},
  };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration(); // agent_runs / special_agent_log / muse_todos / session_summaries
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  vi.restoreAllMocks();
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function seedSession(id: string): Promise<void> {
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, 'tangu', '旧标题', 'm1', 'user')`,
    [id, USER],
  );
}

async function seedDoneRuns(sessionId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const id = `${sessionId}-r${i}`;
    await createRun({
      id, sessionId, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${id}-a`,
      input: { message: 'x', userMessageId: `${id}-u`, attachments: [], agentConfig: {} },
    });
    await updateRunStatus(id, 'done');
  }
}

async function seedMessages(sessionId: string): Promise<void> {
  const long = '这是一段足够长的实质对话内容,用来越过 120 字的实质增量地板。'.repeat(4);
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, 1000)`, [`${sessionId}-m1`, sessionId, long]);
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, 'model', ?, 2000)`, [`${sessionId}-m2`, sessionId, long]);
}

describe('Historian assist 模式', () => {
  it('第 3 轮触发:branch 讨论会话 + 群聊 run 落库(旗标齐)+ 活动流/登记;标题独立更新,LOG 不由 Historian 写', async () => {
    writeConfig('assist', 3); // 讨论跟「记忆」周期:memory 每 3 轮 → roundN=3 时 memoryDue 拉起讨论
    await seedSession('S');
    await seedMessages('S');
    await seedDoneRuns('S', 3);

    await onUserRunDone('S', USER);

    // 标题仍由 Historian 独立维护
    const s = await query<any[]>(`SELECT title FROM chat_sessions WHERE id = 'S'`);
    expect(s[0].title).toBe('新标题');
    // LOG 未被 Historian 独立写入(交由讨论中的主 Agent 定夺)
    expect(appendedLogs).toEqual([]);

    // branch 出的讨论会话:kind='discussion',parent_session_id 指回主会话(Background Session 统一链接),继承了消息
    const disc = await query<any[]>(`SELECT id, title, kind, parent_session_id FROM chat_sessions WHERE kind = 'discussion'`);
    expect(disc.length).toBe(1);
    expect(String(disc[0].title)).toContain('记忆维护');
    expect(disc[0].parent_session_id).toBe('S');
    const copied = await query<any[]>(`SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?`, [disc[0].id]);
    expect(Number(copied[0].n)).toBe(2);

    // 讨论 run 落库:群聊旗标齐全,Historian 先发言,sandbox
    const runs = await query<any[]>(`SELECT id, input FROM agent_runs WHERE session_id = ?`, [disc[0].id]);
    expect(runs.length).toBe(1);
    const input = typeof runs[0].input === 'string' ? JSON.parse(runs[0].input) : runs[0].input;
    const ac = input.agentConfig;
    expect(ac.groupChat).toBe(true);
    expect(ac.groupNoSummary).toBe(true);
    expect(ac.groupSeedHistory).toBe(true);
    expect(ac.execMode).toBe('sandbox');
    expect(ac.groupAgents).toHaveLength(2);
    expect(ac.groupAgents[0]).toBe('xyra'); // 会话无 agentSlug → 默认 agent
    expect(String(ac.groupAgents[1])).toMatch(/^historian-/);
    expect(ac.priorityAgent).toBe(ac.groupAgents[1]);
    expect(String(ac.groupTempAgents[0].model)).toBe('m1');
    // 开场白带当前记忆/今日日志
    expect(String(input.message)).toContain('旧记忆内容');
    expect(String(input.message)).toContain('既有日志');

    // 活动流
    const act = await query<any[]>(`SELECT action, session_ref FROM special_agent_log WHERE agent = 'historian' AND action = 'assist_discussion'`);
    expect(act.length).toBe(1);
    expect(act[0].session_ref).toBe('S');

    // 子聊天面板的持久事实来源(GET /agent/sessions/:id/background 同款查询):按父链接列出 + 最新 run
    const bg = await query<any[]>(
      `SELECT id, kind FROM chat_sessions WHERE parent_session_id = 'S' AND user_id = ? AND kind != 'user' ORDER BY created_at DESC`,
      [USER],
    );
    expect(bg.length).toBe(1);
    const bgRun = await query<any[]>(`SELECT id, status FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`, [bg[0].id]);
    expect(bgRun[0].id).toBe(runs[0].id);
    expect(bgRun[0].status).toBe('queued'); // enqueueRun 被 mock,run 停在落库初态
  });

  it('未到期轮什么都不做(周期合一:标题+记忆同一节奏,每 everyRounds 轮)', async () => {
    writeConfig('assist', 5); // 每 5 轮 → roundN=3 不到期
    await seedSession('S2');
    await seedMessages('S2');
    await seedDoneRuns('S2', 3);

    await onUserRunDone('S2', USER);

    const s = await query<any[]>(`SELECT title FROM chat_sessions WHERE id = 'S2'`);
    expect(s[0].title).not.toBe('新标题'); // 标题未动
    expect(appendedLogs).toEqual([]);
    const disc = await query<any[]>(`SELECT id FROM chat_sessions WHERE kind = 'discussion'`);
    expect(disc.length).toBe(0);
  });

  it('首轮(roundN=1)在 assist 配置下仍走独立模式:写 LOG、不起讨论', async () => {
    writeConfig('assist');
    await seedSession('S1');
    await seedMessages('S1');
    await seedDoneRuns('S1', 1); // roundN=1 → firstRoundTrigger 全触发,但 assist 不参与首轮

    await onUserRunDone('S1', USER);

    expect(appendedLogs.length).toBe(1); // 独立模式写了 LOG
    const disc = await query<any[]>(`SELECT id FROM chat_sessions WHERE kind = 'discussion'`);
    expect(disc.length).toBe(0);
  });
});
