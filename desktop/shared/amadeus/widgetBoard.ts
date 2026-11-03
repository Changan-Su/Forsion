// 小组件(用户 / Agent 在对话里做的卡)摆进看板:卡片区(`Dashboards/卡片区.dashboard.md`)与仪表盘
// 都是普通 `.dashboard.md`,一张小组件 = 一个块,正文是 ```widget 围栏,只写 id(卡片区再写显示范围)。
// 原件按 id 从引擎读,看板里不拷字节 —— Agent 改原件、记一笔,每处一起变。
//
// 与内置七种卡片(dashboard.ts 的 DASH_WIDGETS)分开解析:那张表是宿主卡片,这里是小组件,不进那张表。
// 纪律同 dashboardRecipe:复用真 compile();读不懂(schema 更新 / 布局坏值 / frontmatter 坏)一律拒,
// 整文件重写发生在编辑之后,坏值当空会把用户布局永久覆盖。
import { compile } from './compiler/compile'
import { parsePageSource } from './compiler/page'
import { bumpNextId, generateColumnId, generatePageId, generateRowId, nextBlockId } from './compiler/names'
import { COMPILER_VERSION, PAGE_SCHEMA, type BlockId, type PageManifest } from './compiler/types'
import { moveCard, readDash3Layout, reconcileGrid, setDash3InFm, orderedIds, clampCell, type Dash3Layout } from './dashboard3'

export interface WidgetRef {
  id: string
  /** 卡片区的显示范围:缺省 = 只在归属者(这个 Agent / 这个项目)的会话里;`all` = 所有会话。 */
  scope?: 'all'
}
export interface BoardWidget { blockId: BlockId; ref: WidgetRef }
export type BoardRead = { ok: true; items: BoardWidget[] } | { ok: false; error: string }
export type BoardEdit = { ok: true; text: string; changed: boolean } | { ok: false; error: string }

const ID_RE = /^w_[A-Za-z0-9_-]{1,64}$/
const REF_RE = /^```widget[ \t]*\r?\n([\s\S]*?)\r?\n?```$/
/** 新放进来的卡:落在板的最后,dash3 的「大」档(12 列参考系 6 × 5)。 */
export const WIDGET_CELL = { w: 6, h: 5 } as const

export function parseWidgetRef(content: string): WidgetRef | null {
  const m = REF_RE.exec(content.trim())
  if (!m) return null
  const opts: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) opts[kv[1]] = kv[2].trim()
  }
  if (!ID_RE.test(opts.id ?? '')) return null
  return opts.scope === 'all' ? { id: opts.id, scope: 'all' } : { id: opts.id }
}

export function widgetRefSource(ref: WidgetRef): string {
  return ['```widget', `id: ${ref.id}`, ...(ref.scope === 'all' ? ['scope: all'] : []), '```'].join('\n')
}

interface Board { manifest: PageManifest; contents: Record<BlockId, string>; layout: Dash3Layout }

function load(raw: string, path: string, now: string): { ok: true; board: Board } | { ok: false; error: string } {
  const page = parsePageSource(path, raw, now)
  if (page.manifest.schemaTooNew) return { ok: false, error: 'board written by a newer format' }
  const lay = readDash3Layout(page.manifest.fmExtra ?? '')
  if (!lay.ok) return { ok: false, error: lay.error }
  const contents: Record<BlockId, string> = {}
  for (const [id, b] of Object.entries(page.blocks)) contents[id] = b.content
  return { ok: true, board: { manifest: page.manifest, contents, layout: lay.layout } }
}

function widgetsOf(b: Board): BoardWidget[] {
  const ids = Object.keys(b.manifest.blocks)
  const out: BoardWidget[] = []
  for (const blockId of orderedIds(b.layout, ids)) {
    const ref = parseWidgetRef(b.contents[blockId] ?? '')
    if (ref) out.push({ blockId, ref })
  }
  return out
}

/** 板上的小组件,按板上的顺序(dashboard3 的 order;没排过版 = 文档序)。 */
export function readBoardWidgets(raw: string, path: string, now = new Date().toISOString()): BoardRead {
  const l = load(raw, path, now)
  return l.ok ? { ok: true, items: widgetsOf(l.board) } : l
}

function emptyBoard(title: string, now: string): Board {
  return {
    manifest: {
      schema: PAGE_SCHEMA, id: generatePageId(), title, createdAt: now, updatedAt: now,
      compiler: { version: COMPILER_VERSION }, root: { type: 'stack', children: [] }, blocks: {}, fmExtra: '',
    },
    contents: {},
    layout: {},
  }
}

/** 读 → 改 → 编译。raw = null 表示文件还不存在(建一块新板,title 是板名)。edit 返回 false = 没变。 */
function editBoard(raw: string | null, path: string, title: string, edit: (b: Board) => boolean): BoardEdit {
  const now = new Date().toISOString()
  let board: Board
  if (raw == null) board = emptyBoard(title, now)
  else {
    const l = load(raw, path, now)
    if (!l.ok) return l
    board = l.board
  }
  if (!edit(board)) return { ok: true, text: raw ?? '', changed: false }
  const fmExtra = setDash3InFm(board.manifest.fmExtra ?? '', board.layout)
  if (fmExtra === null) return { ok: false, error: 'frontmatter is not valid YAML' }
  try {
    return { ok: true, text: compile({ ...board.manifest, fmExtra }, board.contents), changed: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function addWidgetToBoard(raw: string | null, path: string, title: string, ref: WidgetRef): BoardEdit {
  return editBoard(raw, path, title, (b) => {
    if (widgetsOf(b).some((w) => w.ref.id === ref.id)) return false
    const m = b.manifest
    const existing = Object.keys(m.blocks)
    // 没排过版的板先补齐(否则只有新卡有 order,会排到所有老卡前面)
    const base = reconcileGrid(b.layout, existing) ?? b.layout
    const id = nextBlockId(existing, m.nextId)
    const lastRow = m.root.children[m.root.children.length - 1]
    if (lastRow) lastRow.columns[lastRow.columns.length - 1].children.push({ ref: id })
    else m.root.children.push({ type: 'row', id: generateRowId(), columns: [{ id: generateColumnId(), width: 1, children: [{ ref: id }] }] })
    m.blocks[id] = { type: 'markdown' }
    m.nextId = bumpNextId(m.nextId, id)
    b.contents[id] = widgetRefSource(ref)
    b.layout = { ...base, [id]: clampCell({ order: existing.length, ...WIDGET_CELL }) }
    return true
  })
}

export function removeWidgetFromBoard(raw: string, path: string, widgetId: string): BoardEdit {
  return editBoard(raw, path, '', (b) => {
    const hit = widgetsOf(b).filter((w) => w.ref.id === widgetId).map((w) => w.blockId)
    if (!hit.length) return false
    const m = b.manifest
    for (const id of hit) {
      delete m.blocks[id]
      delete b.contents[id]
      delete b.layout[id]
      m.nextId = bumpNextId(m.nextId, id) // 删了也抬水位,别让下一张卡复用这个号
    }
    for (const row of m.root.children) for (const col of row.columns) col.children = col.children.filter((c) => !hit.includes(c.ref))
    m.root.children = m.root.children
      .map((row) => ({ ...row, columns: row.columns.filter((c) => c.children.length) }))
      .filter((row) => row.columns.length)
    for (const row of m.root.children) {
      const sum = row.columns.reduce((s, c) => s + (c.width > 0 ? c.width : 0), 0) || 1
      row.columns.forEach((c) => (c.width = (c.width > 0 ? c.width : 0) / sum))
    }
    return true
  })
}

/** 把小组件挪到 beforeId 那张之前(null = 末尾)。卡片区里拖动排序写回这里。 */
export function moveWidgetOnBoard(raw: string, path: string, widgetId: string, beforeWidgetId: string | null): BoardEdit {
  return editBoard(raw, path, '', (b) => {
    const items = widgetsOf(b)
    const from = items.find((w) => w.ref.id === widgetId)?.blockId
    if (!from) return false
    const before = beforeWidgetId == null ? null : items.find((w) => w.ref.id === beforeWidgetId)?.blockId ?? null
    const ids = Object.keys(b.manifest.blocks)
    const next = moveCard(reconcileGrid(b.layout, ids) ?? b.layout, ids, from, before)
    if (orderedIds(next, ids).join() === orderedIds(b.layout, ids).join() && Object.keys(b.layout).length === ids.length) return false
    b.layout = next
    return true
  })
}

export function setWidgetScope(raw: string, path: string, widgetId: string, scope: WidgetRef['scope']): BoardEdit {
  return editBoard(raw, path, '', (b) => {
    const hit = widgetsOf(b).filter((w) => w.ref.id === widgetId && w.ref.scope !== scope)
    for (const w of hit) b.contents[w.blockId] = widgetRefSource({ id: widgetId, ...(scope ? { scope } : {}) })
    return hit.length > 0
  })
}
