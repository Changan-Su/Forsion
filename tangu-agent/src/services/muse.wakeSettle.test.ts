/**
 * 睡醒稳定期(11-20 生产遥测):macOS 合盖时的 DarkWake 只醒几秒,到期的巡检恰在那一秒起周期 → 请求发出去机器就回睡,
 * 下一次 DarkWake(约 15 分钟后)才报网络错 / 流超时。巡检看墙钟上的存活间隔(5 秒一跳,隔了 12 秒以上 = 睡过),要连续醒着
 * 60s 才起后台 run(Muse 周期、Agent 日程一起推迟);用户刚点的叫醒照起。
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
    // 睡之前就挂着的叫醒(当时被让位挡住)不算「人在跟前」;同一毫秒记下的睡醒与叫醒算人在跟前
    expect(m.inWakeSettle({ now: T0 + 30_000, wokeAt: T0, wakeRequestedAt: T0 - 600_000 })).toBe(true);
    expect(m.inWakeSettle({ now: T0 + 30_000, wokeAt: T0, wakeRequestedAt: T0 })).toBe(false);
    // 时钟被往回拨到睡醒之前 → 不挡(否则要等墙钟追回来)
    expect(m.inWakeSettle({ now: T0 - 3600_000, wokeAt: T0, wakeRequestedAt: 0 })).toBe(false);
  });
});

describe('巡检', () => {
  /** 这段时间一直醒着:存活心跳每 5 秒跳一次(真进程里是 setInterval;这里只假造 Date,手动跳)。停在 toMs。 */
  const awake = (fromMs: number, toMs: number): void => {
    for (let t = fromMs; t < toMs; t += 5000) { at(t); m.__museAliveBeatForTests(T0 + t); }
    at(toMs);
  };
  const tick = async (ms: number): Promise<void> => { at(ms); await m.__museTickForTests(); };

  it('对照:一直醒着、心跳到点 → 立刻起周期', async () => {
    awake(0, 20_000);
    await tick(20_000);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].input.museTrigger).not.toBe('manual'); // 心跳或首次播种的装备巡检日程,都是后台起的
  });

  it('隔了 16 分钟才醒(DarkWake)→ 60s 内不起周期、日程也推迟;连续醒满 60s 照常起', async () => {
    m.__museAliveBeatForTests(T0);
    const wake = 16 * 60_000; // 机器睡了 16 分钟,醒来第一件事就是到期的巡检
    await tick(wake);
    expect(state.runs).toHaveLength(0);
    expect(state.schedules).toBe(0);
    expect(state.logs.some((l) => /没有存活心跳/.test(l))).toBe(true);

    awake(wake, wake + 30_000); // 还在稳定期(DarkWake 撑不到这么久;真醒了也只等一分钟)
    await tick(wake + 30_000);
    expect(state.runs).toHaveLength(0);

    awake(wake + 30_000, wake + m.WAKE_SETTLE_MS + 1000);
    await tick(wake + m.WAKE_SETTLE_MS + 1000);
    expect(state.schedules).toBe(1);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].input.museTrigger).not.toBe('manual');
  });

  it('稳定期里又睡了一觉 → 从新的醒来时刻重新起算', async () => {
    m.__museAliveBeatForTests(T0);
    await tick(16 * 60_000); // 第一次 DarkWake
    await tick(32 * 60_000); // 下一次 DarkWake:离上次存活又是 16 分钟
    expect(state.runs).toHaveLength(0);
    awake(32 * 60_000, 32 * 60_000 + 30_000);
    await tick(32 * 60_000 + 30_000);
    expect(state.runs).toHaveLength(0);
    awake(32 * 60_000 + 30_000, 32 * 60_000 + m.WAKE_SETTLE_MS + 1000);
    await tick(32 * 60_000 + m.WAKE_SETTLE_MS + 1000);
    expect(state.runs).toHaveLength(1);
  });

  it('成串的短 DarkWake(pmset 11-17 17:55:51 / 17:56:18 / 17:56:47 / 17:57:46,各醒 10 秒左右)→ 一个周期都不起', async () => {
    // 醒窗(相对 17:55:00 的秒数):[51,62] [78,91] [107,120] [166,177];之间睡 16 / 16 / 46 秒
    const base = 10 * 60_000;
    m.__museAliveBeatForTests(T0); // 17:45 左右最后一次见到醒着
    const windows: Array<[number, number]> = [[51, 62], [78, 91], [107, 120], [166, 177]];
    for (const [a, b] of windows) {
      const from = base + a * 1000;
      const to = base + b * 1000;
      await tick(from); // 醒来那一秒到期的巡检 / 补巡检
      awake(from, to);
      for (let t = from; t <= to; t += 1000) await tick(t); // 醒窗里每秒都有一次巡检机会(最坏情况)
    }
    expect(state.runs).toHaveLength(0);
    expect(state.schedules).toBe(0);
    // 之后真醒了:连续醒满 60 秒才起
    const up = base + 400_000;
    await tick(up);
    awake(up, up + 59_000);
    await tick(up + 59_000);
    expect(state.runs).toHaveLength(0);
    awake(up + 59_000, up + m.WAKE_SETTLE_MS + 1000);
    await tick(up + m.WAKE_SETTLE_MS + 1000);
    expect(state.runs).toHaveLength(1);
  });

  it('刚开盖就点叫醒(存活心跳还没来得及跳)→ 叫醒排在这次睡醒之后,照起', async () => {
    m.__museAliveBeatForTests(T0);
    at(16 * 60_000);
    m.requestMuseWake(); // 请求先到,tick 后到
    await m.__museTickForTests();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].input.museTrigger).toBe('manual');
  });

  it('睡醒后用户点了叫醒 → 不等稳定期,照起', async () => {
    m.__museAliveBeatForTests(T0);
    await tick(16 * 60_000);
    expect(state.runs).toHaveLength(0);
    awake(16 * 60_000, 16 * 60_000 + 5000);
    m.requestMuseWake(); // supervisor 没起 → 只记请求,下面手动巡检
    await m.__museTickForTests();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0].input.museTrigger).toBe('manual');
  });
});
