/**
 * capabilities.approval:'edit' —— 插件写工具并入写文件档(与 write_file 同档)。
 * 钉的是它与 'command' 档的差别:「替我批准」(auto-edit)直接做、只有「询问我批准」(readonly)问;
 * custom 的 base 照样作数;云端 / sandbox 会话不问;「总允许」照旧记下。
 * 负对照(实跑):去掉 toolNeedsApproval 里 writesFiles 的 `declared === 'edit'` → 前四条红(只有云端 / sandbox 那条照旧绿);
 * 闸门不把 ctx.profile 传进 toolNeedsApproval → profile 那条红。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  publish: vi.fn(async (..._a: any[]) => 1),
  rules: undefined as any,
}));
vi.mock('../src/services/eventBus.js', async (orig) => ({ ...(await orig<any>()), publish: state.publish }));
vi.mock('../src/hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));
vi.mock('../src/core/config.js', async (orig) => ({
  ...(await orig<typeof import('../src/core/config.js')>()),
  getRawSection: (name: string) => (name === 'approval' ? state.rules : undefined),
}));

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { gateToolCall, isAlwaysAllowed, resolveApproval, toolNeedsApproval } from '../src/services/approvals.js';
import { declaredApproval, registerToolProvider, unregisterToolProvider } from '../src/tools/toolRegistry.js';
import type { ToolCall } from '../src/core/types.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const tool = (name: string, approval: 'edit' | 'command') => ({
  name, capabilities: { sideEffect: 'write', approval },
  definition: { type: 'function' as const, function: { name, description: name, parameters: { type: 'object', properties: {} } } },
  execute: async () => 'ok',
});
const PROVIDER = 'test:approval-edit';
const call = (name: string): ToolCall => ({ id: 'c1', type: 'function', function: { name, arguments: '{}' } }) as ToolCall;

let home: string;
let seq = 0;
/** 跑一次闸;弹了卡就按 answer 兑现(缺省 = 中止,闸按拒绝收场)。 */
async function gate(c: ToolCall, ctx: Record<string, any>, answer?: 'approve' | 'approve_always'): Promise<{ asked: boolean; decision: any }> {
  const runId = `E${++seq}`;
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
  return { asked: !!request, decision: await p };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-approval-edit-'));
  process.env.TANGU_HOME = home;
  configureTangu({ host: {} as any, brain: {} as any, billing: {} as any, profile, state: { getAgentConfig: async () => null } as any } as any);
  registerToolProvider({ id: PROVIDER, tools: () => [tool('plugin_save', 'edit'), tool('plugin_command', 'command')] } as any);
});
afterAll(() => {
  unregisterToolProvider(PROVIDER);
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => { state.rules = undefined; });

describe("capabilities.approval: 'edit'", () => {
  it('声明读得到;档位判定与 write_file 一致,和 command 档不同', () => {
    expect(declaredApproval('plugin_save')).toBe('edit');
    for (const mode of ['readonly', 'auto-edit', 'full-auto', undefined] as const) {
      expect(toolNeedsApproval('plugin_save', mode), String(mode)).toBe(toolNeedsApproval('write_file', mode));
    }
    expect(toolNeedsApproval('plugin_save', 'auto-edit')).toBe(false);
    expect(toolNeedsApproval('plugin_command', 'auto-edit')).toBe(true); // 对照
    expect(toolNeedsApproval('plugin_save', 'readonly')).toBe(true);
  });

  it('替我批准直接做;询问我批准弹卡;完全通行直接做', async () => {
    const auto = await gate(call('plugin_save'), { approvalMode: 'auto-edit' });
    expect(auto.asked).toBe(false);
    expect(auto.decision.action).toBe('approve');
    expect((await gate(call('plugin_command'), { approvalMode: 'auto-edit' })).asked).toBe(true); // 对照
    expect((await gate(call('plugin_save'), { approvalMode: 'readonly' })).asked).toBe(true);
    expect((await gate(call('plugin_save'), { approvalMode: 'full-auto' })).asked).toBe(false);
  });

  it('custom 的 base 照样作数', async () => {
    state.rules = { base: 'readonly', allow: [], ask: [], deny: [] };
    expect((await gate(call('plugin_save'), { approvalMode: 'custom' })).asked).toBe(true);
    state.rules = { base: 'auto-edit', allow: [], ask: [], deny: [] };
    expect((await gate(call('plugin_save'), { approvalMode: 'custom' })).asked).toBe(false);
  });

  it('询问我批准下点「总允许」,同会话下一次不再问', async () => {
    const first = await gate(call('plugin_save'), { approvalMode: 'readonly', sessionId: 'S-edit' }, 'approve_always');
    expect(first.asked).toBe(true);
    expect(first.decision.action).toBe('approve');
    expect(isAlwaysAllowed('S-edit', 'plugin_save')).toBe(true);
    expect((await gate(call('plugin_save'), { approvalMode: 'readonly', sessionId: 'S-edit' })).asked).toBe(false);
  });

  it('应用 profile 自带的工具(toolLoadout.providers)声明的档也认', async () => {
    const appProfile = createTanguProfile({ sandboxMode: 'none' }) as any;
    appProfile.toolLoadout = { ...(appProfile.toolLoadout ?? {}), providers: [{ id: 'test:profile-edit', tools: () => [tool('profile_save', 'edit'), tool('profile_command', 'command')] }] };
    expect(toolNeedsApproval('profile_save', 'readonly')).toBe(false); // 不带 profile 看不见(修之前闸门就是这么判的)
    expect(toolNeedsApproval('profile_save', 'readonly', { profile: appProfile })).toBe(true);
    expect(toolNeedsApproval('profile_save', 'auto-edit', { profile: appProfile })).toBe(false);
    expect((await gate(call('profile_save'), { approvalMode: 'readonly', profile: appProfile })).asked).toBe(true);
    expect((await gate(call('profile_save'), { approvalMode: 'auto-edit', profile: appProfile })).asked).toBe(false);
    expect((await gate(call('profile_command'), { approvalMode: 'auto-edit', profile: appProfile })).asked).toBe(true);
  });

  it('云端 / sandbox 会话不问', async () => {
    const r = await gate(call('plugin_save'), { execMode: 'sandbox', approvalMode: undefined });
    expect(r.asked).toBe(false);
    expect(r.decision.action).toBe('approve');
  });
});
