/**
 * 新触发源:「电脑上」四个 + 「日历事件开始前」(triggerRegistry 的表项,老七种在 museTriggers.ts 末尾)。
 *
 * 本机事件流 = 桌面主进程已经在写的电脑历史:这里只经 computerHistory.readChSignals 读切换与系统事件,
 * 清除 / 排除 / 关闭 / 保留期全部原样生效,不另起一份记录「你开了什么」的文件。主进程落盘后踢一下
 * POST /agent/special/automation/kick,不用等 5 分钟巡检;踢不到也只是晚一个巡检周期。
 *
 * 隐私(与电脑历史博客「它不会做的事」一致):匹配全在本机,标题 / 网址 / 输入进不来;
 * 交给模型的只有 summary 那一句「打开了 X」。
 */
import type { ChSignal } from './computerHistory.js';
import { parseParams, registerTriggerSource, type LocalizedName, type ParsedCond, type TriggerEvalIo, type TriggerSource } from './triggerRegistry.js';
import type { MuseTrigger, MuseTriggerCond, TriggerContext } from './museTriggers.js';

const MIN = 60_000;
/** 事件新鲜度:直接提醒过时就算了;叫醒 Muse 要过额度和让位闸,可以多等一阵(用户跑着别的会话时它会等)。 */
const REMIND_FRESH_MS = 15 * MIN;
const WAKE_FRESH_MS = 120 * MIN;
/** 一次评估读多久的电脑历史(「连续用了 N 分钟」「离开 N 分钟」的上限要小于它)。 */
export const CH_LOOKBACK_MS = 12 * 60 * MIN;
const MAX_MINUTES = 8 * 60;
/** 切出去这么久以内再切回来,不算中断(回个消息不该把「连续用了 90 分钟」清零)。 */
const BRIEF_SWITCH_MS = MIN;
/** 日历事件开始后这么久内还算赶得上:巡检 5 分钟一次,窗口比它短的提前量会被跳过。 */
const CALENDAR_LATE_MS = 5 * MIN;

/** 一条可提醒的日历事件(ctx 给 `{{row.X}}` 模板用)。 */
export interface CalendarEventHit { key: string; startMs: number; ctx: TriggerContext }

const paramsOf = (t: MuseTrigger): Record<string, string | number> => (t.cond as { params?: Record<string, string | number> }).params ?? {};
const condParams = (c: MuseTriggerCond): Record<string, string | number> => (c as { params?: Record<string, string | number> }).params ?? {};

/** 规则的事件起算点:规则建好之后 + 冷却结束之后 + 还算新鲜。 */
function eventSince(t: MuseTrigger, io: TriggerEvalIo): number {
  const fresh = t.actions?.length ? REMIND_FRESH_MS : WAKE_FRESH_MS;
  return Math.max(Date.parse(t.createdAt) || 0, io.lastMs ? io.lastMs + io.cooldownMs : 0, io.now.getTime() - fresh);
}

/** App 按标识认(macOS bundle id / Windows exe 名),也认显示名(Muse 提规则时多半只知道名字);不分大小写。 */
export function appMatches(app: ChSignal['app'], want: string): boolean {
  if (!app) return false;
  const w = want.trim().toLowerCase();
  return !!w && (app.bundleId?.toLowerCase() === w || app.name.toLowerCase() === w);
}

/** 这个 App 当前这段连续使用的起点;现在不在用 → null。锁屏 / 睡眠算中断,一分钟内切回来不算。
 *  ponytail: 不看键鼠,人走开但 App 还在前台也算在用(看视频没有输入事件,分不清);要准得接系统空闲时间。 */
export function appSessionStart(signals: ChSignal[], want: string): number | null {
  let start: number | null = null;
  let leftAt: number | null = null;
  for (const s of signals) {
    if (s.kind === 'system' && (s.state === 'locked' || s.state === 'sleep')) {
      start = leftAt = null;
    } else if (s.kind === 'app') {
      if (appMatches(s.app, want)) {
        if (start === null || (leftAt !== null && s.t - leftAt > BRIEF_SWITCH_MS)) start = s.t;
        leftAt = null;
      } else if (start !== null && leftAt === null) {
        leftAt = s.t;
      }
    }
  }
  return leftAt === null ? start : null;
}

/** 最近一次「离开至少 awayMs 后回来」的时刻。离开 = 锁屏 / 睡眠,或这么久没有任何动静;回来 = 解锁或第一条动静(醒来时可能还锁着,不算)。 */
export function lastReturnAt(signals: ChSignal[], awayMs: number): number | null {
  let prev: number | null = null;
  let awaySince: number | null = null;
  let back: number | null = null;
  for (const s of signals) {
    if (s.kind === 'system' && (s.state === 'locked' || s.state === 'sleep')) {
      awaySince ??= s.t;
    } else if (!(s.kind === 'system' && s.state === 'wake')) {
      const from = awaySince ?? prev;
      if (from !== null && s.t - from >= awayMs) back = s.t;
      awaySince = null;
    }
    prev = s.t;
  }
  return back;
}

const label = (p: Record<string, string | number>): string => String(p.appName || p.app);
const appParam = { key: 'app', type: 'app', required: true, name: { zh: 'App', en: 'App' } } as const;
const appNameParam = { key: 'appName', type: 'text', hidden: true, name: { zh: 'App 名字', en: 'App name' } } as const;
const minutesParam = (name: LocalizedName, min = 1) => ({ key: 'minutes', type: 'number', required: true, min, max: MAX_MINUTES, name }) as const;

function paramSource(src: Omit<TriggerSource, 'parse'>): TriggerSource {
  return {
    ...src,
    parse: (input): ParsedCond => {
      const p = parseParams(src, input.params);
      return p.ok ? { ok: true, cond: { type: src.id as `${string}.${string}`, params: p.params } } : p;
    },
  };
}

const computer: Pick<TriggerSource, 'group' | 'requires' | 'eventSource' | 'selfWakeSafe'> = { group: 'computer', requires: ['computer_history'], eventSource: 'computer', selfWakeSafe: true };

/** museTriggers.ts 模块体里调(排在老时间类之后,界面菜单的顺序)。 */
export function registerLocalTriggerSources(): void {
  registerTriggerSource(paramSource({
    ...computer, id: 'computer.app_opened', name: { zh: '打开了 App', en: 'App opened' }, defaultCooldownHours: 2,
    params: [appParam, appNameParam],
    evaluate: async (t, io) => {
      const signals = await io.signals();
      if (!signals) return;
      const since = eventSince(t, io);
      const want = String(paramsOf(t).app);
      if (signals.some((s) => s.kind === 'app' && s.t > since && appMatches(s.app, want))) io.hit();
    },
    summary: (c) => `the user opened ${label(condParams(c))}`,
  }));
  registerTriggerSource(paramSource({
    ...computer, id: 'computer.app_used', name: { zh: 'App 连续用了一段时间', en: 'App used for a while' }, defaultCooldownHours: 1,
    params: [appParam, appNameParam, minutesParam({ zh: '分钟', en: 'Minutes' })],
    evaluate: async (t, io) => {
      const signals = await io.signals();
      if (!signals) return;
      const p = paramsOf(t);
      const start = appSessionStart(signals, String(p.app));
      // 一段连续使用只响一次:上次触发就在这一段里 → 不再催。
      if (start !== null && io.now.getTime() - start >= Number(p.minutes) * MIN && io.lastMs < start) io.hit();
    },
    summary: (c) => {
      const p = condParams(c);
      return `the user has been in ${label(p)} for ${p.minutes}+ minutes`;
    },
  }));
  registerTriggerSource(paramSource({
    ...computer, id: 'computer.returned', name: { zh: '离开电脑后回来', en: 'Back at the computer' }, defaultCooldownHours: 1,
    params: [minutesParam({ zh: '至少离开（分钟）', en: 'Away for at least (minutes)' })],
    evaluate: async (t, io) => {
      const signals = await io.signals();
      if (!signals) return;
      const back = lastReturnAt(signals, Number(paramsOf(t).minutes) * MIN);
      if (back !== null && back > eventSince(t, io)) io.hit();
    },
    summary: (c) => `the user came back after ${condParams(c).minutes}+ minutes away`,
  }));
  registerTriggerSource(paramSource({
    ...computer, id: 'computer.unlocked', name: { zh: '解锁或唤醒', en: 'Unlocked or woke up' }, defaultCooldownHours: 1,
    params: [],
    evaluate: async (t, io) => {
      const signals = await io.signals();
      if (!signals) return;
      const since = eventSince(t, io);
      if (signals.some((s) => s.kind === 'system' && (s.state === 'unlocked' || s.state === 'wake') && s.t > since)) io.hit();
    },
    summary: () => 'the user unlocked or woke the computer',
  }));
  registerTriggerSource(paramSource({
    id: 'calendar.before', group: 'forsion', name: { zh: '日历事件开始前', en: 'Before a calendar event' }, eventSource: 'calendar', timed: true, selfWakeSafe: true,
    params: [minutesParam({ zh: '提前（分钟）', en: 'Minutes before' })],
    evaluate: async (t, io) => {
      const before = Number(paramsOf(t).minutes) * MIN;
      const now = io.now.getTime();
      // 游标记到已提醒的最后一个 (开始时刻, key):同一时刻开始的事件按 key 排,一轮提醒一个,下一轮接着下一个。
      const doneAt = Number(t.lastEventCursor?.ts) || 0;
      const doneKey = t.lastEventCursor?.hash ?? '';
      const due = (await io.calendarEvents())
        .filter((e) => now >= e.startMs - before && now < e.startMs + CALENDAR_LATE_MS && (e.startMs > doneAt || (e.startMs === doneAt && e.key > doneKey)))
        .sort((a, b) => a.startMs - b.startMs || (a.key < b.key ? -1 : 1))[0];
      if (!due) return;
      io.hit(due.ctx);
      if (io.env.outCursors) io.env.outCursors[t.id] = { ts: String(due.startMs), hash: due.key };
    },
    summary: (c) => `a calendar event starts within ${condParams(c).minutes} minutes`,
  }));
}
