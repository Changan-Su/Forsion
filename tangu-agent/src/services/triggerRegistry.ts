/**
 * 触发源注册表 —— 自动化规则的「当…」(方案 docs/ToBeImproved/Muse与Agent升级方案_2026-10-29/triggers.html)。
 *
 * 一种触发源一条:id、中英名字、参数表、要什么权限、事件从哪来,外加校验 / 求值 / 摘要 / 下次时刻四个函数。
 * museTriggers.ts 的校验、求值、摘要、nextRunAt 都只查这张表,加一种触发不再改十来处。
 *
 * cond 落盘两种形状:
 *   老七种 = 平铺字段(`{ type:'daily_at', time }`),**一个字节都不改** —— upsertTrigger 按 JSON 比对 cond,
 *     形状一变存量规则第一次保存就丢游标;
 *   新源 = `{ type, params }`,id 带点或 `plugin:` 前缀(类型上和老七种不相交,`c.type === 'db_changed'` 照常收窄)。
 */
import type { ChSignal } from './computerHistory.js';
import type { CalendarEventHit } from './triggerSources.js';
import type { EvaluateEnv, MuseTrigger, MuseTriggerCond, TriggerContext, TriggerInput } from './museTriggers.js';

/** 菜单分组(界面按它分节)。 */
export type TriggerGroup = 'time' | 'computer' | 'forsion' | 'external' | 'plugin';
/** 事件从哪来:clock = 算时刻;poll = 巡检时看一眼;computer = 电脑历史;calendar = 日历;plugin = 插件 emit;manual = 只被点起来。 */
export type TriggerEventSource = 'clock' | 'poll' | 'computer' | 'calendar' | 'plugin' | 'manual';
/** 宿主能力闸:不满足时规则暂停(不停用),开回来自愈。 */
export type TriggerRequirement = 'computer_history';

export interface LocalizedName { zh: string; en: string }

/** 新源的参数一行。`app` = App 标识(bundle id / Windows exe 名,也认显示名);老七种的表只作说明,表单是专门写的。 */
export interface TriggerParam {
  key: string;
  type: 'app' | 'number' | 'text';
  name: LocalizedName;
  required?: boolean;
  /** 界面不单独出控件(如 appName 跟着 App 选择器写)。 */
  hidden?: boolean;
  min?: number;
  max?: number;
  default?: string | number;
}

export type ParsedCond = { ok: true; cond: MuseTriggerCond } | { ok: false; error: string };

export interface TriggerEvalIo {
  env: EvaluateEnv;
  now: Date;
  /** 上次触发(epoch ms);0 = 从未。 */
  lastMs: number;
  cooldownMs: number;
  /** 命中一次;带 ctx 的(db_changed 的行、日历事件)模板变量可用。 */
  hit(ctx?: TriggerContext): void;
  /** 电脑历史信号(本轮所有规则共用一次读取);闸关着或读的途中被清除 = null。 */
  signals(): Promise<ChSignal[] | null>;
  /** 日历事件(本轮共用一次读取)。 */
  calendarEvents(): Promise<CalendarEventHit[]>;
}

export interface TriggerSource {
  id: string;
  group: TriggerGroup;
  name: LocalizedName;
  params: TriggerParam[];
  requires?: TriggerRequirement[];
  eventSource: TriggerEventSource;
  /** 自带节奏(时刻 / 锚点 / 按事件去重):不吃 cooldown,校验时 cooldownHours 归 0。 */
  timed?: boolean;
  /** 没填冷却时的缺省(小时);缺省 24。 */
  defaultCooldownHours?: number;
  /** 事件不是 Muse 自己能造出来的:Muse 建「叫醒自己」的规则不算自激(第二步用)。 */
  selfWakeSafe?: boolean;
  parse(input: TriggerInput, opts: { cwd?: string; vaultPath?: string }): ParsedCond;
  evaluate(t: MuseTrigger, io: TriggerEvalIo): Promise<void>;
  /** 给模型看的英文摘要。 */
  summary(cond: MuseTriggerCond): string;
  nextRunAt?(t: MuseTrigger, from: Date): string | null;
}

const sources = new Map<string, TriggerSource>();

export function registerTriggerSource(src: TriggerSource): void {
  sources.set(src.id, src);
}
export function unregisterTriggerSource(id: string): void {
  sources.delete(id);
}
export function getTriggerSource(id: string | undefined): TriggerSource | undefined {
  return id ? sources.get(id) : undefined;
}
export function listTriggerSources(): TriggerSource[] {
  return [...sources.values()];
}

/** 引擎状态位里的 code(不是界面文案:桌面按 code 取中英文,见 views/automation/lib.ts noticeText)。 */
export const NOTICE_SOURCE_MISSING = 'trigger:source_missing';
export const NOTICE_COMPUTER_HISTORY_OFF = 'trigger:computer_history_off';

/** 新源的通用参数校验:按表取值、转型、钳范围,**按表的顺序重建**(upsert 靠 JSON 比对判 cond 变没变,键序不能跟着入参走)。 */
export function parseParams(src: Pick<TriggerSource, 'id' | 'params'>, raw: unknown):
  { ok: true; params: Record<string, string | number> } | { ok: false; error: string } {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const params: Record<string, string | number> = {};
  for (const p of src.params) {
    const v = input[p.key] ?? p.default;
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (p.required) return { ok: false, error: `${src.id} needs params.${p.key}` };
      continue;
    }
    if (p.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) return { ok: false, error: `${src.id}: params.${p.key} must be a number` };
      if ((p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)) {
        return { ok: false, error: `${src.id}: params.${p.key} must be between ${p.min ?? '-∞'} and ${p.max ?? '∞'}` };
      }
      params[p.key] = n;
    } else {
      const s = String(v).trim().slice(0, 200);
      if (!s) {
        if (p.required) return { ok: false, error: `${src.id} needs params.${p.key}` };
        continue;
      }
      params[p.key] = s;
    }
  }
  return { ok: true, params };
}
