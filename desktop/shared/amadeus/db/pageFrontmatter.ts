/** 「笔记视图」(Bases 式)的纯逻辑:单元格 ↔ 笔记 frontmatter 的读写与类型折算。
 *  刻意不碰 compiler「神圣内核」——只做外科式 frontmatter 改写:amadeus_* 保留行原样保留
 *  (尤其 amadeus_layout 的单行 JSON 绝不过 YAML 往返,否则重排即损坏布局),正文字节级不动;
 *  仅合并/删除外来键。
 *  **行级**(D-20,评审 2026-09-27):只重写被 patch 的那几个顶层条目,其余行(注释、引号、`007`、`1.10`、
 *  20 位整数、`0x1F`、块状多行值、flow 写法、键序)逐字。旧版 parse 后整块 stringify,改一个键就把别的键改值。 */
import { Document, isMap, isSeq, parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { AMADEUS_FM_KEY, BOM, fmEntries } from '../compiler/split'
import { PAGE_NAME_KEY, type CellValue, type ColumnType, type DbColumn } from './schema'

// 口径与 compiler/split.ts stripFrontmatter 恒一致(空 fm 合法 + 收尾栅栏独占一行,Codex P0);
// 文件头 BOM 由 setFmExtraOnSource 先摘掉再匹配(D-01),所以这里不写 `\uFEFF?`。
const FM_BLOCK_RE = /^---\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/

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

// ── 行级 YAML 外科(D-20)──────────────────────────────────────────────────────────────────────────
// 按顶层条目(split.ts fmEntries:键行 + 缩进续行 / 顶格序列项 / flow 收尾,V-01)定位被改的键,只换那一组行。
// 认不出的键写法(复杂键 `? k`、锚点键、合并键 `<<`)一律当「别的条目」原样留着;事后按「原值 + patch」解析核对,
// 对不上(比如认不出的写法里恰好就是要改的键,追加成了重复键)→ 调用方退回整块重排(语义对、格式丢,即旧行为)。

/** 条目首行 → 键(`key:` / `"key":` / `'key':`,冒号后须是空白或行尾)与键在行首的原文 token;认不出 → null。 */
function entryKey(line: string): { key: string; token: string } | null {
  let m = /^("(?:[^"\\]|\\.)*")[ \t]*:(?=[ \t]|$)/.exec(line)
  if (m) {
    try { return { key: JSON.parse(m[1]) as string, token: m[1] } } catch { return null }
  }
  m = /^('(?:[^']|'')*')[ \t]*:(?=[ \t]|$)/.exec(line)
  if (m) return { key: m[1].slice(1, -1).replace(/''/g, "'"), token: m[1] }
  if (/^(?:[?:,[\]{}#&*!|>'"%@`]|-[ \t]|-$)/.test(line)) return null
  m = /^(.+?)[ \t]*:(?=[ \t]|$)/.exec(line)
  return m ? { key: m[1], token: m[1] } : null
}

/** 发射一个条目(`key: value` 的若干行)。flow:原值是单行 `[…]` / `{…}` 写法 → 新值也写成 flow,不无端改形。
 *  lineWidth 0 = 长字符串不折行(折行会把一行值拆成多行,又是一次无谓改形)。 */
function emitEntry(key: string, value: unknown, flow: boolean): string[] {
  const doc = new Document({ [key]: value })
  if (flow) {
    const n = doc.get(key, true)
    if (isSeq(n) || isMap(n)) n.flow = true
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false }).replace(/\n+$/, '').split('\n')
}

type LineEdit = { set: Record<string, unknown> } | { rename: { from: string; to: string } }

/** 在 YAML 映射文本上做行级改写,返回新文本(行尾口径:原文含 CRLF 则全用 CRLF,结尾换行有无照旧)。
 *  current = 原文解析结果(可缺):新值与现值相同的键整条逐字不动(`zip: 007` 被设成 7 仍是 `007`)。 */
function spliceYaml(text: string, edit: LineEdit, eolHint?: string, current?: Record<string, unknown>): string {
  const crlf = text ? text.includes('\r\n') : eolHint === '\r\n'
  const nl = text.endsWith('\n')
  const lines = text ? (nl ? text.slice(0, -1) : text).split('\n').map((l) => (crlf ? l.replace(/\r$/, '') : l)) : []
  const entries = fmEntries(lines)
  const out: string[] = []
  if ('rename' in edit) {
    const { from, to } = edit.rename
    const tok = entryKey(emitEntry(to, null, false)[0])?.token ?? to
    for (const e of entries) {
      const k = entryKey(e[0])
      out.push(...(k && k.key === from ? [tok + e[0].slice(k.token.length), ...e.slice(1)] : e))
    }
  } else {
    const done = new Set<string>()
    for (const e of entries) {
      const k = entryKey(e[0])
      if (!k || !Object.prototype.hasOwnProperty.call(edit.set, k.key)) { out.push(...e); continue }
      const v = edit.set[k.key]
      if (v === undefined || done.has(k.key)) continue // 删键 / 同名的后续条目(本就是坏 YAML)一并摘掉
      done.add(k.key)
      if (current && Object.prototype.hasOwnProperty.call(current, k.key) && sameValue(current[k.key], v)) { out.push(...e); continue }
      const emitted = emitEntry(k.key, v, e.length === 1 && /^[[{]/.test(e[0].slice(k.token.length).replace(/^[ \t]*:[ \t]*/, '')))
      const et = entryKey(emitted[0])
      // 键原本带引号(`"title":`)→ 沿用原 token,只换值
      if (et && et.token !== k.token) emitted[0] = k.token + emitted[0].slice(et.token.length)
      out.push(...emitted)
    }
    for (const [key, v] of Object.entries(edit.set)) if (v !== undefined && !done.has(key)) out.push(...emitEntry(key, v, false))
  }
  const eol = crlf ? '\r\n' : '\n'
  return out.length ? out.join(eol) + (nl || !text ? eol : '') : ''
}

/** 解析成映射对象;空 = {};不是映射 / 解析失败 = null。 */
function parseMap(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {}
  try {
    const v: unknown = parseYaml(text)
    if (v == null) return {}
    return typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  }
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k)
    && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** 按「原值 + 改动」应该得到的对象(核对用;rename 保留原位置不重要,比较不看键序)。 */
function expectedAfter(obj: Record<string, unknown>, edit: LineEdit): Record<string, unknown> {
  const out = { ...obj }
  if ('rename' in edit) {
    if (Object.prototype.hasOwnProperty.call(out, edit.rename.from)) {
      out[edit.rename.to] = out[edit.rename.from]
      delete out[edit.rename.from]
    }
    return out
  }
  for (const [k, v] of Object.entries(edit.set)) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return out
}

/** 行级改写 + 解析核对:原文是合法映射且结果对得上 → 行级结果;对不上 → 整块重排(语义正确的旧路径);
 *  原文不是合法映射 → null(调用方决定:内存路径拒改,外科路径照行级写)。 */
function editYamlVerified(text: string, edit: LineEdit, eolHint?: string): string | null {
  const before = parseMap(text)
  if (!before) return null
  const want = expectedAfter(before, edit)
  const out = spliceYaml(text, edit, eolHint, before)
  const after = parseMap(out)
  if (after && sameValue(after, want)) return out
  console.warn('[amadeus] line-level frontmatter edit did not verify; rewriting the block')
  return Object.keys(want).length ? stringifyYaml(want).replace(/\n+$/, '') + (text.endsWith('\n') ? '\n' : '') : ''
}

/** 属性面板 / 内存 fmExtra:改若干顶层键(值 undefined = 删),其余行逐字。非法 YAML → null。 */
export function patchYamlText(text: string, patch: Record<string, unknown>): string | null {
  return editYamlVerified(text, { set: patch })
}

/** 属性面板改键名:只换那一行的键 token,值与其余行逐字。非法 YAML → null;from 不在 → 原样。 */
export function renameYamlKey(text: string, from: string, to: string): string | null {
  return editYamlVerified(text, { rename: { from, to } })
}

/** 外科式合并:在 raw(一个 .md 源)的 frontmatter 里写入 patch 的键(值 = undefined 即删该键),
 *  保留 amadeus_* 行与正文原样,返回新的 .md 源。无 frontmatter 时按需前置一个块。
 *  行级(D-20):fm 块里只有被 patch 的条目改动,栅栏、保留行、别的键、注释逐字。 */
export function setFmExtraOnSource(raw: string, patch: Record<string, unknown>): string {
  // 文件头 BOM(D-01)先摘下、结果里原样放回字节 0:不摘则 fm 块认不出,会在 `\uFEFF---…` 前面
  // 再叠一个新 fm 块,旧那块沦为正文(编辑器里显示成水平线 + setext 标题,下一次保存即毁)。
  const bom = raw.startsWith(BOM) ? BOM : ''
  return bom + setFmExtraOnBomless(raw.slice(bom.length), patch)
}

function setFmExtraOnBomless(raw: string, patch: Record<string, unknown>): string {
  const m = FM_BLOCK_RE.exec(raw)
  const inner = m?.[1] ?? '' // 空 fm 块时捕获组缺席
  const body = m ? raw.slice(m[0].length) : raw
  // 绝不让列名劫持 amadeus_* 保留键(保留行因此永远不在改写范围里,块状写法的续行也跟着条目原样留着,V-01)
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (!isReserved(k)) clean[k] = v
  const eol = m && m[0].startsWith('---\r\n') ? '\r\n' : '\n'
  // 行级改写。整块解析得了 → 事后核对,对不上 → 退回旧的「保留行原样 + 外来区重排」(**绝不**整块重排:保留行的
  // 单行 JSON 过 YAML 往返就被改成块状);解析不了(本就坏的 YAML)→ 行级结果照写:只动被改的那个条目,别的行一概不碰
  // (旧版把解析失败折算成 {},改一个单元格就抹掉全部外来键)。
  const before = parseMap(inner)
  let next = spliceYaml(inner, { set: clean }, eol, before ?? undefined)
  if (before) {
    const after = parseMap(next)
    if (!after || !sameValue(after, expectedAfter(before, { set: clean }))) {
      console.warn('[amadeus] line-level frontmatter edit did not verify; regrouping the foreign keys')
      next = regroupForeign(inner, clean)
    }
  }
  // 无保留键、无外来键(只剩空行)→ 不留空 frontmatter 块
  if (!next.trim()) return m ? body.replace(/^\r?\n/, '') : raw
  if (!next.endsWith('\n')) next += eol
  if (m) {
    const open = m[0].indexOf('\n') + 1 // 开栏 `---` 行原样(含 CRLF),收栏行与正文原样拼回
    return raw.slice(0, open) + next + raw.slice(open + inner.length)
  }
  const fmBlock = `---\n${next}---`
  return body ? `${fmBlock}\n\n${body}` : `${fmBlock}\n`
}

/** 旧路径(行级核对不过时的兜底):保留行按条目原样置顶,外来区解析 → 合并 patch → 重排。 */
function regroupForeign(inner: string, patch: Record<string, unknown>): string {
  const amadeusLines: string[] = []
  const foreignLines: string[] = []
  // 按条目分(V-01):块状写法的 amadeus_* 值连同缩进续行整组留在保留区。逐行分会把续行塞进外来区 →
  // 外来 YAML 解析失败被折算成 {} → 改一个单元格就同时抹掉画布/分栏几何与全部外来键。
  for (const entry of fmEntries(inner.split('\n'))) {
    if (AMADEUS_FM_KEY.test(entry[0])) amadeusLines.push(...entry)
    else foreignLines.push(...entry)
  }
  const foreign = safeParseObj(foreignLines.join('\n'))
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete foreign[k]
    else foreign[k] = v
  }
  const foreignYaml = Object.keys(foreign).length ? stringifyYaml(foreign).replace(/\n+$/, '') : ''
  const lines = [...amadeusLines, ...(foreignYaml ? [foreignYaml] : [])]
  return lines.length ? `${lines.join('\n')}\n` : ''
}

/** 在 fmExtra(manifest 里的外来 frontmatter 文本)上应用 patch(值 = undefined 删键),返回新文本。
 *  与 setFmExtraOnSource 同一套行级改写;区别:fmExtra 非空但 YAML 解析失败 → 返回 null
 *  拒改(内存路径守住用户手写内容;外科路径在坏 YAML 上仍只动被改的条目,两者不对称是有意的)。 */
export function patchFmExtraText(fmExtra: string, patch: Record<string, unknown>): string | null {
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (!isReserved(k)) clean[k] = v
  const out = patchYamlText(fmExtra, clean)
  return out == null ? null : out.replace(/\r?\n+$/, '')
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
