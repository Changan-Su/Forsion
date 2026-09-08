/**
 * scripts/stall-timeline.mjs 的归属逻辑:间隙按「前一事件之后的状态」进桶;流段自身时长记 stream;
 * usage.ttftMs 测量值优先。改 stateAfter/collapse 先过这里。
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error 脚本是无类型的 .mjs
import { attribute, collapse, stateAfter } from '../scripts/stall-timeline.mjs';

const T0 = 1_700_000_000_000;
const ev = (type: string, t: number, extra: Record<string, unknown> = {}) => ({ seq: t, type, t, ...extra });

describe('stall-timeline attribute', () => {
  it('折叠流段;间隙归到等首帧/生成/工具/审批;首帧取 usage.ttftMs', () => {
    const events = collapse([
      ev('status', T0, { phase: 'running' }),
      ev('status', T0, { phase: 'llm_call', stage: 'sending', bytes: 2048 }),
      ev('token', T0 + 8_000), ev('token', T0 + 8_500), ev('token', T0 + 11_000),
      ev('usage', T0 + 11_000, { prompt: 1000, cached: 500, ttftMs: 8000, uploadMs: 300, requestBytes: 2048 }),
      ev('tool_call', T0 + 11_000, { name: 'run_bash' }),
      ev('approval_request', T0 + 11_000, { name: 'run_bash' }),
      ev('approval_result', T0 + 41_000, { action: 'approve' }),
      ev('tool_result', T0 + 46_000, { name: 'run_bash', elapsedMs: 5000 }),
      ev('reasoning', T0 + 56_000), ev('reasoning', T0 + 59_000),
      ev('token', T0 + 60_000),
      ev('usage', T0 + 60_000, { prompt: 1200, cached: 1100, ttftMs: 10_000 }),
      ev('done', T0 + 60_000),
    ]);
    expect(events.filter((e: any) => e.type === 'token').map((e: any) => e.n)).toEqual([3, 1]);
    const r = attribute([{ id: 'R', model: 'm', created: T0, events }]);
    expect(r.tot.llm_wait).toBe(8_000 + 10_000);      // sending→首 token 8s;tool_result→reasoning 10s
    expect(r.tot.stream).toBe(3_000 + 3_000 + 1_000);  // token 段 3s + reasoning 段 3s + reasoning→token 1s
    expect(r.tot.approval).toBe(30_000);
    expect(r.tot.tool).toBe(5_000);
    expect(r.perModel.m.ttftMeasured).toEqual([8000, 10_000]);
    expect(r.perModel.m.upload).toEqual([300]);
    expect(r.tools.run_bash).toEqual([5000]);
    expect(r.approvals).toEqual([30_000]);
    expect(r.perRun[0]).toMatchObject({ silent: 18_000, wall: 60_000 });
    expect(r.big.map((b: any) => b.k)).toEqual(['approval', 'llm_wait']); // ≥10s 的间隙:30s 审批、10s 等首帧
  });

  it('没应答的审批计入 unanswered;工具后紧跟工具(并行组)算工具时间', () => {
    const events = collapse([
      ev('tool_call', T0), ev('tool_call', T0),
      ev('tool_result', T0 + 2_000), ev('tool_result', T0 + 4_000),
      ev('approval_request', T0 + 4_000),
    ]);
    const r = attribute([{ id: 'R', model: 'm', created: T0, events }]);
    expect(r.tot.tool).toBe(4_000);
    expect(r.unanswered).toBe(1);
    expect(stateAfter({ type: 'status', phase: 'queued' }, { type: 'status' })).toBe('queue');
    expect(stateAfter({ type: 'status', phase: 'llm_retry' }, { type: 'token' })).toBe('retry');
  });
});
