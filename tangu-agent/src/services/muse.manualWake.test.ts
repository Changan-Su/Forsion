/**
 * 面板「叫醒」(2026-11-08)在巡检里怎么办:下一次 tick 当作到点 —— 清掉 Muse 自己定的休眠、不看心跳间隔与运行时段,
 * 起一轮 trigger = 'manual' 的周期(落进 agent_runs.input.museTrigger,简报里多一句「用户刚叫醒你」);
 * 次数上限照守(作废、写原因);用户有 run 在跑照旧让位(请求留着,下次巡检再办)。
 * 对照:同样「在睡 + 运行时段外 + 心跳没到点」,没点叫醒 → 不起周期。
 * 模型那半(叫醒后它是不是当一轮完整的来做)走 live `--only musewakenow`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  process.env.TANGU_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-manual-wake-'));
  return {
    runs: [] as any[],
    sleep: null as null | { until: number; reason: string; setAt: number; minuteLines: number },
    userRunActive: false,
    maxRestarts: 5,
    logs: [] as string[],
  };
});

vi.mock('../seams/runtime.js', () => ({
  deps: () => ({ profile: { appId: 'tangu', capabilities: { hostExec: true } }, host: { log: (m: string) => state.logs.push(m) } }),
}));
vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string) => {
    if (/s\.kind = 'user' LIMIT 1/.test(sql)) return state.userRunActive ? [{ 1: 1 }] : [];
    if (/COUNT\(\*\)/i.test(sql)) return [{ n: 0 }];
    return [];
  }),
  getOlderThanSql: (col: string, minutes: number) => `${col} < CURRENT_TIMESTAMP - INTERVAL '${minutes} minutes'`,
}));
vi.mock('./runStore.js', () => ({ createRun: vi.fn(async (r: any) => { state.runs.push(r); }), setRunTerminalListener: () => {} }));
vi.mock('./agentLoop.js', () => ({ enqueueRun: () => {} }));
vi.mock('./remoteLock.js', async (orig) => ({ ...(await orig<typeof import('./remoteLock.js')>()), remoteLocked: () => false }));
vi.mock('./museTriggers.js', async (orig) => ({ ...(await orig<typeof import('./museTriggers.js')>()), loadTriggers: async () => [] }));
vi.mock('./automation.js', async (orig) => ({ ...(await orig<typeof import('./automation.js')>()), launchDueSchedules: async () => {} }));
vi.mock('./museCards.js', async (orig) => ({ ...(await orig<typeof import('./museCards.js')>()), postObservedRuleCards: async () => {}, postIntroCard: async () => {}, inboxHint: async () => '', recommendHint: async () => '' }));
vi.mock('../agents/agentRegistry.js', async (orig) => ({ ...(await orig<typeof import('../agents/agentRegistry.js')>()), ensureMuseAgent: async () => {}, getAgent: async () => null }));
vi.mock('./museState.js', async (orig) => ({
  ...(await orig<typeof import('./museState.js')>()),
  readLastCycleAt: async () => Date.now() - 5 * 60_000, // 5 分钟前醒过:120 分钟的心跳没到点
  readMuseSessionId: async () => null,
  getMuseSleep: async () => (state.sleep && Date.now() < state.sleep.until ? state.sleep : null),
  setMuseSleep: async (s: any) => { state.sleep = s; },
}));
vi.mock('./specialAgentsConfig.js', async (orig) => {
  const o = await orig<typeof import('./specialAgentsConfig.js')>();
  const h = new Date().getHours();
  return {
    ...o,
    resolveBackgroundModelId: async (id: string) => id,
    // 运行时段 = 两小时后的那一个钟头:此刻一定在时段外
    loadSpecialAgentsConfig: () => ({ ...o.SPECIAL_AGENTS_DEFAULTS, muse: { ...o.SPECIAL_AGENTS_DEFAULTS.muse, enabled: true, modelId: 'model-x', heartbeatMinutes: 120, maxRestartsPerWindow: state.maxRestarts, activeHours: { start: (h + 2) % 24, end: (h + 3) % 24 } } }),
  };
});

import { __museTickForTests, requestMuseWake, museStatus, cycleTrigger, MANUAL_WAKE_NOTE } from './muse.js';

const asleep = () => ({ until: Date.now() + 6 * 3600_000, reason: 'user is away', setAt: Date.now() - 60_000, minuteLines: 0 });

beforeEach(() => {
  state.runs = [];
  state.sleep = asleep();
  state.userRunActive = false;
  state.maxRestarts = 5;
  state.logs = [];
});

describe('cycleTrigger', () => {
  it('叫醒 > 规则 > 到期日程 > 心跳;都没有 → null', () => {
    const fired = [{ id: 't1' }, { id: 't2' }];
    const due = [{ name: 'Weekly loadout review' }];
    expect(cycleTrigger({ manual: true, fired, due, heartbeatDue: true })).toBe('manual');
    expect(cycleTrigger({ manual: false, fired, due, heartbeatDue: true })).toBe('rule:t1+t2');
    expect(cycleTrigger({ manual: false, fired: [], due, heartbeatDue: true })).toBe('schedule:Weekly loadout review');
    expect(cycleTrigger({ manual: false, fired: [], due: [], heartbeatDue: true })).toBe('heartbeat');
    expect(cycleTrigger({ manual: false, fired: [], due: [], heartbeatDue: false })).toBeNull();
  });
});

describe('巡检 × 叫醒', () => {
  it('对照:在睡、时段外、心跳没到点,没点叫醒 → 不起周期,休眠不动', async () => {
    await __museTickForTests();
    expect(state.runs).toHaveLength(0);
    expect(state.sleep).not.toBeNull();
  });

  it('点了叫醒 → 清休眠、不看运行时段,起一轮 manual 周期;简报带「用户刚叫醒你」、不挂心跳的安静提示;请求清掉', async () => {
    requestMuseWake();
    expect((await museStatus()).wakePending).toBe(true);
    await __museTickForTests();
    expect(state.sleep).toBeNull();
    expect(state.runs).toHaveLength(1);
    const input = state.runs[0].input;
    expect(input.museTrigger).toBe('manual');
    expect(input.ephemeralHint).toContain(MANUAL_WAKE_NOTE.trim());
    expect(input.ephemeralHint).not.toContain('this is a heartbeat');
    const st = await museStatus();
    expect(st.wakePending).toBe(false);
    expect(st.wakeBlocked).toBeNull();
  });

  it('用户有 run 在跑 → 照旧让位,请求留着、写明在等什么;那个 run 跑完下一次巡检就起', async () => {
    state.userRunActive = true;
    requestMuseWake();
    await __museTickForTests();
    expect(state.runs).toHaveLength(0);
    expect(await museStatus()).toMatchObject({ wakePending: true, wakeBlocked: 'userActive' });
    state.userRunActive = false;
    await __museTickForTests();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].input.museTrigger).toBe('manual');
  });

  it('次数上限到了 → 不起,请求作废、写明原因(不会过一阵自己又起)', async () => {
    state.maxRestarts = 0;
    requestMuseWake();
    await __museTickForTests();
    expect(state.runs).toHaveLength(0);
    expect(await museStatus()).toMatchObject({ wakePending: false, wakeBlocked: 'restartCap' });
    await __museTickForTests();
    expect(state.runs).toHaveLength(0);
  });
});
