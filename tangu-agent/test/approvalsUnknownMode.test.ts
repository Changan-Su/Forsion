/**
 * H5 未知档位 fail-closed + 拒绝文案英文化(审批档重设计 2026-09-25 §3.4 / §3.6)。
 *   H5:非空但不认识的档位(拼错 / 新客户端才有的 id / 非字符串)从前一路 `||` 透传到 toolNeedsApproval 末尾的
 *       `return false` = 全部放行;现在按 readonly 并告警。空 / 缺席照旧(host 缺省 auto-edit,云端 full-auto)。
 *       会话存值同理:存了个不认识的值,从前当「没存」回落到可能更宽的启动快照。
 *   文案:用户拒绝的模型面回落文案从中文「用户拒绝了该操作。」改成英文,并与规则 / hook(rejectReason)、中止区分开。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
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
import { subscribe } from '../src/services/eventBus.js';
import {
  ABORTED_REJECT_REASON, USER_REJECT_REASON, customRules, gateToolCall, normalizeApprovalMode, requestApproval, resolveApproval,
  storedApprovalMode, toolNeedsApproval,
} from '../src/services/approvals.js';
import { enqueueRun } from '../src/services/agentLoop.js';

const USER = 'u1';
let home: string;
let ws: string;
let script: Array<() => any>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-h5-'));
  process.env.TANGU_HOME = home;
  ws = join(home, 'ws');
  mkdirSync(ws, { recursive: true });
  script = [];
  warn = vi.spyOn(console, 'warn');
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        const step = script.shift();
        if (!step) throw new Error('脚本耗尽');
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
});

afterEach(() => {
  warn.mockRestore();
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const write = (p: string): any => ({ id: 'w', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: p, content: 'x' }) } });

let seq = 0;
async function gate(c: any, ctx: Record<string, unknown>): Promise<{ d: any; asked: any[] }> {
  const runId = `H5-${++seq}`;
  const asked: any[] = [];
  const off = subscribe(runId, (ev) => {
    if (ev.type !== 'approval_request') return;
    asked.push(ev.payload);
    resolveApproval(ev.payload.approvalId, { action: 'reject' });
  });
  try {
    return { d: await gateToolCall(runId, c, { sessionId: 'S', execMode: 'host', cwd: ws, ...ctx } as any), asked };
  } finally { off(); }
}

/** 真 loop 跑一次(非输入区发起 = 只认快照);审批一律拒,返回审批请求与工具结果。 */
async function runLoop(agentConfig: Record<string, unknown>): Promise<{ asked: any[]; results: Array<{ name: string; result: string }> }> {
  const runId = `L${++seq}`;
  const asked: any[] = [];
  const results: Array<{ name: string; result: string }> = [];
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A${seq}`,
    input: { message: 'go', userMessageId: `U${seq}`, attachments: [], agentConfig: { execMode: 'host', cwd: ws, ...agentConfig } },
  });
  const off = subscribe(runId, (ev) => {
    if (ev.type === 'tool_result') results.push({ name: String(ev.payload?.name), result: String(ev.payload?.result) });
    if (ev.type !== 'approval_request' || asked.some((x) => x.approvalId === ev.payload.approvalId)) return;
    asked.push(ev.payload);
    resolveApproval(ev.payload.approvalId, { action: 'reject' });
  });
  enqueueRun('S', runId);
  try {
    const t0 = Date.now();
    for (;;) {
      const r = await getRun(runId);
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) { expect(r.status).toBe('done'); break; }
      if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
      await new Promise((res) => setTimeout(res, 25));
    }
  } finally { off(); }
  return { asked, results };
}
const writeStep = (file: string) => () => ({
  content: '', reasoning: '',
  toolCalls: [{ id: `w-${file}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: 'x' }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
});
const finalStep = () => () => ({ content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' });

describe('H5 未知档位按 readonly', () => {
  it('normalizeApprovalMode:空 / 缺席 → undefined;四个 id 原样;其它非空值(含非字符串)→ readonly 并告警一次', () => {
    for (const v of [undefined, null, '']) expect(normalizeApprovalMode(v)).toBeUndefined();
    for (const v of ['readonly', 'auto-edit', 'full-auto', 'custom']) expect(normalizeApprovalMode(v)).toBe(v);
    for (const v of ['yolo', 'Full-Auto', 'bypass', 1, { a: 1 }, true]) expect(normalizeApprovalMode(v, 'unit')).toBe('readonly');
    const n = warn.mock.calls.length;
    normalizeApprovalMode('yolo', 'unit');
    expect(warn.mock.calls.length).toBe(n); // 同来源同值只告警一次
  });

  it('toolNeedsApproval:不认识的档 = 最严(写 + 命令都要批);空 / 缺席照旧不审批', () => {
    expect(toolNeedsApproval('write_file', 'yolo' as any)).toBe(true);
    expect(toolNeedsApproval('run_bash', 'bypass' as any)).toBe(true);
    expect(toolNeedsApproval('read_file', 'yolo' as any)).toBe(false);
    expect(toolNeedsApproval('write_file', '' as any)).toBe(false);
    expect(toolNeedsApproval('write_file', undefined)).toBe(false);
  });

  it('闸门:快照是不认识的档 → 工作区内写照问(mode=readonly)', async () => {
    const { d, asked } = await gate(write(join(ws, 'a.txt')), { approvalMode: 'yolo' });
    expect(asked.map((x) => x.reason)).toEqual([{ kind: 'mode', mode: 'readonly' }]);
    expect(d.action).toBe('reject');
  });

  it('会话存了个不认识的档 → readonly,不回落到更宽的启动快照(full-auto)', async () => {
    await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'S'`, [JSON.stringify({ approvalMode: 'yolo' })]);
    expect(await storedApprovalMode('S')).toBe('readonly');
    const { asked } = await gate(write(join(ws, 'a.txt')), { approvalMode: 'full-auto', modeSessionId: 'S' });
    expect(asked.map((x) => x.reason?.mode)).toEqual(['readonly']);
    await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'S'`, [JSON.stringify({})]);
    expect(await storedApprovalMode('S')).toBeUndefined(); // 没存照旧 undefined(交快照)
  });

  it('真 loop:agentConfig 带不认识的档 → 起跑即归一成 readonly(告警点名本 run),工作区内写照问', async () => {
    script = [writeStep('a.txt'), finalStep()];
    const { asked } = await runLoop({ approvalMode: 'yolo' });
    expect(asked.map((x) => x.reason)).toEqual([{ kind: 'mode', mode: 'readonly' }]);
    expect(existsSync(join(ws, 'a.txt'))).toBe(false);
    expect(warn.mock.calls.some((c) => /未知审批档 "yolo"\(来源 run L\d+\)/.test(String(c[0])))).toBe(true);
  });

  it('对照:空档照旧按 host 缺省 auto-edit —— 工作区内写不问', async () => {
    script = [writeStep('b.txt'), finalStep()];
    const { asked } = await runLoop({ approvalMode: '' });
    expect(asked).toEqual([]);
    expect(existsSync(join(ws, 'b.txt'))).toBe(true);
  });
});

describe('H5 · custom 档的 base(config.json approval.base)', () => {
  const setBase = (b: unknown): void => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ approval: b === undefined ? {} : { base: b } }));
  };

  it('缺席 / 空 → 缺省 auto-edit(照旧);三档原样;拼错 / 大小写变体 / 把 custom 当 base → readonly 并告警', () => {
    setBase(undefined);
    expect(customRules().base).toBe('auto-edit');
    setBase('');
    expect(customRules().base).toBe('auto-edit');
    for (const m of ['readonly', 'auto-edit', 'full-auto']) { setBase(m); expect(customRules().base).toBe(m); }
    for (const bad of ['Readonly', 'read-only', ' readonly', 'custom', 5]) { setBase(bad); expect(customRules().base, String(bad)).toBe('readonly'); }
    expect(warn.mock.calls.some((c) => String(c[0]).includes('config.json approval.base'))).toBe(true);
  });

  it('闸门:custom 档 + base 写成 "Readonly" → 工作区内写照问(从前静默落 auto-edit,不问)', async () => {
    setBase('Readonly');
    const { d, asked } = await gate(write(join(ws, 'a.txt')), { approvalMode: 'custom' });
    expect(asked.map((x) => x.reason)).toEqual([{ kind: 'mode', mode: 'readonly' }]);
    expect(d.action).toBe('reject');
  });
});

describe('拒绝文案:模型面英文、按原因区分', () => {
  it('用户点拒绝 → 模型收到英文回落文案(不含中文)', async () => {
    script = [writeStep('c.txt'), finalStep()];
    const { results } = await runLoop({ approvalMode: 'readonly' });
    const r = results.find((x) => x.name === 'write_file')?.result;
    expect(r).toBe(USER_REJECT_REASON);
    expect(r).not.toMatch(/[一-鿿]/);
  });

  it('规则拒绝仍带规则原文(与用户拒绝可区分)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ approval: { base: 'auto-edit', deny: ['write_file'] } }));
    script = [writeStep('d.txt'), finalStep()];
    const { results } = await runLoop({ approvalMode: 'custom' });
    expect(results.find((x) => x.name === 'write_file')?.result).toBe('Denied by approval rule: write_file');
  });

  it('PreToolUse hook 拦截 → 模型收到英文、写明是 hook 挡的(评审 #6:从前是「⛔ Hook 拦截:…」)', async () => {
    const { saveHooksConfig, discoverAll, trustHook } = await import('../src/hooks/config.js');
    saveHooksConfig({
      events: { PreToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: `printf '%s' '{"decision":"block","reason":"policy says no"}'` }] }] },
      state: {},
    } as any);
    for (const h of discoverAll((await import('../src/hooks/config.js')).loadHooksConfig())) trustHook(h.key);
    script = [writeStep('h.txt'), finalStep()];
    const { asked, results } = await runLoop({ approvalMode: 'full-auto' });
    const r = results.find((x) => x.name === 'write_file')?.result;
    expect(r).toBe('Blocked by a PreToolUse hook, so this tool call was NOT run: policy says no');
    expect(asked).toEqual([]);
    expect(existsSync(join(ws, 'h.txt'))).toBe(false);
  });

  it('中止:已中止 / 等待中被中止 → rejectReason 写明是被停的,不是用户拒绝', async () => {
    const c = write(join(ws, 'e.txt'));
    const ac1 = new AbortController(); ac1.abort();
    expect(await requestApproval('AB1', c, 'p', ac1.signal)).toEqual({ action: 'reject', rejectReason: ABORTED_REJECT_REASON });
    const ac2 = new AbortController();
    const p = requestApproval('AB2', c, 'p', ac2.signal);
    await new Promise((res) => setTimeout(res, 10));
    ac2.abort();
    expect(await p).toEqual({ action: 'reject', rejectReason: ABORTED_REJECT_REASON });
    expect(ABORTED_REJECT_REASON).not.toBe(USER_REJECT_REASON);
  });
});
