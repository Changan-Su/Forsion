// Dashboard(`.dashboard.md`)的纯逻辑:网格布局表 + 功能卡片的 fence 编解码。
//
// 一个 Dashboard **就是一份普通 Amadeus 笔记** —— 同样的 `<!-- a id -->` 块、同样的 compiler、
// 同样的 frontmatter。它只多一个**外来** frontmatter 键 `dashboard:`,记每块在网格里的矩形:
//
//     dashboard:
//       "1": [0, 0, 10, 6]     # [x, y, w, h],单位=格
//       "2": [10, 0, 5, 4]
//
// 「外来键」是关键:compiler 的 fmExtra 通道逐字保留非 amadeus_* 行,所以**编译内核一个字节都不用改**,
// 而且这份文件被普通笔记编辑器打开、编辑、保存也不会丢布局(最坏就是块按线性顺序堆着)。
// 代价是搜索/双链/备链/云同步/Obsidian 全都天然吃得到 —— 这正是选它的理由。
//
// 几何:**列数固定 24,高度向下无限长**(用户选定的「有限画布」语义)。窗宽变化只改格子像素宽,
// 相对布局恒定 → 永不横向滚动。x 被夹在 [0, 24-w],y 只有下界。
//
// ponytail: 冲突策略 = 拒绝(拖到压住别人的位置就回弹),没有自动挤开/自动上浮。
// 要 react-grid-layout 那种 compact 语义再说 —— 那是一整套重排算法,当前这套「放哪是哪」更可预测。

import { Document, parseDocument } from 'yaml'

export const DASH_COLS = 24
/** 一格的高度(px);宽度由容器 / 24 得出。gap 见 CSS 变量,两处要一致。 */
export const DASH_ROW_PX = 28
export const DASH_GAP_PX = 8
/** frontmatter 里的键名(外来键,不进 AMADEUS_FM_KEY 保留集)。 */
export const DASH_FM_KEY = 'dashboard'
/** 新块的默认大小。 */
export const DASH_DEFAULT_W = 8
export const DASH_DEFAULT_H = 6
/** y/h 的硬上界。手写 md 里一个 `1e308` 就能让 findSlot 的逐行扫描实际变成死循环
 *  (Number.isFinite 拦不住它),CSS 的 `repeat(1e308, 28px)` 也不是合法网格。 */
export const DASH_MAX_ROWS = 2000

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export type DashLayout = Record<string, Rect>

export function isDashboardPath(p: string): boolean {
  return /\.dashboard\.md$/i.test(p)
}

/** 展示名:去掉目录与 `.dashboard.md` 后缀。 */
export function dashBaseName(p: string): string {
  const seg = p.split(/[\\/]/).pop() ?? p
  return seg.replace(/\.dashboard\.md$/i, '')
}

export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/** 夹进画布:w∈[1,24]、x∈[0,24-w]、h∈[1,MAX_ROWS]、y∈[0,MAX_ROWS]。
 *  h/y 的上界不是洁癖:没有它,手写 md 里一个 `[0,0,24,1e308]` 就让 findSlot 逐行扫到天荒地老。
 *  NaN(非数字混进来)一律折成最小合法值,绝不放 NaN 进网格。 */
export function clampRect(r: Rect): Rect {
  const n = (v: number, lo: number, hi: number): number =>
    Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : lo
  const w = n(r.w, 1, DASH_COLS)
  return {
    w,
    h: n(r.h, 1, DASH_MAX_ROWS),
    x: n(r.x, 0, DASH_COLS - w),
    y: n(r.y, 0, DASH_MAX_ROWS),
  }
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** id 能否停在 r:必须已在界内(clamp 后不变)且不压住任何别的块。 */
export function canPlace(id: string, r: Rect, layout: DashLayout): boolean {
  if (!sameRect(clampRect(r), r)) return false
  for (const [other, o] of Object.entries(layout)) {
    if (other !== id && overlaps(r, o)) return false
  }
  return true
}

/** 首个放得下 w×h 的空位:自上而下、自左而右扫;扫到现有内容底部还没位就接在底部。 */
export function findSlot(layout: DashLayout, w: number, h: number): Rect {
  const width = Math.max(1, Math.min(DASH_COLS, Math.round(w)))
  const height = Math.max(1, Math.round(h))
  const taken = Object.values(layout)
  const bottom = taken.reduce((m, o) => Math.max(m, o.y + o.h), 0)
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + width <= DASH_COLS; x++) {
      const r = { x, y, w: width, h: height }
      if (taken.every((o) => !overlaps(r, o))) return r
    }
  }
  return { x: 0, y: bottom, w: width, h: height }
}

/** 布局表对齐到实际存在的块(按文档顺序),并自愈:
 *  · 布局里有、块已不在 → 丢掉;
 *  · 块在、布局里没有(别处新建的块 / 手写 md)→ 自动找位;
 *  · 手改 md 改出的越界或互相重叠 → 后来者重新找位(先到先得,按文档顺序)。
 *  返回 null = 无需改动(别拿它去触发一次无谓落盘)。 */
export function reconcileLayout(layout: DashLayout, ids: string[]): DashLayout | null {
  const present = new Set(ids)
  let changed = Object.keys(layout).some((id) => !present.has(id))
  const next: DashLayout = {}
  for (const id of ids) {
    const want = layout[id] ? clampRect(layout[id]) : null
    if (want && Object.values(next).every((o) => !overlaps(want, o))) {
      next[id] = want
      if (!sameRect(layout[id], want)) changed = true
    } else {
      next[id] = findSlot(next, want?.w ?? DASH_DEFAULT_W, want?.h ?? DASH_DEFAULT_H)
      changed = true
    }
  }
  return changed ? next : null
}

/** frontmatter 对象(parseFmObject 的产物)→ 布局表。坏数据只丢它自己,别的照读。
 *  ⚠️ 这个签名分不清「YAML 解析失败」与「本来就没有 dashboard 键」——两者都得到 {}。
 *  调用方**不要**用它来决定要不要自愈落盘(会把用户真实布局覆盖成默认值);用 readDashLayout。 */
export function parseDashLayout(fm: Record<string, unknown> | undefined | null): DashLayout {
  const raw = fm?.[DASH_FM_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: DashLayout = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.length < 4) continue
    const n = v.slice(0, 4).map((x) => Number(x))
    if (!n.every((x) => Number.isFinite(x))) continue
    out[String(id)] = clampRect({ x: n[0], y: n[1], w: n[2], h: n[3] })
  }
  return out
}

/** 布局键与实际块 id **完全不相交** —— 这份布局不是给这些块写的,自愈会把它整份当孤儿清掉重排,
 *  那是数据丢失而不是自愈。已知成因:compiler 的 legacy-id 重编号(parseV3 里,非数字 id / 首段
 *  markerless 内容会触发全量 1..N 重编号)只 remap `amadeus_layout`,不认识外来键。
 *  ⚠️ 那条链没在 compiler 里补 —— 补它要让编译内核知道「还有一个按块 id 建索引的外来键」。
 *  这里选择**认出来并停手**:布局原样留在文件里,由用户决定是否重排。 */
export function layoutIsStale(layout: DashLayout, ids: string[]): boolean {
  if (!ids.length || !Object.keys(layout).length) return false
  return !ids.some((id) => layout[id])
}

/** 读 fmExtra 的结果。`ok:false` = 这份 frontmatter 我们**读不懂**(用户手写坏了 YAML,
 *  哪怕坏在跟 dashboard 无关的键上)—— 此时任何自动写入都是在拿默认布局覆盖用户的真实布局,
 *  必须一个字节都别动。这条区分是 Codex 评审揪出来的:此前坏 YAML 与「没有布局」同样得到 {}。 */
export type DashRead = { ok: true; layout: DashLayout } | { ok: false; error: string }

export function readDashLayout(fmExtra: string): DashRead {
  if (!fmExtra.trim()) return { ok: true, layout: {} }
  const doc = parseDocument(fmExtra)
  if (doc.errors.length) return { ok: false, error: doc.errors[0].message.split('\n')[0] }
  const obj = doc.toJS() as unknown
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: true, layout: {} }
  return { ok: true, layout: parseDashLayout(obj as Record<string, unknown>) }
}

/** 把布局写回 fmExtra 文本,只换 `dashboard:` 这一个键。
 *
 *  ⚠️ 早先是手写的「按行扫 `dashboard:` 再跳过缩进子行」——Codex 复现出四种能把用户 frontmatter
 *  写成**不可解析**的合法输入:引号键 `"dashboard":`(不命中 → 留下重复键)、整体缩进的根映射、
 *  键块里夹零缩进注释或空行(提前收尾 → 后面的子行变悬空、还静默吞掉一条布局)。
 *  改走 yaml 的 Document:它保留注释与键序,`doc.setIn` 只动目标键,其余节点原样序列化。
 *  数组用 flow 样式(`[0, 0, 8, 6]`)——block 样式会把每个矩形摊成四行,md 里没法看。
 *
 *  返回 null = **拒改**(输入根本不是可解析的 YAML)。调用方必须把 null 当「别写」,不是「写空」。 */
export function setDashInFm(fmExtra: string, layout: DashLayout): string | null {
  // 空 frontmatter 时 parseDocument 的 contents 是 null(set 会炸)→ 直接起一个空根映射。
  const doc = fmExtra.trim() ? parseDocument(fmExtra) : new Document({})
  if (doc.errors.length) return null
  const ids = Object.keys(layout).sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b))
  if (!ids.length) {
    doc.delete(DASH_FM_KEY)
  } else {
    const obj: Record<string, number[]> = {}
    for (const id of ids) {
      const r = layout[id]
      obj[id] = [r.x, r.y, r.w, r.h]
    }
    const node = doc.createNode(obj)
    // 只让**矩形**走 flow(一行一个块);键映射本身保持 block,便于人读人改。
    if ('items' in node) for (const it of (node as { items: Array<{ value?: unknown }> }).items) {
      const v = it.value as { flow?: boolean } | undefined
      if (v && typeof v === 'object') v.flow = true
    }
    doc.set(DASH_FM_KEY, node)
  }
  return String(doc).replace(/\n+$/, '')
}

// ───────────────────────────── 功能卡片(widget) ─────────────────────────────
//
// 一张功能卡片 = 一个带语言标签的围栏代码块。选这个表示法是因为它在**任何** markdown 阅读器里
// 都降级成一段普通代码块(Obsidian 打开不会看到乱码、更不会毁档),而且块内容就是纯文本、
// 天然进搜索。刻意只在 Dashboard 视图里活化 —— 普通笔记里它就是一段代码块,这是设计,不是遗漏。

// 'view' = 把宿主**任意已注册视图**(日历/待办/收件箱/活动日志/插件视图……)活化成一张卡片,
// opts.type 记视图注册键、其余键即该视图的 params。活化逻辑在 AmadeusDashboardView(要宿主的
// 视图注册表),不放进这层可移植的 amadeus 代码 —— 这里只管它的文本表示。
// 'section' = 分区标题条。它不是「一个会动的东西」,而是**排版语汇**:整行、只有一行高,
// 把下面的卡片在视觉上归成一组。放在 widget 通道里是因为它同样要在 Obsidian 里降级成一段
// 普通代码块,而且同样要进搜索。
// 'stat' / 'chart' = 数据卡(见 shared/amadeus/dashboardData.ts):从一份 .db 里取数,
// 并且**吃页面级筛选** —— 它们是「一屏面板」与「一个复合 view」的分界线。
export const DASH_WIDGETS = ['clock', 'weather', 'webview', 'view', 'section', 'stat', 'chart'] as const
export type WidgetKind = (typeof DASH_WIDGETS)[number]
export interface Widget {
  kind: WidgetKind
  opts: Record<string, string>
}

const FENCE = '```'
const WIDGET_RE = new RegExp(`^${FENCE}(${DASH_WIDGETS.join('|')})[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?${FENCE}$`)
const EMPTY_WIDGET_RE = new RegExp(`^${FENCE}(${DASH_WIDGETS.join('|')})[ \\t]*\\r?\\n?${FENCE}$`)

/** 块内容是不是一张功能卡片;不是 → null(照常走 markdown 渲染)。 */
export function parseWidget(content: string): Widget | null {
  const src = content.trim()
  const empty = EMPTY_WIDGET_RE.exec(src)
  if (empty) return { kind: empty[1] as WidgetKind, opts: {} }
  const m = WIDGET_RE.exec(src)
  if (!m) return null
  const opts: Record<string, string> = {}
  for (const line of m[2].split('\n')) {
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) opts[kv[1]] = kv[2].trim()
  }
  return { kind: m[1] as WidgetKind, opts }
}

export function widgetSource(kind: WidgetKind, opts: Record<string, string> = {}): string {
  const body = Object.entries(opts)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return body ? `${FENCE}${kind}\n${body}\n${FENCE}` : `${FENCE}${kind}\n${FENCE}`
}

/** 网页卡片允许自动加载的地址。**默认拒**:一份 .dashboard.md 可能是同步/导入/别人分享来的,
 *  里面的 `url:` 是不可信输入,而 `<webview src>` 一挂上去就是**无需用户操作的自动导航**。
 *  拒掉:非 http(s)(file:/data:/javascript: 等)、localhost 与各类私网/链路本地/唯一本地地址
 *  (内网探测、对本机服务发 GET 型副作用请求)。
 *  ponytail: 只拦字面主机名/字面 IP;`evil.com` 把 A 记录指向 127.0.0.1 这种 DNS 重绑定拦不住 ——
 *  那需要在 guest session 的请求层逐次导航校验,等真有人要把仪表盘当内网面板用再补。 */
export function webviewUrlAllowed(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return false
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127 || a === 10 || a === 0) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 169 && b === 254) return false // 链路本地(含云元数据 169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return false // IPv6 唯一本地 / 链路本地
  return true
}

/** 拖动/缩放的纯几何:像素位移 → 格数增量。step = 一格的步长(格宽/高 + gap)。 */
export function snapDelta(dxPx: number, dyPx: number, stepX: number, stepY: number): { dx: number; dy: number } {
  return {
    dx: Math.round(dxPx / Math.max(1, stepX)),
    dy: Math.round(dyPx / Math.max(1, stepY)),
  }
}

// ───────────────────── 画布版布局(dashboard2:,2026-08-25 拍板的新版) ─────────────────────
//
// 与旧 24 列网格同一份笔记、同一套块与 widget,只换几何:外来键 `dashboard2:` 记每块的
// **自由 px 矩形**(格式与旧键同构:块 id → [x, y, w, h],单位从「格」换成 px)。
// 打开时新键优先;只有旧键 → 视图给一键迁移(写新键、**保留旧键**——它无害,而且是回滚保险)。
// 旧键的读写函数原样保留:迁移横幅与旧视图(保留一个发布周期)都还要读它。

export const DASH2_FM_KEY = 'dashboard2'
/** px 边界:卡最小 80×60(比它小连标题都放不下),坐标±1e6(手写 1e308 会把 CSS transform 写炸)。 */
export const DASH2_MIN_W = 80
export const DASH2_MIN_H = 60
export const DASH2_MAX_WH = 4000
export const DASH2_MAX_XY = 1_000_000
/** 新卡默认 px 尺寸(≈ 旧默认 8×6 格的观感)。**取点阵步长 24 的整倍数** —— 默认落下来就能与
 *  邻居严丝合缝地拼上(用户 2026-08-25:「卡片之间应当可以无缝衔接」)。 */
export const DASH2_DEFAULT_W = 408
export const DASH2_DEFAULT_H = 216

export function clampRect2(r: Rect): Rect {
  const n = (v: number, lo: number, hi: number): number =>
    Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : lo
  return {
    x: n(r.x, -DASH2_MAX_XY, DASH2_MAX_XY),
    y: n(r.y, -DASH2_MAX_XY, DASH2_MAX_XY),
    w: n(r.w, DASH2_MIN_W, DASH2_MAX_WH),
    h: n(r.h, DASH2_MIN_H, DASH2_MAX_WH),
  }
}

/** 读画布布局:三态语义比旧键更严——**「键不存在」与「键在但 schema 坏」必须分开**。
 *
 *  ⚠️ 二者都返回 `ok:true, layout:{}` 会酿成数据丢失(Codex 评审实证):空布局既不 stale 也不
 *  migratable,自愈 effect 视之为「一张卡都没排过」,当场按默认值重排并落盘 —— 用户手写/合并
 *  损伤/未来 schema 漂移出来的**合法 YAML 坏值**,只要打开一次就被永久覆盖,与横幅承诺的
 *  「读不懂即冻结」正好相反。故坏值一律 ok:false:画面不好看可以忍,布局写没了不能忍。 */
export function readDash2Layout(fmExtra: string): DashRead {
  if (!fmExtra.trim()) return { ok: true, layout: {} }
  const doc = parseDocument(fmExtra)
  if (doc.errors.length) return { ok: false, error: doc.errors[0].message.split('\n')[0] }
  const obj = doc.toJS() as unknown
  // ⚠️ 根节点必须是**映射**。标量/数组根是合法 YAML 但不是 frontmatter,当成「还没排过版」有两害
  // (Codex 2026-08-25):①自愈当场按默认值重排并落盘,原内容被覆盖;②`setDash2InFm` 对标量根
  // `doc.set` 会抛,异常从 effect 里冒出来。一律冻结。
  if (obj === null || obj === undefined) return { ok: true, layout: {} } // 空 frontmatter
  if (typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'frontmatter 根节点不是映射' }
  const raw = (obj as Record<string, unknown>)[DASH2_FM_KEY]
  // `undefined`(键不存在)与显式 `null`(写了键但没内容)都视为「还没排过版」——**这一条是刻意的**:
  // 两种情形下都没有布局可丢,冻结只会让用户对着一个改不动的横幅发呆。真正要冻结的是「有内容但读不懂」。
  if (raw === undefined || raw === null) return { ok: true, layout: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${DASH2_FM_KEY} 不是映射` }
  const out: DashLayout = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    // 长度必须**恰好** 4:多出来的项写回时会被静默丢掉(未来 schema 加字段时就是无声的数据损失)。
    if (!Array.isArray(v) || v.length !== 4) return { ok: false, error: `${DASH2_FM_KEY}.${id} 不是 [x, y, w, h]` }
    // 必须是**真数字**,不做 `Number()` 强转:'100' / true 都能转成有限值,但它们一旦被接受,
    // 下一次写回就把原来的表示悄悄改掉了 —— 与「读不懂即冻结」同一条纪律。
    if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      return { ok: false, error: `${DASH2_FM_KEY}.${id} 含非数值` }
    }
    const n = v as number[]
    out[String(id)] = clampRect2({ x: n[0], y: n[1], w: n[2], h: n[3] })
  }
  return { ok: true, layout: out }
}

/** 写画布布局(只动 dashboard2: 一个键;yaml Document 保注释键序,同 setDashInFm 的教训)。 */
export function setDash2InFm(fmExtra: string, layout: DashLayout): string | null {
  const doc = fmExtra.trim() ? parseDocument(fmExtra) : new Document({})
  if (doc.errors.length) return null
  const ids = Object.keys(layout).sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b))
  if (!ids.length) {
    doc.delete(DASH2_FM_KEY)
  } else {
    const obj: Record<string, number[]> = {}
    for (const id of ids) {
      const r = layout[id]
      obj[id] = [r.x, r.y, r.w, r.h]
    }
    const node = doc.createNode(obj)
    if ('items' in node) for (const it of (node as { items: Array<{ value?: unknown }> }).items) {
      const v = it.value as { flow?: boolean } | undefined
      if (v && typeof v === 'object') v.flow = true
    }
    doc.set(DASH2_FM_KEY, node)
  }
  return String(doc).replace(/\n+$/, '')
}

/** 旧网格 → 画布:纯数学,格步长换固定 px 系数(cell 44 + gap 8 = 52 / row 28 + 8 = 36),
 *  比例与旧版中等窗宽下的观感一致;卡内边 8px 的 gap 语义折进尺寸(-8)。 */
export const DASH2_MIGRATE_STEP_X = 52
export const DASH2_MIGRATE_STEP_Y = 36
export function migrateGridToCanvas(grid: DashLayout): DashLayout {
  const out: DashLayout = {}
  for (const [id, r] of Object.entries(grid)) {
    out[id] = clampRect2({
      x: r.x * DASH2_MIGRATE_STEP_X,
      y: r.y * DASH2_MIGRATE_STEP_Y,
      w: r.w * DASH2_MIGRATE_STEP_X - DASH_GAP_PX,
      h: r.h * DASH2_MIGRATE_STEP_Y - DASH_GAP_PX,
    })
  }
  return out
}

/** 画布自愈(对齐 reconcileLayout 的语义,但自由坐标没有「重叠禁令」——只补缺、清孤儿):
 *  · 布局里有、块已不在 → 丢;
 *  · 块在、布局没有(别处新建/手写)→ 排到现有内容下方,依次错开;
 *  返回 null = 无需改动。 */
export function reconcileCanvas(layout: DashLayout, ids: string[]): DashLayout | null {
  const present = new Set(ids)
  let changed = Object.keys(layout).some((id) => !present.has(id))
  const next: DashLayout = {}
  let bottom = 0
  for (const id of ids) if (layout[id]) bottom = Math.max(bottom, layout[id].y + layout[id].h)
  for (const id of ids) {
    if (layout[id]) {
      const want = clampRect2(layout[id])
      next[id] = want
      if (!sameRect(layout[id], want)) changed = true
    } else {
      next[id] = clampRect2({ x: 0, y: bottom + 16, w: DASH2_DEFAULT_W, h: DASH2_DEFAULT_H })
      bottom = next[id].y + next[id].h
      changed = true
    }
  }
  return changed ? next : null
}
