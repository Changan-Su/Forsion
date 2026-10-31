/**
 * 触发源注册表 + 新源(电脑上 / 日历)。老七种的回归在 museTriggers.test / automationV3.test / automationDb.test,一行不改。
 * 事件全部注入(EvaluateEnv.readChSignals / calendarEvents),不碰盘;隐私那条(标题 / 网址 / 输入进不来)在 computerHistory.test。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { condSummary, evaluateTriggers, loadTriggers, markTriggersFired, nextRunAt, saveTriggers, upsertTrigger, validateTriggerInput, type MuseTrigger, type TriggerInput } from './museTriggers.js';
import { getTriggerSource, listTriggerSources, NOTICE_COMPUTER_HISTORY_OFF, NOTICE_SOURCE_MISSING, registerTriggerSource, unregisterTriggerSource } from './triggerRegistry.js';
import { appSessionStart, lastReturnAt, type CalendarEventHit } from './triggerSources.js';
import type { ChSignal } from './computerHistory.js';

const MIN = 60_000;
const NOW = new Date(2026, 9, 29, 15, 0); // 周四 15:00
const ago = (m: number): number => NOW.getTime() - m * MIN;
const STEAM = { name: 'Steam', bundleId: 'com.valvesoftware.steam' };
const CODE = { name: 'Code', bundleId: 'com.microsoft.VSCode' };

function rule(p: Partial<MuseTrigger> & Pick<MuseTrigger, 'cond'>): MuseTrigger {
  return { id: 'r', desc: 'd', cooldownHours: 2, lastFiredAt: null, enabled: true, createdAt: new Date(ago(24 * 60)).toISOString(), actions: [{ type: 'remind', title: 'hi' }], ...p };
}
const opened = rule({ cond: { type: 'computer.app_opened', params: { app: STEAM.bundleId, appName: 'Steam' } } });
const run = (t: MuseTrigger, signals: ChSignal[] | null, extra: Record<string, unknown> = {}) =>
  evaluateTriggers([t], { now: NOW, computerHistoryOn: true, readChSignals: async () => signals, ...extra });

describe('一轮之内', () => {
  it('每日上限:一轮多次命中只认第一次(次数按规则写回,一轮记一次)', async () => {
    registerTriggerSource({
      id: 'test.multi', group: 'forsion', name: { zh: 'x', en: 'x' }, params: [], eventSource: 'poll',
      parse: () => ({ ok: true, cond: { type: 'test.multi', params: {} } }),
      evaluate: async (_t, io) => { io.hit(); io.hit(); },
      summary: () => 'x',
    });
    const t = rule({ cond: { type: 'test.multi', params: {} } });
    expect(await evaluateTriggers([t], { now: NOW })).toHaveLength(2);
    expect(await evaluateTriggers([{ ...t, maxPerDay: 3 }], { now: NOW })).toHaveLength(1);
    unregisterTriggerSource('test.multi');
  });

  it('清除历史后,同轮后面的规则不再用读过的信号', async () => {
    const reads: number[] = [];
    let version = 'a';
    const hits = [{ t: ago(5), kind: 'app' as const, app: STEAM }];
    const second = { ...opened, id: 'r2' };
    const [first] = [opened];
    const fired = await evaluateTriggers([first, second], {
      now: NOW, computerHistoryOn: true, chSignalsVersion: () => version,
      readChSignals: async () => { reads.push(1); version = 'b'; return reads.length === 1 ? hits : []; },
    });
    expect(reads).toHaveLength(2);
    expect(fired.map((t) => t.id)).toEqual(['r']);
  });

  it('版本没变:整轮只读一次', async () => {
    let reads = 0;
    await evaluateTriggers([opened, { ...opened, id: 'r2' }], { now: NOW, computerHistoryOn: true, chSignalsVersion: () => 'a', readChSignals: async () => { reads++; return []; } });
    expect(reads).toBe(1);
  });
});

describe('注册表', () => {
  it('老七种都在,存盘形状一个字节不变(upsert 靠 JSON 比对判 cond 变没变)', () => {
    const ids = listTriggerSources().map((s) => s.id);
    for (const id of ['file_chars_gte', 'event_seen', 'daily_at', 'at', 'every', 'manual', 'db_changed']) expect(ids).toContain(id);
    const shape = (input: TriggerInput) => {
      const v = validateTriggerInput({ desc: 'x', ...input }, { vaultPath: '/v' });
      return v.ok ? JSON.stringify(v.value.cond) : v.error;
    };
    expect(shape({ cond_type: 'daily_at', time: '09:00' })).toBe('{"type":"daily_at","time":"09:00"}');
    expect(shape({ cond_type: 'every', interval: '2h' })).toBe('{"type":"every","interval":"2h"}');
    expect(shape({ cond_type: 'event_seen', match: 'note.edit' })).toBe('{"type":"event_seen","match":"note.edit"}');
    expect(shape({ cond_type: 'manual' })).toBe('{"type":"manual"}');
    expect(shape({ cond_type: 'db_changed', path: 'T.db', event: 'cell_changed', column_id: 'c1' })).toBe('{"type":"db_changed","path":"T.db","vault":"/v","event":"cell_changed","columnId":"c1"}');
  });

  it('未知 cond_type 报错时列出全部触发源', () => {
    const v = validateTriggerInput({ desc: 'x', cond_type: 'nope' });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toContain('computer.app_opened');
  });

  it('新源的参数按表校验,按表的顺序重建(键序跟入参走会被当成 cond 变了)', () => {
    const a = validateTriggerInput({ desc: 'x', cond_type: 'computer.app_used', params: { minutes: '30', appName: 'Steam', app: STEAM.bundleId } });
    const b = validateTriggerInput({ desc: 'x', cond_type: 'computer.app_used', params: { app: STEAM.bundleId, appName: 'Steam', minutes: 30 } });
    expect(a.ok && JSON.stringify(a.value.cond)).toBe(b.ok && JSON.stringify(b.value.cond));
    expect(validateTriggerInput({ desc: 'x', cond_type: 'computer.app_used', params: { app: 'x', minutes: 0 } }).ok).toBe(false);
    expect(validateTriggerInput({ desc: 'x', cond_type: 'computer.app_used', params: { minutes: 5 } }).ok).toBe(false);
    expect(validateTriggerInput({ desc: 'x', cond_type: 'computer.returned', params: { minutes: 9999 } }).ok).toBe(false);
  });

  it('缺省冷却:打开 App 2 小时,其余新源 1 小时,日历自带节奏归 0', () => {
    const cd = (input: TriggerInput) => { const v = validateTriggerInput({ desc: 'x', actions: [{ type: 'remind', title: 't' }], ...input }); return v.ok ? v.value.cooldownHours : -1; };
    expect(cd({ cond_type: 'computer.app_opened', params: { app: 'x' } })).toBe(2);
    expect(cd({ cond_type: 'computer.unlocked' })).toBe(1);
    expect(cd({ cond_type: 'calendar.before', params: { minutes: 10 } })).toBe(0);
  });

  it('插件卸载后规则还能整量 upsert(关规则永远不许被校验挡住),没有 params 的未知类型照旧拒', () => {
    expect(validateTriggerInput({ desc: 'x', cond_type: 'plugin:wecom:mentioned', params: { room: 'a' }, enabled: false }).ok).toBe(true);
    expect(validateTriggerInput({ desc: 'x', cond_type: 'plugin:wecom:mentioned' }).ok).toBe(false);
  });

  it('触发源不在了:不命中、不抛、写状态位', async () => {
    const notices: Record<string, string> = {};
    const fired = await evaluateTriggers([rule({ cond: { type: 'plugin:gone:x', params: {} } })], { now: NOW, outNotices: notices });
    expect(fired).toEqual([]);
    expect(notices.r).toBe(NOTICE_SOURCE_MISSING);
    expect(condSummary({ type: 'plugin:gone:x', params: {} })).toBe('unknown condition');
    expect(nextRunAt(rule({ cond: { type: 'plugin:gone:x', params: {} } }), NOW)).toBeNull();
  });
});

describe('电脑上', () => {
  it('打开了 App:按 bundle id 或显示名认,不分大小写', async () => {
    expect(await run(opened, [{ t: ago(1), kind: 'app', app: STEAM }])).toHaveLength(1);
    const byName = rule({ cond: { type: 'computer.app_opened', params: { app: 'steam' } } });
    expect(await run(byName, [{ t: ago(1), kind: 'app', app: STEAM }])).toHaveLength(1);
    expect(await run(opened, [{ t: ago(1), kind: 'app', app: CODE }])).toHaveLength(0);
  });

  it('负对照:规则建好之前的、过时的、冷却内的都不算', async () => {
    const fresh = rule({ ...opened, createdAt: new Date(ago(5)).toISOString() });
    expect(await run(fresh, [{ t: ago(6), kind: 'app', app: STEAM }])).toHaveLength(0);
    // 直接提醒 15 分钟新鲜窗,叫醒 Muse 2 小时(它要等让位闸)。
    expect(await run(opened, [{ t: ago(20), kind: 'app', app: STEAM }])).toHaveLength(0);
    expect(await run(rule({ ...opened, actions: undefined }), [{ t: ago(20), kind: 'app', app: STEAM }])).toHaveLength(1);
    expect(await run(rule({ ...opened, lastFiredAt: new Date(ago(30)).toISOString() }), [{ t: ago(1), kind: 'app', app: STEAM }])).toHaveLength(0);
    // 冷却刚过,但那次打开发生在冷却期内:不能因为冷却结束补响一次旧事件。
    const cooled = rule({ ...opened, lastFiredAt: new Date(ago(121)).toISOString(), actions: undefined });
    expect(await run(cooled, [{ t: ago(30), kind: 'app', app: STEAM }])).toHaveLength(0);
  });

  it('电脑历史关着:不读事件、不命中、写「电脑历史关了」,不停用', async () => {
    const notices: Record<string, string> = {};
    let read = 0;
    const fired = await evaluateTriggers([opened], { now: NOW, computerHistoryOn: false, outNotices: notices, readChSignals: async () => { read++; return []; } });
    expect(fired).toEqual([]);
    expect(read).toBe(0);
    expect(notices.r).toBe(NOTICE_COMPUTER_HISTORY_OFF);
    expect(opened.enabled).toBe(true);
  });

  it('读的途中被清除(信号为 null):不命中', async () => {
    expect(await run(opened, null)).toEqual([]);
  });

  it('一轮评估只读一次电脑历史', async () => {
    let read = 0;
    await evaluateTriggers([{ ...opened, id: 'a' }, { ...opened, id: 'b' }], { now: NOW, computerHistoryOn: true, readChSignals: async () => { read++; return []; } });
    expect(read).toBe(1);
  });

  it('连续使用:一分钟内切回来不算中断,切走太久、锁屏都算', () => {
    const app = (m: number, a = STEAM): ChSignal => ({ t: ago(m), kind: 'app', app: a });
    expect(appSessionStart([app(100)], 'steam')).toBe(ago(100));
    expect(appSessionStart([app(100), app(50, CODE), { t: ago(49.5), kind: 'app', app: STEAM }], 'steam')).toBe(ago(100));
    expect(appSessionStart([app(100), app(50, CODE), app(40)], 'steam')).toBe(ago(40));
    expect(appSessionStart([app(100), app(50, CODE)], 'steam')).toBeNull();
    expect(appSessionStart([app(100), { t: ago(50), kind: 'system', state: 'locked' }], 'steam')).toBeNull();
    // 切到被排除的 App:没有名字,但确实切走了。
    expect(appSessionStart([app(100), { t: ago(50), kind: 'app' }], 'steam')).toBeNull();
  });

  it('App 连续用了 N 分钟:到点响,同一段只响一次', async () => {
    const used = rule({ cooldownHours: 1, cond: { type: 'computer.app_used', params: { app: 'Steam', minutes: 60 } } });
    const signals: ChSignal[] = [{ t: ago(90), kind: 'app', app: STEAM }];
    expect(await run(used, signals)).toHaveLength(1);
    expect(await run(rule({ ...used, cond: { type: 'computer.app_used', params: { app: 'Steam', minutes: 120 } } }), signals)).toHaveLength(0);
    expect(await run(rule({ ...used, lastFiredAt: new Date(ago(65)).toISOString() }), signals)).toHaveLength(0);
  });

  it('离开后回来:锁屏到解锁、长时间没动静;醒来但还锁着不算', () => {
    const away = 30 * MIN;
    expect(lastReturnAt([{ t: ago(90), kind: 'system', state: 'locked' }, { t: ago(80), kind: 'system', state: 'sleep' }, { t: ago(41), kind: 'system', state: 'wake' }, { t: ago(40), kind: 'system', state: 'unlocked' }], away)).toBe(ago(40));
    expect(lastReturnAt([{ t: ago(90), kind: 'activity' }, { t: ago(40), kind: 'activity' }], away)).toBe(ago(40));
    expect(lastReturnAt([{ t: ago(90), kind: 'system', state: 'locked' }, { t: ago(70), kind: 'system', state: 'unlocked' }], away)).toBeNull();
    expect(lastReturnAt([{ t: ago(90), kind: 'system', state: 'sleep' }, { t: ago(5), kind: 'system', state: 'wake' }], away)).toBeNull();
    expect(lastReturnAt([{ t: ago(90), kind: 'activity' }, { t: ago(85), kind: 'activity' }], away)).toBeNull();
  });

  it('离开后回来 / 解锁:只看新鲜的那次', async () => {
    const back = rule({ cooldownHours: 1, cond: { type: 'computer.returned', params: { minutes: 30 } } });
    const signals: ChSignal[] = [{ t: ago(90), kind: 'activity' }, { t: ago(3), kind: 'activity' }];
    expect(await run(back, signals)).toHaveLength(1);
    expect(await run(back, [{ t: ago(190), kind: 'activity' }, { t: ago(100), kind: 'activity' }])).toHaveLength(0);
    const unlock = rule({ cooldownHours: 1, cond: { type: 'computer.unlocked', params: {} } });
    expect(await run(unlock, [{ t: ago(2), kind: 'system', state: 'unlocked' }])).toHaveLength(1);
    expect(await run(unlock, [{ t: ago(2), kind: 'system', state: 'locked' }])).toHaveLength(0);
  });

  it('交给模型的只有「打开了 X」,没有窗口内容', () => {
    expect(condSummary(opened.cond)).toBe('the user opened Steam');
  });
});

describe('日历事件开始前', () => {
  const ev = (m: number, key = `e${m}`): CalendarEventHit => ({ key, startMs: NOW.getTime() + m * MIN, ctx: { dbPath: 'Cal.db', row: { id: key, cells: { 名称: '开会' } } } });
  const before = rule({ cooldownHours: 0, cond: { type: 'calendar.before', params: { minutes: 10 } } });
  const runCal = (t: MuseTrigger, events: CalendarEventHit[], out: Record<string, unknown> = {}) => evaluateTriggers([t], { now: NOW, calendarEvents: async () => events, ...out });

  it('同一时刻开始的事件:一轮一个,下一轮接着下一个,不重复', async () => {
    const a = ev(8, 'a'); const b = ev(8, 'b');
    const go = async (cursor?: { ts: string; hash: string }): Promise<{ ts: string; hash: string } | undefined> => {
      const outCursors: Record<string, { ts: string; hash: string }> = {};
      await evaluateTriggers([rule({ cond: before.cond, lastEventCursor: cursor })], { now: NOW, calendarEvents: async () => [b, a], outCursors });
      return outCursors.r;
    };
    const first = await go();
    expect(first?.hash).toBe('a');
    const second = await go(first);
    expect(second?.hash).toBe('b');
    expect(await go(second)).toBeUndefined();
  });

  it('进了提前量才响,带上事件那一行给模板', async () => {
    const hits: Array<{ id: string; ctx: unknown }> = [];
    expect(await runCal(before, [ev(30)])).toHaveLength(0);
    expect(await runCal(before, [ev(8)], { outHits: hits })).toHaveLength(1);
    expect(hits[0].ctx).toEqual(ev(8).ctx);
  });

  it('同一事件不响两次,紧挨着的下一个照响(不吃 cooldown)', async () => {
    const cursors: Record<string, { ts: string; hash: string }> = {};
    await runCal(before, [ev(8)], { outCursors: cursors });
    const again = rule({ ...before, lastFiredAt: NOW.toISOString(), lastEventCursor: cursors.r });
    expect(await runCal(again, [ev(8)])).toHaveLength(0);
    expect(await runCal(again, [ev(8), ev(9)])).toHaveLength(1);
  });

  it('开始后一个巡检周期内还算赶得上,再晚不补', async () => {
    expect(await runCal(before, [ev(-3)])).toHaveLength(1);
    expect(await runCal(before, [ev(-6)])).toHaveLength(0);
  });
});

describe('只在:时段、星期、每天最多几次', () => {
  const signals: ChSignal[] = [{ t: ago(1), kind: 'app', app: STEAM }];

  it('时段(含跨夜)与星期挡住就不命中', async () => {
    expect(await run(rule({ ...opened, only: { hours: { start: 9, end: 18 } } }), signals)).toHaveLength(1);
    expect(await run(rule({ ...opened, only: { hours: { start: 18, end: 23 } } }), signals)).toHaveLength(0);
    expect(await run(rule({ ...opened, only: { hours: { start: 22, end: 16 } } }), signals)).toHaveLength(1);
    expect(await run(rule({ ...opened, only: { weekdays: [4] } }), signals)).toHaveLength(1);
    expect(await run(rule({ ...opened, only: { weekdays: [0, 6] } }), signals)).toHaveLength(0);
  });

  it('到了每天上限就停,第二天重新数', async () => {
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(await run(rule({ ...opened, maxPerDay: 2, firedDay: { day: day(NOW), n: 2 } }), signals)).toHaveLength(0);
    expect(await run(rule({ ...opened, maxPerDay: 2, firedDay: { day: '2026-10-28', n: 2 } }), signals)).toHaveLength(1);
  });

  it('入参校验:小时与星期出界拒,空条件归 null', () => {
    const v = (only: unknown, max?: unknown) => validateTriggerInput({ desc: 'x', cond_type: 'manual', only, max_per_day: max });
    expect(v({ hours: { start: 25, end: 3 } }).ok).toBe(false);
    expect(v({ weekdays: [7] }).ok).toBe(false);
    expect(v({}, 0)).toMatchObject({ ok: true, value: { only: null, maxPerDay: null } });
    expect(v({ weekdays: [6, 1, 1] }, 3)).toMatchObject({ ok: true, value: { only: { weekdays: [1, 6] }, maxPerDay: 3 } });
  });
});

describe('落盘', () => {
  beforeAll(() => { process.env.TANGU_HOME = mkdtempSync(join(tmpdir(), 'tangu-trig-registry-')); });

  it('markTriggersFired 数当天次数;老规则(没设上限)文件形状不变', async () => {
    await saveTriggers([
      { ...opened, id: 'capped', maxPerDay: 3 },
      { id: 'old', desc: 'o', cond: { type: 'daily_at', time: '09:00' }, cooldownHours: 0, lastFiredAt: null, enabled: true, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    await markTriggersFired(['capped', 'old'], NOW);
    await markTriggersFired(['capped'], NOW);
    const [capped, old] = await loadTriggers();
    expect(capped.firedDay?.n).toBe(2);
    expect('firedDay' in old).toBe(false);
  });

  it('老客户端整量 upsert 不带 only / max_per_day:保留;显式 null:清掉', async () => {
    await saveTriggers([{ ...opened, id: 'keep', only: { weekdays: [1] }, maxPerDay: 2, firedDay: { day: 'x', n: 1 } }]);
    const base = { desc: 'd', cond_type: 'computer.app_opened', params: { app: STEAM.bundleId, appName: 'Steam' } };
    const v1 = validateTriggerInput(base);
    await upsertTrigger(v1.ok ? v1.value : (null as never), 'keep', { actor: 'user' });
    expect((await loadTriggers())[0]).toMatchObject({ only: { weekdays: [1] }, maxPerDay: 2 });
    const v2 = validateTriggerInput({ ...base, only: null, max_per_day: null });
    await upsertTrigger(v2.ok ? v2.value : (null as never), 'keep', { actor: 'user' });
    const after = (await loadTriggers())[0];
    expect(after.only).toBeUndefined();
    expect(after.maxPerDay).toBeUndefined();
    expect(after.firedDay).toBeUndefined();
  });

  it('电脑类规则带 requires,日历不带(Linux / 关着时菜单按这个收)', () => {
    expect(getTriggerSource('computer.app_opened')?.requires).toEqual(['computer_history']);
    expect(getTriggerSource('calendar.before')?.requires).toBeUndefined();
  });
});
