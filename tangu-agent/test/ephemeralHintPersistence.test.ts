/**
 * run 级钉死「本轮可见、永不落库、下一 run 不回放」——尾部 user 通道的两个乘客:
 *   ① C-3 `input.ephemeralHint`(Muse 每周期的 kickoff 摘要)
 *   ② B1 记忆易变段(`## Recalled Memory for This Turn`,TANGU_MEMORY_VOLATILE 缺省 = tail)
 * 评审 #6:memoryRecall.test.ts / muse.session.test.ts 只验纯函数拆分 —— 即便 startCycle 把 hint
 * 拼回 message、或 agentLoop 把注入后的 user 消息落了库,那两个文件仍全绿。本文件走真 loop:
 * 真内存 SQLite + fake brain 抓 wire 消息,断言三处**同时**成立(少任一处就是回归):
 *   wire 尾部有 → chat_messages 没有 → 下一 run hydrate 出来的历史里也没有。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/ephemeralHintPersistence.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';

const USER = 'u1';
const HINT = 'EPHEMERAL-HINT-MARK';
const RECALL_HEADER = '## Recalled Memory for This Turn';
const TERM = 'hummingbird'; // 记忆行与本轮消息共有的检索词:没有它 §2 打分为 0,易变段恒空
const FIRST_MESSAGE = `${TERM} 进度`;

/**
 * 记忆行刻意做长(每行 900 字符):buildAgentMemoryContext 的 §1「存储证据」段预算只有 cap/4,
 * 第一行填满即停 → 它落**稳定段**(留在 system 原位),后两行转**易变段**(走尾部通道)。
 * 两段各带自己的标记,于是「落点对不对」也被钉住 —— 只断言「出现过」在 system 档下同样是绿的。
 */
const pad = (s: string): string => s + ' '.repeat(Math.max(0, 900 - s.length));
const SEEDED_MEMORY = [
  pad(`${TERM} STABLE-EVIDENCE-1`),
  pad(`${TERM} VOLATILE-EVIDENCE-2`),
  pad(`${TERM} VOLATILE-EVIDENCE-3`),
].join('\n');

let home: string;
let llmPayloads: any[];
let script: Array<(o: any) => any>;
let memoryContent: string;
let prevVolatile: string | undefined;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-ephemeral-'));
  process.env.TANGU_HOME = home;
  // 尾部落点是本文件的前提,必须显式钉:测试进程带着 TANGU_MEMORY_VOLATILE=system 启动的话,
  // 易变段会留在 system 里,本文件的断言全是假红/假绿(与评审 #11 同一类环境泄漏)。
  prevVolatile = process.env.TANGU_MEMORY_VOLATILE;
  delete process.env.TANGU_MEMORY_VOLATILE;
  llmPayloads = [];
  script = [];
  memoryContent = SEEDED_MEMORY;

  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));

  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => {
        llmPayloads.push(o.payload);
        const step = script.shift();
        if (!step) throw new Error(`脚本耗尽:第 ${llmPayloads.length} 次 LLM 调用没有出招`);
        return step(o);
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: memoryContent }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = {
    canConsumeTokenPoints: async () => ({ ok: true }),
    consumeTokenPoints: async () => ({ ok: true }),
    calculateCost: async () => 0,
    logApiUsage: async () => {},
  };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`,
    [USER],
  );
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  if (prevVolatile === undefined) delete process.env.TANGU_MEMORY_VOLATILE;
  else process.env.TANGU_MEMORY_VOLATILE = prevVolatile;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function runToSettled(msg: string, extraInput: Record<string, unknown> = {}, id = 'R1'): Promise<any> {
  await createRun({
    id, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A-${id}`,
    input: { message: msg, userMessageId: `U-${id}`, attachments: [], agentConfig: {}, ...extraInput },
  });
  enqueueRun('S', id);
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(id);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
    if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

const finalStep = (content: string) => () =>
  ({ content, reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' });
const textOf = (m: any): string => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''));
const systemOf = (payload: any): string => textOf((payload.messages as any[]).find((m) => m.role === 'system'));
const tailOf = (payload: any): any => (payload.messages as any[])[payload.messages.length - 1];
const wireText = (payload: any): string => (payload.messages as any[]).map(textOf).join('\n');
const dbRows = (): Promise<any[]> =>
  query<any[]>(`SELECT role, content FROM chat_messages WHERE session_id = 'S' ORDER BY timestamp ASC`);

describe('尾部 user 通道:本轮可见 / 不落库 / 不回放', () => {
  it('run 1 的 wire 尾部同时带 hint 与召回块;chat_messages 一个都不留', async () => {
    script = [finalStep('答一。')];
    expect((await runToSettled(FIRST_MESSAGE, { ephemeralHint: HINT })).status).toBe('done');

    // ① 本轮 wire:两个乘客都挂在**最后一条 user 消息**上
    const tail = tailOf(llmPayloads[0]);
    expect(tail.role).toBe('user');
    expect(textOf(tail)).toContain(FIRST_MESSAGE);
    expect(textOf(tail)).toContain(HINT);
    expect(textOf(tail)).toContain(RECALL_HEADER);
    expect(textOf(tail)).toContain('VOLATILE-EVIDENCE-2');
    expect(textOf(tail)).toContain('VOLATILE-EVIDENCE-3');

    // ② 落点:稳定段留在 system 原位,易变段与 hint 一个字都不许进 system(否则前缀缓存每条消息作废)
    const sys = systemOf(llmPayloads[0]);
    expect(sys, '§1 存储证据是稳定段,留在系统提示里').toContain('STABLE-EVIDENCE-1');
    expect(sys).not.toContain('VOLATILE-EVIDENCE');
    expect(sys).not.toContain(RECALL_HEADER);
    expect(sys).not.toContain(HINT);

    // ③ 落库面:用户消息按原文落,注入的两样一个都不留
    const rows = await dbRows();
    expect(rows.length, '本轮的 user + assistant 都该落库(否则下面几条是空真的)').toBeGreaterThanOrEqual(2);
    expect(rows.find((r) => r.role === 'user')?.content).toBe(FIRST_MESSAGE); // 原文,不是「原文 + 注入」
    for (const mark of [HINT, RECALL_HEADER, 'VOLATILE-EVIDENCE-2', 'VOLATILE-EVIDENCE-3']) {
      expect(rows.some((r) => String(r.content).includes(mark)), `${mark} 不该落库`).toBe(false);
    }
  }, 30_000);

  it('run 2 hydrate 出来的历史里没有上一轮的 hint / 召回块(回放一次就等于永久驻留)', async () => {
    script = [finalStep('答一。')];
    expect((await runToSettled(FIRST_MESSAGE, { ephemeralHint: HINT })).status).toBe('done');

    llmPayloads = [];
    memoryContent = ''; // 本轮不再召回:wire 里再出现召回块 = 它是从历史回放来的
    script = [finalStep('答二。')];
    expect((await runToSettled('第二问', {}, 'R2')).status).toBe('done');

    const wire = wireText(llmPayloads[0]);
    // 先证 hydrate 真的发生了 —— 否则「历史里没有 hint」只是因为历史是空的
    expect(wire, '上一轮的 user 必须回放').toContain(FIRST_MESSAGE);
    expect(wire, '上一轮的 assistant 必须回放').toContain('答一。');
    for (const mark of [HINT, RECALL_HEADER, 'VOLATILE-EVIDENCE-2', 'VOLATILE-EVIDENCE-3']) {
      expect(wire.includes(mark), `${mark} 不该被回放进 run 2`).toBe(false);
    }
  }, 40_000);

  it('负对照:不给 ephemeralHint、记忆也为空 → 尾部 user 两样都没有(标记不是台架自带的)', async () => {
    memoryContent = '';
    script = [finalStep('好。')];
    expect((await runToSettled(FIRST_MESSAGE)).status).toBe('done');

    const tail = tailOf(llmPayloads[0]);
    expect(tail.role).toBe('user');
    expect(textOf(tail)).toContain(FIRST_MESSAGE); // 本轮那条 user 确实在尾部(不是尾部找错了)
    expect(textOf(tail)).not.toContain(HINT);
    expect(textOf(tail)).not.toContain(RECALL_HEADER);
    expect(systemOf(llmPayloads[0])).not.toContain('STABLE-EVIDENCE-1');
  }, 30_000);
});
