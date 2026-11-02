/** 「自动化」Space 三个 view 共用的小工具(文案拼装;t 由调用方传入)+ 构建器的 draft ↔ spec 纯映射
 *  (2026-09-02 从 AutomationBuilder.tsx 搬来:desktop vitest 只收 *.test.ts,留在 .tsx 里永远测不到,
 *  而「编辑既有规则再保存不丢字段」正是需要仪器的那件事,见 lib.test.ts)。 */
import type {
  AutomationActionCatalogItem,
  AutomationActionSpec,
  AutomationWhere,
  MuseTriggerInfo,
  MuseTriggerUpsert,
  NormalAgentDef,
  TriggerSourceInfo,
} from '../../types'
import { formatMonthDay, formatTime, toDate } from '../../format/time'
import { agentName } from '../../agentName'
import './messages'

type T = (key: string, vars?: Record<string, string>) => string

/** 触发条件的人话摘要(未知类型防御回落——新引擎新 cond 不炸旧面板)。 */
export function condText(t: T, cond: MuseTriggerInfo['cond']): string {
  if (!cond || typeof cond !== 'object') return '—'
  if (cond.type === 'daily_at') return t('automation.cond.daily', { time: cond.time })
  if (cond.type === 'event_seen') return t('automation.cond.event', { match: cond.match })
  if (cond.type === 'at') return t('automation.cond.at', { time: String(cond.datetime || '').replace('T', ' ') })
  if (cond.type === 'every') return t('automation.cond.every', { ivl: cond.interval })
  if (cond.type === 'file_chars_gte') return t('automation.cond.file', { path: shortPath(cond.path), n: String(cond.n) })
  if (cond.type === 'manual') return t('automation.cond.manual')
  if (cond.type === 'computer.app_opened') return t('automation.cond.appOpened', { app: paramText(cond.params, 'appName', 'app') })
  if (cond.type === 'computer.app_used') return t('automation.cond.appUsed', { app: paramText(cond.params, 'appName', 'app'), n: paramText(cond.params, 'minutes') })
  if (cond.type === 'computer.returned') return t('automation.cond.returned', { n: paramText(cond.params, 'minutes') })
  if (cond.type === 'computer.unlocked') return t('automation.cond.unlocked')
  if (cond.type === 'calendar.before') return t('automation.cond.calendarBefore', { n: paramText(cond.params, 'minutes') })
  if (cond.type === 'db_changed') {
    const base = cond.event === 'row_added'
      ? t('automation.cond.dbRow', { path: shortPath(cond.path) })
      : t('automation.cond.dbCell', { path: shortPath(cond.path) })
    // 附加条件只报条数(逐条内容在详情页 whereText);等值条件顺手带上,以前连它都没显示。
    const eq = cond.event === 'cell_changed' && cond.equals ? ` = ${cond.equals}` : ''
    const wn = cond.where?.length ? ` · ${t('automation.cond.dbWhereN', { n: String(cond.where.length) })}` : ''
    return `${base}${eq}${wn}`
  }
  const pluginKey = /^plugin:[^:]+:(.+)$/.exec(String(cond.type))?.[1]
  if (pluginKey) return t('automation.cond.plugin', { key: pluginKey })
  return String((cond as any).type || '—')
}

const paramText = (params: Record<string, string | number> | undefined, ...keys: string[]): string =>
  String(keys.map((k) => params?.[k]).find((v) => v !== undefined && v !== '') ?? '—')

/** 引擎状态位 → 界面文案:`trigger:*` 是 code;其余是引擎写好的暂时性说明,原样显示。 */
export function noticeText(t: T, notice: string | undefined): string {
  if (notice === 'trigger:computer_history_off') return t('automation.notice.computerOff')
  if (notice === 'trigger:source_missing') return t('automation.notice.sourceMissing')
  return notice || ''
}

/** cell_changed 实际监听的列 id:columnIds ∪ columnId,去重保序(引擎 watchedCols 同口径;两键只带一个也能取到)。 */
export function watchedColumnIds(cond: MuseTriggerInfo['cond'] | undefined): string[] {
  if (cond?.type !== 'db_changed') return []
  const out: string[] = []
  for (const raw of [...(Array.isArray(cond.columnIds) ? cond.columnIds : []), cond.columnId]) {
    const id = String(raw ?? '').trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** where 条件逐条成文(详情页):`列 = 值` / `列 ≠ 值` / `列 为空` / `列 不为空`。 */
export function whereText(t: T, where: AutomationWhere[] | undefined): string {
  if (!where?.length) return ''
  return where
    .map((w) =>
      w.op === 'eq' ? `${w.column} = ${w.value ?? ''}`
      : w.op === 'ne' ? `${w.column} ≠ ${w.value ?? ''}`
      : w.op === 'empty' ? `${w.column} ${t('automation.builder.dbWhereOpEmpty')}`
      : `${w.column} ${t('automation.builder.dbWhereOpNotEmpty')}`)
    .join(' ∧ ')
}

/** 动作链摘要(列表副行/详情 facts):notify → 通知 · agent_run → agent 名 · tool_call → 工具名。
 *  db_row_edit 带靶行标记(→关联列 / →匹配列):ERP 一类规则在列表里都长成「✎ 库存表.db」,没标记分不清。 */
export function actionsText(t: T, defs: NormalAgentDef[], tr: MuseTriggerInfo): string {
  if (tr.actions?.length) {
    return tr.actions
      .map((a) =>
        a.type === 'notify' ? t('automation.step.notify')
        : a.type === 'remind' ? t('automation.step.remind')
        : a.type === 'agent_run' ? runnerName(defs, a.agentSlug)
        : a.type === 'db_row_add' ? `＋ ${shortPath(a.path)}${a.skipIfEmpty ? ` (?${a.skipIfEmpty})` : ''}`
        : a.type === 'db_row_edit' ? `✎ ${shortPath(a.path)}${a.rowFrom ? ` →${a.rowFrom}` : a.match ? ` →${a.match.column}` : ''}`
        : (a as any).tool || 'tool')
      .join(' → ')
  }
  return runnerName(defs, tr.agentSlug)
}

/** 路径尾部截断(列表摘要用)。 */
export function shortPath(p: string): string {
  return p.length > 36 ? `…${p.slice(-35)}` : p
}

/** 'YYYY-MM-DD[( |T)HH:mm]' → 本地 Date(时分缺省 00:00;手工拆分量,勿 Date.parse——UTC 午夜坑)。 */
export function parseLocalDatetime(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(String(raw || '').trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0))
  return isNaN(d.getTime()) ? null : d
}

/** 已结束=一次性(at)规则时刻已过且已停用(触发自灭/手动关过期)——重新启用会被引擎拒,归档显示。 */
export function isFinishedTrigger(tr: MuseTriggerInfo): boolean {
  if (tr.cond?.type !== 'at' || tr.enabled) return false
  const d = parseLocalDatetime(tr.cond.datetime)
  return !!d && d.getTime() <= Date.now()
}

/** 一次性和手动规则没有观察(引擎 canObserve 同口径)。 */
export const canObserve = (condType: string): boolean => condType !== 'at' && condType !== 'manual'
export type RuleState = 'off' | 'observe' | 'on'
/** 观察位只在开着时生效,暂停时留着。 */
export const ruleState = (tr: Pick<MuseTriggerInfo, 'enabled' | 'observe'>): RuleState => !tr.enabled ? 'off' : tr.observe ? 'observe' : 'on'

/** 执行者显示名:agentSlug 缺省=Muse(品牌名不进 i18n);有 slug 找 defs 显示名,找不到回落 slug。 */
export function runnerName(defs: NormalAgentDef[], agentSlug?: string): string {
  if (!agentSlug) return 'Muse'
  return agentName(defs.find((d) => d.slug === agentSlug)) || agentSlug
}

/**
 * 内置活动事件目录(builder 事件 datalist;正典=各埋点调用处,这里只是补全建议非枚举约束,
 * 自由子串仍然合法)。插件声明的事件由 pluginStore 侧合并(Phase G)。
 */
export const BUILTIN_EVENTS = [
  'note.edit', 'note.create', 'file.save', 'chat.send', 'chat.new', 'agent.edit',
  'run.done', 'row.edit', 'task.new', 'event.new', 'base.create', 'drawing.create',
  'mindmap.create', 'image.generate', 'market.install', 'agent.create', 'app.start', 'view.open', 'space.save',
]

/** ISO/epoch → 本地短时间。 */
export function fmtTime(v: string | number | null | undefined): string {
  const d = toDate(v)
  return d ? `${formatMonthDay(d)} ${formatTime(d)}` : '—'
}

// ── 规则 → upsert 全量入参 ───────────────────────────────────────────────────────────────

/** 规则 → upsert 全量入参(启停翻转时其余字段原样带回,upsert 语义要求全字段;actions 显式回传防抹链)。
 *  住在纯模块里:pluginStore 禁用插件时也用它把 `plugin:<id>:` 规则关掉(不能从视图模块 import)。 */
export function triggerToUpsert(t: MuseTriggerInfo): MuseTriggerUpsert {
  return {
    id: t.id,
    desc: t.desc,
    cond_type: t.cond.type,
    // 新触发源的参数整包带回;「只在」没设也要发 null / 不发由引擎保留,这里原样回传。
    params: 'params' in t.cond ? t.cond.params : undefined,
    only: t.only,
    max_per_day: t.maxPerDay,
    // ⚠️ cond 的每个字段都必须原样带回:upsert 是**整量**语义,漏一个后端就 400。
    // db_changed 的 path/event/vault/column_id 漏掉过一次——表现是「DB 规则的启停开关点不动」;
    // where 是同一个坑的第二次候选:漏了=点一下启停开关就把附加条件抹光(且 cond 变化还会重置游标)。
    path: t.cond.type === 'file_chars_gte' || t.cond.type === 'db_changed' ? t.cond.path : undefined,
    n: t.cond.type === 'file_chars_gte' ? t.cond.n : undefined,
    match: t.cond.type === 'event_seen' ? t.cond.match : undefined,
    time: t.cond.type === 'daily_at' ? t.cond.time : undefined,
    datetime: t.cond.type === 'at' ? t.cond.datetime : undefined,
    interval: t.cond.type === 'every' ? t.cond.interval : undefined,
    event: t.cond.type === 'db_changed' ? t.cond.event : undefined,
    vault: t.cond.type === 'db_changed' ? t.cond.vault : undefined,
    column_id: t.cond.type === 'db_changed' ? t.cond.columnId : undefined,
    // 多列监听是同一个坑的第三次候选:漏发 = 启停开关一按,多列规则静默退化成只盯首列(且 cond 变化重置游标)。
    column_ids: t.cond.type === 'db_changed' && t.cond.columnIds?.length ? t.cond.columnIds : undefined,
    equals: t.cond.type === 'db_changed' ? t.cond.equals : undefined,
    where: t.cond.type === 'db_changed' && t.cond.where?.length ? t.cond.where : undefined,
    prompt: t.prompt,
    // 0 是合法值(db_changed 纯动作链 = 不冷却);`||` 会把它变成 undefined → 引擎重新按默认算。
    cooldown_hours: t.cooldownHours ?? undefined,
    agent_slug: t.agentSlug,
    enabled: t.enabled,
    actions: t.actions?.length ? t.actions : null,
  }
}

// ── 构建器 draft ↔ spec ───────────────────────────────────────────────────────────────────

export interface StepDraft {
  key: number
  type: 'notify' | 'remind' | 'agent_run' | 'tool_call' | 'db_row_add' | 'db_row_edit'
  title: string
  body: string
  agentSlug: string
  prompt: string
  tool: string
  /** 工具参数原始输入(全字符串;boolean 存 'true'/'false'，缺席保持省略)。 */
  argValues: Record<string, string>
  /** db 动作:目标 .db(vault 相对路径)。 */
  dbPath: string
  /** db_row_edit:行 id;空 = 触发命中的那一行(仅多维表触发下有)。 */
  rowId: string
  /** db_row_edit:沿触发行的关联列取目标行(列 id 或列名);优先级 rowId > rowFrom > match > 触发行。 */
  rowFrom: string
  /** db_row_edit:按目标表某列的值匹配多行(值可含 {{row.id}} 模板)。
   *  ⚠️不叫 match —— 组件作用域里 match 已被 event_seen 的子串条件占用。 */
  matchColumn: string
  matchValue: string
  /** db_row_add:该单元格键展开后为空则跳过本步(不算失败)。 */
  skipIfEmpty: string
  /** db 动作:写入的 列名/列id → 值(值可含 {{row.X}} 模板)。 */
  cells: Array<{ k: string; v: string }>
}

/** where 行的表单态(全字符串;op 是 empty/notempty 时 value 不用)。 */
export interface WhereDraft {
  column: string
  op: AutomationWhere['op']
  value: string
}

export const WHERE_OPS: AutomationWhere['op'][] = ['eq', 'ne', 'empty', 'notempty']
/** 引擎侧 where 条数上限(museTriggers 校验同值)。 */
export const MAX_WHERE = 10

/** 本版构建器能编辑的全部步骤类型(2.8 起含 DB 动作)。 */
export function isEditableStep(a: AutomationActionSpec): boolean {
  return a.type === 'notify' || a.type === 'remind' || a.type === 'agent_run' || a.type === 'tool_call' || a.type === 'db_row_add' || a.type === 'db_row_edit'
}

/** 每种动作/条件本版表单认识的键。不在表里的键 = 表单表达不了 → 打开即只读(见 hasUnsupportedParts)。 */
const KNOWN_ACTION_KEYS: Record<StepDraft['type'], readonly string[]> = {
  notify: ['type', 'title', 'body'],
  remind: ['type', 'title', 'body'],
  agent_run: ['type', 'agentSlug', 'prompt'],
  tool_call: ['type', 'tool', 'args'],
  db_row_add: ['type', 'path', 'cells', 'skipIfEmpty'],
  db_row_edit: ['type', 'path', 'rowId', 'rowFrom', 'match', 'cells'],
}
const KNOWN_COND_KEYS: Record<string, readonly string[]> = {
  file_chars_gte: ['type', 'path', 'n'],
  event_seen: ['type', 'match'],
  daily_at: ['type', 'time'],
  at: ['type', 'datetime'],
  every: ['type', 'interval'],
  manual: ['type'],
  db_changed: ['type', 'path', 'vault', 'event', 'columnId', 'columnIds', 'equals', 'where'],
}
const hasUnknownKeys = (o: object, known: readonly string[]): boolean =>
  Object.entries(o).some(([k, v]) => v !== undefined && !known.includes(k))

/** 这条规则里有本版构建器还不认识的部分吗(将来引擎新增的动作类型 **或字段**;不静默降级 —— 那等于
 *  用户点开看一眼、按保存就把动作抹了:draft↔spec 是白名单重建,不认的字段一进一出即蒸发)。 */
export function hasUnsupportedParts(t?: MuseTriggerInfo): boolean {
  if (!t) return false
  if (t.actions?.some((a) => !isEditableStep(a) || hasUnknownKeys(a, KNOWN_ACTION_KEYS[a.type]))) return true
  const cond = t.cond as { type?: string } | undefined
  if (!cond || typeof cond !== 'object') return false
  // 新触发源统一是 { type, params }:表单按注册表的参数表出,任何插件源都编辑得了。
  const known = isParamCond(cond) ? ['type', 'params'] : KNOWN_COND_KEYS[String(cond.type)]
  return !known || hasUnknownKeys(cond, known)
}

/** 新触发源(电脑上 / 日历 / 插件),对应的表单是通用参数表。 */
export const isParamCond = (cond: { type?: string } | undefined): boolean => /\.|^plugin:/.test(String(cond?.type ?? ''))

let stepKey = 1
export const blankStep = (type: StepDraft['type']): StepDraft => ({
  key: stepKey++, type, title: '', body: '', agentSlug: '', prompt: '', tool: '', argValues: {},
  dbPath: '', rowId: '', rowFrom: '', matchColumn: '', matchValue: '', skipIfEmpty: '', cells: [{ k: '', v: '' }],
})

/** editing → 表单初值(旧式 agentSlug 规则转成一个 agent_run 步骤)。 */
export function stepsFrom(editing?: MuseTriggerInfo): StepDraft[] {
  if (editing?.actions?.length) {
    return editing.actions.filter(isEditableStep).map((a) => ({
      ...blankStep(a.type as StepDraft['type']),
      title: a.type === 'notify' || a.type === 'remind' ? a.title : '',
      body: a.type === 'notify' || a.type === 'remind' ? a.body || '' : '',
      agentSlug: a.type === 'agent_run' ? a.agentSlug : '',
      prompt: a.type === 'agent_run' ? a.prompt : '',
      tool: a.type === 'tool_call' ? a.tool : '',
      argValues: a.type === 'tool_call'
        ? Object.fromEntries(Object.entries(a.args || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
        : {},
      dbPath: a.type === 'db_row_add' || a.type === 'db_row_edit' ? a.path : '',
      rowId: a.type === 'db_row_edit' ? a.rowId || '' : '',
      rowFrom: a.type === 'db_row_edit' ? a.rowFrom || '' : '',
      matchColumn: a.type === 'db_row_edit' ? a.match?.column || '' : '',
      matchValue: a.type === 'db_row_edit' ? a.match?.value || '' : '',
      skipIfEmpty: a.type === 'db_row_add' ? a.skipIfEmpty || '' : '',
      cells: a.type === 'db_row_add' || a.type === 'db_row_edit'
        ? [...Object.entries(a.cells || {}).map(([k, v]) => ({ k, v })), { k: '', v: '' }]
        : [{ k: '', v: '' }],
    }))
  }
  if (editing?.agentSlug) return [{ ...blankStep('agent_run'), agentSlug: editing.agentSlug, prompt: editing.prompt || '' }]
  return []
}

/** 参数原始输入 → 工具 args(按 schema 类型转换;空值省略;非原语字段尝试 JSON)。 */
export function buildToolArgs(cat: AutomationActionCatalogItem | undefined, vals: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const props = cat?.parameters?.properties || {}
  for (const [k, raw] of Object.entries(vals)) {
    if (raw === undefined || raw === '') continue
    const ty = props[k]?.type
    if (ty === 'number') out[k] = Number(raw)
    else if (ty === 'boolean') out[k] = raw === 'true'
    else if (ty === 'string' || ty === undefined) out[k] = raw
    else { try { out[k] = JSON.parse(raw) } catch { out[k] = raw } }
  }
  return out
}

const cellsOf = (s: StepDraft): Record<string, string> =>
  Object.fromEntries(s.cells.filter((c) => c.k.trim()).map((c) => [c.k.trim(), c.v]))

/** 表单步骤 → 动作链 spec(保存回写口)。可选字段**有值才带键**(空串=没填=不带,与引擎存盘形状一致,
 *  往返测试才能用 toEqual 钉「一个不丢」)。match.value 不 trim(可能是纯模板,与 cells 值口径一致)。 */
export function toSpec(steps: StepDraft[], catalog: AutomationActionCatalogItem[]): AutomationActionSpec[] {
  return steps.map((s): AutomationActionSpec => {
    if (s.type === 'notify' || s.type === 'remind') return { type: s.type, title: s.title.trim(), ...(s.body.trim() ? { body: s.body.trim() } : {}) }
    if (s.type === 'agent_run') return { type: 'agent_run', agentSlug: s.agentSlug, prompt: s.prompt.trim() }
    if (s.type === 'db_row_add') {
      return { type: 'db_row_add', path: s.dbPath.trim(), cells: cellsOf(s), ...(s.skipIfEmpty.trim() ? { skipIfEmpty: s.skipIfEmpty.trim() } : {}) }
    }
    if (s.type === 'db_row_edit') {
      return {
        type: 'db_row_edit',
        path: s.dbPath.trim(),
        ...(s.rowId.trim() ? { rowId: s.rowId.trim() } : {}),
        ...(s.rowFrom.trim() ? { rowFrom: s.rowFrom.trim() } : {}),
        ...(s.matchColumn.trim() ? { match: { column: s.matchColumn.trim(), value: s.matchValue } } : {}),
        cells: cellsOf(s),
      }
    }
    return { type: 'tool_call', tool: s.tool, args: buildToolArgs(catalog.find((c) => c.name === s.tool), s.argValues) }
  })
}

/** cond.where → 表单行(只在 db_changed 下有)。 */
export function whereDraftFrom(cond: MuseTriggerInfo['cond'] | undefined): WhereDraft[] {
  if (cond?.type !== 'db_changed') return []
  return (cond.where || []).map((w) => ({ column: w.column, op: w.op, value: w.value || '' }))
}

/** 表单行 → upsert 的 where:丢掉没选列的行;empty/notempty 不带 value;**空数组给 undefined**
 *  (发 [] 引擎按 JSON 比对认为 cond 变了 → 每次保存都重置游标/冷却)。 */
export function whereToUpsert(rows: WhereDraft[]): AutomationWhere[] | undefined {
  const out = rows
    .filter((w) => w.column.trim())
    .map((w): AutomationWhere => ({ column: w.column.trim(), op: w.op, ...(w.op === 'eq' || w.op === 'ne' ? { value: w.value } : {}) }))
  return out.length ? out : undefined
}

/** 冷却输入框初值:服务端存的 0 必须显示成 '0'(`|| 24` 会把 ERP 那类 0 冷却规则改成 24h)。
 *  新建规则按触发类型给默认:db_changed 起 '0'(引擎对纯动作链的默认;不然手建「订单新增→通知」
 *  会静默变成一天一次),新触发源用注册表的缺省,其余 '24'。 */
export const initialCooldown = (editing?: Pick<MuseTriggerInfo, 'cooldownHours'> | null, kind?: string, sourceDefault?: number): string =>
  editing ? String(editing.cooldownHours ?? 24) : kind === 'db_changed' ? '0' : String(sourceDefault ?? 24)

/** 冷却输入 → upsert 的 cooldown_hours:timer/manual 没有冷却;其余 ≥0 的有限数原样送(**0 放行**,
 *  db_changed 纯动作链 0 = 不冷却;引擎对别的触发类型自己抬下限),非法输入不送=引擎默认。 */
export function cooldownPayload(kind: string, raw: string): number | undefined {
  if (kind === 'timer' || kind === 'manual') return undefined
  const n = Number(raw)
  return raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : undefined
}

// ── 触发类型菜单 + 「只在」──────────────────────────────────────────────────────

export type TriggerMenuGroup = 'time' | 'computer' | 'forsion' | 'external'
/** 菜单一项:老类型指向构建器的专用表单(kind),新类型指向通用参数表(source)。 */
export interface TriggerMenuItem {
  id: string
  kind: 'timer' | 'event_seen' | 'file_chars_gte' | 'manual' | 'db_changed' | 'param'
  source?: TriggerSourceInfo
}

const LEGACY_KINDS: Record<string, TriggerMenuItem['kind']> = {
  daily_at: 'timer', at: 'timer', every: 'timer', event_seen: 'event_seen', file_chars_gte: 'file_chars_gte', manual: 'manual', db_changed: 'db_changed',
}
const LEGACY_MENU: Array<[TriggerMenuGroup, TriggerMenuItem]> = [
  ['time', { id: 'timer', kind: 'timer' }], ['time', { id: 'manual', kind: 'manual' }],
  ['forsion', { id: 'db_changed', kind: 'db_changed' }], ['forsion', { id: 'event_seen', kind: 'event_seen' }], ['forsion', { id: 'file_chars_gte', kind: 'file_chars_gte' }],
]

/** 注册表 → 菜单分组:定时三种合成一个「定时」(子模式在表单里),外部与插件并成一组。老引擎没有目录 → 老的五项。 */
export function triggerMenu(sources: TriggerSourceInfo[]): Array<{ group: TriggerMenuGroup; items: TriggerMenuItem[] }> {
  const groups: TriggerMenuGroup[] = ['time', 'computer', 'forsion', 'external']
  const entries: Array<[TriggerMenuGroup, TriggerMenuItem]> = sources.length ? [] : [...LEGACY_MENU]
  for (const s of sources) {
    const group: TriggerMenuGroup = s.group === 'plugin' ? 'external' : s.group
    const kind = LEGACY_KINDS[s.id]
    if (kind === 'timer') {
      if (!entries.some(([, i]) => i.kind === 'timer')) entries.push([group, { id: 'timer', kind }])
    } else {
      entries.push([group, { id: s.id, kind: kind ?? 'param', source: s }])
    }
  }
  return groups.map((group) => ({ group, items: entries.filter(([g]) => g === group).map(([, i]) => i) })).filter((g) => g.items.length)
}

/** 表单态的「只在」(全字符串;小时空 = 全天)。 */
export interface OnlyDraft { start: string; end: string; weekdays: number[]; maxPerDay: string }

export const onlyDraftFrom = (t?: Pick<MuseTriggerInfo, 'only' | 'maxPerDay'>): OnlyDraft => ({
  start: t?.only?.hours ? String(t.only.hours.start) : '',
  end: t?.only?.hours ? String(t.only.hours.end) : '',
  weekdays: t?.only?.weekdays ?? [],
  maxPerDay: t?.maxPerDay ? String(t.maxPerDay) : '',
})

const hourOk = (s: string): boolean => Number.isInteger(Number(s)) && Number(s) >= 0 && Number(s) <= 24

/** 小时要么都空要么都填对,每天次数要么空要么 1–50。 */
export function onlyDraftValid(d: OnlyDraft): boolean {
  const s = d.start.trim(); const e = d.end.trim()
  if (!!s !== !!e || (s && !(hourOk(s) && hourOk(e)))) return false
  const m = d.maxPerDay.trim()
  return !m || (Number.isInteger(Number(m)) && Number(m) >= 1 && Number(m) <= 50)
}

/** 表单 → upsert:全空发 null(显式清空),不发 undefined(那是「保留旧值」)。 */
export function onlyToUpsert(d: OnlyDraft): Pick<MuseTriggerUpsert, 'only' | 'max_per_day'> {
  const hours = d.start.trim() ? { start: Number(d.start), end: Number(d.end) } : undefined
  const weekdays = d.weekdays.length ? d.weekdays : undefined
  return { only: hours || weekdays ? { ...(hours ? { hours } : {}), ...(weekdays ? { weekdays } : {}) } : null, max_per_day: d.maxPerDay.trim() ? Number(d.maxPerDay) : null }
}

const sameDays = (a: number[], b: number[]): boolean => a.length === b.length && a.every((d, i) => d === b[i])
export const WEEKDAYS = [1, 2, 3, 4, 5]
export const WEEKEND = [0, 6]

/** 「只在」的白话(详情页、Muse 右栏、规则卡共用)。 */
export function onlyText(t: T, r: Pick<MuseTriggerInfo, 'only' | 'maxPerDay' | 'cooldownHours'>, withCooldown = false): string {
  const days = r.only?.weekdays ?? []
  const parts: string[] = []
  if (days.length) parts.push(sameDays(days, WEEKDAYS) ? t('automation.only.workdays') : sameDays(days, WEEKEND) ? t('automation.only.weekend') : days.map((d) => t(`automation.only.day${d}`)).join(' '))
  if (r.only?.hours) parts.push(`${String(r.only.hours.start).padStart(2, '0')}:00–${String(r.only.hours.end).padStart(2, '0')}:00`)
  if (r.maxPerDay) parts.push(t('automation.only.maxPerDay', { n: String(r.maxPerDay) }))
  if (withCooldown && r.cooldownHours > 0) parts.push(t('automation.only.cooldown', { n: String(r.cooldownHours) }))
  return parts.join(' · ')
}

/** 下次心跳(ms):Muse 自己定的休眠优先;没开心跳 / 没记录 → null。 */
export function nextHeartbeatAt(s: { sleepUntil?: number | null; lastCycleAt?: number | null; heartbeatMinutes?: number } | null, now = Date.now()): number | null {
  if (!s) return null
  if (s.sleepUntil && s.sleepUntil > now) return s.sleepUntil
  if (!s.heartbeatMinutes || !s.lastCycleAt) return null
  return Math.max(now, s.lastCycleAt + s.heartbeatMinutes * 60_000)
}
