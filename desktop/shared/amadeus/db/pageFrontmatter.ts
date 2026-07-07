/** 「笔记视图」(Bases 式)的纯逻辑:单元格 ↔ 笔记 frontmatter 的读写与类型折算。
 *  刻意不碰 compiler「神圣内核」——只做外科式 frontmatter 改写:amadeus_* 保留行原样保留
 *  (尤其 amadeus_layout 的单行 JSON 绝不过 YAML 往返,否则重排即损坏布局),正文字节级不动;
 *  仅合并/删除外来键。 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { AMADEUS_FM_KEY } from '../compiler/split'
import { PAGE_NAME_KEY, type CellValue, type ColumnType, type DbColumn } from './schema'

const FM_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

const isReserved = (key: string): boolean => AMADEUS_FM_KEY.test(`${key}:`)

function safeParseObj(yamlStr: string): Record<string, unknown> {
  if (!yamlStr.trim()) return {}
  try {
    const v: unknown = parseYaml(yamlStr)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 解析笔记的外来 frontmatter 字符串(readPage 返回的 manifest.fmExtra)为对象。 */
export function parseFmObject(fmExtra: string): Record<string, unknown> {
  return safeParseObj(fmExtra)
}

/** 外科式合并:在 raw(一个 .md 源)的 frontmatter 里写入 patch 的键(值 = undefined 即删该键),
 *  保留 amadeus_* 行与正文原样,返回新的 .md 源。无 frontmatter 时按需前置一个块。 */
export function setFmExtraOnSource(raw: string, patch: Record<string, unknown>): string {
  const m = FM_BLOCK_RE.exec(raw)
  const inner = m ? m[1] : ''
  const body = m ? raw.slice(m[0].length) : raw

  const amadeusLines: string[] = []
  const foreignLines: string[] = []
  for (const line of inner.split('\n')) {
    if (AMADEUS_FM_KEY.test(line)) amadeusLines.push(line)
    else foreignLines.push(line)
  }

  const foreign = safeParseObj(foreignLines.join('\n'))
  for (const [k, v] of Object.entries(patch)) {
    if (isReserved(k)) continue // 绝不让列名劫持 amadeus_* 保留键
    if (v === undefined) delete foreign[k]
    else foreign[k] = v
  }

  const foreignYaml = Object.keys(foreign).length ? stringifyYaml(foreign).replace(/\n+$/, '') : ''

  // 无保留键、无外来键 → 不留空 frontmatter 块
  if (!amadeusLines.length && !foreignYaml) return m ? body.replace(/^\r?\n/, '') : raw

  const fmBlock = ['---', ...amadeusLines, ...(foreignYaml ? [foreignYaml] : []), '---'].join('\n')
  if (m) return `${fmBlock}\n${body}` // body 携带其原有的前导换行/内容,原样拼回
  return body ? `${fmBlock}\n\n${body}` : `${fmBlock}\n`
}

/** 导入/列发现:按一个 YAML frontmatter 值推断列类型。 */
export function inferColumnType(value: unknown): ColumnType {
  if (typeof value === 'boolean') return 'checkbox'
  if (Array.isArray(value)) return 'multiselect'
  if (typeof value === 'number' && Number.isFinite(value)) return 'number'
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date'
  return 'text'
}

/** 读:把一个 frontmatter 值折算成给定列类型的 CellValue(供表格显示/编辑)。 */
export function fmValueToCell(value: unknown, type: ColumnType): CellValue {
  switch (type) {
    case 'checkbox':
      return value === true
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string') {
        const n = Number.parseFloat(value)
        if (Number.isFinite(n)) return n
      }
      return null
    case 'multiselect':
      if (Array.isArray(value)) return value.map(String)
      return value == null || value === '' ? [] : [String(value)]
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
    default: // text / url / select / page
      if (value == null) return ''
      return Array.isArray(value) ? value.map(String).join(', ') : String(value)
  }
}

/** 写:把一行某列的 CellValue 折算成写进 frontmatter 的 YAML 值;空值返回 undefined(= 删该键,保持笔记干净)。 */
export function cellToFmValue(v: CellValue | undefined, type: ColumnType): unknown {
  switch (type) {
    case 'checkbox':
      return v === true ? true : undefined // 未勾选不写键(缺 key = false)
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined
    case 'multiselect':
      return Array.isArray(v) && v.length ? v : undefined
    case 'date':
      return typeof v === 'string' && v ? v : undefined
    default: {
      // text / url / select
      const s = typeof v === 'string' ? v : v == null ? '' : String(v)
      return s || undefined
    }
  }
}

/** 「笔记视图」列并集推导:保留现有列,把各笔记 frontmatter 里表格没有的键增量补为新列
 *  (类型按值推断,列 id = frontmatter 键 = 稳定身份);始终含 Page Name 身份列;
 *  select/multiselect 列的选项池并入观察到的值。 = 用户确认的「并集列」。 */
export function deriveColumns(existing: DbColumn[], fmList: Record<string, unknown>[]): DbColumn[] {
  const cols: DbColumn[] = existing.map((c) => ({ ...c, options: c.options ? [...c.options] : undefined }))
  const byId = new Map(cols.map((c) => [c.id, c] as const))
  if (!byId.has(PAGE_NAME_KEY)) {
    const pn: DbColumn = { id: PAGE_NAME_KEY, name: 'Page Name', type: 'page' }
    cols.unshift(pn)
    byId.set(PAGE_NAME_KEY, pn)
  }
  for (const fm of fmList) {
    for (const [k, val] of Object.entries(fm)) {
      if (k === PAGE_NAME_KEY || byId.has(k)) continue
      const c: DbColumn = { id: k, name: k, type: inferColumnType(val) }
      cols.push(c)
      byId.set(k, c)
    }
  }
  for (const c of cols) {
    if (c.type !== 'select' && c.type !== 'multiselect') continue
    const opts = new Set(c.options ?? [])
    for (const fm of fmList) {
      const val = fm[c.id]
      if (Array.isArray(val)) val.forEach((x) => opts.add(String(x)))
      else if (typeof val === 'string' && val) opts.add(val)
    }
    c.options = [...opts]
  }
  return cols
}
