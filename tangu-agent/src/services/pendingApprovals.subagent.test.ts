/**
 * 延后审批 × 具名子代理的**目标漂移**(2026-09-15 回归)。
 *
 * 排队行只存得下一个 `agent_slug`(= 本 run 的归属 agent,LOG / 收件箱 / 叫醒 Muse 都读它),
 * 而 executeApproved 事后是按它**重建** ALS 作用域去跑的。于是:具名子代理 subby 发起的
 * manage_harness,当场执行写 agents/subby/HARNESS.md,排队后由用户批准却写到 agents/parenty/ ——
 * 同一笔调用两条路落到两个文件。delegate 的 grantTools 之前,管理面工具在子代理里压根到不了审批闸,
 * 这条路是那次改动新开的,所以闸也开在那次改动的同一层:**这类工具不排队**。
 *
 * 判据:AGENT_SCOPED_TOOLS(写入目标取自 ALS 身份的那几个)× 执行身份≠run 身份 → 当场拒绝、不落行。
 * 三条负对照钉住闸的边界,免得「全都不排队了」也能全绿:
 *   ① 目标写在参数里的工具(write_file)照排;② 身份一致(自己委派自己)照排;③ 深度 0 主 loop 照排。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; tool: string; agentSlug: string; key: string }>,
  sent: [] as Array<{ title: string }>,
}));

vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string, params: any[]) => {
    if (/SELECT id FROM pending_approvals/.test(sql)) return state.rows.filter((r) => r.key === params[1]).map((r) => ({ id: r.id }));
    if (/INSERT INTO pending_approvals/.test(sql)) {
      state.rows.push({ id: params[0], tool: params[5], agentSlug: params[4], key: params[params.length - 1] });
      return { ok: true };
    }
    return [];
  }),
}));
vi.mock('../tools/builtin/inboxSend.js', () => ({
  MUSE_SENDER_ID: 'muse',
  sendInboxMessage: vi.fn(async (_u: string, m: any) => { state.sent.push(m); return { ok: true }; }),
}));
vi.mock('../seams/runtime.js', () => ({
  deps: () => ({ brain: { memory: { appendLogEntry: async () => {} } } }),
}));
// 真模块整份透传,只把「哪些工具排得了队」换成固定两个:AGENT_SCOPED_TOOLS 是被测判据,必须用真值。
vi.mock('../tools/toolRegistry.js', async (orig) => ({
  ...(await orig<typeof import('../tools/toolRegistry.js')>()),
  listToolProviders: () => [{ origin: 'builtin', tools: () => [{ name: 'write_file' }, { name: 'manage_harness' }] }],
}));

import { deferApproval } from './pendingApprovals.js';

const callOf = (name: string, args: Record<string, unknown>) =>
  ({ id: 'c1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
const harness = callOf('manage_harness', { action: 'upsert', title: 'lesson from sub', body: 'x' });
const writeFile = callOf('write_file', { path: '/tmp/x.md', content: 'hi' });
/** 无人值守父 run(Muse ask/agent 档)。execAgentSlug 由 subAgent 在具名子代理时填上。 */
const ctxOf = (extra: Record<string, unknown> = {}) =>
  ({ userId: 'u1', sessionId: 's1', agentSlug: 'parenty', cwd: '/tmp', approvalDeferral: 'queue' as const, ...extra });

beforeEach(() => { state.rows.length = 0; state.sent.length = 0; });

describe('ALS 作用域工具不排队(执行身份 ≠ run 身份时)', () => {
  it('子代理的 manage_harness → 当场拒绝、不落行,措辞点名两个 agent', async () => {
    const d = await deferApproval('r1', harness, 'harness upsert', { kind: 'mode', mode: 'auto-edit' }, ctxOf({ execAgentSlug: 'subby' }));
    expect(d.action).toBe('reject');
    expect(d.rejectReason).toContain('manage_harness');
    expect(d.rejectReason, '得让用户/模型看出会写错到谁头上').toContain('parenty');
    expect(d.rejectReason).toContain('subby');
    expect(d.rejectReason, '给模型一条能走的路,而不是只说不行').toMatch(/final report/i);
    expect(state.rows, '一旦落行,用户事后一批就写到父代理的 HARNESS.md 去了').toHaveLength(0);
    expect(state.sent, '没排上队就不该发审批请求').toHaveLength(0);
  });

  it('负对照①:目标写在参数里的工具(write_file)照排 —— 闸只挡 ALS 作用域那几个', async () => {
    const d = await deferApproval('r1', writeFile, 'write /tmp/x.md', undefined, ctxOf({ execAgentSlug: 'subby' }));
    expect(d.action).toBe('reject'); // 排队本身也是对模型的一句拒绝
    expect(d.rejectReason).toMatch(/Deferred for the user's approval/);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].tool).toBe('write_file');
  });

  it('负对照②:执行身份与 run 身份一致(父代理委派给自己)→ 照排,不存在漂移', async () => {
    const d = await deferApproval('r1', harness, 'harness upsert', undefined, ctxOf({ execAgentSlug: 'parenty' }));
    expect(d.rejectReason).toMatch(/Deferred for the user's approval/);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].agentSlug).toBe('parenty');
  });

  it('负对照③:深度 0 的主 loop(没有 execAgentSlug)→ 照排,老行为零变化', async () => {
    const d = await deferApproval('r1', harness, 'harness upsert', undefined, ctxOf());
    expect(d.rejectReason).toMatch(/Deferred for the user's approval/);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].tool).toBe('manage_harness');
  });
});
