// 画布插件格式(2026-08-14 的 `forsion-plugin-canvas`)→ v4 原生画布的一次性迁移(2026-08-17)。
//
// 为什么要专门写一支而不是让它走 upgradeV3Source:通用升级对**平凡布局**(无分栏)会剥掉全部锚,
// 而画布卡片正是靠锚定位的 —— 走通用路径 = 坐标当场全变孤儿。这也是当初把裸 `canvas:` 键放进
// FOREIGN_ID_TREE_KEY 拒绝升级的原因;现在有了原生画布,拒绝换成转换。
//
// 两套模型的映射(插件是「每个有坐标的块 = 一张卡」,原生是「主卡 + 被拖出的卡」):
//   · 有坐标的块 → 卡片(锚保留,x/y/w 原样带走),按源序排在文末卡片区
//   · 没坐标的块 → 主卡自然流,顺序不动
//   · 连线 e[] / 形状 s[] → `elements`(方案 §3.1 的 connector/shape 形状)。**Phase 1 不渲染但逐字带走**
//     (§8:老端绝不吞掉新端的元素);端点落在形状上时用 `{id}`,落在块上时用 `{ref}`。
//
// ⚠️ 失效闭合:有坐标的块**落在多列行里**时整篇拒绝迁移(方案 §3.2「卡内无分栏」——把它抽出来
//    要连带修 layout(cell 收缩/行解散/tail 维护),那是同一笔事务的活,不在一次性迁移的范围里)。
//    拒绝 = 文件原样留 v3,不动一个字节。
import { blockMarker } from './markers'
import { parsePageSource } from './page'
import { classifyPageSource, compileV4, type UpgradeResult } from './v4'

/** 主卡默认宽度(与 frontend 的 canvas.ts MAIN_W 同值;shared 不依赖 frontend,故此处独立声明)。 */
const MAIN_W = 720
const CARD_W = 400

/** fmExtra 里的裸 `canvas:` 行(插件键)。值是 YAML 单引号标量。 */
const PLUGIN_CANVAS_LINE = /^["']?canvas["']?[ \t]*:[ \t]*(.*)$/m
/** frontmatter 块(收尾栅栏独占一行,口径同 split.ts)。 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * 只在 **frontmatter 块内**找那一行 `canvas:`。
 *
 * ⚠️不能拿 `/m` 正则去扫整份原文(codex 2026-08-17 P2):v3 笔记的**正文**里完全可能有一行
 * 顶格的 `canvas: '{"v":1,...}'` —— 写文档、贴示例、围栏代码块里都会出现。扫全文的话这类
 * 普通笔记会被判成「插件格式画布」,第一次编辑时 router 就把正文当几何迁移掉 = 毁档。
 * 判定与迁移共用这一个入口,两处口径不许再分家。
 */
function pluginCanvasLine(raw: string): RegExpExecArray | null {
  const fm = FRONTMATTER_RE.exec(raw ?? '')
  return fm ? PLUGIN_CANVAS_LINE.exec(fm[1]) : null
}

interface PluginNode { x?: number; y?: number; w?: number; h?: number }
interface PluginEdge { a?: string; b?: string; label?: string }
interface PluginShape { id?: string; t?: string; x?: number; y?: number; w?: number; h?: number; text?: string }
interface PluginCanvas { v?: number; mode?: string; n?: Record<string, PluginNode>; e?: PluginEdge[]; s?: PluginShape[] }

/** YAML 单/双引号标量 → 原始字符串(单引号里的 `''` 是转义的单引号)。裸值原样返回。 */
function unquoteYaml(v: string): string {
  const s = v.trim()
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'")
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s) as string
    } catch {
      return s.slice(1, -1)
    }
  }
  return s
}

const int = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt)

/** 这份 v3 源文是不是「插件格式的画布笔记」(fm 带裸 canvas: 且能解析出画布对象)。 */
export function isPluginCanvasSource(raw: string): boolean {
  if (classifyPageSource(raw) !== 'v3') return false
  const m = pluginCanvasLine(raw)
  if (!m) return false
  try {
    const o = JSON.parse(unquoteYaml(m[1])) as PluginCanvas
    return !!o && typeof o === 'object' && !Array.isArray(o)
  } catch {
    return false
  }
}

export function migratePluginCanvas(pagePath: string, raw: string, now: string): UpgradeResult {
  if (classifyPageSource(raw) !== 'v3') return { ok: false, reason: 'not-v3' }
  const fmMatch = pluginCanvasLine(raw)
  if (!fmMatch) return { ok: false, reason: 'plugin-structured-frontmatter' }
  let canvas: PluginCanvas
  try {
    canvas = JSON.parse(unquoteYaml(fmMatch[1])) as PluginCanvas
  } catch {
    return { ok: false, reason: 'plugin-structured-frontmatter' } // 读不懂就别碰,文件原样留 v3
  }
  if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas)) return { ok: false, reason: 'plugin-structured-frontmatter' }

  const page = parsePageSource(pagePath, raw, now)
  const coords = canvas.n ?? {}
  const shapeIds = new Set((canvas.s ?? []).map((s) => String(s.id ?? '')).filter(Boolean))

  // 源序遍历:主流块与卡片块各自成序。有坐标的块落在多列行里 → 整篇拒绝(见文件头告警)。
  const mainSegments: string[] = []
  const cardRefs: string[] = []
  for (const row of page.manifest.root.children) {
    const multiCol = row.columns.length > 1
    for (const col of row.columns) {
      for (const ref of col.children) {
        const id = ref.ref
        const positioned = Object.prototype.hasOwnProperty.call(coords, id)
        if (positioned && multiCol) return { ok: false, reason: 'plugin-structured-frontmatter' }
        if (positioned) cardRefs.push(id)
        else {
          // 保住块首行首横向空白(段落缩进档=行首制表符,indentIo):裸 .trim() 会抹缩进。
          const content = (page.blocks[id]?.content ?? '').replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()
          if (content) mainSegments.push(content)
        }
      }
    }
  }
  // 多列行 v1 不带进原生画布笔记:真有分栏的画布笔记极少,而「分栏 × 画布」的读侧互斥不变式
  // (§3.2)要求两者绝不引用同一枚锚 —— 一次性迁移不去趟这摊,有多列就整篇拒绝。
  if (page.manifest.root.children.some((r) => r.columns.length > 1)) return { ok: false, reason: 'plugin-structured-frontmatter' }

  const cardSegments = cardRefs.map((id) => {
    const content = (page.blocks[id]?.content ?? '').replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()
    return content ? `${blockMarker(id)}\n\n${content}` : blockMarker(id)
  })

  const cards = cardRefs.map((id) => {
    const n = coords[id] ?? {}
    const h = int(n.h, 0)
    return { ref: id, x: int(n.x, 0), y: int(n.y, 0), w: int(n.w, CARD_W) || CARD_W, ...(h > 0 ? { h } : {}) }
  })

  // 端点:形状 id → {id},其余按块锚 → {ref}。连线自身的 id 在插件格式里没有,按序生成。
  const endpoint = (v: string | undefined): Record<string, string> | null =>
    !v ? null : shapeIds.has(v) ? { id: v } : { ref: v }
  const elements: unknown[] = []
  for (const s of canvas.s ?? []) {
    const id = String(s.id ?? '')
    if (!id) continue
    const t = String(s.t ?? 'rect')
    elements.push({
      id,
      type: t === 'text' ? 'text' : 'shape',
      ...(t === 'text' ? {} : { shape: t }),
      x: int(s.x, 0), y: int(s.y, 0), w: int(s.w, 0), h: int(s.h, 0),
      ...(s.text ? { text: s.text } : {}),
    })
  }
  ;(canvas.e ?? []).forEach((e, i) => {
    const from = endpoint(e.a)
    const to = endpoint(e.b)
    if (!from || !to) return
    elements.push({ id: `e${i + 1}`, type: 'connector', from, to, ...(e.label ? { label: e.label } : {}) })
  })

  // 卡片与元素都空 = 这篇其实没在用画布 → 不发 canvas 键(懒物化口径),让它就是一篇普通 v4 笔记。
  const canvasJson = cards.length || elements.length
    ? JSON.stringify({
        v: 1,
        mode: canvas.mode === 'canvas' ? 'canvas' : 'doc',
        main: { x: 0, y: 0, w: MAIN_W },
        cards,
        ...(elements.length ? { elements } : {}),
      })
    : null

  // fmExtra 去掉已被转换的 canvas 行(留着 = 同一份几何两个真源,下一个写手改哪份都对不上)。
  const fmExtra = (page.manifest.fmExtra ?? '')
    .split('\n')
    .filter((l) => !PLUGIN_CANVAS_LINE.test(l))
    .join('\n')

  const body = [...mainSegments, ...cardSegments].join('\n\n')
  return { ok: true, src: compileV4({ fmExtra, layout: null, canvas: canvasJson, body, kind: 'structured' }) }
}
