/**
 * Muse 自主跳过心跳(set_next_wake,2026-09-24):心跳闸四象限、醒来时刻解析、休眠落盘的防篡改与合并写、
 * 「用户动作」判定(后台 o= 行不算)、作息简报、kickoff 里的节奏规矩、工具可见性(子代理不许替 Muse 关灯)。
 * 模型会不会真的在该睡时睡、醒得对不对:live 台架 `npm run live:harness -- --only muse`。
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../core/db.js', () => ({
  query: vi.fn(async () => []),
  getOlderThanSql: (col: string, minutes: number) => `${col} < CURRENT_TIMESTAMP - INTERVAL '${minutes} minutes'`,
}));
vi.mock('../seams/runtime.js', () => ({
  deps: () => ({ profile: { appId: 'tangu', capabilities: { hostExec: true } }, host: { log: () => {} } }),
}));

import { heartbeatDecision, buildRhythmHint, buildCycleMessages, formatJournalLine, writeLastCycleAt, readLastCycleAt } from './muse.js';
import { validSleep, getMuseSleep, setMuseSleep, museStateFile, resetMuseStateCacheForTest, MUSE_SLEEP_MAX_MS } from './museState.js';
import { isUserActivityLine, activityRhythm } from './userActivity.js';
import { resolveWakeAt, museWakeProvider } from '../tools/builtin/museWake.js';
import { SPECIAL_AGENTS_DEFAULTS } from './specialAgentsConfig.js';

const H = 3600_000;
const withHome = async (fn: () => Promise<void>): Promise<void> => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'muse-wake-'));
  const prev = process.env.TANGU_HOME;
  process.env.TANGU_HOME = home;
  resetMuseStateCacheForTest();
  try { await fn(); } finally {
    resetMuseStateCacheForTest();
    if (prev === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prev;
    await fsp.rm(home, { recursive: true, force: true });
  }
};

describe('心跳闸', () => {
  const now = 1_800_000_000_000;
  const base = { heartbeatMinutes: 120, lastCycleAt: now - 3 * H, now, sleep: null, userActiveSinceSleep: false };
  const sleep = { until: now + 5 * H, setAt: now - 2 * H, reason: 'night' };
  it('没到点 / 心跳关着 → not_due(休眠与否无关)', () => {
    expect(heartbeatDecision({ ...base, lastCycleAt: now - 1 * H })).toBe('not_due');
    expect(heartbeatDecision({ ...base, heartbeatMinutes: 0, sleep })).toBe('not_due');
  });
  it('到点且醒着 → due;休眠已过期 → due', () => {
    expect(heartbeatDecision(base)).toBe('due');
    expect(heartbeatDecision({ ...base, sleep: { ...sleep, until: now } })).toBe('due');
  });
  it('到点但睡着 → asleep;睡下之后用户动过 → woken', () => {
    expect(heartbeatDecision({ ...base, sleep })).toBe('asleep');
    expect(heartbeatDecision({ ...base, sleep, userActiveSinceSleep: true })).toBe('woken');
  });
});

describe('set_next_wake 醒来时刻', () => {
  // 本地 2026-09-24 23:40
  const now = new Date(2026, 8, 24, 23, 40).getTime();
  it('until = 下一次出现的本地时刻(已过 → 明天)', () => {
    expect(resolveWakeAt({ until: '08:30' }, now)).toBe(new Date(2026, 8, 25, 8, 30).getTime());
    expect(resolveWakeAt({ until: '23:50' }, now)).toBe(new Date(2026, 8, 24, 23, 50).getTime());
    expect(resolveWakeAt({ until: '23:40' }, now)).toBe(now + MUSE_SLEEP_MAX_MS); // 恰好是现在 → 明天同一时刻 = 24h 封顶
  });
  it('hours;0 = 取消;封顶 24h', () => {
    expect(resolveWakeAt({ hours: 3 }, now)).toBe(now + 3 * H);
    expect(resolveWakeAt({ hours: 0 }, now)).toBe(0);
    expect(resolveWakeAt({ hours: 500 }, now)).toBe(now + MUSE_SLEEP_MAX_MS);
  });
  it('非法输入回错误串,不落盘', () => {
    for (const a of [{ until: '25:00' }, { until: '8.30' }, { hours: -1 }, { hours: 'x' }, {}]) {
      expect(typeof resolveWakeAt(a as any, now)).toBe('string');
    }
  });
});

describe('休眠落盘', () => {
  it('读回校验:未来的 setAt / 超 24h / until ≤ setAt / 坏值 → 当没睡', () => {
    const now = 1_800_000_000_000;
    expect(validSleep({ until: now + H, setAt: now - 1, reason: 'r' }, now)).toEqual({ until: now + H, setAt: now - 1, reason: 'r' });
    expect(validSleep({ until: now + H, setAt: now + 1 }, now)).toBeNull();
    expect(validSleep({ until: now + 30 * H, setAt: now - 1 }, now)).toBeNull();
    expect(validSleep({ until: now - 5, setAt: now - 1 }, now)).toBeNull();
    expect(validSleep('nope', now)).toBeNull();
  });

  it('与 lastCycleAt 按字段合并:谁写都不抹掉另一半;重读盘上一致', async () => {
    await withHome(async () => {
      const t = Date.now() - 1000;
      await writeLastCycleAt(t);
      const sleep = { until: Date.now() + 2 * H, setAt: Date.now() - 10, reason: 'user asleep' };
      await setMuseSleep(sleep);
      await writeLastCycleAt(t + 1);
      resetMuseStateCacheForTest();
      expect(await readLastCycleAt()).toBe(t + 1);
      expect(await getMuseSleep()).toEqual(sleep);
      await setMuseSleep(null);
      resetMuseStateCacheForTest();
      expect(await getMuseSleep()).toBeNull();
      expect(await readLastCycleAt()).toBe(t + 1);
    });
  });

  it('盘上被写成远未来 → 读回当没睡(Muse 停不死自己)', async () => {
    await withHome(async () => {
      await fsp.writeFile(museStateFile(), JSON.stringify({ sleep: { until: Date.now() + 400 * H, setAt: Date.now() - 1, reason: 'x' } }), 'utf8');
      expect(await getMuseSleep()).toBeNull();
    });
  });
});

describe('用户动作判定与作息', () => {
  it('引擎后台写的 o= 行不算用户动作;引号里的字面 o= 不算后台', () => {
    expect(isUserActivityLine('202609241200 note.edit f="Notes/a.md" l=3')).toBe(true);
    expect(isUserActivityLine('202609241200 run.done s=abc123 status=done')).toBe(true);
    expect(isUserActivityLine('202609241200 run.done s=abc123 status=done o=muse')).toBe(false);
    expect(isUserActivityLine('202609241200 agent.edit tool=write_file f="My Notes/a.md" o=trg1')).toBe(false);
    expect(isUserActivityLine('202609241200 note.edit f="a o=b.md"')).toBe(true);
  });

  it('按本地小时数「有活动的天数」,同一天同一小时只算一次', () => {
    const r = activityRhythm(['202609230905', '202609230950', '202609240910', '202609242301', 'garbage']);
    expect(r.hourDays[9]).toBe(2);
    expect(r.hourDays[23]).toBe(1);
    expect(r.hourDays[3]).toBe(0);
    expect(r.activeDays).toBe(2);
    expect(r.last).toBe('202609242301');
  });

  it('作息简报:现在几点、最近一次活动多久前、24 小时分布', () => {
    const now = new Date(2026, 8, 24, 23, 40);
    const hint = buildRhythmHint(activityRhythm(['202609241000', '202609242235']), now, 14);
    expect(hint).toContain('Local time now: Thu 23:40');
    expect(hint).toContain('Last user activity: 22:35 (1h 5m ago)');
    expect(hint).toContain('10:1');
    expect(hint).toContain('22:1');
    expect(buildRhythmHint(activityRhythm([]), now, 14)).toContain('No user activity recorded');
  });
});

describe('kickoff 与 Journal', () => {
  const cfg = { ...SPECIAL_AGENTS_DEFAULTS.muse, mode: 'ask' as const, escalateTo: '', notify: 'immediate' as const };
  it('节奏规矩在落库的稳定指令里(逐字不变、仍在长度预算内);休眠提示只进本周期简报', () => {
    const a = buildCycleMessages(cfg, { sleepNote: '\n\n(You set yourself to sleep until 08:30 — x)' });
    const b = buildCycleMessages(cfg, {});
    expect(a.message).toBe(b.message);
    expect(a.message).toContain('set_next_wake');
    expect(a.message.length).toBeLessThan(2500);
    expect(a.ephemeralHint).toContain('sleep until 08:30');
    expect(a.message).not.toContain('08:30');
  });
  it('Journal 行记下本周期定的休眠;没定时格式与从前一致', () => {
    const base = { time: '23:40', mode: 'ask', trigger: 'heartbeat', tokens: 1200, files: 0, status: 'done', note: 'Nothing to do.' };
    expect(formatJournalLine(base)).toBe('- 23:40 · ask · heartbeat · tokens 1200 · files 0 · done · Nothing to do.');
    expect(formatJournalLine({ ...base, sleep: '08:30 (user asleep)' })).toBe('- 23:40 · ask · heartbeat · tokens 1200 · files 0 · done · sleep → 08:30 (user asleep) · Nothing to do.');
  });
});

describe('工具可见性', () => {
  const tool = museWakeProvider.tools()[0];
  const visible = (ctx: any) => (tool.isEnabledFor ? tool.isEnabledFor({} as any, ctx) : true);
  it('只给 Muse 周期;普通 run 与 Muse 派出去的子代理都看不到', () => {
    expect(visible({ muse: true })).toBe(true);
    expect(visible({})).toBe(false);
    expect(visible({ muse: true, subAgentDepth: 1 })).toBe(false);
  });
});
