/**
 * P1 · K2 §3.4:锁定时 Muse 巡检整轮跳过 —— 盯任务规则、Agent 日程、Muse 周期一起**推迟**(不丢:解锁后下一次 tick 照常评估,
 * 到期条目按 dueEntries 补跑)。急停的语义是「不是我在键盘前发起的一律停」(K2 U1 缺省)。
 * 负对照:改前(tick 无现查)锁定时 drainAutomation / launchDueSchedules 照样被调 → 红(实跑记在 K2 交付报告)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ locked: false, lockThrows: false, drained: 0, schedules: 0, logs: [] as string[] }));

vi.mock('../seams/runtime.js', () => ({
  deps: () => ({ profile: { appId: 'tangu', capabilities: { hostExec: true } }, host: { log: (m: string) => state.logs.push(m) } }),
}));
vi.mock('./remoteLock.js', async (orig) => ({
  ...(await orig<typeof import('./remoteLock.js')>()),
  remoteLocked: () => { if (state.lockThrows) throw new Error('boom'); return state.locked; },
}));
vi.mock('./museState.js', async (orig) => ({ ...(await orig<typeof import('./museState.js')>()), readLastCycleAt: async () => 0, readMuseSessionId: async () => null }));
vi.mock('./museTriggers.js', async (orig) => ({ ...(await orig<typeof import('./museTriggers.js')>()), loadTriggers: async () => [{ id: 't1', cond: { type: 'event_seen' } }] }));
vi.mock('./userActivity.js', async (orig) => ({ ...(await orig<typeof import('./userActivity.js')>()), readActivityLines: async () => [] }));
vi.mock('./automationDrain.js', () => ({ drainAutomation: vi.fn(async () => { state.drained++; return { museFired: [], trigCursors: {}, notices: {} }; }) }));
vi.mock('./automation.js', async (orig) => ({ ...(await orig<typeof import('./automation.js')>()), launchDueSchedules: vi.fn(async () => { state.schedules++; }) }));
vi.mock('./specialAgentsConfig.js', async (orig) => {
  const o = await orig<typeof import('./specialAgentsConfig.js')>();
  return { ...o, loadSpecialAgentsConfig: () => ({ ...o.SPECIAL_AGENTS_DEFAULTS, muse: { ...o.SPECIAL_AGENTS_DEFAULTS.muse, enabled: false } }) };
});

import { __museTickForTests } from './muse.js';

beforeEach(() => {
  state.locked = false;
  state.lockThrows = false;
  state.drained = 0;
  state.schedules = 0;
  state.logs = [];
});

describe('Muse 巡检 × 远程锁定', () => {
  it('未锁:盯任务规则与 Agent 日程照常评估(对照)', async () => {
    await __museTickForTests();
    expect(state.drained).toBe(1);
    expect(state.schedules).toBe(1);
  });

  it('锁定:整轮跳过(规则、日程、Muse 周期都不评估),日志只提示一次;解锁后下一轮照常', async () => {
    state.locked = true;
    await __museTickForTests();
    await __museTickForTests();
    expect(state.drained).toBe(0);
    expect(state.schedules).toBe(0);
    expect(state.logs.filter((l) => l.includes('remote lock')).length).toBe(1);
    state.locked = false;
    await __museTickForTests();
    expect(state.drained).toBe(1);
    expect(state.schedules).toBe(1);
  });

  it('读锁抛异常 → 按锁定跳过', async () => {
    state.lockThrows = true;
    await __museTickForTests();
    expect(state.drained).toBe(0);
    expect(state.schedules).toBe(0);
  });
});
