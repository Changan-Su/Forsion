/**
 * 睡醒稳定期(11-20 生产遥测):macOS 合盖时的 DarkWake 只醒几秒,到期的巡检恰在那一秒起周期 → 请求发出去机器就回睡,
 * 下一次 DarkWake(约 15 分钟后)才报网络错 / 流超时。巡检看墙钟上的存活间隔:隔了 90s 以上 = 刚睡醒,
 * 60s 内整轮不起后台 run(Muse 周期、Agent 日程一起推迟);用户刚点的叫醒照起。
 * 对照:同样心跳到点、没有睡过 → 立刻起周期。真进程的复现(SIGSTOP / SIGCONT)见 scripts/muse-darkwake.repro.mjs。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  process.env.TANGU_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-wake-settle-'));
  return { runs: [] as any[], logs: [] as string[], schedules: 0 };
});

vi.mock('../seams/runtime.js', () => ({
  deps: () => ({ profile: { appId: 'tangu', capabilities: { hostExec: true } }, host: { log: (m: string) => state.logs.push(m) } }),
}));
vi.mock('../core/db.js', () => ({
  query: vi.fn(async (sql: string) => (/COUNT\(\*\)/i.test(sql) ? [{ n: 0 }] : [])),
  getOlderThanSql: (col: string, minutes: number) => `${col} < CURRENT_TIMESTAMP - INTERVAL '${minutes} minutes'`,
}));
vi.mock('./runStore.js', () => ({ createRun: vi.fn(async (r: any) => { state.runs.push(r); }), setRunTerminalListener: () => {} }));
vi.mock('./agentLoop.js', () => ({ enqueueRun: () => {} }));
vi.mock('./remoteLock.js', async (orig) => ({ ...(await orig<typeof import('./remoteLock.js')>()), remoteLocked: () => false }));
vi.mock('./museTriggers.js', async (orig) => ({ ...(await orig<typeof import('./museTriggers.js')>()), loadTriggers: async () => [] }));
vi.mock('./automation.js', async (orig) => ({ ...(await orig<typeof import('./automation.js')>()), launchDueSchedules: async () => { state.schedules++; } }));
vi.mock('./museCards.js', async (orig) => ({ ...(await orig<typeof import('./museCards.js')>()), postObservedRuleCards: async () => {}, postIntroCard: async () => {}, inboxHint: async () => '', recommendHint: async () => '' }));
vi.mock('../agents/agentRegistry.js', async (orig) => ({ ...(await orig<typeof import('../agents/agentRegistry.js')>()), ensureMuseAgent: async () => {}, getAgent: async () => null }));
vi.mock('./museState.js', async (orig) => ({
  ...(await orig<typeof import('./museState.js')>()),
  readLastCycleAt: async () => Date.now() - 3 * 3600_000, // 三小时前醒过:120 分钟的心跳早到点了
  readMuseSessionId: async () => null,
  getMuseSleep: async () => null,
  setMuseSleep: async () => {},
}));
vi.mock('./specialAgentsConfig.js', async (orig) => {
  const o = await orig<typeof import('./specialAgentsConfig.js')>();
  return {
    ...o,
    resolveBackgroundModelId: async (id: string) => id,
    loadSpecialAgentsConfig: () => ({ ...o.SPECIAL_AGENTS_DEFAULTS, muse: { ...o.SPECIAL_AGENTS_DEFAULTS.muse, enabled: true, modelId: 'model-x', heartbeatMinutes: 120, maxTokensPerWindow: 1_000_000, maxRestartsPerWindow: 10, activeHours: null } }),
  };
});

type MuseModule = typeof import('./muse.js');
let m: MuseModule;
const T0 = Date.parse('2026-11-17T18:00:00Z');
const at = (ms: number): void => { vi.setSystemTime(T0 + ms); };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
  state.runs = [];
  state.logs = [];
  state.schedules = 0;
  vi.resetModules(); // 每个用例一份新的模块状态(lastAliveAt / wokeAt / lastCycleAt)
  m = await import('./muse.js');
});
afterEach(() => { vi.useRealTimers(); });

describe('inWakeSettle(纯函数)', () => {
  it('没睡过 / 稳定期满 / 睡醒后点了叫醒 → 不挡;睡醒 60s 内 → 挡', () => {
    expect(m.inWakeSettle({ now: T0, wokeAt: 0, wakeRequestedAt: 0 })).toBe(false);
    expect(m.inWakeSettle({ now: T0 + 30_000, wokeAt: T0, wakeRequestedAt: 0 })).toBe(true);
    expect(m.inWakeSettle({ now: T0 + m.WAKE_SETTLE_MS, wokeAt: T0, wakeRequestedAt: 0 })).toBe(false);
    expect(m.inWakeSettle({ now: T0 + 30_000, wokeAt: T0, wakeRequestedAt: T0 + 10_000 })).toBe(false);
    // 睡之前就挂着的叫醒(当时被让位挡住)不算「人在跟前」
    expect(m.inWakeSettle({ now: T0 + 30_000, wokeAt: T0, wakeRequestedAt: T0 - 600_000 })).toBe(true);
  });
});

describe('巡检', () => {
  it('对照:一直醒着、心跳到点 → 立刻起周期', async () => {
    m.__museAliveBeatForTests(T0);
    at(20_000);
    await m.__museTickForTests();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].input.museTrigger).not.toBe('manual'); // 心跳或首次播种的装备巡检日程,都是后台起的
  });

  it('隔了 16 分钟才醒(DarkWake)→ 60s 内不起周期、日程也推迟;稳定期满照常起', async () => {
    m.__museAliveBeatForTests(T0);
    at(16 * 60_000); // 机器睡了 16 分钟,醒来第一件事就是到期的巡检
    await m.__museTickForTests();
    expect(state.runs).toHaveLength(0);
    expect(state.schedules).toBe(0);
    expect(state.logs.some((l) => /没有存活心跳/.test(l))).toBe(true);

    at(16 * 60_000 + 30_000); // 还在稳定期(DarkWake 撑不到这么久;真醒了也只等一分钟)
    await m.__museTickForTests();
    expect(state.runs).toHaveLength(0);

    at(16 * 60_000 + m.WAKE_SETTLE_MS + 1000);
    await m.__museTickForTests();
    expect(state.schedules).toBe(1);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].input.museTrigger).not.toBe('manual'); // 心跳或首次播种的装备巡检日程,都是后台起的
  });

  it('稳定期里又睡了一觉 → 从新的醒来时刻重新起算', async () => {
    m.__museAliveBeatForTests(T0);
    at(16 * 60_000);
    await m.__museTickForTests(); // 第一次 DarkWake
    at(32 * 60_000);
    await m.__museTickForTests(); // 下一次 DarkWake:离上次存活又是 16 分钟
    expect(state.runs).toHaveLength(0);
    at(32 * 60_000 + 30_000);
    await m.__museTickForTests();
    expect(state.runs).toHaveLength(0);
    at(32 * 60_000 + m.WAKE_SETTLE_MS + 1000);
    await m.__museTickForTests();
    expect(state.runs).toHaveLength(1);
  });

  it('睡醒后用户点了叫醒 → 不等稳定期,照起', async () => {
    m.__museAliveBeatForTests(T0);
    at(16 * 60_000);
    await m.__museTickForTests();
    expect(state.runs).toHaveLength(0);
    at(16 * 60_000 + 5000);
    m.requestMuseWake(); // supervisor 没起 → 只记请求,下面手动巡检
    await m.__museTickForTests();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].input.museTrigger).toBe('manual');
  });
});
