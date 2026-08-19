// v4 格式层(spec:monorepo docs/Function/Amadeus-v4格式规范与迁移方案.md,2026-08-13):
// 块从存储单位降级为呈现单位。素文件 = 纯 markdown(零 frontmatter 零标记,与外来 md 同构);
// 结构化文件(有分栏/锚点才出现)= `amadeus_schema: amadeus.page/4` + 按需 `<!-- a id -->` 锚
// + `amadeus_layout` 只列分栏行。
//
// 锚的辖域(Codex #2 后定稿):**被 layout 引用的锚 = 从锚行到下一锚或文件尾**(与 v3 相同,
// 一格分栏单元格可容多个 md 节点/空单元格=裸锚);**未被引用的锚 = 惰性**,不切分文档,仅在
// 将来被散文引用(`![[note#id]]`)时按「命名紧随其后的一个块级节点」取内容。辖域按 layout
// refs 判定,解析期即可决定。
//
// v4 不写 amadeus_page(页身份=路径;全端核实页 id 零消费者)也不写 amadeus_next_id(锚永不
// 重编号,无需高水位);`amadeus_` 前缀整体保留(未知 amadeus_* 键 → 按 v3 处理,升级时剥除)。
//
// DORMANT:本模块目前没有调用方——统一实例编辑器落地前 loadPage/compile 仍走 v3;先行合入
// 是为了用契约测试钉住格式,与 v3→v4 升级规则。

import { z } from 'zod'
import { BLOCK_MARKER_RE, blockMarker } from './markers'
import { parsePageSource } from './page'
import { AMADEUS_FM_KEY, extractFrontmatterExtra, parseFrontmatter, schemaMajorOf, stripFrontmatter } from './split'

export const PAGE_SCHEMA_V4 = 'amadeus.page/4' as const
export const SCHEMA_MAJOR_V4 = 4

// ── 识别(spec §3.1):按 frontmatter 键判,绝不按标记判 ─────────────────────────────
// 外来 md 里的无辜注释 `<!-- a note -->` 恰好匹配标记语法;按标记判会把它送进 parseV3,
// 触发补号并在打开时落盘改写外来文件。

export type PageClass = 'v3' | 'v4-plain' | 'v4-structured' | 'future'

export function classifyPageSource(raw: string): PageClass {
  const fm = parseFrontmatter(raw)
  const major = schemaMajorOf(fm)
  if (major != null && major > SCHEMA_MAJOR_V4) return 'future'
  if (major === SCHEMA_MAJOR_V4) return 'v4-structured'
  // 任一 amadeus_ 前缀键在场(含解析不出 major 的 amadeus_schema、未知的 amadeus_* 键)
  // → v3 尽力而为:前缀是整体保留的,未知键宁可保守当 v3 也不能误判成素文件(Codex #5)。
  // 实测全部 5 库 0 个「有标记但无 amadeus_layout」的 v3 文件,此规则无漏判(2026-08-13)。
  if (Object.keys(fm).some((k) => k.startsWith('amadeus_'))) return 'v3'
  return 'v4-plain'
}

// ── 分栏布局编解码(spec §3.3):只描述分栏行,自然流不进 layout ────────────────────

const v4ColumnSchema = z.object({ refs: z.array(z.string()), width: z.number() })
/** tail = 行尾界标锚(可选):锚辖域=「锚行到下一锚或文件尾」,行在文件中间而行后内容无锚时,
 *  末列会把后续自然流整个吞进来。升级/编辑器写出的分栏行一律带 tail 封底(语法仍是普通锚注释)。 */
const v4RowSchema = z.object({ columns: z.array(v4ColumnSchema), tail: z.string().optional() })
const v4LayoutSchema = z.object({ v: z.literal(4), rows: z.array(v4RowSchema) })

export type V4Column = z.infer<typeof v4ColumnSchema>
export type V4Row = z.infer<typeof v4RowSchema>
export type V4Layout = z.infer<typeof v4LayoutSchema>

export function serializeV4Layout(layout: V4Layout): string {
  return JSON.stringify(layout)
}

/** null on absent/invalid — 读侧容错:布局坏了内容按自然流呈现,绝不因布局丢正文。 */
export function parseV4Layout(value: string | undefined): V4Layout | null {
  if (!value) return null
  try {
    return v4LayoutSchema.parse(JSON.parse(value))
  } catch {
    return null
  }
}

// ── 解析/编译 ────────────────────────────────────────────────────────────────────

export interface V4Page {
  kind: 'plain' | 'structured'
  /** 外来 frontmatter 原文行(与 v3 fmExtra 同义);'' = 无。 */
  fmExtra: string
  /** 分栏布局;素文件与无分栏的结构化文件为 null。 */
  layout: V4Layout | null
  /** `amadeus_canvas` 单行 JSON 原文(画布几何,不解释内容);无画布为 null。
   *  刻意存原文而非解析对象:画布 schema 独立演进(§8),编译器只负责字节保全与 schema 不变式。 */
  canvas: string | null
  /** frontmatter 之后的正文,原样保留(锚点标记行含在内)。 */
  body: string
  /** 正文里出现的锚点 id,按文序。素文件中它们是惰性的(仅被引用时才有意义)。 */
  anchors: string[]
}

function scanAnchors(body: string): string[] {
  const out: string[] = []
  for (const line of body.split('\n')) {
    const m = BLOCK_MARKER_RE.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

/** 首尾规整:去掉正文头部空行(CRLF 同样认),尾部收敛为恰好一个 LF。规范格式的 md 文件是
 *  不动点;纯空白文件规整为空串(不主张字节级往返)。正文中段的 CRLF 原样保留。 */
function normalizeBody(body: string): string {
  const b = body.replace(/^(?:\r?\n)+/, '').replace(/(?:\r?\n)+$/, '')
  return b ? `${b}\n` : ''
}

export function parseV4Source(raw: string): V4Page {
  const cls = classifyPageSource(raw)
  if (cls !== 'v4-plain' && cls !== 'v4-structured') {
    throw new Error(`amadeus v4: source is ${cls}, not a v4 page (classify first)`)
  }
  const fm = parseFrontmatter(raw)
  const body = normalizeBody(stripFrontmatter(raw))
  return {
    kind: cls === 'v4-structured' ? 'structured' : 'plain',
    fmExtra: extractFrontmatterExtra(raw),
    layout: cls === 'v4-structured' ? parseV4Layout(fm.amadeus_layout) : null,
    // 空值(`amadeus_canvas:`)不折成 null:那是「画布键在场但值坏了」,按 §3.2 读侧容错
    // 逐字保留、本次会话按无画布渲染 —— 折成 null 会让写侧连键带 schema 一起剥掉(Codex P2)。
    canvas: cls === 'v4-structured' && fm.amadeus_canvas != null ? fm.amadeus_canvas.trim() : null,
    body,
    anchors: scanAnchors(body),
  }
}

/** 与 compile() 同一道写盘过滤。已知保留键与裸 '---' 行恒拒;未知 `amadeus_*` 前缀键**按来源分**
 *  (spec §6.0-3 / §8,Codex 评审 P1):
 *  - 来源已是 v4-structured → **保留**:未知 amadeus_* 是不透明扩展元数据(只承诺字节保全,不承诺
 *    语义),剥掉 = 新端写的扩展被老端一次保存静默吞掉;
 *  - 升级路径 / 素文件 → **剥除**:v3 遗留垃圾键不加区分地穿透,文件会缺 schema 又带 amadeus_ 键,
 *    下次 classify 二次误判成 v3。 */
const AMADEUS_PREFIX_LINE = /^["']?amadeus_[A-Za-z0-9_-]*["']?\s*:/
function sanitizeFmExtra(fmExtra: string, keepUnknown: boolean): string {
  return fmExtra
    .split('\n')
    .map((l) => l.replace(/\r$/, '')) // CRLF 源文的行尾 \r 不进重建的 frontmatter
    .filter((l) => !AMADEUS_FM_KEY.test(l) && !/^---\s*$/.test(l))
    .filter((l) => keepUnknown || !AMADEUS_PREFIX_LINE.test(l))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
}

/** **结构键发射的唯一判据**(方案 §6.0-1,2026-08-15):`amadeus_schema` 在场 ⟺ 分栏或画布任一在场。
 *  两个真实写点(本文件的 compileV4 + desktop 的 fm 行级 splice)必须共用这一份——各判各的迟早
 *  写出「剥了 schema 却留着 canvas 行」的半吊子文件,而 classifyPageSource 见任一 amadeus_ 前缀键
 *  无 schema 即判 v3 → 文件被拽进 v3 管线补号改写,画布连同正文一起毁(Codex P0)。
 *  返回的是**结构键行**,顺序固定 schema→layout→canvas;两个 JSON 参数都必须是单行 stringify 输出。 */
export function structureKeysFor(layoutJson: string | null, canvasJson: string | null): string[] {
  if (layoutJson == null && canvasJson == null) return []
  return [
    `amadeus_schema: ${PAGE_SCHEMA_V4}`,
    ...(layoutJson != null ? [`amadeus_layout: ${layoutJson}`] : []),
    ...(canvasJson != null ? [`amadeus_canvas: ${canvasJson}`] : []),
  ]
}

export function compileV4(page: Pick<V4Page, 'fmExtra' | 'layout' | 'canvas' | 'body'> & Partial<Pick<V4Page, 'kind'>>): string {
  // kind 缺省按 'plain' 处理(=剥掉未知 amadeus_* 的保守侧):parseV4Source 的产物天然带 kind,
  // 常规「parse → 改 → compile」链自动走对;只有手搭字面量才需要显式声明。
  const extra = sanitizeFmExtra(page.fmExtra, page.kind === 'structured')
  const body = normalizeBody(page.body)
  // 素文件(无分栏无画布且无外来 fm)= 纯正文,与外来 md 同构。
  const lines = [
    ...structureKeysFor(page.layout ? serializeV4Layout(page.layout) : null, page.canvas),
    ...(extra ? [extra] : []),
  ]
  if (!lines.length) return body
  const fm = ['---', ...lines, '---'].join('\n')
  return body ? `${fm}\n\n${body}` : `${fm}\n`
}

// ── v3 → v4 升级(spec §5.1) ─────────────────────────────────────────────────────

export type UpgradeRefusalReason =
  /** 输入不是 v3(素文件/结构化 v4 无需升级;future 绝不动)。 */
  | 'not-v3'
  /** mindmap/excalidraw 等结构文件按文件名排除(块=真实存储单元,保持 v3 标记制)。 */
  | 'plugin-structured-file'
  /** frontmatter 携带 layout 之外的块 id 树(mindmap:/dashboard 键),剥标记会剪断它们。 */
  | 'plugin-structured-frontmatter'

export type UpgradeResult = { ok: true; src: string } | { ok: false; reason: UpgradeRefusalReason }

/** 布局之外持有块 id 的已知 frontmatter 键(宿主 dashboard + mindmap 插件 + **已退役的**画布插件)。
 *  升级一律拒绝,这些文件留在 v3。清单刻意保守:未知插件键不在此列,但那类文件也都以专属扩展名收尾。
 *  键容忍 YAML 引号:`"mindmap":` 漏判会剥标记剪树(Codex #3)。
 *  ⚠️裸 `canvas:`(2026-08-14 画布插件的旧格式)**留在表上**:画布 2026-08-16 转原生之后这类文件
 *  已无生产者,但存量文件的坐标/连线仍按块 id 引用,升级剥标记会让它们整片孤儿 —— 失效闭合,
 *  存量原样留在 v3 由用户自行处置。原生画布用的是 `amadeus_canvas`(行首带 amadeus_ 前缀,不匹配本正则)。 */
const FOREIGN_ID_TREE_KEY = /^["']?(mindmap|mindmap_rel|dashboard|canvas)["']?\s*:/m

/** 路径闸:这些扩展名的文件恒留 v3(格式归各自的插件所有)。
 *  ⚠️2026-08-16 `canvas` 已移出:画布转为**任意 v4 笔记的一种模式**(fm 键 `amadeus_canvas`,
 *  首次真用才物化),`.canvas.md` 不再是一等文件类型 —— 它就是个普通笔记,照常升 v4。
 *  存量插件格式文件由上面的 fm 键闸兜住,不会被这一刀带走。 */
const PLUGIN_FILETYPE = /\.(mindmap|excalidraw)\.md$/i

/** 把一份 v3 源文升级为 v4 源文(纯函数,不落盘;调用方负责「首次编辑才升」的时机)。
 *  平凡布局(无分栏)→ 素文件:剥全部标记与 amadeus_* 键;含分栏 → 仅保留分栏行内块的
 *  锚(id 原样,历史引用不断)+ v4 布局。amadeus_page/amadeus_next_id 一律不再携带。 */
export function upgradeV3Source(pagePath: string, raw: string, now: string): UpgradeResult {
  if (PLUGIN_FILETYPE.test(pagePath)) return { ok: false, reason: 'plugin-structured-file' }
  if (classifyPageSource(raw) !== 'v3') return { ok: false, reason: 'not-v3' }

  const page = parsePageSource(pagePath, raw, now)
  const fmExtra = page.manifest.fmExtra ?? ''
  if (FOREIGN_ID_TREE_KEY.test(fmExtra)) return { ok: false, reason: 'plugin-structured-frontmatter' }

  const rows: V4Row[] = []
  const segments: string[] = []
  // tail 界标 id 池:与既有块 id 不撞(锚辖域到下一锚/EOF,分栏行不封底会把行后自然流吞进末列,
  // Codex 终审 P1;恒发 tail,行在文件尾时也无害 —— 读侧折叠会把它吸进行属性)。
  const usedIds = new Set(Object.keys(page.blocks))
  let tailN = 1
  const freshTail = (): string => {
    let id = `t${tailN++}`
    while (usedIds.has(id)) id = `t${tailN++}`
    usedIds.add(id)
    return id
  }
  for (const row of page.manifest.root.children) {
    const multiCol = row.columns.length > 1
    const tail = multiCol ? freshTail() : null
    if (multiCol) {
      rows.push({ columns: row.columns.map((c) => ({ refs: c.children.map((r) => r.ref), width: c.width })), tail: tail! })
    }
    for (const col of row.columns) {
      for (const ref of col.children) {
        // 保住块首行首横向空白(段落缩进档=行首制表符,indentIo):裸 .trim() 会抹缩进。
        // trimEnd 而非 /\s+$/(长空白 run 二次方回溯,评审 P1);\r? 防 CRLF 垃圾前缀。
        const content = (page.blocks[ref.ref]?.content ?? '').replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()
        if (multiCol) {
          // 分栏行内的块保留锚(布局引用它;空块也要锚在场)。
          segments.push(content ? `${blockMarker(ref.ref)}\n\n${content}` : blockMarker(ref.ref))
        } else if (content) {
          // 自然流:剥标记,空块直接消失。
          segments.push(content)
        }
      }
    }
    if (tail) segments.push(blockMarker(tail))
  }

  const body = segments.join('\n\n')
  // canvas: null —— v3 源文不可能携带画布(画布是 v4 独有键;.canvas.md 插件文件在函数首行就被拒)。
  return { ok: true, src: compileV4({ fmExtra, layout: rows.length ? { v: 4, rows } : null, canvas: null, body }) }
}
