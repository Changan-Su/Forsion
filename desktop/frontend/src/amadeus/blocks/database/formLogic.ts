/** 表单视图(view.type='form')纯逻辑:字段集 / 空值判定 / 必填校验 / 提交前清洗。
 *  无 React、无 store —— FormBody 只是它的壳,规则改这里并过 formLogic.test.ts。 */
import type { CellValue, DbColumn, DbView } from '@amadeus-shared/db/schema'
import { isComputedCol } from './rowLink'
import { isStamped } from './propertyTypes'

/** 表单字段集 = columns 序 − view.hidden − 计算列(公式/引用,磁盘无值)− 盖章列(自动编号/创建时间,建行即定)。
 *  这是 required/defaults/desc 三张配置表的合法键域:指向域外的键一律被后面三个函数忽略。 */
export function formFields(columns: DbColumn[], view: Pick<DbView, 'hidden'>): DbColumn[] {
  const hidden = new Set(view.hidden ?? [])
  return columns.filter((c) => !hidden.has(c.id) && !isComputedCol(c.type) && !isStamped(c.type))
}

/** 「空」= 缺 / null / 空串 / 全空白串 / 空数组 / false(必填勾选 = 必须勾上)。0 不算空。 */
export function isBlank(v: CellValue | undefined): boolean {
  if (v == null || v === false) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  return false
}

/** 必填未填的字段(只看 fields 里的列:required 指向隐藏/已删/计算列的项不会把表单卡成永远提交不了)。 */
export function missingRequired(fields: DbColumn[], required: string[] | undefined, draft: Record<string, CellValue | undefined>): DbColumn[] {
  if (!required?.length) return []
  const req = new Set(required)
  return fields.filter((c) => req.has(c.id) && isBlank(draft[c.id]))
}

/** 提交前清洗:只保留字段集里的键,剥掉 undefined/null(cellValueSchema 没有 undefined 成员,漏一个 = 写盘被静默拒)。
 *  ⚠️ defaults 里混进的盖章列/计算列键也在这里剥:addRow 只保证盖章压最后,计算列键它不管,不剥就落盘破 E5。 */
export function cleanDraft(draft: Record<string, CellValue | undefined>, fields: DbColumn[]): Record<string, CellValue> {
  const allow = new Set(fields.map((c) => c.id))
  const out: Record<string, CellValue> = {}
  for (const [k, v] of Object.entries(draft)) if (allow.has(k) && v != null) out[k] = v
  return out
}

/** 打开表单 / 提交后清空时的初始草稿 = 清洗过的 defaults。 */
export const formDefaults = (view: Pick<DbView, 'form'>, fields: DbColumn[]): Record<string, CellValue> =>
  cleanDraft(view.form?.defaults ?? {}, fields)
