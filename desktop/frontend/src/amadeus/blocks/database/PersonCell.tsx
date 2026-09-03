/** 人员属性(type='person',baseType=text):值 = 显示名(单机无账号体系,不硬造 user id)。
 *  Cell = 文本输入 + 候选下拉;候选来自**全库所有 person 列已用过的名字**(按出现次数排,同次按名),
 *  候选集合抽成纯函数 personCandidates 供测试/别处复用。
 *  ⚠️ 不 import dbAggregateStore:它 side-effect import 了 propertyTypes.builtins,会成环;这里直接读 useDbStore,
 *  打开下拉时按 dbAggregateStore 同款方式把 vault 里全部 .db 载进来(load 幂等,已载的零开销)。
 *
 *  跨库候选的开销纪律(2026-09-02,Codex 第二波评审 [medium]):
 *  - 拉库:只拉 store 里还没有的,并发封顶 4(见 pullVaultDbs);此前是聚焦一下就把全库无上限并发发出去。
 *  - 数名字:按 entries 对象身份备忘一格(personCountOf),下拉渲染与键盘处理共用;
 *  - 取前 8:O(n) 插入式选取(topByCount),不再排完整候选集。
 *  刻意**不**建增量人员索引:名字只在下拉打开的那一刻要,索引得跟着每次 mutate 维护,不划算。 */
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { DbColumn, DbFile } from '@amadeus-shared/db/schema'
import { useDbStore, type DbEntry } from '../../store/dbStore'
import { usePageStore } from '../../store/pageStore'
import { OverlayAt } from '../../lib/clampMenu'
import type { PropCellProps } from './propertyTypes'

/** ⚠️ 'person' 是发布出去的类型 id(存进 DbColumn.type,自动化「通知到人」将来点名认它),永不改名。 */
export const PERSON_TYPE = 'person'
export const isPersonCol = (c: Pick<DbColumn, 'type'>): boolean => c.type === PERSON_TYPE

const DB_RE = /\.db$/i

/** 已载入且完好的库(missing/corrupt/loading 不算)。
 *  ⚠️ entries 按 ref 原文键控,同一 .db 会以多个 ref(嵌入的 `![[…]]` 原文 / 本组件 load(p,p) 的 vault 路径)各占一条
 *  → 按解析后的 path 去重,先到先得(嵌入那条先进 store、且只有它在吃 mutate,是最新的);否则当前表的名字次数翻倍。 */
export const okDbs = (entries: Record<string, DbEntry>): DbFile[] => {
  const out: DbFile[] = []
  const seen = new Set<string>()
  for (const [ref, e] of Object.entries(entries)) {
    if (e.status !== 'ok' || !e.data) continue
    const key = e.path ?? ref
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e.data)
  }
  return out
}

/** 名字 → 出现次数:只数 person 列(同名的 text 列不算),只认非空字符串;trim 后去重。 */
export function countPersonNames(dbs: DbFile[]): Map<string, number> {
  const count = new Map<string, number>()
  for (const db of dbs) {
    const cols = db.columns.filter(isPersonCol)
    if (!cols.length) continue
    for (const r of db.rows) {
      for (const c of cols) {
        const v = r.cells[c.id]
        if (typeof v !== 'string') continue
        const name = v.trim()
        if (!name) continue
        count.set(name, (count.get(name) ?? 0) + 1)
      }
    }
  }
  return count
}

/** 取前 limit(次数多的在前,同次按名字 zh 序);query 非空时按大小写无关的子串过滤。
 *  ponytail: O(n·limit) 的插入式选取,**不整排** —— limit 恒是个位数,而全库不同名字可能上千
 *  (Codex 第二波评审 [medium]:「排序完整候选集后才截取 8 个」)。比较器在不同名字上是全序,
 *  所以并列次数下的先后只由名字定,与输入顺序无关(结果稳定)。 */
export function topByCount(count: Map<string, number>, query = '', limit = 8): string[] {
  if (limit <= 0) return []
  const q = query.trim().toLowerCase()
  const ahead = (a: [string, number], b: [string, number]): boolean =>
    a[1] !== b[1] ? a[1] > b[1] : a[0].localeCompare(b[0], 'zh') < 0
  const top: Array<[string, number]> = []
  for (const e of count) {
    if (q && !e[0].toLowerCase().includes(q)) continue
    if (top.length === limit) {
      if (!ahead(e, top[limit - 1])) continue
      top.pop()
    }
    let i = top.length
    top.push(e)
    while (i > 0 && ahead(e, top[i - 1])) { top[i] = top[i - 1]; i-- }
    top[i] = e
  }
  return top.map(([name]) => name)
}

/** 候选名单 = 数一遍 + 取前 limit。一把梭的门面,给测试与别处复用。 */
export function personCandidates(dbs: DbFile[], query = '', limit = 8): string[] {
  return topByCount(countPersonNames(dbs), query, limit)
}

/** 按 `entries` **对象身份**记的一格备忘:下拉渲染与键盘处理都要这份计数,同一份 entries 只数一遍。
 *  ⚠️ 键是身份不是内容 —— dbStore 每次 set 都换新的 entries 对象(`{...s.entries, [ref]: …}`),
 *  生产里数据一变缓存自然失效;返回值身份稳定,可直接当 useMemo 依赖。
 *  ⚠️ 测试里若把**同一个** fixture 对象 setState 两次,拿到的是上一次的计数 —— 每例给新对象。 */
let lastEntries: Record<string, DbEntry> | null = null
let lastCount: Map<string, number> = new Map()
export function personCountOf(entries: Record<string, DbEntry>): Map<string, number> {
  if (entries !== lastEntries) {
    lastEntries = entries
    lastCount = countPersonNames(okDbs(entries))
  }
  return lastCount
}

/** 打开下拉时把**还没进 store 的** `.db` 拉进来(候选要跨库),并发封顶 4。
 *  ⚠️ 别用模块级「已拉过」集合记账:切库 / dropByPathPrefix 会清空 entries 而集合不知道,那些库就再也不回来了。
 *  以 `entries` 现状为准 + `load` 本身幂等 = 天然自愈。
 *  ponytail 取舍:**不建增量人员索引**。名字只在下拉打开的那一刻要,索引却得跟着每次 mutate 维护;
 *  这里只保证「不再一次性并发全库」和「已在 store 里的不重复发」,其余交给 load 的幂等。 */
const CONCURRENCY = 4
export function pullVaultDbs(): void {
  const st = useDbStore.getState()
  const todo = usePageStore.getState().files.filter((p) => DB_RE.test(p) && !st.entries[p])
  const next = async (): Promise<void> => {
    for (let p = todo.shift(); p; p = todo.shift()) await st.load(p, p)
  }
  for (let i = Math.min(CONCURRENCY, todo.length); i > 0; i--) void next()
}

/** 下拉本体:只在打开期间挂载,store 订阅住这里 —— 否则一张 500 行表里每个人员格都随任意 mutate 重渲。 */
function PersonPop({ x, y, anchorTop, query, exclude, active, onPick }: {
  x: number
  y: number
  anchorTop: number
  query: string
  /** 当前格已填的名字:与候选逐字相同时不重复列出。 */
  exclude: string
  active: number
  onPick(name: string): void
}) {
  const entries = useDbStore((s) => s.entries)
  // 数名字按 entries 身份备忘、取前 8 挂 useMemo:↑↓ 换 active 时既不重扫全库也不重取
  // (Codex 第二波评审 [medium]:每次重渲都全量扫描 + 排完整候选集)。entries 变了才重扫 —— 那是新数据。
  const count = personCountOf(entries)
  const names = useMemo(() => topByCount(count, query).filter((n) => n !== exclude), [count, query, exclude])
  if (!names.length) return null
  return (
    // ponytail: 无 .amx-db-popwrap(全屏 fixed 壳会盖住输入框,combobox 得让用户能点回去),z-index/高亮先内联,
    //           等样式沉淀再挪进 amadeus-host.css
    <OverlayAt className="amx-db-pop amx-db-personpop" x={x} y={y} anchorTop={anchorTop} style={{ zIndex: 80 }}>
      <div className="amx-db-pop-list">
        {names.map((n, i) => (
          <button
            key={n}
            className="amx-db-opt"
            data-active={i === active || undefined}
            style={i === active ? { background: 'var(--overlay-light, rgba(127, 127, 127, 0.08))' } : undefined}
            onMouseDown={(e) => e.preventDefault()} // 别让输入框先失焦(失焦 = 关下拉,点击就落空了)
            onClick={() => onPick(n)}
          >
            {n}
          </button>
        ))}
      </div>
    </OverlayAt>
  )
}

export function PersonCell({ value, onChange }: PropCellProps) {
  const s = typeof value === 'string' ? value : ''
  const [pos, setPos] = useState<{ x: number; y: number; anchorTop: number } | null>(null)
  const [active, setActive] = useState(-1)
  // 打开后用户改过字才按字过滤;刚聚焦时(格里已有名字)列全部候选 —— 否则拿整个已填名当 query 永远只剩自己
  const [typed, setTyped] = useState(false)
  const query = typed ? s : ''
  const put = (next: string): void => onChange(next === '' ? undefined : next)
  const open = (el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    setPos({ x: r.left, y: r.bottom + 4, anchorTop: r.top })
    setActive(-1)
    setTyped(false)
    // 「全库」= vault 里全部 .db,不只是当前页嵌入的那几张(与 dbAggregateStore 同一路径口径 load(p, p))
    pullVaultDbs()
  }
  const close = (): void => { setPos(null); setActive(-1) }
  /** 键盘:↑↓ 选候选、Enter 取选中(没选中就只关下拉)、Esc 关。候选在下拉子组件里算,这里按同一路子再取一次名字
   *  —— 走 personCountOf 的备忘,与下拉那次共用同一份计数,不会每敲一下方向键就重扫全库。 */
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (!pos) return
    if (e.key === 'Escape') return close()
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return
    const names = topByCount(personCountOf(useDbStore.getState().entries), query).filter((n) => n !== s)
    if (e.key === 'Enter') {
      if (active >= 0 && names[active]) { e.preventDefault(); put(names[active]) }
      return close()
    }
    if (!names.length) return
    e.preventDefault()
    setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % names.length : (a - 1 + names.length) % names.length))
  }
  return (
    <>
      <input
        className="amx-db-input amx-db-personin"
        value={s}
        onFocus={(e) => open(e.currentTarget)}
        onBlur={close}
        onKeyDown={onKey}
        onChange={(e) => { put(e.target.value); setActive(-1); if (!pos) open(e.currentTarget); setTyped(true) }} // open 先(它会清 typed)
      />
      {pos && <PersonPop x={pos.x} y={pos.y} anchorTop={pos.anchorTop} query={query} exclude={s} active={active} onPick={(n) => { put(n); close() }} />}
    </>
  )
}
