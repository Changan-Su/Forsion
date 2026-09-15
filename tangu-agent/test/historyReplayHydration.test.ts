/**
 * B3(Token/缓存评审 §五「回放保真」)的**接线**验收:真内存 SQLite + 真 loop。
 * 第一个 run 跑「工具轮 + 收尾轮」,第二个 run 水合它 —— 送进 provider 的历史必须是在线时的
 * assistant(调用) → tool(结果) → assistant(收尾) 交错,而不是升级前那条
 * 「一条 assistant 带全部调用 + 尾随全部结果」的扁平串(扁平会让下个 run 的缓存前缀在 run 边界分叉)。
 *
 * 单元层(两道闸、字节同形、退回扁平)在 src/services/historyReplay.test.ts;这里只钉
 * hydrateHistory → StateStore.listStepsForMessages → replayAssistantHistory 这条线真的通了。
 */
import { describe, it, expect, afterEach } from 'vitest';
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
import { abortAllRuns, enqueueRun } from '../src/services/agentLoop.js';
import { registerToolProvider } from '../src/tools/toolRegistry.js';
import { PROTOCOL_MARK } from '../src/llm/openaiCompat.js';

const PROBE_CALL = { id: 'c1', type: 'function', function: { name: 'replay_probe', arguments: '{}' } };
/** Responses 流真正吐回来的那组 item:reasoning(带 encrypted_content)+ preamble 的 message +
 *  本轮的 function_call。后两个都少不得 —— openaiToResponsesBody 见到 providerItems 就整组替代
 *  正文与 tool_calls:没有 function_call 项紧随的 function_call_output 会 400,没有 message 项
 *  这一轮的 preamble 正文压根不上 wire、字节前缀就在那个位置分叉(historyReplay 文件头 ②③)。 */
const OUTPUT_ITEMS = [
  { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'looking' }] },
  { type: 'function_call', call_id: 'c1', name: 'replay_probe', arguments: '{}' },
];
/** 收尾轮**也**吐 items(真模型就是这样:末轮照样有 reasoning/message item)。写侧必须不落它们 ——
 *  收尾轮没有 tool_calls,回放的 interleave 不把它当一轮,挂上去的 items 永远读不到,只白占体积。
 *  收尾 fixture 不带 items 的话,这条断言是空转的:写侧哪天真开始落它也照样绿(评审 2026-09-15 #6)。 */
const CLOSING_ITEMS = [
  { type: 'reasoning', id: 'rs_close', encrypted_content: 'ENC2' },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
];
/** 第 0 轮:preamble + 一次工具调用(带 Responses 的 outputItems);第 1 轮:收尾(也带 items)。
 *  之后的 run 一轮收尾。 */
const SCRIPT = [
  { content: 'looking', toolCalls: [PROBE_CALL], outputItems: OUTPUT_ITEMS },
  { content: 'done', toolCalls: [], outputItems: CLOSING_ITEMS },
  { content: 'second run', toolCalls: [] },
];

let cleanupHome: string | null = null;
let payloads: any[] = [];
let scriptAt = 0;

afterEach(() => {
  abortAllRuns();
  delete process.env.TANGU_HOME;
  if (cleanupHome) { try { rmSync(cleanupHome, { recursive: true, force: true }); } catch { /* ignore */ } cleanupHome = null; }
});

/** 本轮 payload 上要打的协议标记(multiBrain 正是按它分发 Responses / anthropic / chat-completions);
 *  留空 = chat-completions。模型上的**静态**标记始终没有 —— 两者不一致正是评审 #2 的场景。 */
let payloadProtocol: string | undefined;

async function setupLoop(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'tangu-replay-hydration-'));
  cleanupHome = home;
  process.env.TANGU_HOME = home;
  payloads = [];
  scriptAt = 0;
  payloadProtocol = undefined;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  // registerToolProvider 同 id 幂等覆盖,两个用例各调一次 setupLoop 不会把工具面注册成两份。
  registerToolProvider({
    id: 'test:replay-probe',
    tools: () => [{
      name: 'replay_probe', mode: 'both',
      definition: { type: 'function', function: { name: 'replay_probe', description: 'test only', parameters: { type: 'object', properties: {} } } },
      execute: async () => 'probe ok',
    } as any],
  });
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', context_window: 128_000 }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({
      messages: structuredClone(o.messages), tools: o.tools,
      ...(payloadProtocol ? { [PROTOCOL_MARK]: payloadProtocol } : {}),
    }),
    streamProviderCompletion: async (o: any) => {
      payloads.push(o.payload);
      const step = SCRIPT[Math.min(scriptAt++, SCRIPT.length - 1)];
      return {
        content: step.content, reasoning: '', toolCalls: step.toolCalls,
        usage: { prompt_tokens: 5, completion_tokens: 5 },
        finishReason: step.toolCalls.length ? 'tool_calls' : 'stop',
        ...(step.outputItems ? { outputItems: step.outputItems } : {}),
      };
    },
  };
  configureTangu({
    host,
    brain: {
      llm: fakeLlm,
      users: { getUserById: async () => ({ id: 'u1', username: 'u' }) },
      memory: { getMemory: async () => ({ content: '' }) },
      models: { hasDirectModel: () => false },
    } as any,
    billing: {
      canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }),
      calculateCost: async () => 0, logApiUsage: async () => {},
    } as any,
    profile: createTanguProfile({ sandboxMode: 'none' }),
  });
  await runMigration();
}

async function runToDone(runId: string): Promise<void> {
  await createRun({
    id: runId, sessionId: 'S', userId: 'u1', appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: `hi ${runId}`, userMessageId: `${runId}-u`, attachments: [], agentConfig: { execMode: 'sandbox' } },
  });
  enqueueRun('S', runId);
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(runId);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) { expect(r.status).toBe('done'); return; }
    if (Date.now() - t0 > 15_000) throw new Error(`run ${runId} 未结束`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

/** 第二个 run 首轮送出的历史(去掉 system 与本轮 user)。 */
const hydratedHistory = (): any[] => {
  const msgs = (payloads[payloads.length - 1]?.messages || []) as any[];
  return msgs.filter((m) => m.role !== 'system');
};

describe('B3 接线:hydrateHistory 按 agent_steps 重建交错', () => {
  it('第二个 run 看到的第一个 run 是 assistant(调用)→tool→assistant(收尾),不是扁平串', async () => {
    await setupLoop();
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user')`);
    await runToDone('R1');
    // 前置:第一个 run 确实按「工具轮 + 收尾轮」跑完,且步骤落了库(交错重建的原料)。
    const steps = await query<any[]>(`SELECT step_no, tool_calls FROM agent_steps WHERE run_id = 'R1' ORDER BY step_no`);
    expect(steps.length).toBe(2);
    const row = (await query<any[]>(`SELECT content, tool_calls FROM chat_messages WHERE id = 'R1-a'`))[0];
    expect(String(row.content)).toBe('looking\n\ndone'); // 落库仍是扁平的一行(写侧未动)

    await runToDone('R2');
    const history = hydratedHistory();
    const roles = history.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(history[1].content).toBe('looking');
    expect(history[1].tool_calls.map((c: any) => c.id)).toEqual(['c1']);
    expect(history[2].content).toBe('probe ok');
    expect(history[3].content).toBe('done'); // 收尾正文排在 tool 结果**之后**
    expect(history[3].tool_calls).toBeUndefined();
    // 负对照:升级前的扁平形态会把两轮正文压成一条 assistant('looking\n\ndone') 且 tool 尾随 —— 不能再出现。
    expect(history.some((m) => m.content === 'looking\n\ndone')).toBe(false);
    expect(history.findIndex((m) => m.role === 'tool')).toBeLessThan(history.length - 2);
  });

  // B3 step (3) 已落地:写侧 agentLoop 的 appendStep 经 stepLlmResponse 把模型的 output items
  // (reasoning/encrypted_content + preamble 的 message + function_call)连同产出它们的 apiModelId
  // 一起落进 agent_steps.llm_response(JSON 列,**无迁移**),读侧同模型才回灌 → Codex 路径的
  // reasoning 延续性不再断在 run 边界。体积由 STEP_ITEMS_MAX_BYTES 硬帽兜(超帽整组丢并留标记)。
  // 这条同时钉住 message 项**逐字往返**:落库一组 === 在线挂在 assistant 轮上的那一组,同序同字节。
  it('providerItems replay: 回放的 assistant 轮带回第一个 run 的 reasoning/message items', async () => {
    await setupLoop();
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user')`);
    await runToDone('R1');
    // 写侧接线:items 真的落了库(字符串形态,见 stepLlmResponse 关于 jsonb 键序的注释),
    // 并绑定到 resolveModelAndKey 给的 apiModelId('m')。
    const step0 = (await query<any[]>(`SELECT llm_response FROM agent_steps WHERE run_id = 'R1' AND step_no = 0`))[0];
    const persisted = typeof step0.llm_response === 'string' ? JSON.parse(step0.llm_response) : step0.llm_response;
    expect(persisted.outputItemsJson).toBe(JSON.stringify(OUTPUT_ITEMS));
    expect(persisted.outputItemsModel.apiModelId).toBe('m');
    // 收尾轮不成一轮(无 tool_calls)→ **即使本轮真吐了 items 也不落**,存了也永远读不到。
    const step1 = (await query<any[]>(`SELECT llm_response FROM agent_steps WHERE run_id = 'R1' AND step_no = 1`))[0];
    const tail = typeof step1.llm_response === 'string' ? JSON.parse(step1.llm_response) : step1.llm_response;
    expect(tail.outputItemsJson).toBeUndefined();
    expect(tail.outputItems).toBeUndefined();
    expect(JSON.stringify(tail)).not.toContain('rs_close'); // CLOSING_ITEMS 一个字节都没进库

    await runToDone('R2');
    expect(hydratedHistory()[1].providerItems).toEqual(OUTPUT_ITEMS);
    // 上游缓存看的是**字节**,不是对象等价 —— 过一趟 JSON 列后键序也得原样回来。
    expect(JSON.stringify(hydratedHistory()[1].providerItems)).toBe(JSON.stringify(OUTPUT_ITEMS));
  });

  // 评审 2026-09-15 #2 的端到端负对照:R1 的 payload 被动态改道 Responses(tuneOpenAiDirectPayload
  // 见 cap.viaResponses + 思考开就是这么干的),模型对象上**没有**静态协议标记;R2 思考关、退回
  // /chat/completions。只比 apiModelId 的话,R1 那组 Responses 私有 item 会原样挂回 assistant 消息,
  // 严格端点直接 400。落库记的是 payload 的真实协议,读侧要的是模型的静态协议('') → 对不上 → 不挂。
  it('协议闸:上一 run 走 Responses 落的 items,不会回灌进走 chat-completions 的下一 run', async () => {
    await setupLoop();
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user')`);
    payloadProtocol = 'openai-responses';
    await runToDone('R1');
    const step0 = (await query<any[]>(`SELECT llm_response FROM agent_steps WHERE run_id = 'R1' AND step_no = 0`))[0];
    const persisted = typeof step0.llm_response === 'string' ? JSON.parse(step0.llm_response) : step0.llm_response;
    // 落的是**本轮 payload 实际走的**协议,不是模型上的静态标记(模型压根没有)。
    expect(persisted.outputItemsModel).toEqual({ apiModelId: 'm', provider: 'test', protocol: 'openai-responses' });
    expect(persisted.outputItemsJson).toBe(JSON.stringify(OUTPUT_ITEMS));

    payloadProtocol = undefined; // R2 退回 chat-completions
    await runToDone('R2');
    const assistant = hydratedHistory()[1];
    expect(assistant.providerItems).toBeUndefined(); // 未知字段绝不上严格端点
    // 只丢 items:交错本身一个字节不变(绑定闸不是第四道「退回扁平」的闸)。
    expect(hydratedHistory().map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(assistant.content).toBe('looking');
    expect(assistant.tool_calls.map((c: any) => c.id)).toEqual(['c1']);
  });
});
