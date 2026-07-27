import { describe, it, expect } from 'vitest';
import { evaluateTriggers, buildTriggerKickoff, validateTriggerInput, nextRunAt, type MuseTrigger, type EventCursor } from './museTriggers.js';

function rule(over: Partial<MuseTrigger>): MuseTrigger {
  return {
    id: 'w-test01',
    desc: 'test rule',
    cond: { type: 'event_seen', match: 'x' },
    cooldownHours: 24,
    lastFiredAt: null,
    enabled: true,
    createdAt: '2026-07-10T00:00:00.000Z',
    ...over,
  };
}

const NOW = new Date(2026, 6, 11, 12, 0); // 本地 2026-07-11 12:00

describe('evaluateTriggers', () => {
  it('file_chars_gte:达标命中,未达/不可读不命中', async () => {
    const t = rule({ cond: { type: 'file_chars_gte', path: '/x/a.md', n: 100 } });
    const hit = await evaluateTriggers([t], { now: NOW, readFileChars: async () => 120 });
    expect(hit.map((x) => x.id)).toEqual(['w-test01']);
    expect(await evaluateTriggers([t], { now: NOW, readFileChars: async () => 99 })).toHaveLength(0);
    expect(await evaluateTriggers([t], { now: NOW, readFileChars: async () => null })).toHaveLength(0);
  });

  it('cooldown:期内不复触,过期可再触;disabled 永不触', async () => {
    const base = rule({ cond: { type: 'file_chars_gte', path: '/x/a.md', n: 1 } });
    const env = { now: NOW, readFileChars: async () => 999 };
    const recent = { ...base, lastFiredAt: new Date(NOW.getTime() - 2 * 3600_000).toISOString() };
    expect(await evaluateTriggers([recent], env)).toHaveLength(0);
    const stale = { ...base, lastFiredAt: new Date(NOW.getTime() - 25 * 3600_000).toISOString() };
    expect(await evaluateTriggers([stale], env)).toHaveLength(1);
    const off = { ...base, enabled: false };
    expect(await evaluateTriggers([off], env)).toHaveLength(0);
  });

  it('event_seen:只认 lastFiredAt/创建之后的活动行(不吃存量)', async () => {
    const created = new Date(NOW.getTime() - 3600_000).toISOString(); // 1h 前创建
    const t = rule({ cond: { type: 'event_seen', match: 'xxx.md' }, createdAt: created, cooldownHours: 0 });
    const oldLine = '202607110900 note.edit f="xxx.md" l=1-2'; // 创建之前
    const newLine = '202607111130 note.edit f="xxx.md" l=3-4'; // 创建之后
    expect(await evaluateTriggers([t], { now: NOW, activityLines: [oldLine] })).toHaveLength(0);
    expect(await evaluateTriggers([t], { now: NOW, activityLines: [oldLine, newLine] })).toHaveLength(1);
    expect(await evaluateTriggers([t], { now: NOW, activityLines: ['202607111130 chat.send "别的"'] })).toHaveLength(0);
  });

  it('daily_at 钉锚:今天过点且今天未触才命中;未到点/当天已触不复触', async () => {
    const t = rule({ cond: { type: 'daily_at', time: '09:00' } });
    expect(await evaluateTriggers([t], { now: NOW })).toHaveLength(1); // 12:00 > 09:00,从未触过 → 补今天的
    const before = new Date(2026, 6, 11, 8, 0);
    expect(await evaluateTriggers([t], { now: before })).toHaveLength(0); // 未到点
    const firedToday = { ...t, lastFiredAt: new Date(2026, 6, 11, 9, 5).toISOString() };
    expect(await evaluateTriggers([firedToday], { now: NOW })).toHaveLength(0); // 今天锚点已触
    const firedYesterday = { ...t, lastFiredAt: new Date(2026, 6, 10, 9, 5).toISOString() };
    expect(await evaluateTriggers([firedYesterday], { now: NOW })).toHaveLength(1); // 昨天触的 → 今天欠着
  });

  it('daily_at 钉锚:晚于锚点创建的规则当天不补发(晚上建"每天早8点"不当场触)', async () => {
    const t = rule({ cond: { type: 'daily_at', time: '08:00' }, createdAt: new Date(2026, 6, 11, 21, 31).toISOString() });
    expect(await evaluateTriggers([t], { now: new Date(2026, 6, 11, 21, 32) })).toHaveLength(0); // 建完当晚不触
    expect(await evaluateTriggers([t], { now: new Date(2026, 6, 12, 8, 3) })).toHaveLength(1); // 次日 08:00 过点 → 触
  });

  it('daily_at 钉锚:触发时刻不随 lastFired 漂移(晚间误触后次晨仍触)', async () => {
    // 回归:旧「距上次>20h」窗会让 21:31 的一次触发把次日 08:00 吞掉,触发时刻永锁晚间。
    const t = rule({ cond: { type: 'daily_at', time: '08:00' }, lastFiredAt: new Date(2026, 6, 10, 21, 31).toISOString() });
    expect(await evaluateTriggers([t], { now: new Date(2026, 6, 11, 8, 3) })).toHaveLength(1); // 距上次仅 10.5h,仍按锚点触
  });

  it('定时类豁免 cooldown gate(存量 daily_at 带 cooldown=24 不吞次日触发)', async () => {
    const t = rule({ cond: { type: 'daily_at', time: '08:00' }, cooldownHours: 24, lastFiredAt: new Date(2026, 6, 10, 21, 31).toISOString() });
    expect(await evaluateTriggers([t], { now: new Date(2026, 6, 11, 8, 3) })).toHaveLength(1); // 距上次 10.5h < 24h,gate 不拦
  });

  it('at 一次性:过点且未在点后触过才命中;lastFiredAt 在点后=不复触', async () => {
    const t = rule({ cond: { type: 'at', datetime: '2026-07-11T11:30' }, cooldownHours: 0 });
    expect(await evaluateTriggers([t], { now: NOW })).toHaveLength(1); // 12:00 过点
    expect(await evaluateTriggers([t], { now: new Date(2026, 6, 11, 11, 0) })).toHaveLength(0); // 未到点
    const fired = { ...t, lastFiredAt: new Date(2026, 6, 11, 11, 35).toISOString() };
    expect(await evaluateTriggers([fired], { now: NOW })).toHaveLength(0);
  });

  it('every:首触=锚+1 间隔;停机只补最近一次;已补不复触', async () => {
    const anchor = new Date(2026, 6, 11, 0, 0).toISOString();
    const t = rule({ cond: { type: 'every', interval: '2h' }, createdAt: anchor, cooldownHours: 0 });
    expect(await evaluateTriggers([t], { now: new Date(2026, 6, 11, 1, 0) })).toHaveLength(0); // 创建 1h 内不触
    expect(await evaluateTriggers([t], { now: NOW })).toHaveLength(1); // 12:00,最近应触 12:00(锚+6 格)
    const caught = { ...t, lastFiredAt: new Date(2026, 6, 11, 12, 0).toISOString() };
    expect(await evaluateTriggers([caught], { now: new Date(2026, 6, 11, 13, 0) })).toHaveLength(0); // 13:00 未到下一格
    const stale = { ...t, lastFiredAt: new Date(2026, 6, 11, 2, 0).toISOString() };
    expect(await evaluateTriggers([stale], { now: NOW })).toHaveLength(1); // 落了 4 格,只补最近一次
  });

  it('event_seen 精确游标:同分钟旧行不重复消费;新行仍触;outCursors 回填', async () => {
    const created = new Date(NOW.getTime() - 3600_000).toISOString();
    const line = '202607111130 note.edit f="xxx.md" l=3-4';
    const t = rule({ cond: { type: 'event_seen', match: 'xxx.md' }, createdAt: created, cooldownHours: 0 });
    const out: Record<string, EventCursor> = {};
    expect(await evaluateTriggers([t], { now: NOW, activityLines: [line], outCursors: out })).toHaveLength(1);
    const cur = out['w-test01'];
    expect(cur?.ts).toBe('202607111130');
    // 冷却过后同一行再评估(lastFiredAt 同分钟)→ 有游标就不再吃
    const again = { ...t, lastFiredAt: new Date(2026, 6, 11, 11, 30).toISOString(), lastEventCursor: cur };
    expect(await evaluateTriggers([again], { now: NOW, activityLines: [line] })).toHaveLength(0);
    // 同分钟出现**不同**新行 → 仍触
    const line2 = '202607111130 note.edit f="xxx.md" l=5-6';
    expect(await evaluateTriggers([again], { now: NOW, activityLines: [line, line2] })).toHaveLength(1);
  });

  it('自激防护:带 o=<本规则id> 的活动行不吃,别的规则 origin 不受影响', async () => {
    const created = new Date(NOW.getTime() - 3600_000).toISOString();
    const t = rule({ cond: { type: 'event_seen', match: 'xxx.md' }, createdAt: created, cooldownHours: 0 });
    const self = '202607111130 agent.edit tool=write_file agent=coder f=xxx.md o=w-test01';
    const other = '202607111131 agent.edit tool=write_file agent=coder f=xxx.md o=w-other9';
    expect(await evaluateTriggers([t], { now: NOW, activityLines: [self] })).toHaveLength(0);
    expect(await evaluateTriggers([t], { now: NOW, activityLines: [other] })).toHaveLength(1);
  });
});

describe('nextRunAt(服务端权威下次触发)', () => {
  it('at=锚点;every=下一格/欠账格;daily=今天或明天;事件/文件/禁用 → null', () => {
    expect(nextRunAt(rule({ cond: { type: 'at', datetime: '2026-07-12T09:00' } }), NOW))
      .toBe(new Date(2026, 6, 12, 9, 0).toISOString());
    const anchor = new Date(2026, 6, 11, 0, 0).toISOString();
    const ev = rule({ cond: { type: 'every', interval: '2h' }, createdAt: anchor, lastFiredAt: new Date(2026, 6, 11, 12, 0).toISOString() });
    expect(nextRunAt(ev, NOW)).toBe(new Date(2026, 6, 11, 14, 0).toISOString()); // 已补到 12:00 → 下格 14:00
    const daily = rule({ cond: { type: 'daily_at', time: '09:00' }, lastFiredAt: new Date(2026, 6, 11, 9, 5).toISOString() });
    expect(nextRunAt(daily, NOW)).toBe(new Date(2026, 6, 12, 9, 0).toISOString()); // 今天已触 → 明天
    const lateCreated = rule({ cond: { type: 'daily_at', time: '09:00' }, createdAt: new Date(2026, 6, 11, 10, 0).toISOString() });
    expect(nextRunAt(lateCreated, NOW)).toBe(new Date(2026, 6, 12, 9, 0).toISOString()); // 过点后建 → 明天(不谎报"现在")
    expect(nextRunAt(rule({ cond: { type: 'event_seen', match: 'x' } }), NOW)).toBeNull();
    expect(nextRunAt(rule({ enabled: false, cond: { type: 'at', datetime: '2026-07-12T09:00' } }), NOW)).toBeNull();
  });
});

describe('buildTriggerKickoff', () => {
  it('空 → 空串;命中 → 英文段 + desc/prompt', () => {
    expect(buildTriggerKickoff([])).toBe('');
    const out = buildTriggerKickoff([
      rule({ desc: '盯 xxx.md 满 100 字', prompt: 'Remind the user.', cond: { type: 'file_chars_gte', path: '/x/xxx.md', n: 100 } }),
    ]);
    expect(out).toContain('[Watch triggers fired this cycle');
    expect(out).toContain('盯 xxx.md 满 100 字');
    expect(out).toContain('Remind the user.');
    expect(out).toContain('100+ non-whitespace chars');
  });
});

describe('validateTriggerInput', () => {
  it('三种 cond 校验;缺参报错', () => {
    expect(validateTriggerInput({ desc: 'a', cond_type: 'daily_at', time: '9:30' }).ok).toBe(true);
    expect(validateTriggerInput({ desc: 'a', cond_type: 'daily_at', time: '930' }).ok).toBe(false);
    expect(validateTriggerInput({ desc: '', cond_type: 'event_seen', match: 'x' }).ok).toBe(false);
    expect(validateTriggerInput({ desc: 'a', cond_type: 'file_chars_gte', path: '/x.md' }).ok).toBe(false);
    expect(validateTriggerInput({ desc: 'a', cond_type: 'nope' }).ok).toBe(false);
  });

  it("agent_slug:'muse' 归一为 undefined;agent 规则 cooldown 下限 1h", () => {
    const muse = validateTriggerInput({ desc: 'a', cond_type: 'event_seen', match: 'x', agent_slug: 'muse', cooldown_hours: 0.1 });
    expect(muse.ok && muse.value.agentSlug).toBeUndefined();
    expect(muse.ok && muse.value.cooldownHours).toBeCloseTo(0.1); // 非 agent 规则不抬下限
    const ag = validateTriggerInput({ desc: 'a', cond_type: 'event_seen', match: 'x', agent_slug: 'coder', cooldown_hours: 0.1 });
    expect(ag.ok && ag.value.agentSlug).toBe('coder');
    expect(ag.ok && ag.value.cooldownHours).toBe(1); // 自激回路护栏
  });

  it('enabled 缺省 true,显式 false 生效', () => {
    const a = validateTriggerInput({ desc: 'a', cond_type: 'event_seen', match: 'x' });
    expect(a.ok && a.value.enabled).toBe(true);
    const b = validateTriggerInput({ desc: 'a', cond_type: 'event_seen', match: 'x', enabled: false });
    expect(b.ok && b.value.enabled).toBe(false);
  });

  it('at/every/daily_at:定时类 cooldown 强制 0;every 下限 15m;agent 动作 every 下限 1h', () => {
    const at = validateTriggerInput({ desc: 'a', cond_type: 'at', datetime: new Date(Date.now() + 3600_000).toISOString().slice(0, 16) });
    expect(at.ok && at.value.cooldownHours).toBe(0);
    const daily = validateTriggerInput({ desc: 'a', cond_type: 'daily_at', time: '08:00', cooldown_hours: 24 });
    expect(daily.ok && daily.value.cooldownHours).toBe(0); // daily_at 每日钉锚,cooldown 会把"每天"吞成隔天
    expect(validateTriggerInput({ desc: 'a', cond_type: 'at', datetime: '2020-01-01 09:00' }).ok).toBe(false); // 过去
    expect(validateTriggerInput({ desc: 'a', cond_type: 'every', interval: '5m' }).ok).toBe(false); // <15m
    expect(validateTriggerInput({ desc: 'a', cond_type: 'every', interval: '30m' }).ok).toBe(true);
    expect(validateTriggerInput({ desc: 'a', cond_type: 'every', interval: '30m', agent_slug: 'coder' }).ok).toBe(false); // agent <1h
    expect(validateTriggerInput({ desc: 'a', cond_type: 'every', interval: '2h', agent_slug: 'coder' }).ok).toBe(true);
  });

  it('actions:非空数组/null/缺席三态;与 agent_slug 互斥;tool_call 仅 allowToolCall 通道', () => {
    const base = { desc: 'a', cond_type: 'event_seen', match: 'x' } as const;
    const absent = validateTriggerInput({ ...base });
    expect(absent.ok && absent.value.actions).toBeUndefined();
    const cleared = validateTriggerInput({ ...base, actions: null });
    expect(cleared.ok && cleared.value.actions).toBeNull();
    expect(validateTriggerInput({ ...base, actions: [] }).ok).toBe(false);
    const chain = validateTriggerInput({ ...base, cooldown_hours: 0.1, actions: [{ type: 'notify', title: '提醒' }, { type: 'agent_run', agentSlug: 'coder', prompt: 'do it' }] });
    expect(chain.ok && chain.value.actions?.length).toBe(2);
    expect(chain.ok && chain.value.cooldownHours).toBe(1); // 含 agent_run → 下限 1h
    const pureNotify = validateTriggerInput({ ...base, cooldown_hours: 0.1, actions: [{ type: 'notify', title: 't' }] });
    expect(pureNotify.ok && pureNotify.value.cooldownHours).toBe(0.25); // 纯直执链下限 15min
    expect(validateTriggerInput({ ...base, agent_slug: 'coder', actions: [{ type: 'notify', title: 't' }] }).ok).toBe(false); // 互斥
    expect(validateTriggerInput({ ...base, actions: [{ type: 'agent_run', agentSlug: 'muse', prompt: 'x' }] }).ok).toBe(false); // 禁 muse
    expect(validateTriggerInput({ ...base, actions: [{ type: 'tool_call', tool: 'run_bash', args: {} }] }).ok).toBe(false); // 工具通道禁 tool_call
    expect(validateTriggerInput({ ...base, actions: [{ type: 'tool_call', tool: 'run_bash', args: {} }] }, { allowToolCall: true }).ok).toBe(true);
  });
});
