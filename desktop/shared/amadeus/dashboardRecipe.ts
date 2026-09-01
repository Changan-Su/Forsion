// Dashboard 配方编译器(2026-09-01,插件生态的 Dashboard 接缝·第一件):
// 声明式配方 → 一份**真** `.dashboard.md` 字节。
//
// 为什么存在:外置插件(vanilla JS,new Function 求值)想给用户产出一页原生 Dashboard
// (服务器总览这类「数字不在任何 .db 里」的 KPI 页),此前唯一的路是手抄围栏与
// frontmatter 格式 —— 一旦抄进插件,词表就成了没有版本契约的公开 API(评审 P8)。
// 本编译器把格式留在宿主:插件给数据,宿主给字节;格式演进时只改这里。
//
// 三条纪律:
//  ① **复用真 compile()**,不手拼 frontmatter/标记 —— amadeus_page/schema/layout 三件套、
//     块标记编解码与真实笔记逐字节同构,Obsidian/普通编辑器打开同样降级安全。
//  ② **再生成保布局**:传入现有文件字节时,dashboard3: 里已有的卡(按块 id)保留用户手排的
//     order/w/h,只有新卡拿默认值;dashboard3x(手工行位)/dashFilter/dashLayout 等外来键
//     经 fmExtra 逐字带过。卡 id 因此是配方的稳定契约 —— 同一张卡每次编译用同一个 id。
//  ③ **读不懂即拒**:现有文件的 frontmatter 解析不了 / dashboard3 是坏值 / schema 比本端新,
//     一律 ok:false —— 整文件重写发生在编译之后,坏值当空值会把用户布局永久覆盖(与
//     readDash3Layout 的冻结纪律同源)。
import { compile } from './compiler/compile'
import { extractFrontmatterExtra, parseFrontmatter, schemaMajorOf } from './compiler/split'
import { generatePageId } from './compiler/names'
import { COMPILER_VERSION, PAGE_SCHEMA, type BlockId, type PageManifest, type StackNode } from './compiler/types'
import { widgetSource } from './dashboard'
import {
  DASH3_COLS, DASH3_DEFAULT_MINI, DASH3_DEFAULT_TEXT, DASH3_DEFAULT_VIEW,
  clampCell, readDash3Layout, setDash3InFm, type Cell, type Dash3Layout,
} from './dashboard3'

/** 配方里的一张卡。id = 块 id(BLOCK_MARKER_RE 字符集),**跨次编译必须稳定** ——
 *  再生成时按它对上用户手排的布局。w/h 用 12 列参考系,缺省按卡类分档。 */
export type RecipeCard =
  | { kind: 'stat'; id: string; label: string; value: string; unit?: string; w?: number; h?: number }
  | { kind: 'section'; id: string; label: string }
  | { kind: 'view'; id: string; type: string; params?: Record<string, string>; w?: number; h?: number }
  | { kind: 'text'; id: string; md: string; w?: number; h?: number }

export interface DashboardRecipe {
  cards: RecipeCard[]
}

export type RecipeResult = { ok: true; text: string } | { ok: false; error: string }

const ID_RE = /^[A-Za-z0-9_-]+$/
const SCHEMA_MAJOR = 3

/** 围栏 opts 的值必须单行(parseWidget 按行解析);顺带掐首尾空白。 */
const oneLine = (s: string): string => String(s ?? '').replace(/[\r\n]+/g, ' ').trim()

function defaultCell(card: RecipeCard, order: number): Cell {
  const base =
    card.kind === 'stat' ? DASH3_DEFAULT_MINI
    : card.kind === 'section' ? { order: 0, w: DASH3_COLS, h: 1 }
    : card.kind === 'view' ? DASH3_DEFAULT_VIEW
    : DASH3_DEFAULT_TEXT
  const w = 'w' in card && card.w != null ? card.w : base.w
  const h = 'h' in card && card.h != null ? card.h : base.h
  return clampCell({ order, w, h })
}

function cardContent(card: RecipeCard): string {
  if (card.kind === 'stat') {
    return widgetSource('stat', {
      label: oneLine(card.label),
      value: oneLine(card.value),
      ...(card.unit ? { unit: oneLine(card.unit) } : {}),
    })
  }
  // ⚠️ section 渲染层读 `title:`(widgets.tsx SectionWidget),不是 label —— 键名错=恒「未命名分区」
  if (card.kind === 'section') return widgetSource('section', { title: oneLine(card.label) })
  if (card.kind === 'view') {
    const opts: Record<string, string> = { type: oneLine(card.type) }
    for (const [k, v] of Object.entries(card.params ?? {})) {
      if (k !== 'type' && v != null) opts[k] = oneLine(v)
    }
    return widgetSource('view', opts)
  }
  return String(card.md ?? '').trim()
}

export function compileDashboardRecipe(
  recipe: DashboardRecipe,
  opts: { existingFileText?: string; pageId?: string; now?: string } = {},
): RecipeResult {
  const cards = recipe?.cards
  if (!Array.isArray(cards) || !cards.length) return { ok: false, error: '配方至少要有一张卡' }
  const seen = new Set<string>()
  for (const c of cards) {
    if (!c || typeof c.id !== 'string' || !ID_RE.test(c.id)) {
      return { ok: false, error: `卡 id 非法(须 [A-Za-z0-9_-]+):${String(c && c.id)}` }
    }
    if (seen.has(c.id)) return { ok: false, error: `卡 id 重复:${c.id}` }
    seen.add(c.id)
  }

  // 现有文件:提取外来 frontmatter(pins/filters/mode 全在里面,逐字保留)+ 既有布局 + 页 id。
  let fmExtra = ''
  let existingLayout: Dash3Layout = {}
  let pageId = opts.pageId || ''
  const existing = opts.existingFileText ?? ''
  if (existing.trim()) {
    const fm = parseFrontmatter(existing)
    const major = schemaMajorOf(fm)
    if (major !== null && major > SCHEMA_MAJOR) {
      return { ok: false, error: '现有文件由更新版本的格式写入,拒绝改写' }
    }
    fmExtra = extractFrontmatterExtra(existing)
    const read = readDash3Layout(fmExtra)
    if (!read.ok) return { ok: false, error: `现有布局读不懂,拒绝覆盖:${read.error}` }
    existingLayout = read.layout
    if (!pageId && fm.amadeus_page) pageId = fm.amadeus_page.trim()
  }
  if (!pageId) pageId = generatePageId()

  // 布局合并:老卡保用户手排的几何,新卡拿默认;order 全量按配方序重排
  // (视觉序=配方序是配方的语义;行内手摆由 dashboard3x 的 pin 承载,不受 order 重排影响)。
  const layout: Dash3Layout = {}
  cards.forEach((card, i) => {
    const prev = existingLayout[card.id]
    layout[card.id] = prev ? clampCell({ ...prev, order: i }) : defaultCell(card, i)
  })
  const nextExtra = setDash3InFm(fmExtra, layout)
  if (nextExtra === null) return { ok: false, error: '现有 frontmatter 不是可解析的 YAML,拒绝覆盖' }

  const contents: Record<BlockId, string> = {}
  const blocks: Record<BlockId, { type: string }> = {}
  for (const card of cards) {
    contents[card.id] = cardContent(card)
    blocks[card.id] = { type: 'markdown' }
  }
  const root: StackNode = {
    type: 'stack',
    children: [{
      type: 'row',
      id: 'row_1',
      columns: [{ id: 'col_1', width: 1, children: cards.map((c) => ({ ref: c.id })) }],
    }],
  }
  const now = opts.now || new Date().toISOString()
  const manifest: PageManifest = {
    schema: PAGE_SCHEMA,
    id: pageId,
    title: '',
    createdAt: now,
    updatedAt: now,
    compiler: { version: COMPILER_VERSION },
    root,
    blocks,
    ...(nextExtra ? { fmExtra: nextExtra } : {}),
  }
  try {
    return { ok: true, text: compile(manifest, contents) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
