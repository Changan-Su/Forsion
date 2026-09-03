import { describe, it, expect } from 'vitest';
import {
  evaluateTriggers, buildTriggerKickoff, validateTriggerInput, nextRunAt, condSummary,
  cursorFor, cursorFits, keyParts, replaceKeyPart, watchedCols, MAX_WATCH_COLS,
  type MuseTrigger, type EventCursor, type DbLike,
} from './museTriggers.js';

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
/** 游标身份三件套(cursorFor 一律写全;造入参 / 拼期望值共用这一处,手写等于把闸门抄错)。 */
const idy = (event: 'row_added' | 'cell_changed' = 'cell_changed') => ({ v: 2 as const, path: 't.db', vault: '/v', event });

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

  it('同一规则多行命中(fired 含重复引用)→ 按 id 去重,不挤占 5 条名额', () => {
    const same = rule({ id: 'w-db', desc: '订单加行', cond: { type: 'db_changed', path: 'a.db', vault: '/v', event: 'row_added' } });
    const others = Array.from({ length: 4 }, (_, i) => rule({ id: `w-o${i}`, desc: `其它${i}` }));
    const out = buildTriggerKickoff([same, same, same, same, same, ...others]);
    expect(out.match(/订单加行/g)).toHaveLength(1);
    expect(out).toContain('其它3'); // 负对照:不去重时 5 个 same 占满 slice(0,5),其它3 被挤掉
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

  it('E6 db_changed 纯动作链:默认 0、显式 0 认、显式 2 保留、下限不抬到 0.25;含 agent_run 仍 ≥1h;不含 actions 的 Muse 唤醒路照旧 24', () => {
    const base = { desc: 'erp', cond_type: 'db_changed', path: '订单.db', event: 'row_added', vault: '/v' };
    const chain = [{ type: 'db_row_add', path: '出库.db', cells: { a: '1' } }];
    const dflt = validateTriggerInput({ ...base, actions: chain });
    expect(dflt.ok && dflt.value.cooldownHours).toBe(0);
    const zero = validateTriggerInput({ ...base, actions: chain, cooldown_hours: 0 });
    expect(zero.ok && zero.value.cooldownHours).toBe(0); // 从前 `> 0` 会把显式 0 当没传 → 24
    const two = validateTriggerInput({ ...base, actions: chain, cooldown_hours: 2 });
    expect(two.ok && two.value.cooldownHours).toBe(2);
    const tiny = validateTriggerInput({ ...base, actions: chain, cooldown_hours: 0.1 });
    expect(tiny.ok && tiny.value.cooldownHours).toBeCloseTo(0.1); // 纯直执链 0.25 下限对 db 链不适用
    const llm = validateTriggerInput({ ...base, actions: [{ type: 'agent_run', agentSlug: 'coder', prompt: 'x' }], cooldown_hours: 0.1 });
    expect(llm.ok && llm.value.cooldownHours).toBe(1);
    const muse = validateTriggerInput({ ...base });
    expect(muse.ok && muse.value.cooldownHours).toBe(24);
  });

  it('E6 evaluate 侧:db 纯动作链显式设了冷却就要认(期内不复触)', async () => {
    const t = rule({
      cond: { type: 'db_changed', path: 't.db', vault: '/v', event: 'row_added' },
      actions: [{ type: 'notify', title: 'x' }],
      cooldownHours: 2,
      lastFiredAt: new Date(NOW.getTime() - 3600_000).toISOString(),
    });
    const env = { now: NOW, currentVault: '/v', dbCursors: { 'w-test01': { ...idy('row_added'), rowIds: [] } }, readDbFile: async () => ({ columns: [], rows: [{ id: 'r1', cells: {} }] }) };
    expect(await evaluateTriggers([t], env)).toHaveLength(0);
    expect(await evaluateTriggers([{ ...t, cooldownHours: 0 }], env)).toHaveLength(1);
  });

  it('E5 where 校验:≤10 条、column 非空、op 白名单、空数组视同无', () => {
    const base = { desc: 'w', cond_type: 'db_changed', path: 't.db', event: 'row_added', vault: '/v' };
    const ok = validateTriggerInput({ ...base, where: [{ column: '配件', op: 'notempty' }, { column: 'c2', op: 'eq', value: '已确认' }] });
    expect(ok.ok && ok.value.cond).toMatchObject({ where: [{ column: '配件', op: 'notempty' }, { column: 'c2', op: 'eq', value: '已确认' }] });
    const empty = validateTriggerInput({ ...base, where: [] });
    expect(empty.ok && (empty.value.cond as any).where).toBeUndefined();
    expect(validateTriggerInput({ ...base, where: [{ column: '', op: 'eq', value: 'x' }] }).ok).toBe(false);
    expect(validateTriggerInput({ ...base, where: [{ column: 'a', op: 'like', value: 'x' }] }).ok).toBe(false);
    expect(validateTriggerInput({ ...base, where: Array.from({ length: 11 }, () => ({ column: 'a', op: 'empty' })) }).ok).toBe(false);
    expect(validateTriggerInput({ ...base, where: 'nope' }).ok).toBe(false);
  });

  it('F1 column_id/column_ids 归一:单列只落 columnId;多列 columnId=首列 + columnIds 排序去重;缺/超限/非数组拒', () => {
    const base = { desc: 'w', cond_type: 'db_changed', path: 't.db', event: 'cell_changed', vault: '/v' };
    // 单列(老入参形状)→ 存盘形状逐字不变:没有 columnIds 键(存量规则 / 游标 / 桌面 KNOWN_COND_KEYS 零迁移)
    const one = validateTriggerInput({ ...base, column_id: ' c2 ' });
    expect(one.ok && one.value.cond).toEqual({ type: 'db_changed', path: 't.db', vault: '/v', event: 'cell_changed', columnId: 'c2', equals: undefined });
    expect(one.ok && 'columnIds' in one.value.cond).toBe(false);
    // column_ids 单元素 + 同名 column_id → 仍是单列形状
    const dup = validateTriggerInput({ ...base, column_id: 'c2', column_ids: ['c2'] });
    expect(dup.ok && (dup.value.cond as any).columnIds).toBeUndefined();
    // 多列:并集、去重、**排序**(桌面勾选顺序不同的同一集合不能被 JSON 比对当成 cond 变了 → 丢游标)
    const multi = validateTriggerInput({ ...base, column_id: 'st', column_ids: ['cust', ' st ', 'cust', ''] });
    expect(multi.ok && multi.value.cond).toMatchObject({ columnId: 'cust', columnIds: ['cust', 'st'] });
    const reorder = validateTriggerInput({ ...base, column_ids: ['st', 'cust'] });
    expect(reorder.ok && multi.ok && JSON.stringify(reorder.value.cond)).toBe(JSON.stringify(multi.value.cond));
    // 只给 column_ids 不给 column_id 也行
    expect(validateTriggerInput({ ...base, column_ids: ['a', 'b'] }).ok).toBe(true);
    // 缺 / 全空 / 非数组 / 超限 → 拒
    expect(validateTriggerInput({ ...base }).ok).toBe(false);
    expect(validateTriggerInput({ ...base, column_ids: [' ', ''] }).ok).toBe(false);
    expect(validateTriggerInput({ ...base, column_ids: 'a,b' }).ok).toBe(false);
    expect(validateTriggerInput({ ...base, column_ids: Array.from({ length: MAX_WATCH_COLS + 1 }, (_, i) => `c${i}`) }).ok).toBe(false);
    // row_added 不看列
    expect(validateTriggerInput({ ...base, event: 'row_added', column_ids: 'junk' }).ok).toBe(true);
    // 负对照(实跑过):parseColumnIds 去掉 out.sort() → reorder 用例 JSON 不等 → 红
  });

  it('E3/E4 动作校验:rowFrom/match/skipIfEmpty 解析;skipIfEmpty 键必须在 cells 里;MAX_ACTIONS=24', () => {
    const base = { desc: 'a', cond_type: 'db_changed', path: 't.db', event: 'row_added', vault: '/v' };
    const v = validateTriggerInput({ ...base, actions: [
      { type: 'db_row_add', path: '出库.db', cells: { 配件: '{{row.CPU}}', 订单: '{{row.id}}' }, skipIfEmpty: '配件' },
      { type: 'db_row_edit', path: '库存.db', rowFrom: '配件', cells: { 数量: '{{= {target.数量} - 1 }}' } },
      { type: 'db_row_edit', path: '出库.db', match: { column: '订单总表', value: '{{row.id}}' }, cells: { 状态: '{{row.状态}}' } },
    ] });
    expect(v.ok && v.value.actions).toEqual([
      { type: 'db_row_add', path: '出库.db', cells: { 配件: '{{row.CPU}}', 订单: '{{row.id}}' }, skipIfEmpty: '配件' },
      { type: 'db_row_edit', path: '库存.db', rowId: undefined, rowFrom: '配件', cells: { 数量: '{{= {target.数量} - 1 }}' } },
      { type: 'db_row_edit', path: '出库.db', rowId: undefined, match: { column: '订单总表', value: '{{row.id}}' }, cells: { 状态: '{{row.状态}}' } },
    ]);
    const badKey = validateTriggerInput({ ...base, actions: [{ type: 'db_row_add', path: 'x.db', cells: { a: '1' }, skipIfEmpty: 'b' }] });
    expect(badKey.ok).toBe(false); // 写错键 = 每行都被静默跳过,比 400 糟
    const badMatch = validateTriggerInput({ ...base, actions: [{ type: 'db_row_edit', path: 'x.db', match: { value: '1' }, cells: { a: '1' } }] });
    expect(badMatch.ok).toBe(false);
    const many = (n: number) => Array.from({ length: n }, () => ({ type: 'notify', title: 't' }));
    expect(validateTriggerInput({ ...base, actions: many(24) }).ok).toBe(true);
    expect(validateTriggerInput({ ...base, actions: many(25) }).ok).toBe(false);
  });

  it('manual:巡检永不命中、无下次时刻、cooldown 强制 0(含 agent_run 也是)', async () => {
    // 按钮类规则的全部执行入口是 fire 端点。巡检若命中它,笔记里的按钮就变成了后台定时任务。
    const t = rule({ cond: { type: 'manual' }, cooldownHours: 0 });
    expect(await evaluateTriggers([t], { now: NOW, activityLines: ['202607111200 anything'] })).toHaveLength(0);
    expect(nextRunAt(t, NOW)).toBeNull();
    // 冷却必须是 0:1h 下限会把用户第二次点击静默吞成「没反应」(防重入靠服务端单飞锁)。
    const v = validateTriggerInput({
      desc: '一键整理', cond_type: 'manual', cooldown_hours: 24,
      actions: [{ type: 'agent_run', agentSlug: 'coder', prompt: 'tidy' }],
    });
    expect(v.ok && v.value.cooldownHours).toBe(0);
  });
});

describe('F1 多列监听:游标 key 拼装与形状判定', () => {
  const cond = (over: Record<string, unknown>) => ({ type: 'db_changed' as const, path: 't.db', vault: '/v', event: 'cell_changed' as const, ...over });
  const tbl: DbLike = {
    columns: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    rows: [{ id: 'r1', cells: { a: 'x', b: ['m', 'n'] } }, { id: 'r2', cells: {} }],
  };

  it('watchedCols = columnIds ∪ columnId 去重保序;两键只带一个也能取到', () => {
    expect(watchedCols(cond({ columnId: 'a' }))).toEqual(['a']);
    expect(watchedCols(cond({ columnIds: ['a', 'b'] }))).toEqual(['a', 'b']);
    expect(watchedCols(cond({ columnId: 'a', columnIds: ['a', 'b'] }))).toEqual(['a', 'b']);
    expect(watchedCols(cond({ columnId: 'c', columnIds: ['a', 'b'] }))).toEqual(['a', 'b', 'c']); // 手改文件两键不一致 → 并集
    expect(watchedCols(cond({}))).toEqual([]);
  });

  it('cursorFor:游标一律带 cols(n=1 也带);多列复合 key(缺列位空串)', () => {
    expect(cursorFor(cond({ columnId: 'a' }), tbl)).toEqual({ ...idy(), cols: ['a'], cells: { r1: 'x', r2: '' } });
    // 钉新契约:单列也写 cols —— 没有它,改列后 B 的当前值 × A 的历史值逐行比 = 满表误触发
    expect(JSON.stringify(cursorFor(cond({ columnId: 'a' }), tbl)))
      .toBe('{"v":2,"path":"t.db","event":"cell_changed","vault":"/v","cols":["a"],"cells":{"r1":"x","r2":""}}');
    const two = cursorFor(cond({ columnId: 'a', columnIds: ['a', 'b'] }), tbl)!;
    expect(two).toEqual({ ...idy(), cols: ['a', 'b'], cells: { r1: 'x\u001fmn', r2: '\u001f' } });
    expect(keyParts(two.cells!.r1, 2)).toEqual(['x', 'mn']);
    expect(keyParts(two.cells!.r2, 2)).toEqual(['', '']);
    expect(keyParts('bare', 1)).toEqual(['bare']);
    expect(keyParts('short', 3)).toEqual(['short', '', '']); // 位数不足补空
    expect(replaceKeyPart(two.cells!.r1, 2, 1, 'Q')).toBe('x\u001fQ');
    expect(replaceKeyPart('old', 1, 0, 'new')).toBe('new');
    expect(cursorFor(cond({}), tbl)).toBeNull();
  });

  it('cursorFits:任何列数都须 cols 同序同集;单列换了列 = 不符;旧的无 cols 游标 = 不符', () => {
    expect(cursorFits({ ...idy(), cols: ['a'], cells: {} }, ['a'])).toBe(true);
    expect(cursorFits({ ...idy(), cols: ['a', 'b'], cells: {} }, ['a', 'b'])).toBe(true);
    // 头号 bug:单列 a 的游标遇上改成盯 b 的规则 —— 从前判「相符」,B 的当前值 × A 的历史值逐行比 = 满表误触发
    expect(cursorFits({ ...idy(), cols: ['a'], cells: {} }, ['b'])).toBe(false);
    expect(cursorFits({ ...idy(), cells: {} }, ['a'])).toBe(false); // 旧的无 cols 单列游标 → 只重播种(fail-closed 一次性代价)
    expect(cursorFits({ ...idy(), cells: {} }, ['a', 'b'])).toBe(false); // 旧单列游标 × 改成多列
    expect(cursorFits({ ...idy(), cols: ['b', 'a'], cells: {} }, ['a', 'b'])).toBe(false); // 序不同(排序后不该出现,出现即不认)
    expect(cursorFits({ ...idy(), cols: ['a', 'b'], cells: {} }, ['a'])).toBe(false); // 多列游标 × 改回单列
    expect(cursorFits({ ...idy(), cols: ['a', 'b', 'c'], cells: {} }, ['a', 'b'])).toBe(false);
    expect(cursorFits(undefined, ['a'])).toBe(false);
    expect(cursorFits({ ...idy('row_added'), rowIds: [] }, ['a'])).toBe(false);
  });

  it('evaluate 多列:任一列变化即命中;equals 按变了的那列比;旧单列游标遇多列规则只重播种不误触', async () => {
    const t = rule({ cooldownHours: 0, cond: cond({ columnId: 'a', columnIds: ['a', 'b'] }) });
    const seeded = { 'w-test01': { ...idy(), cols: ['a', 'b'], cells: { r1: 'x\u001fmn', r2: '\u001f' } } };
    const run = async (rows: DbLike['rows'], cursors: any, over: Partial<MuseTrigger> = {}, cols?: DbLike['columns']) => {
      const outDbCursors: Record<string, any> = {};
      const outHits: Array<{ id: string; ctx: any }> = [];
      const logs: string[] = [];
      const fired = await evaluateTriggers([{ ...t, ...over }], {
        now: NOW, currentVault: '/v', dbCursors: cursors, outDbCursors, outHits, log: (m) => logs.push(m),
        readDbFile: async () => ({ ...tbl, ...(cols ? { columns: cols } : {}), rows }),
      });
      return { fired: fired.length, hits: outHits.map((h) => h.ctx.row?.id), next: outDbCursors['w-test01'], logs };
    };
    // 只有 b 列变 → 命中(单列版盯 a 永远看不见)
    let r = await run([{ id: 'r1', cells: { a: 'x', b: ['m', 'z'] } }, { id: 'r2', cells: {} }], seeded);
    expect(r.hits).toEqual(['r1']);
    expect(r.next).toEqual({ ...idy(), cols: ['a', 'b'], cells: { r1: 'x\u001fmz', r2: '\u001f' } });
    // 只有 a 列变 → 也命中;两行同时各变一列 → 两条 hit
    r = await run([{ id: 'r1', cells: { a: 'y', b: ['m', 'n'] } }, { id: 'r2', cells: { b: 'k' } }], seeded);
    expect(r.hits).toEqual(['r1', 'r2']);
    // 都没变 → 不命中,游标原样
    r = await run(tbl.rows, seeded);
    expect(r.hits).toEqual([]);
    expect(r.next).toEqual(seeded['w-test01']);
    // equals 按列:b 变成 'done' 命中;a 变成 'done' 也命中;b 变了但不是 'done'、而 a 恰好一直是 'done'(没变)→ 不命中
    const eq = { cond: cond({ columnId: 'a', columnIds: ['a', 'b'], equals: 'done' }) };
    expect((await run([{ id: 'r1', cells: { a: 'x', b: 'done' } }, { id: 'r2', cells: {} }], seeded, eq)).hits).toEqual(['r1']);
    expect((await run([{ id: 'r1', cells: { a: 'done', b: ['m', 'n'] } }, { id: 'r2', cells: {} }], seeded, eq)).hits).toEqual(['r1']);
    const stale = { 'w-test01': { ...idy(), cols: ['a', 'b'], cells: { r1: 'done\u001fmn', r2: '\u001f' } } };
    r = await run([{ id: 'r1', cells: { a: 'done', b: 'other' } }, { id: 'r2', cells: {} }], stale, eq);
    expect(r.hits).toEqual([]);
    expect(r.next.cells.r1).toBe('done\u001fother'); // equals 不符照样推进游标
    // 负对照(实跑过):候选过滤改回 `now2 === c.equals`(整串比)→ 上面两条 equals 命中用例得 [] → 红
    // 缺 cols 的游标 × 多列规则:不比对、只播种;满表现有行一个都不报
    r = await run([{ id: 'r1', cells: { a: 'CHANGED', b: 'CHANGED' } }, { id: 'r2', cells: { a: 'q' } }], { 'w-test01': { ...idy(), cells: { r1: 'x', r2: '' } } });
    expect(r.hits).toEqual([]);
    expect(r.next).toEqual({ ...idy(), cols: ['a', 'b'], cells: { r1: 'CHANGED\u001fCHANGED', r2: 'q\u001f' } });
    // 负对照(实跑过):evaluate 把 `!cursorFits(cur, cols)` 换回 `!cur?.cells` → 此处 hits 得 ['r1','r2'](满表误触发)→ 红
    // 含 LLM 的规则每 tick 取一行:回填的游标必须仍带 cols(丢了下轮当未播种,第二行永远排不到)
    r = await run([{ id: 'r1', cells: { a: 'y', b: ['m', 'n'] } }, { id: 'r2', cells: { b: 'k' } }], seeded, { agentSlug: 'worker' });
    expect(r.hits).toEqual(['r1']);
    expect(r.next).toEqual({ ...idy(), cols: ['a', 'b'], cells: { r1: 'y\u001fmn', r2: '\u001f' } });
    // 监听列全被删 → 规则错误:不触发、游标冻住、log 留痕
    r = await run([{ id: 'r1', cells: { a: 'y' } }], seeded, { cond: cond({ columnIds: ['zz', 'yy'] }) });
    expect(r.fired).toBe(0);
    expect(r.next).toBeUndefined();
    expect(r.logs.some((l) => l.includes('w-test01') && l.includes('监听列已不存在'))).toBe(true);
  });

  it('多列监听删掉其中一列 = 规则错误:零触发 + 游标冻住 + log;列一回来照常续上', async () => {
    // 盯 [a,b] 删掉 b:游标 cols 没变仍判「相符」,但所有原先 b 非空的行 key 从「a␟b」塌成「a␟」——
    // 从前只要求「至少一列还在」,无 equals 时整表成候选,纯 DB 动作链一次跑完全表(codex 抓的)。
    const t = rule({ cooldownHours: 0, cond: cond({ columnId: 'a', columnIds: ['a', 'b'] }) });
    // 删列的真实落盘形态:列从 columns 里没了,**每行的 cells[b] 也被删掉**(DatabaseEmbed.delCol 两件一起做)。
    const withB: DbLike['rows'] = [{ id: 'r1', cells: { a: 'x', b: ['m', 'n'] } }, { id: 'r2', cells: { a: 'p', b: 'q' } }];
    const noB: DbLike['rows'] = [{ id: 'r1', cells: { a: 'x' } }, { id: 'r2', cells: { a: 'p' } }];
    const seeded = { 'w-test01': { ...idy(), cols: ['a', 'b'], cells: { r1: 'x\u001fmn', r2: 'p\u001fq' } } };
    const run = async (columns: DbLike['columns'], rows: DbLike['rows']) => {
      const outDbCursors: Record<string, any> = {};
      const outHits: Array<{ id: string; ctx: any }> = [];
      const logs: string[] = [];
      const fired = await evaluateTriggers([t], {
        now: NOW, currentVault: '/v', dbCursors: seeded, outDbCursors, outHits, log: (m) => logs.push(m),
        readDbFile: async () => ({ columns, rows }),
      });
      return { fired: fired.length, hits: outHits.map((h) => h.ctx.row?.id), next: outDbCursors['w-test01'], logs };
    };
    // b 被删:每行 key 从「a␟b」塌成「a␟」= 满表都「变了」
    const gone = await run([{ id: 'a', name: 'A' }], noB);
    expect(gone.hits).toEqual([]); // 负对照(实跑过):`missing.length` 换回 `!cols.some(...)` → hits 得 ['r1','r2'](一次满表变更)→ 红
    expect(gone.fired).toBe(0);
    expect(gone.next).toBeUndefined(); // 游标冻住:一格都没被消费
    expect(gone.logs.some((l) => l.includes('w-test01') && l.includes('监听列已不存在') && l.includes('b'))).toBe(true);
    // 列回来(schema 迁移的中间态过去了)→ 从原游标续上,一个事件都没丢
    const back = await run([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], withB);
    expect(back.hits).toEqual([]); // 值本来就没变
    expect(back.next).toEqual(seeded['w-test01']);
  });

  it('condSummary:单列文案不变;多列列出全部列', () => {
    expect(condSummary(cond({ columnId: 'st', equals: '已确认' }))).toBe('column st changed to "已确认" in t.db');
    expect(condSummary(cond({ columnId: 'cust', columnIds: ['cust', 'st'] }))).toBe('any of columns cust, st changed in t.db');
  });
});
