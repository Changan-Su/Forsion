/** 日历设置随账号走的那份文件(引擎家目录 human/Settings/calendar.db,云端 __human__ 槽位同名)的纯函数层:
 *  文档 ↔ 设置的互转、单项改动(op)、按 k 定的行 id。没有 IO、没有 store,两台「设备」在单测里各起一份也互不干扰。
 *
 *  文件是 DbFile 形状:两列 k / v,一行 = 一项设置。k = `<库键>|<字段>|<来源键>`(库键这一期只有 `sync`),
 *  v = 值(字符串;结构化的值是 JSON 串)。删一项 = 删那一行。行 id = 's' + sha1(k) 前 16 位 —— 两台设备给同一项设置
 *  算出同一个行 id,同步层按行三方合并才对得上。认不出的行(别的字段 / 别的库键 / 以后的版本写的)原样留着,不许丢。 */
import type { DbFile, DbRow } from '@amadeus-shared/db/schema'
import { sha1Hex } from '@amadeus-shared/sha1'

/** 日历成员的列映射:哪一列是日期锚点(必)、哪一列是完成/待办勾选(可选)。 */
export interface CalMember {
  dateCol: string
  checkboxCol?: string
}
export interface VaultCfg {
  colors: Record<string, string> // dbPath → 用户手选的颜色(优先;自动定色永不改写它)
  /** 来源路径 → 自动定下的调色板色:一个来源第一次出现时定一次,之后顺序怎么变都不动;来源移除后也留着(加回来还是原来的色)。
   *  键 = 来源自己的路径(表的库内路径 / `human://…` / `agent://…` / `otherside:…` / `ics://<id>` / `mdnote://…`)。
   *  没有这个键 = 这个库还没播种:播种那一次按老规则(排第几个取第几个色)存下当时的一整列,保证升级前后颜色不变。 */
  autoColors?: Record<string, string>
  hidden: string[] // 隐藏的 dbPath
  defaultDbPath: string | null // 新建事件落入
  members: Record<string, CalMember> // dbPath → 列映射;有键 = 「在日历中」(显式成员制)
  migrated?: boolean // 旧「有 calendarDate 列即入历」数据一次性迁移完成;之后成员全靠显式增删
  /** 这份本机镜像属于哪个账号(只在随账号走的库上有):换账号后上一个账号的本机设置不合进新账号的共享文件。
   *  没有 = 升级前的老数据,算当前账号的。 */
  owner?: string
}

export const LIB_SYNC = 'sync'
export const SETTINGS_DOC_NAME = 'calendar-settings'
export type SettingField = 'member' | 'color' | 'auto' | 'hidden' | 'default' | 'migrated' | 'seeded'

export const settingKey = (field: SettingField, src = ''): string => `${LIB_SYNC}|${field}|${src}`
/** 只按前两个 `|` 切:来源键(文件名)里可以有 `|`。 */
export function parseSettingKey(k: string): { lib: string; field: string; src: string } | null {
  const i = k.indexOf('|')
  const j = i < 0 ? -1 : k.indexOf('|', i + 1)
  if (i < 0 || j < 0) return null
  return { lib: k.slice(0, i), field: k.slice(i + 1, j), src: k.slice(j + 1) }
}
export const rowIdOf = (k: string): string => `s${sha1Hex(k).slice(0, 16)}`

/** 能跨设备的来源键:库内相对路径(`/` 分隔)、`human://`、`agent://`、`mdnote://`。
 *  `otherside:<另一侧的绝对根>/…`、`ics://<id>`(订阅 id 各设备不同)以及别的 scheme、绝对路径、带反斜杠的一律留本机。 */
export function isPortableSource(p: string): boolean {
  if (!p) return false
  if (/^(?:human|agent|mdnote):\/\//i.test(p)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return false // 别的 scheme(otherside: / ics:// / …)、Windows 盘符
  if (p.startsWith('/') || p.includes('\\')) return false
  return true
}

export function emptySettingsDoc(): DbFile {
  return {
    version: 2,
    name: SETTINGS_DOC_NAME,
    columns: [{ id: 'k', name: 'key', type: 'text' }, { id: 'v', name: 'value', type: 'text' }],
    rows: [],
  }
}

/** 单项改动。set / del = 用户手势(覆盖);setIfAbsent = 自动的(迁移、定色播种、插件 ensureMember、第一次合并):
 *  共享里已经有这一项就不动 —— 两台设备同时播种也只会有一个赢家,不会来回跳。三种都按 k 幂等,重放多少次结果一样。 */
export type SettingOp =
  | { t: 'set'; k: string; v: string }
  | { t: 'setIfAbsent'; k: string; v: string }
  | { t: 'del'; k: string }

const keyOfRow = (r: DbRow): string | null => (typeof r?.cells?.k === 'string' ? (r.cells.k as string) : null)

/** 把改动按顺序放到文档上。不改入参;认不出的行、行里别的格子、文档别的顶层字段原样带着。 */
export function applySettingOps(doc: DbFile, ops: readonly SettingOp[]): DbFile {
  if (!ops.length) return doc
  let rows = [...doc.rows]
  for (const op of ops) {
    const at = rows.findIndex((r) => keyOfRow(r) === op.k)
    if (op.t === 'del') {
      if (at >= 0) rows = rows.filter((r) => keyOfRow(r) !== op.k)
      continue
    }
    if (at >= 0) {
      if (op.t === 'setIfAbsent') continue
      const cur = rows[at]
      if (cur.cells.v === op.v) continue
      rows[at] = { ...cur, cells: { ...cur.cells, v: op.v } }
      continue
    }
    rows.push({ id: rowIdOf(op.k), cells: { k: op.k, v: op.v } })
  }
  const columns = [...doc.columns]
  if (!columns.some((c) => c.id === 'k')) columns.push({ id: 'k', name: 'key', type: 'text' })
  if (!columns.some((c) => c.id === 'v')) columns.push({ id: 'v', name: 'value', type: 'text' })
  return { ...doc, columns, rows }
}

/** 两份文档的设置内容一样(按 k → v 比,不管行序):一样就不用写。 */
export function sameSettings(a: DbFile, b: DbFile): boolean {
  const m = (d: DbFile): Map<string, unknown> => new Map(d.rows.map((r) => [String(keyOfRow(r) ?? `#${r.id}`), r.cells.v]))
  const x = m(a), y = m(b)
  if (x.size !== y.size) return false
  for (const [k, v] of x) if (!y.has(k) || y.get(k) !== v) return false
  return a.columns.some((c) => c.id === 'k') === b.columns.some((c) => c.id === 'k')
}

const parseMember = (v: string): CalMember | null => {
  try {
    const o = JSON.parse(v) as { dateCol?: unknown; checkboxCol?: unknown }
    if (!o || typeof o.dateCol !== 'string' || !o.dateCol) return null
    return typeof o.checkboxCol === 'string' && o.checkboxCol ? { dateCol: o.dateCol, checkboxCol: o.checkboxCol } : { dateCol: o.dateCol }
  } catch {
    return null
  }
}
const memberValue = (m: CalMember): string => JSON.stringify(m.checkboxCol ? { dateCol: m.dateCol, checkboxCol: m.checkboxCol } : { dateCol: m.dateCol })
const TRUE = 'true'
const isTrue = (v: string): boolean => v !== 'false' && v !== '0' && v !== ''

/** 文档 → 设置(只含 `sync|…` 那些认得出的行)。值形状不对的行在这里跳过,但仍留在文档里。 */
export function docToVaultCfg(doc: DbFile): VaultCfg {
  const out: VaultCfg = { colors: {}, hidden: [], defaultDbPath: null, members: {} }
  let auto: Record<string, string> | undefined
  for (const r of doc.rows) {
    const k = keyOfRow(r)
    const v = r?.cells?.v
    if (!k || typeof v !== 'string') continue
    const p = parseSettingKey(k)
    if (!p || p.lib !== LIB_SYNC) continue
    switch (p.field) {
      case 'member': { const m = p.src ? parseMember(v) : null; if (m) out.members[p.src] = m; break }
      case 'color': if (p.src && v) out.colors[p.src] = v; break
      case 'auto': if (p.src && v) (auto ??= {})[p.src] = v; break
      case 'hidden': if (p.src && isTrue(v) && !out.hidden.includes(p.src)) out.hidden.push(p.src); break
      case 'default': if (v) out.defaultDbPath = v; break
      case 'migrated': if (isTrue(v)) out.migrated = true; break
      case 'seeded': if (isTrue(v)) auto ??= {}; break
    }
  }
  if (auto) out.autoColors = auto
  return out
}

/** 一份设置里能进共享文件的那些项,按 k → v 列出(不可移植的来源键不在里面)。 */
export function vaultCfgEntries(vc: VaultCfg): Map<string, string> {
  const out = new Map<string, string>()
  for (const [p, m] of Object.entries(vc.members ?? {})) if (isPortableSource(p) && m?.dateCol) out.set(settingKey('member', p), memberValue(m))
  for (const [p, c] of Object.entries(vc.colors ?? {})) if (isPortableSource(p) && typeof c === 'string' && c) out.set(settingKey('color', p), c)
  for (const [p, c] of Object.entries(vc.autoColors ?? {})) if (isPortableSource(p) && typeof c === 'string' && c) out.set(settingKey('auto', p), c)
  if (vc.autoColors) out.set(settingKey('seeded'), TRUE)
  for (const p of vc.hidden ?? []) if (isPortableSource(p)) out.set(settingKey('hidden', p), TRUE)
  if (vc.defaultDbPath && isPortableSource(vc.defaultDbPath)) out.set(settingKey('default'), vc.defaultDbPath)
  if (vc.migrated) out.set(settingKey('migrated'), TRUE)
  return out
}

/** 前后两份设置的差 → 单项改动。auto = 这次是自动的写(迁移 / 定色 / ensureMember):只补、不删、不覆盖。 */
export function diffVaultCfg(prev: VaultCfg | undefined, next: VaultCfg, auto: boolean): SettingOp[] {
  const a = prev ? vaultCfgEntries(prev) : new Map<string, string>()
  const b = vaultCfgEntries(next)
  const ops: SettingOp[] = []
  for (const [k, v] of b) if (a.get(k) !== v) ops.push(auto ? { t: 'setIfAbsent', k, v } : { t: 'set', k, v })
  // 缺省表换成了不可移植的(另一侧库的表):那是这台的事,不删共享里别的设备在用的缺省表
  const localOnlyDefault = !!next.defaultDbPath && !isPortableSource(next.defaultDbPath)
  if (!auto) for (const k of a.keys()) if (!b.has(k) && !(localOnlyDefault && k === settingKey('default'))) ops.push({ t: 'del', k })
  return ops
}

/** 第一次合并时本机这份的贡献:每一项都是 setIfAbsent —— 共享里已有的值不覆盖,只补共享没有的。
 *  成员按路径并集(同路径列映射不同用共享的)、颜色只补、隐藏并集、缺省表共享有值用共享的、已迁移 / 已播种取或,都由此得出。 */
export const mergeContribution = (local: VaultCfg): SettingOp[] =>
  [...vaultCfgEntries(local)].map(([k, v]) => ({ t: 'setIfAbsent', k, v }))

/** 共享那份投到内存:可移植的项取共享的;本机独有的(`otherside:`、`ics://` 等不可移植的来源键)从本机这份叠回来。 */
export function projectShared(shared: VaultCfg, local: VaultCfg | undefined, owner: string): VaultCfg {
  const keep = <T>(o: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([p]) => !isPortableSource(p)))
  const localAuto = keep(local?.autoColors)
  const auto = shared.autoColors || Object.keys(localAuto).length ? { ...shared.autoColors, ...localAuto } : undefined
  const localDefault = local?.defaultDbPath && !isPortableSource(local.defaultDbPath) ? local.defaultDbPath : null
  return {
    colors: { ...shared.colors, ...keep(local?.colors) },
    ...(auto ? { autoColors: auto } : {}),
    hidden: [...shared.hidden, ...(local?.hidden ?? []).filter((p) => !isPortableSource(p) && !shared.hidden.includes(p))],
    defaultDbPath: localDefault ?? shared.defaultDbPath,
    members: { ...shared.members, ...keep(local?.members) },
    ...(shared.migrated ? { migrated: true } : {}),
    owner,
  }
}
