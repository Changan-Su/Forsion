/**
 * 子代理循环的拒绝 / 拦截文案与主循环(agentLoop)逐字一致(评审 #6 的子代理那半):
 *   ① PreToolUse hook 拦截 → `Blocked by a PreToolUse hook, so this tool call was NOT run: <reason>`(旧:中文「⛔ Hook 拦截：…」);
 *      hook 没给原因 → 同主循环的 `no reason given.` 回落;
 *   ② 用户在审批卡点了拒绝(决定体不带 rejectReason)→ approvals.USER_REJECT_REASON(旧:子代理自带一句
 *      `The user rejected this operation.`,与主循环分叉,模型看不到「别重试、问用户」那半句);
 *   ③ 对照:规则拒绝带着自己的 rejectReason 原样到模型(与用户拒绝可区分)。
 * 模型收到的是子代理下一轮 payload 里的 role='tool' 消息 —— 本文件量的就是它。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { createRun } from '../src/services/runStore.js';
import { runSubAgent } from '../src/services/subAgent.js';
import { USER_REJECT_REASON } from '../src/services/approvals.js';
import type { ToolContext } from '../src/tools/registry.js';

const spies = vi.hoisted(() => ({ gate: vi.fn(), hooks: vi.fn(), exec: vi.fn() }));
vi.mock('../src/tools/registry.js', async (orig) => {
  const actual = await orig<typeof import('../src/tools/registry.js')>();
  return {
    ...actual,
    executeTool: (...args: Parameters<typeof actual.executeTool>) => {
      spies.exec(...args);
      return actual.executeTool(...args);
    },
  };
});
// lifecycle hook:缺省空判定;单个用例 mockImplementationOnce 返回 block。
vi.mock('../src/hooks/index.js', async (orig) => {
  const actual = await orig<typeof import('../src/hooks/index.js')>();
  return {
    ...actual,
    runHooks: async (...args: any[]) => {
      const forced = await spies.hooks(...args);
      return forced !== undefined ? forced : { additionalContext: [], systemMessages: [], runs: [] };
    },
  };
});
// 审批:缺省透传(sandbox 下非 mcp 工具即时放行);单个用例 mockImplementationOnce 返回一个决定。
// 必须 ...actual:subAgent 还要从这里取 USER_REJECT_REASON。
vi.mock('../src/services/approvals.js', async (orig) => {
  const actual = await orig<typeof import('../src/services/approvals.js')>();
  return {
    ...actual,
    gateToolCall: (...args: Parameters<typeof actual.gateToolCall>) => {
      const forced = spies.gate(...args);
      return forced !== undefined ? forced : actual.gateToolCall(...args);
    },
  };
});

const USER = 'u1';
let home: string;
let payloads: any[];
let script: Array<() => any>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-subreject-'));
  process.env.TANGU_HOME = home;
  payloads = [];
  spies.gate.mockClear();
  spies.hooks.mockClear();
  spies.exec.mockClear();
  // 一次无副作用的工具调用(get_datetime),次轮收尾
  script = [
    () => ({
      content: '', reasoning: '',
      toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'get_datetime', arguments: '{}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
    }),
    () => ({ content: 'done', reasoning: '', toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 4 }, finishReason: 'stop' }),
  ];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
      streamProviderCompletion: async (o: any) => {
        payloads.push(o.payload);
        const step = script.shift();
        if (!step) throw new Error(`脚本耗尽:第 ${payloads.length} 次 LLM 调用没有出招`);
        return step();
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
  await createRun({
    id: 'R1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
    input: { message: 'go', userMessageId: 'U1', attachments: [], agentConfig: {} },
  });
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const parentCtx = (): ToolContext => {
  const unlocked = new Set<string>();
  return {
    userId: USER, sessionId: 'S', appId: 'tangu', runId: 'R1',
    profile: createTanguProfile({ sandboxMode: 'none' }),
    execMode: 'sandbox', thinkingLevel: 'medium',
    unlockedTools: unlocked, unlockTools: (names: string[]) => names.forEach((n) => unlocked.add(n)),
  } as unknown as ToolContext;
};

/** 子代理第二轮 payload 里的最后一条 tool 消息 = 模型真正收到的工具结果。 */
const toolResult = (): string => String((payloads[1]?.messages as any[]).filter((m) => m.role === 'tool').pop()?.content ?? '');
const blockHook = (blockReason?: string) => async (ev: string) =>
  (ev === 'PreToolUse' ? { block: true, blockReason, additionalContext: [], systemMessages: [], runs: [] } : undefined);

describe('子代理的拒绝 / 拦截文案 = 主循环同一句(英文)', () => {
  it('① PreToolUse hook 拦截 → 英文、写明是 hook 挡的、没执行', async () => {
    spies.hooks.mockImplementationOnce(blockHook('policy says no'));
    await runSubAgent({ task: 't', parentCtx: parentCtx(), modelId: 'm1' });
    expect(payloads.length).toBe(2);
    expect(toolResult()).toBe('Blocked by a PreToolUse hook, so this tool call was NOT run: policy says no');
    expect(spies.exec).not.toHaveBeenCalled();
  }, 20_000);

  it('① hook 没给原因 → 同主循环的回落,不含中文', async () => {
    spies.hooks.mockImplementationOnce(blockHook(undefined));
    await runSubAgent({ task: 't', parentCtx: parentCtx(), modelId: 'm1' });
    const r = toolResult();
    expect(r).toBe('Blocked by a PreToolUse hook, so this tool call was NOT run: no reason given.');
    expect(r).not.toMatch(/[一-鿿]/);
  }, 20_000);

  it('② 用户点拒绝(决定体无 rejectReason)→ USER_REJECT_REASON,工具没执行', async () => {
    spies.gate.mockImplementationOnce(async () => ({ action: 'reject' }));
    await runSubAgent({ task: 't', parentCtx: parentCtx(), modelId: 'm1' });
    expect(toolResult()).toBe(USER_REJECT_REASON);
    expect(spies.exec).not.toHaveBeenCalled();
  }, 20_000);

  it('③ 对照:规则拒绝带自己的原因原样到模型', async () => {
    spies.gate.mockImplementationOnce(async () => ({ action: 'reject', rejectReason: 'Denied by approval rule: get_datetime' }));
    await runSubAgent({ task: 't', parentCtx: parentCtx(), modelId: 'm1' });
    expect(toolResult()).toBe('Denied by approval rule: get_datetime');
  }, 20_000);
});
