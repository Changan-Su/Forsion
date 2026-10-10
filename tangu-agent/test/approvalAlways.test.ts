/**
 * capabilities.approval:'always' —— 每次都问用户本人的那一档(花掉账号里的东西这类动作)。
 * 钉的是它与 'command' 档的全部差别:不看执行形态(云端 / sandbox 会话照样问)、不看档位(空档与完全通行都问)、
 * custom allow / hook allow / 总允许都不放行、没人能当场答的 run 与远程污点 run 直接拒。
 * 负对照(实跑):去掉 gateToolCall 里非 host 早退的 `!alwaysAsk` → 「云端」那条红;去掉总允许那处的 `!alwaysAsk` → 「总允许」那条红。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  publish: vi.fn(async (..._a: any[]) => 1),
  rules: undefined as any,
  hook: {} as any,
}));
vi.mock('../src/services/eventBus.js', async (orig) => ({ ...(await orig<any>()), publish: state.publish }));
vi.mock('../src/hooks/index.js', () => ({ runHooks: vi.fn(async () => state.hook) }));
vi.mock('../src/core/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/core/config.js')>()),
  getRawSection: (name: string) => (name === 'approval' ? state.rules : undefined),
}));

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { gateToolCall, isAlwaysAllowed, resolveApproval, toolNeedsApproval } from '../src/services/approvals.js';
import { registerToolProvider, unregisterToolProvider } from '../src/tools/toolRegistry.js';
import { isAutomationTool } from '../src/services/automation.js';
import '../src/tools/registry.js'; // 内置工具登记(forsion_account_action 是头一个用 'always' 的)
import type { ToolCall } from '../src/core/types.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const tool = (name: string, approval: 'command' | 'always') => ({
  name, capabilities: { approval },
  definition: { type: 'function' as const, function: { name, description: name, parameters: { type: 'object', properties: {} } } },
  execute: async () => 'ok',
});
const PROVIDER = 'test:approval-always';
const call = (name: string, args: Record<string, unknown> = {}): ToolCall =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as ToolCall;

let home: string;
let seq = 0;
/** 跑一次闸;弹了卡就按 answer 兑现(缺省 = 中止,闸按拒绝收场)。 */
async function gate(c: ToolCall, ctx: Record<string, any>, answer?: 'approve' | 'approve_always'): Promise<{ asked: boolean; decision: any; request?: any }> {
  const runId = `A${++seq}`;
  const ac = new AbortController();
  const before = state.publish.mock.calls.length;
  const p = gateToolCall(runId, c, { sessionId: ctx.sessionId ?? 'S', execMode: 'host', profile, ...ctx } as any, ac.signal);
  let request: any;
  const settled = await Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 150))]);
  if (!settled) {
    request = state.publish.mock.calls.slice(before).find((x: any[]) => x[0] === runId && x[1] === 'approval_request')?.[2];
    if (answer && request) resolveApproval(request.approvalId, { action: answer }, runId);
    else ac.abort();
  }
  return { asked: !!request, decision: await p, request };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-approval-always-'));
  process.env.TANGU_HOME = home;
  configureTangu({ host: {} as any, brain: {} as any, billing: {} as any, profile, state: { getAgentConfig: async () => null } as any } as any);
  registerToolProvider({ id: PROVIDER, tools: () => [tool('spend_asset', 'always'), tool('plain_command', 'command')] } as any);
});
afterAll(() => {
  unregisterToolProvider(PROVIDER);
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => { state.rules = undefined; state.hook = {}; });

describe("capabilities.approval: 'always'", () => {
  it('本机会话:完全通行与空档都问,原因标 always', async () => {
    for (const approvalMode of ['full-auto', 'auto-edit', 'readonly', undefined]) {
      const r = await gate(call('spend_asset'), { approvalMode });
      expect(r.asked, String(approvalMode)).toBe(true);
      expect(r.request.reason.kind).toBe('always');
      expect(r.request.localOnly).toBeUndefined(); // 不是「只在执行设备本机批」:云端 run 没有本机
    }
  });

  it('云端 / sandbox 会话(非 host、没有档位)照样问;command 档在那里照旧直接放行', async () => {
    const cloud = await gate(call('spend_asset'), { execMode: 'sandbox', approvalMode: undefined });
    expect(cloud.asked).toBe(true);
    expect(cloud.request.reason.kind).toBe('always');
    const plain = await gate(call('plain_command'), { execMode: 'sandbox', approvalMode: undefined });
    expect(plain.asked).toBe(false);
    expect(plain.decision.action).toBe('approve');
  });

  it('批准后执行;「总允许」不作数 —— 下一次仍然问', async () => {
    const first = await gate(call('spend_asset'), { approvalMode: 'auto-edit', sessionId: 'S-always' }, 'approve_always');
    expect(first.asked).toBe(true);
    expect(first.decision.action).toBe('approve');
    expect(isAlwaysAllowed('S-always', 'spend_asset')).toBe(false);
    expect((await gate(call('spend_asset'), { approvalMode: 'auto-edit', sessionId: 'S-always' })).asked).toBe(true);
    // 对照:command 档的「总允许」照旧记下、下一次不问
    const cmd = await gate(call('plain_command'), { approvalMode: 'auto-edit', sessionId: 'S-cmd' }, 'approve_always');
    expect(cmd.asked).toBe(true);
    expect(isAlwaysAllowed('S-cmd', 'plain_command')).toBe(true);
    expect((await gate(call('plain_command'), { approvalMode: 'auto-edit', sessionId: 'S-cmd' })).asked).toBe(false);
  });

  it('用户写的 allow 规则与 hook 的 allow 都不放行;deny 规则与 hook 的 block 照样拒', async () => {
    state.rules = { base: 'full-auto', allow: ['spend_asset', 'plain_command'], ask: [], deny: [] };
    expect((await gate(call('spend_asset'), { approvalMode: 'custom' })).asked).toBe(true);
    expect((await gate(call('plain_command'), { approvalMode: 'custom' })).asked).toBe(false); // 对照
    state.rules = undefined;
    state.hook = { allow: true };
    expect((await gate(call('spend_asset'), { approvalMode: 'auto-edit' })).asked).toBe(true);
    state.hook = { block: true };
    const blocked = await gate(call('spend_asset'), { approvalMode: 'auto-edit' });
    expect(blocked.asked).toBe(false);
    expect(blocked.decision.action).toBe('reject');
    state.hook = {};
    state.rules = { base: 'full-auto', allow: [], ask: [], deny: ['spend_asset'] };
    const denied = await gate(call('spend_asset'), { approvalMode: 'custom' });
    expect(denied.asked).toBe(false);
    expect(denied.decision).toMatchObject({ action: 'reject' });
  });

  it('没人能当场答的 run(自动化 / Muse 排队与代批)和远程污点 run:不弹卡,直接拒', async () => {
    for (const ctx of [{ unattended: true }, { approvalDeferral: 'queue' }, { approvalDeferral: 'agent' }, { remote: { via: 'tunnel', marked: true } }]) {
      const r = await gate(call('spend_asset'), { approvalMode: 'full-auto', ...ctx });
      expect(r.asked, JSON.stringify(ctx)).toBe(false);
      expect(r.decision.action, JSON.stringify(ctx)).toBe('reject');
      expect(r.decision.rejectReason).toMatch(/confirm/);
    }
  });

  it('头一个用它的内置工具 forsion_account_action:云端 / 聊天会话(非 host、没有档位)照样弹卡,卡上是人话', async () => {
    const r = await gate(call('forsion_account_action', { action: 'move_quota_to_background', percent: 25 }), { execMode: 'sandbox', approvalMode: undefined });
    expect(r.asked).toBe(true);
    expect(r.request.reason.kind).toBe('always');
    expect(r.request.preview).toMatch(/^Forsion account: move 25% of the AI quota limit to the background quota/);
  });

  it('应用自带工具(profile.toolLoadout.providers)声明的 always 同样作数:云端会话照样问', async () => {
    const app = { ...profile, toolLoadout: { ...profile.toolLoadout, providers: [{ id: 'app:spend', tools: () => [tool('app_spend', 'always')] }] } };
    const r = await gate(call('app_spend'), { execMode: 'sandbox', approvalMode: undefined, profile: app });
    expect(r.asked).toBe(true);
    expect(r.request.reason.kind).toBe('always');
  });

  it('同名覆盖 run_bash 并声明 always:已知安全的只读命令也不走免批捷径', async () => {
    registerToolProvider({ id: 'test:bash-always', tools: () => [tool('run_bash', 'always')] } as any);
    try {
      expect((await gate(call('run_bash', { command: 'pwd' }), { approvalMode: 'auto-edit', cwd: home })).asked).toBe(true);
    } finally { unregisterToolProvider('test:bash-always'); }
    const plain = await gate(call('run_bash', { command: 'pwd' }), { approvalMode: 'auto-edit', cwd: home });
    expect(plain.asked).toBe(false); // 对照:撤掉后照旧免批
    expect(plain.decision.action).toBe('approve');
  });

  it('自动化动作目录不收 always 的工具,哪怕它同时声明了 automationSafe(动作到点直接执行,不过审批闸)', () => {
    const t = (name: string, approval?: 'always') => ({ ...tool(name, 'command'), capabilities: { automationSafe: true, ...(approval ? { approval } : {}) } });
    registerToolProvider({ id: 'test:auto', tools: () => [t('auto_spend', 'always'), t('auto_plain')] } as any);
    try {
      expect(isAutomationTool('auto_spend')).toBe(false);
      expect(isAutomationTool('auto_plain')).toBe(true); // 对照
    } finally { unregisterToolProvider('test:auto'); }
  });

  it('toolNeedsApproval:always 不看档位;command 档口径不变', () => {
    for (const m of [undefined, 'full-auto', 'auto-edit', 'readonly'] as const) expect(toolNeedsApproval('spend_asset', m)).toBe(true);
    expect(toolNeedsApproval('plain_command', undefined)).toBe(false);
    expect(toolNeedsApproval('plain_command', 'full-auto')).toBe(false);
    expect(toolNeedsApproval('plain_command', 'auto-edit')).toBe(true);
  });
});
