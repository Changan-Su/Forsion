/**
 * 跨树互发的审批档上限(services/approvals.ts runApprovalCap,方案「会话互通升级」11-08):
 * 树外会话发来的消息起的那一轮登记了上限 → 收方会话哪怕是完全放行,审批闸也按上限问;custom 的 allow 规则不越过上限;
 * 清掉上限后回到收方自己的档。
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
import { allowAlways, clearRunApprovalCap, gateToolCall, runApprovalCap, setRunApprovalCap } from '../src/services/approvals.js';
import { minCapMode } from '../src/services/remoteOrigin.js';
import '../src/tools/registry.js';
import type { ToolCall } from '../src/core/types.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const call = (name: string, args: Record<string, unknown> = {}): ToolCall =>
  ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as ToolCall;

let home: string;
let seq = 0;
async function asked(c: ToolCall, ctx: Record<string, any>, cap?: 'readonly' | 'auto-edit' | 'full-auto'): Promise<boolean> {
  const runId = `C${++seq}`;
  if (cap) setRunApprovalCap(runId, cap);
  const ac = new AbortController();
  const before = state.publish.mock.calls.length;
  const p = gateToolCall(runId, c, { sessionId: 'S', execMode: 'host', profile, cwd: home, ...ctx } as any, ac.signal);
  const settled = await Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 150))]);
  const request = settled ? undefined : state.publish.mock.calls.slice(before).find((x: any[]) => x[0] === runId && x[1] === 'approval_request');
  if (!settled) ac.abort();
  await p.catch(() => {});
  clearRunApprovalCap(runId);
  return !!request;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-sessmsg-cap-'));
  process.env.TANGU_HOME = home;
  configureTangu({ host: {} as any, brain: {} as any, billing: {} as any, profile, state: { getAgentConfig: async () => null } as any } as any);
});
afterAll(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => { state.rules = undefined; });

describe('session message approval cap', () => {
  it('minCapMode 取较严的那个', () => {
    expect(minCapMode(undefined, undefined)).toBeUndefined();
    expect(minCapMode('full-auto', undefined)).toBe('full-auto');
    expect(minCapMode(undefined, 'readonly')).toBe('readonly');
    expect(minCapMode('full-auto', 'auto-edit')).toBe('auto-edit');
    expect(minCapMode('readonly', 'full-auto')).toBe('readonly');
  });

  it('收方完全放行:没有上限时跑命令不问;上限 = 发方的替我批准时照样问', async () => {
    const bash = call('run_bash', { command: 'npm install left-pad' });
    expect(await asked(bash, { approvalMode: 'full-auto' })).toBe(false);
    expect(await asked(bash, { approvalMode: 'full-auto' }, 'auto-edit')).toBe(true);
    expect(await asked(bash, { approvalMode: 'full-auto' }, 'full-auto')).toBe(false);
  });

  it('上限只读:工作区里改文件也要问', async () => {
    const write = call('write_file', { path: join(home, 'a.txt'), content: 'x' });
    expect(await asked(write, { approvalMode: 'auto-edit' })).toBe(false);
    expect(await asked(write, { approvalMode: 'auto-edit' }, 'readonly')).toBe(true);
  });

  it('custom 的 allow 规则不越过上限', async () => {
    state.rules = { base: 'full-auto', allow: ['run_bash'], ask: [], deny: [] };
    const bash = call('run_bash', { command: 'npm install left-pad' });
    expect(await asked(bash, { approvalMode: 'custom' })).toBe(false);
    expect(await asked(bash, { approvalMode: 'custom' }, 'auto-edit')).toBe(true);
  });

  it('本会话点过的「总允许」不越过上限(Codex 11-08)', async () => {
    allowAlways('S', 'run_bash');
    const bash = call('run_bash', { command: 'npm install left-pad' });
    expect(await asked(bash, { approvalMode: 'auto-edit' })).toBe(false); // 没上限:总允许照旧
    expect(await asked(bash, { approvalMode: 'auto-edit' }, 'auto-edit')).toBe(true);
    expect(await asked(bash, { approvalMode: 'auto-edit' }, 'full-auto')).toBe(false);
  });

  it('收尾清掉后不残留', () => {
    setRunApprovalCap('X1', 'readonly');
    expect(runApprovalCap('X1')).toBe('readonly');
    clearRunApprovalCap('X1');
    expect(runApprovalCap('X1')).toBeUndefined();
  });
});
