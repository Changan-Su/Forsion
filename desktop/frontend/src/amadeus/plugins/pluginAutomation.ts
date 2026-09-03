/**
 * `ctx.automation.ensure` 的纯逻辑(2026-09-02):插件规则 → 引擎 upsert 入参的构造、校验、路径归一。
 * 零 React / 零 store,宿主侧(pluginStore)只负责等后端与库就绪、逐条发、收 errors。
 *
 * 纪律:
 *  - id 由宿主拼 `plugin:<pluginId>:<key>`,key 限 `[a-z0-9-]+` —— 放行 `:` 就能拼出 `plugin:a:b:c` 伪装成别家规则;
 *  - `path` 归一与引擎 `normalizeVaultRel`(museTriggers.ts)**同口径**:ensure 每次 setup 都重放,path 差一个斜杠
 *    引擎就认为 cond 变了 → dropCursors 重新播种 → 期间新增的行永久丢;
 *  - `where: []` 一律不带键(同上:JSON 比对认为 cond 变了);
 *  - actions 只许 notify / db_row_add / db_row_edit(引擎路由对 plugin: 前缀同样兜底,这里先拒省一次 400);
 *  - 单条坏规则只拒那一条(errors 里带 key),其余照发;vault 空 / 后端超时是宿主层的整批拒,不在这里。
 */
import type { AutomationActionSpec, AutomationWhere, MuseTriggerUpsert } from '../../types'
import type { PluginAutomationRule } from './types'

export const PLUGIN_RULE_KEY_RE = /^[a-z0-9-]+$/
const WHERE_OPS: ReadonlySet<string> = new Set(['eq', 'ne', 'empty', 'notempty'])
const ALLOWED_ACTIONS: ReadonlySet<string> = new Set(['notify', 'db_row_add', 'db_row_edit'])
/** 引擎 MAX_ACTIONS(museTriggers.ts)同值;MAX_WHERE 同引擎 where 校验上限。 */
const MAX_ACTIONS = 24
const MAX_WHERE = 10

/** 库相对路径归一(镜像引擎 normalizeVaultRel):反斜杠→正斜杠、去首尾斜杠、折叠 //、丢 `.` 段。 */
export function normalizeVaultRel(raw: string): string {
  const parts = String(raw || '').trim().replace(/\\/g, '/').split('/')
  return parts.filter((seg) => seg !== '' && seg !== '.').join('/')
}

/** 本插件拥有的规则 id 前缀(禁用时按它过滤)。 */
export const pluginRulePrefix = (pluginId: string): string => `plugin:${pluginId}:`
export const isPluginOwnedRule = (pluginId: string, ruleId: string): boolean => ruleId.startsWith(pluginRulePrefix(pluginId))

export interface BuiltPluginUpserts {
  upserts: MuseTriggerUpsert[]
  errors: string[]
}

const isDbPath = (p: string): boolean => /\.db$/i.test(p) && !p.split('/').includes('..')

/** 一条动作的形状校验(只查宿主能看懂的部分;cells 值等细节交给引擎 parseActionsInput)。 */
function actionError(a: unknown, i: number): string | null {
  if (!a || typeof a !== 'object') return `actions[${i}] 不是对象`
  const t = String((a as { type?: unknown }).type ?? '')
  if (!ALLOWED_ACTIONS.has(t)) return `actions[${i}] 类型「${t || '?'}」不允许(插件规则只许 notify / db_row_add / db_row_edit)`
  if (t === 'notify') return String((a as { title?: unknown }).title ?? '').trim() ? null : `actions[${i}] notify 缺 title`
  const path = normalizeVaultRel(String((a as { path?: unknown }).path ?? ''))
  if (!isDbPath(path)) return `actions[${i}] path 必须是库内 .db 文件`
  const cells = (a as { cells?: unknown }).cells
  if (!cells || typeof cells !== 'object' || !Object.keys(cells as object).length) return `actions[${i}] cells 为空`
  if (t === 'db_row_add') {
    const k = (a as { skipIfEmpty?: unknown }).skipIfEmpty
    if (k !== undefined && !Object.hasOwn(cells as object, String(k))) return `actions[${i}] skipIfEmpty「${String(k)}」不在 cells 的键里`
  }
  if (t === 'db_row_edit') {
    const m = (a as { match?: unknown }).match
    if (m !== undefined && (!m || typeof m !== 'object' || !String((m as { column?: unknown }).column ?? '').trim())) return `actions[${i}] match.column 为空`
  }
  return null
}

/** 动作重建:只带引擎认的字段,path 归一(与 cond.path 同口径,避免同表两种写法)。 */
function rebuildAction(a: AutomationActionSpec): AutomationActionSpec {
  if (a.type === 'notify') return { type: 'notify', title: a.title.trim(), ...(a.body ? { body: a.body } : {}) }
  if (a.type === 'db_row_add') {
    return { type: 'db_row_add', path: normalizeVaultRel(a.path), cells: { ...a.cells }, ...(a.skipIfEmpty ? { skipIfEmpty: a.skipIfEmpty } : {}) }
  }
  if (a.type === 'db_row_edit') {
    return {
      type: 'db_row_edit',
      path: normalizeVaultRel(a.path),
      ...(a.rowId ? { rowId: a.rowId } : {}),
      ...(a.rowFrom ? { rowFrom: a.rowFrom } : {}),
      ...(a.match ? { match: { column: a.match.column, value: String(a.match.value ?? '') } } : {}),
      cells: { ...a.cells },
    }
  }
  return a
}

function whereError(w: unknown): string | null {
  if (w === undefined) return null
  if (!Array.isArray(w)) return 'where 必须是数组'
  if (w.length > MAX_WHERE) return `where 最多 ${MAX_WHERE} 条`
  for (const [i, c] of w.entries()) {
    if (!c || typeof c !== 'object') return `where[${i}] 不是对象`
    if (!String((c as { column?: unknown }).column ?? '').trim()) return `where[${i}].column 为空`
    if (!WHERE_OPS.has(String((c as { op?: unknown }).op ?? ''))) return `where[${i}].op 必须是 eq / ne / empty / notempty`
  }
  return null
}

/** 一条规则 → upsert 入参;坏规则返回 { error }。 */
export function buildPluginTriggerUpsert(pluginId: string, vault: string, rule: PluginAutomationRule): { upsert: MuseTriggerUpsert } | { error: string } {
  const key = String(rule?.key ?? '')
  const tag = `规则「${key || '?'}」`
  if (!PLUGIN_RULE_KEY_RE.test(key)) return { error: `${tag}:key 只能是 [a-z0-9-]+` }
  if (rule.cond_type !== 'db_changed') return { error: `${tag}:cond_type 只支持 db_changed` }
  const path = normalizeVaultRel(rule.path)
  if (!isDbPath(path)) return { error: `${tag}:path 必须是库内 .db 文件` }
  if (rule.event !== 'row_added' && rule.event !== 'cell_changed') return { error: `${tag}:event 必须是 row_added / cell_changed` }
  const columnId = String(rule.column_id ?? '').trim()
  if (rule.event === 'cell_changed' && !columnId) return { error: `${tag}:cell_changed 必须给 column_id` }
  const we = whereError(rule.where)
  if (we) return { error: `${tag}:${we}` }
  if (!Array.isArray(rule.actions) || !rule.actions.length) return { error: `${tag}:actions 不能为空` }
  if (rule.actions.length > MAX_ACTIONS) return { error: `${tag}:actions 最多 ${MAX_ACTIONS} 步` }
  for (const [i, a] of rule.actions.entries()) {
    const ae = actionError(a, i)
    if (ae) return { error: `${tag}:${ae}` }
  }
  const cd = rule.cooldown_hours
  if (cd !== undefined && !(Number.isFinite(cd) && cd >= 0)) return { error: `${tag}:cooldown_hours 必须是 ≥0 的数` }
  const where: AutomationWhere[] | undefined = rule.where?.length
    ? rule.where.map((w) => ({ column: w.column.trim(), op: w.op, ...(w.op === 'eq' || w.op === 'ne' ? { value: String(w.value ?? '') } : {}) }))
    : undefined
  const upsert: MuseTriggerUpsert = {
    id: `${pluginRulePrefix(pluginId)}${key}`,
    desc: String(rule.desc ?? '').trim() || key,
    cond_type: 'db_changed',
    path,
    event: rule.event,
    vault,
    ...(rule.event === 'cell_changed' ? { column_id: columnId } : {}),
    ...(rule.event === 'cell_changed' && String(rule.equals ?? '').trim() ? { equals: String(rule.equals).trim() } : {}),
    ...(where ? { where } : {}),
    actions: rule.actions.map(rebuildAction),
    ...(cd !== undefined ? { cooldown_hours: cd } : {}),
    enabled: true,
    // 幂等重放的自报家门:插件每次 setup 都把全部规则原样再发一遍,引擎据此拒绝把**它自己停用的**规则开回来。
    actor: 'plugin-ensure',
  }
  return { upsert }
}

/** 整批:坏的进 errors,好的进 upserts(宿主逐条发)。 */
export function buildPluginTriggerUpserts(pluginId: string, vault: string, rules: PluginAutomationRule[]): BuiltPluginUpserts {
  const out: BuiltPluginUpserts = { upserts: [], errors: [] }
  if (!Array.isArray(rules)) return { upserts: [], errors: ['rules 必须是数组'] }
  const seen = new Set<string>()
  for (const r of rules) {
    const b = buildPluginTriggerUpsert(pluginId, vault, r)
    if ('error' in b) { out.errors.push(b.error); continue }
    if (seen.has(b.upsert.id!)) { out.errors.push(`规则「${r.key}」:key 重复`); continue }
    seen.add(b.upsert.id!)
    out.upserts.push(b.upsert)
  }
  return out
}
