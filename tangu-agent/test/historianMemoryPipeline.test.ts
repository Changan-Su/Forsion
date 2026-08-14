/**
 * Historian 记忆两阶段流水线(借 Codex:采集 → 整固)集成测试:
 * 真 SQLite(内存)+ TANGU_HOME 临时目录 + fake llm(逐调用脚本)/brain。
 * 覆盖:候选采集(No-op 门/脱敏/不动正典)→ 攒批触发整固(去重合并→setMemory→raw 清场)→
 * NOCHANGE 消费 → 缩水守卫不消费 → 过期(stale)触发。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, updateRunStatus } from '../src/services/runStore.js';
import { onUserRunDone, parseRawLines, redactSecrets, resetHistorianConsolidationState } from '../src/services/localHistorian.js';
import { agentsDir, DEFAULT_AGENT_SLUG } from '../src/core/tanguHome.js';

const USER = 'u1';

let home: string;
let llmScript: (string | { content: string; finishReason?: string })[];
let llmPayloads: any[];
let setMemoryCalls: string[];
let memContent: string;
let memQueue: string[]; // 非空则 getMemory 逐次 shift(模拟并发修改);空则恒返 memContent
let memThrow: boolean;

function rawFile(): string {
  return join(agentsDir(), DEFAULT_AGENT_SLUG, '.memory-raw.md');
}

function seedRaw(lines: string[]): void {
  mkdirSync(dirname(rawFile()), { recursive: true });
  writeFileSync(rawFile(), lines.join('\n') + '\n', 'utf8');
}

const today = (): string => new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-hist-mem-'));
  process.env.TANGU_HOME = home;
  llmScript = [];
  llmPayloads = [];
  setMemoryCalls = [];
  memContent = '- 旧条目:用户在学线性代数';
  memQueue = [];
  memThrow = false;
  resetHistorianConsolidationState();

  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));

  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages }),
      streamProviderCompletion: async (o: any) => {
        llmPayloads.push(o.payload);
        const next = llmScript.shift() || '';
        const r = typeof next === 'string' ? { content: next } : next;
        return { content: r.content, finishReason: r.finishReason, usage: { prompt_tokens: 5, completion_tokens: 5 } };
      },
    },
    users: { getUserById: async () => ({ username: 'u' }) },
    memory: {
      getMemory: async () => {
        if (memThrow) throw new Error('transient read failure');
        return { content: memQueue.length ? memQueue.shift()! : memContent };
      },
      getLog: async () => ({ date: 'today', content: '' }),
      appendLogEntry: async () => ({ date: 'd', time: 't' }),
      // 记录并回写 memContent:连续整固语义可被验证(第二次整固读到第一次的产出)。
      setMemory: async (_u: string, content: string) => { setMemoryCalls.push(content); memContent = content; return {}; },
    },
  };
  const fakeBilling: any = {
    canConsumeTokenPoints: async () => ({ ok: true }),
    consumeTokenPoints: async () => ({ ok: true }),
    calculateCost: async () => 0,
    logApiUsage: async () => {},
  };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();

  writeFileSync(join(home, 'config.json'), JSON.stringify({
    specialAgents: { historian: { enabled: true, modelId: 'm1', everyRounds: 3, firstRoundTrigger: true, mode: 'independent' } },
  }), 'utf8');

  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', '旧标题', 'm1', 'user')`, [USER]);
  const long = '这是一段足够长的实质对话内容,用来越过 120 字的实质增量地板。'.repeat(4);
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('m1', 'S', 'user', ?, 1000)`, [long]);
  await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('m2', 'S', 'model', ?, 2000)`, [long]);
  await createRun({
    id: 'R1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
    input: { message: 'x', userMessageId: 'U1', attachments: [], agentConfig: {} },
  });
  await updateRunStatus('R1', 'done');
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const judgeOut = (cands: string[]): string => JSON.stringify({ title: '新标题', log: '', memory_candidates: cands });

describe('Historian 记忆两阶段流水线', () => {
  it('采集:候选落 raw 层(带脱敏),正典 MEMORY 不动', async () => {
    llmScript = [judgeOut(['用户偏好中文回复', '测试环境 key 是 sk-abcdefghijklmnopqrstuvwx'])];
    await onUserRunDone('S', USER);

    const raw = parseRawLines(readFileSync(rawFile(), 'utf8'));
    expect(raw.length).toBe(2);
    expect(raw[0].text).toBe('用户偏好中文回复');
    expect(raw[1].text).toContain('[REDACTED]');
    expect(raw[1].text).not.toContain('sk-abcdef');
    expect(setMemoryCalls).toEqual([]); // 采集绝不直写正典
    expect(llmPayloads.length).toBe(1); // 只有 judge 一次调用(未攒够不整固)

    const act = await query<any[]>(`SELECT action FROM special_agent_log WHERE agent = 'historian' AND action = 'memory_candidates'`);
    expect(act.length).toBe(1);
  });

  it('No-op 门:空候选数组 → 不落 raw、不整固', async () => {
    llmScript = [judgeOut([])];
    await onUserRunDone('S', USER);
    expect(existsSync(rawFile())).toBe(false);
    expect(llmPayloads.length).toBe(1);
    expect(setMemoryCalls).toEqual([]);
  });

  it('攒够 5 条触发整固:setMemory 收到整固产出,raw 清场,活动流记 memory_updated', async () => {
    seedRaw([1, 2, 3, 4].map((i) => `- [${today()} s:seed0000] 既有候选${i}`));
    llmScript = [judgeOut(['第五条候选内容']), '- 合并后的记忆\n- 用户偏好中文回复'];
    await onUserRunDone('S', USER);

    expect(llmPayloads.length).toBe(2); // judge + 整固
    const consInput = String(llmPayloads[1].messages[1].content);
    expect(consInput).toContain('[Current Memory]');
    expect(consInput).toContain('旧条目:用户在学线性代数');
    expect(consInput).toContain('既有候选1');
    expect(consInput).toContain('第五条候选内容');
    expect(setMemoryCalls).toEqual(['- 合并后的记忆\n- 用户偏好中文回复']);
    expect(parseRawLines(readFileSync(rawFile(), 'utf8')).length).toBe(0); // 消费完毕

    const act = await query<any[]>(`SELECT action FROM special_agent_log WHERE agent = 'historian' AND action = 'memory_updated'`);
    expect(act.length).toBe(1);
  });

  it('NOCHANGE:候选被裁定无并入价值 → 不写正典,但消费 raw 防反复触发', async () => {
    seedRaw([1, 2, 3, 4, 5].map((i) => `- [${today()} s:seed0000] 噪音候选${i}`));
    llmScript = [judgeOut([]), 'NOCHANGE'];
    await onUserRunDone('S', USER);

    expect(llmPayloads.length).toBe(2);
    expect(setMemoryCalls).toEqual([]);
    expect(parseRawLines(readFileSync(rawFile(), 'utf8')).length).toBe(0);
    const act = await query<any[]>(`SELECT action FROM special_agent_log WHERE agent = 'historian' AND action = 'memory_consolidated'`);
    expect(act.length).toBe(1);
  });

  it('缩水守卫:整固产出骤降 → 不落盘、不消费 raw,且退避期内不再烧整固调用', async () => {
    memContent = '- 很长的既有记忆。'.repeat(60); // >200 字
    seedRaw([1, 2, 3, 4, 5].map((i) => `- [${today()} s:seed0000] 候选${i}`));
    llmScript = [judgeOut([]), '- 短'];
    await onUserRunDone('S', USER);

    expect(setMemoryCalls).toEqual([]);
    expect(parseRawLines(readFileSync(rawFile(), 'utf8')).length).toBe(5); // 原样保留

    // 第二个到点轮(roundN=3):judge 照跑,但整固在退避期内被跳过 → 只多 1 次模型调用。
    // 把首轮活动记录回拨到过去,既有消息即可越过「实质增量地板」(不依赖时间戳格式细节)。
    await query(`UPDATE special_agent_log SET created_at = '2020-01-01 00:00:00' WHERE agent = 'historian'`);
    for (const id of ['R2', 'R3']) {
      await createRun({ id, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${id}-a`, input: { message: 'x', userMessageId: `${id}-u`, attachments: [], agentConfig: {} } });
      await updateRunStatus(id, 'done');
    }
    const before = llmPayloads.length;
    llmScript = [judgeOut([])];
    await onUserRunDone('S', USER);
    expect(llmPayloads.length).toBe(before + 1); // 无第二次整固调用
    expect(setMemoryCalls).toEqual([]);
  });

  it('正典瞬时读失败:整固中止(不带空底盖写),raw 保留', async () => {
    seedRaw([1, 2, 3, 4, 5].map((i) => `- [${today()} s:seed0000] 候选${i}`));
    memThrow = true;
    llmScript = [judgeOut([])];
    await onUserRunDone('S', USER);

    expect(llmPayloads.length).toBe(1); // 只有 judge,整固在读正典处止步
    expect(setMemoryCalls).toEqual([]);
    expect(parseRawLines(readFileSync(rawFile(), 'utf8')).length).toBe(5);
  });

  it('整固产出被 token 上限截断(finishReason=length):弃用,不落盘不消费', async () => {
    seedRaw([1, 2, 3, 4, 5].map((i) => `- [${today()} s:seed0000] 候选${i}`));
    llmScript = [judgeOut([]), { content: '- 被截断的半份产出', finishReason: 'length' }];
    await onUserRunDone('S', USER);

    expect(setMemoryCalls).toEqual([]);
    expect(parseRawLines(readFileSync(rawFile(), 'utf8')).length).toBe(5);
  });

  it('写前复核:整固期间正典被并发修改 → 放弃盖写,raw 保留', async () => {
    seedRaw([1, 2, 3, 4, 5].map((i) => `- [${today()} s:seed0000] 候选${i}`));
    memQueue = ['- 快照A', '- 快照A + remember 刚追加的条目'];
    llmScript = [judgeOut([]), '- 基于快照A 的整固产出'];
    await onUserRunDone('S', USER);

    expect(setMemoryCalls).toEqual([]);
    expect(parseRawLines(readFileSync(rawFile(), 'utf8')).length).toBe(5);
  });

  it('legacy memory 字符串(多行 bullet):按行拆成多条候选,不丢尾行', async () => {
    llmScript = [JSON.stringify({ title: '新标题', log: '', memory: '- 喜欢喝茶\n- 项目统一用 pnpm 管包' })];
    await onUserRunDone('S', USER);

    const raw = parseRawLines(readFileSync(rawFile(), 'utf8'));
    expect(raw.map((r) => r.text)).toEqual(['喜欢喝茶', '项目统一用 pnpm 管包']);
  });

  it('过期触发:不足 5 条但最老候选超 7 天 → 照样整固', async () => {
    seedRaw(['- [2026-01-01 s:seed0000] 很久以前的候选']);
    llmScript = [judgeOut([]), '- 合并了旧候选的记忆'];
    await onUserRunDone('S', USER);

    expect(llmPayloads.length).toBe(2);
    expect(setMemoryCalls).toEqual(['- 合并了旧候选的记忆']);
    expect(parseRawLines(readFileSync(rawFile(), 'utf8')).length).toBe(0);
  });
});

describe('自进化自动档(harness_candidates,P3)', () => {
  const seedSession = async (agentSlug = 'mybot'): Promise<void> => {
    await query(
      `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, agent_config) VALUES ('S2', ?, 'tangu', '旧标题', 'm1', 'user', ?)`,
      [USER, JSON.stringify({ agentSlug })],
    );
    const long = '这是一段足够长的实质对话内容,用来越过 120 字的实质增量地板。'.repeat(4);
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('m3', 'S2', 'user', ?, 1000)`, [long]);
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('m4', 'S2', 'model', ?, 2000)`, [long]);
    await createRun({
      id: 'R9', sessionId: 'S2', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A9',
      input: { message: 'x', userMessageId: 'U9', attachments: [], agentConfig: {} },
    });
    await updateRunStatus('R9', 'done');
  };
  const enableHarnessTier = (): void => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      specialAgents: { historian: { enabled: true, modelId: 'm1', everyRounds: 3, firstRoundTrigger: true, mode: 'independent', harnessCandidates: true } },
    }), 'utf8');
  };

  it('开档:harness 候选落展示身份收件箱,memory 候选落记忆域(shareDefaultMemory 折叠不串桶)', async () => {
    enableHarnessTier();
    const { saveAgent } = await import('../src/agents/agentRegistry.js');
    await saveAgent({ slug: 'mybot', name: 'MyBot', systemPrompt: 'x' }); // 归桶闸要求 agent 真实存在
    await seedSession();
    llmScript = [JSON.stringify({
      title: '标题', log: '',
      memory_candidates: ['用户偏好中文'],
      harness_candidates: ['Run the relevant tests before review', 'y' + 'x'.repeat(400)],
    })];
    await onUserRunDone('S2', USER, DEFAULT_AGENT_SLUG); // 模拟 shareDefaultMemory:记忆域折叠到默认

    expect(String(llmPayloads[0].messages[0].content)).toContain('harness_candidates'); // 字段规格进了 judge 提示词
    // memory 候选 → 折叠记忆域;harness 候选 → agent 本体(agent_config.agentSlug)
    expect(parseRawLines(readFileSync(rawFile(), 'utf8')).map((r) => r.text)).toEqual(['用户偏好中文']);
    const inbox = readFileSync(join(agentsDir(), 'mybot', '.harness-raw.md'), 'utf8');
    expect(inbox).toContain('Run the relevant tests before review');
    expect(existsSync(join(agentsDir(), DEFAULT_AGENT_SLUG, '.harness-raw.md'))).toBe(false);
    expect(inbox).toContain('y' + 'x'.repeat(299)); // 单条 300 字封顶
    expect(inbox).not.toContain('x'.repeat(400));
    const act = await query<any[]>(`SELECT action FROM special_agent_log WHERE action = 'harness_candidates'`);
    expect(act.length).toBe(1);
  });

  it('默认关:judge 提示词无该字段;半服从模型硬给 harness_candidates 也被忽略', async () => {
    llmScript = [JSON.stringify({ title: '标题', log: '', memory_candidates: [], harness_candidates: ['Sneaky lesson'] })];
    await onUserRunDone('S', USER);
    expect(String(llmPayloads[0].messages[0].content)).not.toContain('harness_candidates');
    expect(existsSync(join(agentsDir(), DEFAULT_AGENT_SLUG, '.harness-raw.md'))).toBe(false);
  });

  it('归桶闸:agent_config.agentSlug 非法(../ 穿越)或 agent 不存在 → 丢弃候选,不落任何收件箱', async () => {
    enableHarnessTier();
    await seedSession('../evil'); // isValidSlug 拒绝;即便合法形状,getAgent 不存在同样拒
    llmScript = [JSON.stringify({ title: '标题', log: '', memory_candidates: [], harness_candidates: ['Escape attempt'] })];
    await onUserRunDone('S2', USER, DEFAULT_AGENT_SLUG);
    expect(existsSync(join(agentsDir(), '..', 'evil', '.harness-raw.md'))).toBe(false);
    expect(existsSync(join(agentsDir(), DEFAULT_AGENT_SLUG, '.harness-raw.md'))).toBe(false); // 也不错桶进默认 agent
    const act = await query<any[]>(`SELECT action FROM special_agent_log WHERE action = 'harness_candidates'`);
    expect(act.length).toBe(0);
  });
});

describe('纯函数', () => {
  it('parseRawLines 只认规范行;redactSecrets 盖 token 形状但放过 40 位 git SHA', () => {
    const parsed = parseRawLines('- [2026-07-25 s:abc] 条目A\n随意噪音行\n- [2026-07-26] 条目B\n');
    expect(parsed.map((p) => p.text)).toEqual(['条目A', '条目B']);
    expect(redactSecrets('ghp_' + 'a'.repeat(24))).toBe('[REDACTED]');
    expect(redactSecrets('AKIA' + 'A'.repeat(16))).toBe('[REDACTED]');
    expect(redactSecrets('xoxb-1234567890-abcdef')).toBe('[REDACTED]');
    expect(redactSecrets('密钥 ' + 'f'.repeat(64) + ' 结尾')).toContain('[REDACTED]');
    // 40 位 hex = git SHA,是有用的记忆内容,不误伤
    const sha = '230d2e2c' + 'a'.repeat(32);
    expect(redactSecrets(`上游锁定在 ${sha}`)).toContain(sha);
    expect(redactSecrets('普通句子不受影响')).toBe('普通句子不受影响');
  });
});
