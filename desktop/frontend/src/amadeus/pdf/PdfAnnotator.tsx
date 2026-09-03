/**
 * 可批注 PDF 阅读器(布局对标 PDF Expert / UPDF:左缩略图栏 + 顶部工具栏 + 底部悬浮缩放/页码胶囊)。
 * 所有批注写进 PDF 本身(原生注释对象)→ 任何阅读器可见。两条写入路径,单一串行队列防双写:
 *  - pdf.js 原生编辑器:高亮(HIGHLIGHT)/添加文字(FREETEXT)→ 防抖 saveDocument() 覆盖写回;
 *  - pdf-lib(pdfMarkup.ts):下划线/波浪线/删除线(选区 QuadPoints)、便签(/Text)、书签(Outline)、
 *    形状(/Square /Circle /Line + /AP)、手写(/Ink,Excalidraw 手感)→ 先 flush pdf.js 待存内容,
 *    再改字节,写回后【必须】swapDoc 重载(否则 pdf.js 基线过期,下次 saveDocument 会把 pdf-lib 写的内容丢掉)。
 *    手写为免每笔一次重载打断连续书写,笔画先攒在预览层,防抖/切工具/卸载时整批入队。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
// ⚠️必须用 legacy 构建:pdf.js 5.7 用了 TC39 `Map.prototype.getOrInsertComputed`(upsert 提案),
// Electron 40 的 V8 未提供 → 非 legacy 版运行时崩「getOrInsertComputed is not a function」(主线程 + worker 都用到)。
// legacy 版内置 core-js polyfill(主/worker 各自打)。故 core/viewer/worker/css 全部走 legacy 路径。
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { AnnotationEditorType, AnnotationEditorParamsType } from 'pdfjs-dist/legacy/build/pdf.mjs'
// pdf_viewer.mjs = pdf.js 官方组件包(PDFViewer 全家桶);类型在同目录 .d.mts。
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
// ⚠️?inline + @scope:pdf_viewer.css 抢了 .dialog / .sidebar 等通用类名并**直接画背景色**,
// 全局注入会接管 Amadeus 全 App 共用的 Dialogs.tsx(className="dialog",23 处)——表现为「打开过 PDF 后
// 输入弹窗配色不对」。故不 import 副作用版,改注入 @scope 关进阅读器内。见 ensureScopedCss。
import pdfViewerCss from 'pdfjs-dist/legacy/web/pdf_viewer.css?inline'
import './pdfAnnotator.css'
import {
  BookmarkPlus, Circle, Eraser, Highlighter, Minus, MousePointer2, MoveUpRight, PanelLeft, PenLine, Square,
  StickyNote, Strikethrough, Type, Underline as UnderlineIcon, Waves,
} from 'lucide-react'
import { isHostPath, buildPdfLink } from '@amadeus-shared/pdfLink'
import { askString } from '../components/askString'
import { amadeus } from '../api'
import { registerMessages, translate, useI18n } from '../../i18n'
import {
  addBookmark, addInk, addNote, addShape, addTextMarkup,
  EDITABLE_SUBTYPES, INK_ONLY, MOVABLE_SUBTYPES, removeAnnots, setAnnotContents, translateAnnots,
  type InkStroke, type MarkupKind, type ShapeKind, type ShapeStyle,
} from './pdfMarkup'
import { paintHlBands } from './hlBand'
/** 引语落地提醒动画的时长,必须与 pdfAnnotator.css 里 .pdfa-citehl-band.is-pulse 的一致。 */
const PULSE_MS = 1000
import { frameOf, pageAt, pointOnPage, selectionToQuads } from './selectionQuads'
import { distToFlatSq, distToPointsSq, outlineToSvgPath, strokeOutline } from './inkStroke'

// ⚠️模块级的 PALETTE / TOOLS / ZOOMS 只存**键**,渲染时才 t()/translate() —— 存字面量会在模块加载
// 那一刻冻住,切语言不再更新(工具提示/颜色名/缩放档全是模块级表)。
registerMessages({
  'pdfa.colorYellow': { zh: '黄', en: 'Yellow' },
  'pdfa.colorGreen': { zh: '绿', en: 'Green' },
  'pdfa.colorBlue': { zh: '蓝', en: 'Blue' },
  'pdfa.colorPink': { zh: '粉', en: 'Pink' },
  'pdfa.colorOrange': { zh: '橙', en: 'Orange' },
  'pdfa.colorRed': { zh: '红', en: 'Red' },
  'pdfa.colorBlack': { zh: '黑', en: 'Black' },
  'pdfa.toolMouse': { zh: '鼠标(选择文字/滚动)', en: 'Pointer (select text, scroll)' },
  'pdfa.toolHighlight': { zh: '高亮(选中文本;空白处拖拽=自由高亮)', en: 'Highlight (select text; drag on a blank area for a free-form highlight)' },
  'pdfa.toolUnderline': { zh: '下划线(选中文本即标)', en: 'Underline (select text to mark it)' },
  'pdfa.toolSquiggly': { zh: '波浪线(选中文本即标)', en: 'Squiggly underline (select text to mark it)' },
  'pdfa.toolStrikeout': { zh: '删除线(选中文本即标)', en: 'Strikethrough (select text to mark it)' },
  'pdfa.toolText': { zh: '添加文字(点击页面输入)', en: 'Add text (click the page to type)' },
  'pdfa.toolNote': { zh: '便签评论(点击页面放置)', en: 'Sticky note (click the page to place one)' },
  'pdfa.toolPen': { zh: '手写笔(压感笔迹写进 PDF;支持数位笔)', en: 'Pen (pressure-sensitive ink written into the PDF; stylus supported)' },
  'pdfa.toolEraser': { zh: '橡皮(拖过手写笔迹即擦除)', en: 'Eraser (drag across ink to erase it)' },
  'pdfa.toolRect': { zh: '矩形(在页面上拖拽)', en: 'Rectangle (drag on the page)' },
  'pdfa.toolCircle': { zh: '圆形/椭圆(在页面上拖拽)', en: 'Ellipse (drag on the page)' },
  'pdfa.toolLine': { zh: '直线(在页面上拖拽)', en: 'Line (drag on the page)' },
  'pdfa.toolArrow': { zh: '箭头(在页面上拖拽)', en: 'Arrow (drag on the page)' },
  'pdfa.zoomFitWidth': { zh: '适宽', en: 'Fit width' },
  'pdfa.zoomFitPage': { zh: '适页', en: 'Fit page' },
  'pdfa.writeFailed': { zh: '写入失败:此 PDF 可能受保护或已损坏', en: 'Could not save — this PDF may be protected or damaged' },
  'pdfa.noteTitle': { zh: '便签评论', en: 'Sticky note' },
  'pdfa.add': { zh: '添加', en: 'Add' },
  'pdfa.editNoteTitle': { zh: '编辑便签', en: 'Edit note' },
  'pdfa.save': { zh: '保存', en: 'Save' },
  'pdfa.bookmarkTitle': { zh: '添加书签(写进 PDF 目录)', en: 'Add bookmark (written into the PDF outline)' },
  'pdfa.pageN': { zh: '第 {n} 页', en: 'Page {n}' },
  'pdfa.sidebar': { zh: '侧栏(缩略图/目录)', en: 'Sidebar (thumbnails and outline)' },
  'pdfa.colorTitle': { zh: '批注颜色', en: 'Annotation color' },
  'pdfa.colorNamed': { zh: '颜色:{name}', en: 'Color: {name}' },
  'pdfa.fillToHollow': { zh: '实心(点击改为空心)', en: 'Filled (click for outline only)' },
  'pdfa.hollowToFill': { zh: '空心(点击改为实心)', en: 'Outline (click to fill)' },
  'pdfa.filled': { zh: '实心', en: 'Filled' },
  'pdfa.hollow': { zh: '空心', en: 'Outline' },
  'pdfa.strokeWidth': { zh: '线宽', en: 'Stroke width' },
  'pdfa.opacity': { zh: '不透明度', en: 'Opacity' },
  'pdfa.penWidth': { zh: '笔迹粗细', en: 'Pen thickness' },
  'pdfa.addBookmark': { zh: '添加书签(写进 PDF 目录,任何阅读器可见)', en: 'Add bookmark (written into the PDF outline, visible in any reader)' },
  'pdfa.copyLinkTitle': { zh: '复制指向本页的笔记链接', en: 'Copy a note link to this page' },
  'pdfa.copied': { zh: '已复制', en: 'Copied' },
  'pdfa.copyPageLink': { zh: '复制本页链接', en: 'Copy link to this page' },
  'pdfa.thumbnails': { zh: '缩略图', en: 'Thumbnails' },
  'pdfa.outline': { zh: '目录', en: 'Outline' },
  'pdfa.zoomOut': { zh: '缩小', en: 'Zoom out' },
  'pdfa.zoomTitle': { zh: '缩放(⌘/Ctrl+滚轮 或 触控板捏合)', en: 'Zoom (⌘/Ctrl + scroll wheel, or trackpad pinch)' },
  'pdfa.zoomIn': { zh: '放大', en: 'Zoom in' },
  'pdfa.prevPage': { zh: '上一页', en: 'Previous page' },
  'pdfa.pageInput': { zh: '页码(回车跳转)', en: 'Page number (press Enter to jump)' },
  'pdfa.nextPage': { zh: '下一页', en: 'Next page' },
  'pdfa.loading': { zh: '加载中…', en: 'Loading…' },
  'pdfa.loadError': { zh: '无法加载此 PDF', en: 'Could not load this PDF' },
  'pdfa.retry': { zh: '重试', en: 'Retry' },
  'pdfa.edit': { zh: '编辑', en: 'Edit' },
  'pdfa.delete': { zh: '删除', en: 'Delete' },
  'pdfa.deleteN': { zh: '删除 {n} 条', en: 'Delete {n}' },
  'pdfa.outlineEmpty': { zh: '无目录/书签', en: 'No outline or bookmarks' },
  'pdfa.outlineEmptyHint': { zh: '工具栏「+书签」可添加', en: 'Add one with the bookmark button in the toolbar' },
  'pdfa.untitled': { zh: '(无标题)', en: '(untitled)' },
})

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

/** pdf.js 官方样式表关进 `.pdfa-root` 内(见 import 处注释)。两处改写缺一不可,改动前先跑
 *  `node scripts/pdf-css-scope.check.cjs`(真浏览器断言隔离生效 + 变量没丢 + 运行时高度能进来):
 *  ① `:root` → `:scope`:@scope 内 `:root` 永不匹配(html 不在作用域里)→ 其 CSS 变量全丢、渲染错乱。
 *  ② 剔掉 `--viewer-container-height:0`:pdf.js **运行时**把它写在 `document.documentElement` 上
 *     (viewer 里唯一这么干的变量),而 ① 之后 `:scope` 的同名声明会压过从 html 继承来的真值 →
 *     .dummyPage 高度恒为 0。`:root` 里那个 0 本就只是 JS 跑之前的兜底默认,删掉正好继承。 */
const CSS_ID = 'pdfjs-viewer-scoped'
export const scopePdfCss = (css: string): string =>
  `@scope (.pdfa-root) {\n${css.replace(/:root\b/g, ':scope').replace(/--viewer-container-height:\s*0;/g, '')}\n}`
function ensureScopedCss(): void {
  if (document.getElementById(CSS_ID)) return
  const el = document.createElement('style')
  el.id = CSS_ID
  el.textContent = scopePdfCss(pdfViewerCss)
  document.head.append(el)
}

/** 调色板(名的 i18n 键→色);annotationEditorHighlightColors 需 `k=#hex,` 串。高亮/标记/便签/形状共用。 */
const PALETTE: ReadonlyArray<readonly [string, string]> = [
  ['pdfa.colorYellow', '#ffe14d'], ['pdfa.colorGreen', '#8ce99a'], ['pdfa.colorBlue', '#74c0fc'],
  ['pdfa.colorPink', '#ffa8c5'], ['pdfa.colorOrange', '#ffc078'], ['pdfa.colorRed', '#ff6b6b'],
  ['pdfa.colorBlack', '#1e1e1e'], // Excalidraw 默认墨色,主要给手写笔用
]
const HIGHLIGHT_COLORS = PALETTE.map(([, hex], i) => `c${i}=${hex}`).join(',')

type Tool = 'mouse' | 'highlight' | 'underline' | 'squiggly' | 'strikeout' | 'text' | 'note' | 'pen' | 'eraser' | ShapeKind
/** 手写/橡皮是一对:在两者间切换不触发落盘(待写笔画留在预览层,橡皮可即时擦);切出这一对才提交。 */
const INK_PAIR: ReadonlySet<Tool> = new Set<Tool>(['pen', 'eraser'])
const MARKUP_TOOLS: ReadonlySet<Tool> = new Set<Tool>(['underline', 'squiggly', 'strikeout'])
const SHAPE_TOOLS: ReadonlySet<Tool> = new Set<Tool>(['rect', 'circle', 'line', 'arrow'])
/** 工具 → pdf.js 编辑器模式(标记/便签/形状走自建管线,编辑器保持 NONE)。 */
const TOOL_MODE: Partial<Record<Tool, number>> = {
  highlight: AnnotationEditorType.HIGHLIGHT,
  text: AnnotationEditorType.FREETEXT,
}
const modeOf = (t: Tool): number => TOOL_MODE[t] ?? AnnotationEditorType.NONE

/** tip = i18n 键(模块级表不能存已翻好的文案,见 registerMessages 上方注释),渲染时 t(tip)。 */
const TOOLS: ReadonlyArray<{ id: Tool; tip: string; Icon: typeof MousePointer2; gap?: boolean }> = [
  { id: 'mouse', tip: 'pdfa.toolMouse', Icon: MousePointer2 },
  { id: 'highlight', tip: 'pdfa.toolHighlight', Icon: Highlighter },
  { id: 'underline', tip: 'pdfa.toolUnderline', Icon: UnderlineIcon },
  { id: 'squiggly', tip: 'pdfa.toolSquiggly', Icon: Waves },
  { id: 'strikeout', tip: 'pdfa.toolStrikeout', Icon: Strikethrough },
  { id: 'text', tip: 'pdfa.toolText', Icon: Type },
  { id: 'note', tip: 'pdfa.toolNote', Icon: StickyNote },
  { id: 'pen', tip: 'pdfa.toolPen', Icon: PenLine, gap: true },
  { id: 'eraser', tip: 'pdfa.toolEraser', Icon: Eraser },
  { id: 'rect', tip: 'pdfa.toolRect', Icon: Square, gap: true },
  { id: 'circle', tip: 'pdfa.toolCircle', Icon: Circle },
  { id: 'line', tip: 'pdfa.toolLine', Icon: Minus },
  { id: 'arrow', tip: 'pdfa.toolArrow', Icon: MoveUpRight },
]
/** k = i18n 键(两个预设档);百分比档与语言无关,直接用 label。 */
const ZOOMS: ReadonlyArray<{ v: string; label?: string; k?: string }> = [
  { v: 'page-width', k: 'pdfa.zoomFitWidth' }, { v: 'page-fit', k: 'pdfa.zoomFitPage' },
  { v: '0.5', label: '50%' }, { v: '0.75', label: '75%' }, { v: '1', label: '100%' },
  { v: '1.25', label: '125%' }, { v: '1.5', label: '150%' }, { v: '2', label: '200%' }, { v: '3', label: '300%' },
]
const fmtZoom = (v: string): string => (Number.isNaN(parseFloat(v)) ? v : `${Math.round(parseFloat(v) * 100)}%`)
const WIDTHS = [1, 2, 3, 5, 8]
/** 手写笔独立粗细档(pt,视觉宽 ≈ ×4.25):比形状线宽细得多——写小字要极细的档。 */
const PEN_WIDTHS = [0.35, 0.5, 0.75, 1, 1.5, 2, 3, 5]
const OPACITIES = [1, 0.75, 0.5, 0.25]

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p

/** 拖拽中的形状预览(客户区坐标 → 相对 viewport 的定位盒)。 */
interface Drag { pageIndex: number; ax: number; ay: number; bx: number; by: number }

interface Engine {
  viewer: any
  linkService: any
  eventBus: any
  findController: any
  uiManager: any
  doc: any
  timer: ReturnType<typeof setTimeout> | null
  dirty: boolean
  chain: Promise<void>
  /** 最近一次成功写盘的字节。卸载时若 dead 挡掉了 swapDoc,doc 会落后于磁盘——尾部兜底必须以它为基线。 */
  lastBytes: Uint8Array | null
  /** doc 落后于磁盘(op 写盘成功但 swapDoc 没跑成):尾部兜底禁用 doc.saveDocument() 当基线。 */
  docStale: boolean
}
/** 返回 null = 本步放弃(轮到执行时发现无事可做,例如撤销栈已空):一个字节都不写。 */
type WriteOp = (bytes: Uint8Array) => Promise<Uint8Array | null>

/** 选中的注释条目;raw = pdf.js 解析的注释对象(拖动实时替身要读 inkLists/lineCoordinates/color)。 */
interface SelItem { id: string; pageIndex: number; rect: number[]; subtype: string; contents?: string; raw: any }

/** pdf.js 的 inkLists 形态随版本变([{x,y}] 或平铺数组)→ 统一成平铺。 */
const inkListsOf = (a: any): number[][] => {
  if (!Array.isArray(a?.inkLists)) return []
  return a.inkLists
    .map((l: any) => {
      if (!l?.length) return []
      if (typeof l[0] === 'object' && l[0] !== null) return l.flatMap((pt: any) => [pt.x, pt.y])
      return Array.from(l as ArrayLike<number>)
    })
    .filter((l: number[]) => l.length >= 2)
}

const rgbOf = (c: any): string => (c && c.length >= 3 ? `rgb(${c[0]} ${c[1]} ${c[2]})` : 'rgb(30 30 30)')

/** 页内容盒 → 滚动容器内容坐标系(随内容滚动;叠加层挂在容器里就天然跟手,零滞后)。 */
function pageBox(viewer: any, container: HTMLElement, pageIndex: number): { left: number; top: number; width: number; height: number; t: number[] } | null {
  const pv = viewer.getPageView(pageIndex)
  const frame = pv?.viewport ? frameOf(pv) : null
  if (!frame) return null
  const c = container.getBoundingClientRect()
  return {
    left: frame.left - c.left + container.scrollLeft,
    top: frame.top - c.top + container.scrollTop,
    width: frame.width,
    height: frame.height,
    t: pv.viewport.transform as number[],
  }
}

/** 库外 PDF 的字节:主进程 fs 直读(base64 回传,与 wsfile 预览同一条通道)。 */
async function readHostPdfBytes(p: string): Promise<Uint8Array> {
  const read = window.tangu?.readHostFile
  if (!read) throw new Error('当前环境不支持打开库外文件')
  const r = await read(p)
  if (!r || (r as { tooLarge?: boolean }).tooLarge) throw new Error('文件过大,无法预览')
  const bin = atob(r.content)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** readOnly:笔记内嵌预览形态——无工具栏/无侧栏/无选中编辑,绝不写盘(防与已打开的批注 tab 双实例互踩)。 */
export function PdfAnnotator({ pdfPath, initialPage, initialQuote, readOnly: readOnlyProp }: { pdfPath: string; initialPage?: number; initialQuote?: string; readOnly?: boolean }) {
  // 库外的 PDF(引用条给的是绝对路径):字节走主进程 fs 直读,**一律只读** —— 批注是写回 PDF 本体的,
  // 而写盘只有 vault 通道(saveVaultBytes),库外没有落笔的地方,给了工具栏就是假编辑入口。
  // 只读仍保留底栏(翻页/缩放),看书不受影响。外部深链进不来:deepLinkInstall 的闸对文件类 view
  // 只放行安全的 vault 相对路径,绝对路径在那一层就被拒了。
  // ⚠️只在下面的 return JSX / addBm 里用这个 t —— 大 effect 内部到处有叫 `t` 的局部量(工具/变换矩阵/
  // 轨迹点),且 effect 不随语言重跑,闭包里的 t 会是旧语言;effect 内一律用模块级 translate()。
  const { t } = useI18n()
  const hostPdf = isHostPath(pdfPath)
  const readOnly = readOnlyProp || hostPdf
  const viewportRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const eng = useRef<Engine | null>(null)
  const enqueueRef = useRef<((op?: WriteOp) => Promise<void>) | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [info, setInfo] = useState({ page: initialPage || 1, total: 0 })
  // 待跳页码:amadeus:pdf-goto 可能在文档还没就绪时到(点第二条引用时阅读器正在装载),
  // 当场跳是空操作 —— 记下来,等 pagesinit/pagesloaded 补跳。丢了就停在上一条引用的页(Codex 实证)。
  const pendingGoto = useRef<number | null>(null)
  // 待高亮的引语(引用条带 `&q=`):**临时高亮**,走 pdf.js 的 find —— 只在文本层加个 .highlight,
  // 一个字节都不写进 PDF(批注才写盘)。同 pendingGoto:文档没就绪时先记下,pagesloaded 再放。
  const pendingFind = useRef<string | null>(initialQuote || null)
  // 引语落地时给高亮带子放一次提醒动画(见 hlBand.ts 的 pulseAge)。两段:
  // ① pulseArm = 「已发 find,等落地」。find 到重画之间隔着 pdf.js 抽全文的异步过程(300 页几秒钟),
  //    期间会先来几次一个命中都没有的 textlayerrendered —— 只有真画出带子的那次才算落地,
  //    所以这里不能用固定时限,得等到 painted > 0。
  // ② pulseStart = 落地时刻。动画期内的重画按「已播毫秒数」用负 animation-delay 接着播(不是重来);
  //    过了 PULSE_MS 就再也不挂类 —— 滚动引发的重画绝不会二次放动画。
  const pulseArm = useRef(false)
  const pulseStart = useRef(0)
  const [color, setColor] = useState(PALETTE[0][1])
  const colorRef = useRef(PALETTE[0][1])
  const [tool, setTool] = useState<Tool>('mouse')
  const toolRef = useRef<Tool>('mouse')
  const [shape, setShape] = useState<{ fill: boolean; width: number; opacity: number }>({ fill: false, width: 2, opacity: 1 })
  const shapeRef = useRef(shape)
  const [penOpt, setPenOpt] = useState<{ width: number; opacity: number }>({ width: 0.75, opacity: 1 })
  const penOptRef = useRef(penOpt)
  const [drag, setDrag] = useState<Drag | null>(null)
  // 手写笔画三桶记账(高频 push 走 ref 不走 setState,inkTick 只催预览层重画):
  //   pending    未提交,可 ⌘Z 撤销,卸载时尾部兜底写入;
  //   committing 已被某次在途写入捕获——不可撤、不可重复提交;失败/中止会退回 pending;
  //   ghost      已落盘,只在预览层撑到该页 canvas 重画出笔迹(防闪没),谁也不再写它。
  // ⚠️这些 ref 只是预览层的取景窗:真正的数组每轮 effect 各建各的(见 effect 内 myPending 等),
  //   pdfPath 切换后旧链的退回/收尾都落在旧数组上,旧档笔画与新档互不可见。
  const pendingInk = useRef<InkStroke[]>([])
  const committingInk = useRef<InkStroke[]>([])
  const ghostInk = useRef<InkStroke[]>([])
  const liveInk = useRef<InkStroke | null>(null)
  const commitInkRef = useRef<(() => void) | null>(null)
  const warmAnnsRef = useRef<(() => void) | null>(null)
  // 鼠标模式的注释选中(可多选):sel={页, items[]},selDrag=拖动中的位移(PDF 单位),
  // selMarq=框选矩形(PDF 页坐标),selApi=浮条按钮的回调。
  const selRef = useRef<{ pageIndex: number; items: SelItem[] } | null>(null)
  const selDragRef = useRef<{ dx: number; dy: number } | null>(null)
  const selMarqRef = useRef<{ pageIndex: number; ax: number; ay: number; bx: number; by: number } | null>(null)
  const selApiRef = useRef<{ del: () => void; edit: () => void; clear: () => void } | null>(null)
  const [, setInkTick] = useState(0)
  const [side, setSide] = useState<'thumbs' | 'outline' | null>(readOnly ? null : 'thumbs')
  const [zoomSel, setZoomSel] = useState('page-width')
  const [, setDocVersion] = useState(0) // swapDoc 后催重渲染拿新 doc;不作 key——重挂会把缩略图清白闪一下
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0) // 重试:重建 viewer 重新读字节(自愈瞬时失败)

  useEffect(() => {
    ensureScopedCss()
    const container = containerRef.current
    if (!container) return
    let dead = false
    setStatus('loading')

    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus })
    const findController = new PDFFindController({ linkService, eventBus })
    const viewer = new PDFViewer({
      container,
      eventBus,
      linkService,
      findController, // 引用条的临时高亮(见 runFind);用户可见的只是文本层的选中色
      // 只读嵌入直接 DISABLE 编辑器机器:NONE 下选中文本仍会弹 pdf.js 浮动「高亮」按钮,
      // 点了看似成功、实则被 readOnly 的 enqueue 丢弃 = 假编辑入口(codex)。
      annotationEditorMode: readOnly ? AnnotationEditorType.DISABLE : AnnotationEditorType.NONE,
      annotationEditorHighlightColors: HIGHLIGHT_COLORS,
      enableHighlightFloatingButton: !readOnly, // 选中文本 → 浮动「高亮」按钮(只读不给)
      imageResourcesPath: 'pdfjs-annot/', // /Text 便签图标(public/pdfjs-annot/annotation-*.svg)
      // 以上几项在 v5.7 运行时被读取(pdf_viewer.mjs),.d.mts 类型未收录 → 断言。
    } as any)
    linkService.setViewer(viewer)
    const state: Engine = { viewer, linkService, eventBus, findController, uiManager: null, doc: null, timer: null, dirty: false, chain: Promise.resolve(), lastBytes: null, docStale: false }
    eng.current = state

    const flash = (msg: string): void => {
      setNotice(msg)
      window.setTimeout(() => setNotice(null), 2600)
    }

    // 撤销/恢复 = 字节快照栈:每次 pdf-lib 写入把写入前的整份 PDF 入栈,撤销即回放旧字节——
    // 手写/擦除/形状/标记/便签/书签/移动/改文全覆盖,不用给每种操作写逆操作。
    // 高亮/添加文字走 pdf.js 编辑器,有它自己的 ⌘Z,不进这套(双系统抢快捷键会乱)。
    const undoBytes: Uint8Array[] = []
    const redoBytes: Uint8Array[] = []
    const redoInk: InkStroke[] = [] // 逐笔撤销出来的待写笔画,⌘⇧Z 逐笔放回
    const pushHistory = (stack: Uint8Array[], b: Uint8Array): void => {
      stack.push(b)
      // ponytail: 每栈按字节总量封顶 ~150MB(大扫描件一份就几十 MB),超了丢最老的;
      // 写盘失败的恢复不找回被挤掉的旧条目(挤出×失败双重罕见,不值得为它做事务)。
      let total = stack.reduce((s, x) => s + x.byteLength, 0)
      while (stack.length > 1 && total > 150 * 1024 * 1024) total -= stack.shift()!.byteLength
    }

    /** 串行写队列:pdf.js 存档与 pdf-lib 写入互斥排队。op 缺省 = 纯 flush(防抖保存)。
     *  after(ok) 恰好调一次、无论成败/中止、**且在链内**(尾部兜底排在其后)——手写记账靠它:
     *  ok=true 字节已在磁盘(哪怕 dead/异常挡了 swapDoc);ok=false 完全没写(退回待写桶)。
     *  history=true 表示本次 op 是撤销/恢复的回放,不再入撤销栈(否则撤销自己会吃掉栈)。 */
    const enqueue = (op?: WriteOp, after?: (ok: boolean) => void, history = false): Promise<void> => {
      if (readOnly) { after?.(false); return Promise.resolve() } // 只读预览:绝不写盘
      let written = false
      let fired = false
      const fire = (ok: boolean): void => {
        if (fired) return
        fired = true
        after?.(ok)
      }
      const run = state.chain.then(async () => {
        if (dead || !state.doc) { fire(false); return }
        // docStale=上次 swapDoc 没跑成,doc 落后于磁盘:纯 flush 必须压掉(旧 doc+脏内容会盖掉磁盘上
        // 更新的字节);op 写入则改以磁盘字节为基线。该窗内编辑器未存改动本就随换档丢(既有语义)。
        if (!op && (!state.dirty || state.docStale)) return
        if (state.timer) { clearTimeout(state.timer); state.timer = null }
        const wasDirty = state.dirty
        state.dirty = false // 编辑器待存内容随本次 flush 一并落盘
        const before = state.lastBytes // 本次写之前的磁盘状态(flush 的撤销快照:base 已含编辑器新内容)
        const base: Uint8Array = state.docStale && state.lastBytes ? state.lastBytes : await state.doc.saveDocument()
        const next = op ? await op(base) : base
        if (next === null) { // 历史类 op 轮到时发现无事可做:什么都不动,编辑器脏标还回去(只升不降:await 期间可能又脏了)
          if (wasDirty) state.dirty = true
          fire(true)
          return
        }
        await amadeus.saveVaultBytes(pdfPath, next)
        state.lastBytes = next
        written = true
        if (!history) {
          // pdf-lib 写入:入栈 base(写前状态);写入时若编辑器有脏内容,before 先单独占一步,
          // 否则那次高亮/文字改动会并进相邻步一起被撤掉。纯 flush:入栈 before。
          if (op) {
            if (wasDirty && before) pushHistory(undoBytes, before)
            pushHistory(undoBytes, base)
          } else if (before) {
            pushHistory(undoBytes, before)
          }
          if (op || before) redoBytes.length = 0 // 新写入作废恢复分支(标准撤销语义)
        }
        if (op) state.docStale = true // 磁盘领先 doc,直到 swapDoc 追平
        if (op && !dead) {
          await swapDoc(next)
          if (!dead) state.docStale = false // dead 早退时 swapDoc 没装新 doc,stale 必须留着
        }
        fire(true)
      }).catch((e: unknown) => {
        state.dirty = true // 失败留脏,下次编辑再试
        console.error('[pdf] 写入失败', e)
        if (!dead) flash(translate('pdfa.writeFailed'))
        fire(written) // 写盘成功只是 swap/回调环节炸了 → 对记账而言就是「已落盘」,绝不能退回去重写一遍
      })
      state.chain = run
      return run
    }
    enqueueRef.current = enqueue

    const scheduleSave = (): void => {
      if (state.timer) clearTimeout(state.timer)
      state.timer = setTimeout(() => void enqueue(), 1500)
    }
    const markDirty = (): void => { if (readOnly) return; state.dirty = true; scheduleSave() }

    // 组件包不监听 switchannotationeditorparams(那是 Firefox 完整版 app.js 的活),
    // 必须自己抓住 uiManager 直接 updateParams,否则高亮调色板点了没反应。
    eventBus.on('annotationeditoruimanager', (e: { uiManager: any }) => { state.uiManager = e.uiManager })
    const applyHighlightColor = (): void => {
      try { state.uiManager?.updateParams(AnnotationEditorParamsType.HIGHLIGHT_COLOR, colorRef.current) } catch { /* ignore */ }
    }
    let curScale = 'page-width' // 用户当前缩放(scalechanging 维护);换档恢复只信它,不读 viewer(见 swapDoc 注释)

    /** 挂载文档(初载与 pdf-lib 写后重载共用)。
     *  keep='preserve'(写后重载):滚动位置全程**物理保留**——快照层的撑高垫片让内容不塌缩,
     *  scrollTop 从头到尾没变过,一个坐标都不写回。写回才是偏移/回跳的来源:塌缩把 scrollTop 钳到 0,
     *  惯性滚动又从 0 接着滚,这时「恢复」与「不恢复」都错(拽回=偏移,放着=回到首页)。
     *  只在 pagesloaded 后补一个合成 scroll 让 pdf.js 按真实 scrollTop 重算页码
     *  (setDocument 会把内部页码直写回 1,不广播;scroll 监听是它自己绑在 container 上的)。
     *  keep={page}(初载):跳到目标页;pagesloaded 且用户没翻页时再钉一次(pagesinit 的页高还是占位值)。 */
    /** 临时高亮一段引语:pdf.js find(只在文本层画高亮,绝不写盘)。空串 = 清掉上一次的高亮。 */
    const runFind = (q: string): void => {
      if (q) { pulseArm.current = true; pulseStart.current = 0 } // 落地那一次要放提醒动画(清高亮的空串不算)
      eventBus.dispatch('find', {
        source: window, type: '', query: q, caseSensitive: false, entireWord: false,
        highlightAll: true, findPrevious: false, matchDiacritics: false,
      })
    }

    let offAttach: (() => void) | null = null
    const attach = (doc: any, keep: { page: number } | 'preserve'): void => {
      annCache.clear() // 换了文档,橡皮/选择的注释缓存全部作废
      eraseTrail = [] // 旧文档的擦除轨迹不许重放到新文档上(会误擦轨迹经过处新写的笔画)
      pendingMarq = null // 未结算的框选同理:旧文档的框不许在新缓存上结算
      offAttach?.() // 连续换档时上一轮 attach 的 once 监听可能还没触发,不摘会拿着旧 keep 在新文档上乱跳
      viewer.setDocument(doc)
      linkService.setDocument(doc, null)
      findController.setDocument(doc) // 不接的话 find 事件被 firstPageCapability 永远挂住
      ;(doc.annotationStorage as any).onSetModified = markDirty
      const target = keep === 'preserve' ? 0 : Math.min(doc.numPages, Math.max(1, keep.page))
      // 装载期间到的 goto 优先于 attach 时的目标页(用户后点的那条引用才是他要看的)
      const wanted = (): number => Math.min(doc.numPages, Math.max(1, pendingGoto.current ?? target))
      const onInit = (): void => {
        if (dead) return
        viewer.currentScaleValue = curScale
        if (!readOnly) try { viewer.annotationEditorMode = { mode: modeOf(toolRef.current) } } catch { /* ignore */ }
        applyHighlightColor()
        const want = wanted()
        if (want > 1) viewer.currentPageNumber = want
      }
      const onLoaded = (): void => {
        if (dead) return
        const want = wanted()
        pendingGoto.current = null
        if (keep === 'preserve') container.dispatchEvent(new Event('scroll'))
        else if (want > 1 && viewer.currentPageNumber === want) viewer.currentPageNumber = want // 占位高→真实高,再钉一次;用户已翻页则不打扰
        // 页码先落位再找:pdf.js 从当前页往后找第一处,先跳页才不会命中前面几章的同名句子。
        if (pendingFind.current) { runFind(pendingFind.current); pendingFind.current = null }
      }
      eventBus.on('pagesinit', onInit, { once: true })
      eventBus.on('pagesloaded', onLoaded, { once: true })
      offAttach = () => { eventBus.off('pagesinit', onInit); eventBus.off('pagesloaded', onLoaded) }
      setInfo((p) => (keep === 'preserve'
        ? { page: Math.min(p.page, doc.numPages) || 1, total: doc.numPages }
        : { page: target, total: doc.numPages }))
      setDocVersion((v) => v + 1)
    }

    /** 写后重载防闪:把当前可见页的 canvas 拷成静态快照压在上面,新文档哪页重画完成就撤哪页的快照——
     *  没有它,setDocument 会先清空再异步重画,每次 pdf-lib 写入(批注/手写/擦除)都白闪一下。
     *  返回 arm:attach 装上新文档后才调用——旧文档迟到的 pagerendered 不许撤快照(否则闪回);
     *  连续提交时,还没重画完的页复用上一张快照的像素(此刻活 canvas 可能是半张白纸)。 */
    let dropHold: (() => void) | null = null
    let holdOverlay: HTMLDivElement | null = null
    const holdPages = (): { arm: () => void; cancel: () => void } => {
      const prev = holdOverlay
      const cRect = container.getBoundingClientRect()
      const overlay = document.createElement('div')
      overlay.className = 'pdfa-hold'
      // 撑住滚动区:setDocument 清空页面的瞬间内容塌缩,scrollTop 被浏览器钳回 0——用户的惯性滚动
      // 会从 0 接着滚,事后怎么恢复都两难(见 attach 注释)。垫片把旧文档的滚动尺寸原样撑到新文档
      // 排版完成,scrollTop 全程连续,换档后一个坐标都不用恢复。
      const spacer = document.createElement('div')
      spacer.className = 'pdfa-hold-spacer'
      spacer.style.width = `${container.scrollWidth}px`
      spacer.style.height = `${container.scrollHeight}px`
      overlay.append(spacer)
      for (let p = 0; p < (viewer.pagesCount ?? 0); p++) {
        const src: HTMLCanvasElement | undefined = viewer.getPageView(p)?.canvas
        if (!src) continue
        const r = src.getBoundingClientRect()
        if (r.bottom < cRect.top - 200 || r.top > cRect.bottom + 200) continue // 只快照视口附近
        const source = prev?.querySelector<HTMLCanvasElement>(`[data-hold-page="${p + 1}"]`) ?? src
        const copy = document.createElement('canvas')
        copy.width = source.width
        copy.height = source.height
        try { copy.getContext('2d')?.drawImage(source, 0, 0) } catch { continue }
        copy.dataset.holdPage = String(p + 1)
        copy.style.top = `${r.top - cRect.top + container.scrollTop}px`
        copy.style.left = `${r.left - cRect.left + container.scrollLeft}px`
        copy.style.width = `${r.width}px`
        copy.style.height = `${r.height}px`
        overlay.append(copy)
      }
      // 上一张快照里还没被重画掉的页(连续提交时活 canvas 可能整个不在)原节点搬过来,像素和位置都还对。
      if (prev) {
        for (const c of Array.from(prev.children) as HTMLElement[]) {
          const n = c.dataset.holdPage
          if (n && !overlay.querySelector(`[data-hold-page="${n}"]`)) overlay.append(c)
        }
      }
      dropHold?.() // 旧快照的像素已拷进/搬进新层,才撤旧层
      container.append(overlay) // 垫片必须挂上(哪怕一页快照都没有):滚动区不许塌缩
      holdOverlay = overlay
      let armed = false
      let docLoaded = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const drop = (): void => {
        if (timer) clearTimeout(timer)
        eventBus.off('pagerendered', onRendered)
        eventBus.off('pagesloaded', onDocLoaded)
        overlay.remove()
        if (holdOverlay === overlay) holdOverlay = null
        if (dropHold === drop) dropHold = null
      }
      const maybeDrop = (): void => {
        // 快照页全重画完 **且** 新文档 pagesloaded(所有页真实尺寸就位)才撤:早撤垫片,混合页高的
        // 文档还按首页占位尺寸排版,scrollHeight 临时缩水又会把深处的 scrollTop 钳掉(codex)。
        if (docLoaded && !overlay.querySelector('[data-hold-page]')) drop()
      }
      const onRendered = (e: { pageNumber: number }): void => {
        if (!armed) return // 新文档还没装上:这是旧文档迟到的重画,不算数
        overlay.querySelector(`[data-hold-page="${e.pageNumber}"]`)?.remove()
        maybeDrop()
      }
      const onDocLoaded = (): void => { docLoaded = true; maybeDrop() }
      eventBus.on('pagerendered', onRendered)
      dropHold = drop
      return {
        arm: () => {
          armed = true
          eventBus.on('pagesloaded', onDocLoaded, { once: true })
          // ponytail: 4s 兜底从**装上新文档**起算(解析再慢也不许提前撤垫片,否则塌缩回跳复活);
          // 被滚出视口的页可能永不重画,快照不能悬着,换档异常也靠它收尾。
          timer = setTimeout(drop, 4000)
        },
        cancel: drop, // 解析失败/中止:快照与垫片立刻收掉(此时旧文档还活着,没有塌缩可防)
      }
    }

    /** pdf-lib 写后重载:换新字节的文档(旧 doc 销毁)。滚动/缩放的保持见 attach('preserve')——
     *  这里**不采集也不恢复**任何视图坐标:采集时机永远不可靠(await 期间用户在滚动;连续换档时
     *  viewer 可能正处于上一轮 setDocument 的重置窗,读到 page=1/scale=null 的假值 → 实报「莫名回到首页」)。 */
    const swapDoc = async (bytes: Uint8Array): Promise<void> => {
      const hold = holdPages()
      const old = state.doc
      let doc: any
      try {
        // ⚠️必须给 getDocument 复制件:pdf.js 会把 buffer **转移**进 worker(detach)——
        // 同一份字节还躺在 lastBytes/撤销栈里,直接传原件等于把快照掏空(写盘/撤销全烂)。
        doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
      } catch (e) {
        hold.cancel() // 4s 兜底在 arm 后才起算,失败必须显式收快照
        throw e
      }
      if (dead) { hold.cancel(); void doc.destroy(); return }
      state.doc = doc
      attach(doc, 'preserve')
      hold.arm() // 新文档已装上:此后的 pagerendered 才有资格撤快照,pagesloaded 才有资格撤垫片
      try { void old?.destroy() } catch { /* ignore */ }
    }

    // 引用条临时高亮的带子几何:pdf.js 把命中段铺成行内子元素,几何得按行盒重算(见 hlBand.ts)。
    // 挂两处:find 出结果(updatetextlayermatches)、以及缩放/翻页后文本层重建(textlayerrendered,
    // 重建时 TextHighlighter.enable() 会同步把高亮再铺一遍)。rAF 让 pdf.js 那边先改完 DOM。
    /** 把命中滚到容器正中。pdf.js 的 find 只把命中「弄进视野」(实测落在容器高度的 7.8% 处,
     *  贴着顶边),用户报「没到视野中间」。滚动量是视口 px,容器可能在端级 zoom 里 → 按实测比例换算。 */
    const centerMatch = (): void => {
      const hl = container.querySelector<HTMLElement>('.textLayer .highlight.selected')
        ?? container.querySelector<HTMLElement>('.textLayer .highlight')
      if (!hl) return
      const r = hl.getBoundingClientRect(), cr = container.getBoundingClientRect()
      const z = container.offsetHeight > 0 ? cr.height / container.offsetHeight : 1
      const d = ((r.top + r.height / 2) - (cr.top + cr.height / 2)) / z
      if (Math.abs(d) > 4) container.scrollTop += d
    }

    let bandRaf = 0
    const repaintBands = (): void => {
      if (bandRaf) return // ⚠️ 必须合帧:highlightAll 的 find 会**逐页**发 updatetextlayermatches
      // (300 页的书就是 300 次),不合帧 = 同一帧里跑 300 遍 querySelectorAll + 逐带 rect(读写交替
      // 的强制重排)。实测:合帧前落地那一秒有一个 1007ms 的长帧,合帧后 6s 窗口里一个 >40ms 都没有
      // ——「点引用后整个界面卡住」就是它。(pdfcite 的 C11 钉着。)
      bandRaf = requestAnimationFrame(() => {
        bandRaf = 0
        if (dead) return
        const now = Date.now()
        const age = pulseArm.current ? 0 : (pulseStart.current ? now - pulseStart.current : -1)
        const painted = paintHlBands(container, age >= 0 && age < PULSE_MS ? age : null)
        if (painted > 0 && pulseArm.current) {
          pulseArm.current = false
          pulseStart.current = now
          centerMatch()
          // Desk 展开是有动画的:落地那一刻容器可能还在长个儿,按当时的高度算的居中会偏。
          // 补一次(与标题引用的 600ms 补跳同理);期间有人滚过就不再动他。
          const mark = container.scrollTop
          window.setTimeout(() => { if (!dead && Math.abs(container.scrollTop - mark) < 2) centerMatch() }, 420)
        }
      })
    }
    eventBus.on('updatetextlayermatches', repaintBands)
    eventBus.on('textlayerrendered', repaintBands)

    eventBus.on('pagechanging', (e: { pageNumber: number }) => setInfo((p) => ({ ...p, page: e.pageNumber })))
    eventBus.on('scalechanging', (e: { scale: number; presetValue?: string }) => {
      // curScale 是换档时缩放的唯一真源:重置窗里读 viewer.currentScaleValue 会拿到 null(丢用户缩放)。
      curScale = e.presetValue || String(e.scale)
      setZoomSel(curScale)
    })
    // 两路脏信号取并集(表单存储 + 编辑器状态),防某一路在高亮场景不触发。
    eventBus.on('annotationeditorstateschanged', markDirty)

    // 下划线/波浪线/删除线:标记工具激活时,松开鼠标即把选区写成对应注释。
    const onPointerUp = (): void => {
      const t = toolRef.current
      if (!MARKUP_TOOLS.has(t)) return
      setTimeout(() => {
        if (dead) return
        const marks = selectionToQuads(state.viewer)
        if (!marks.length) return
        window.getSelection()?.removeAllRanges()
        void enqueue((b) => addTextMarkup(b, t as MarkupKind, colorRef.current, marks))
      }, 10) // 等浏览器把选区定稿
    }
    // 便签评论:点击页面 → 输入文字 → /Text 注释(悬停图标可看内容)。
    const onNoteClick = (ev: MouseEvent): void => {
      if (toolRef.current !== 'note') return
      if ((ev.target as HTMLElement).closest?.('.annotationLayer section')) return // 点在已有注释上=看弹窗,不新建
      const hit = pageAt(state.viewer, ev.clientX, ev.clientY)
      if (!hit) return
      void askString(translate('pdfa.noteTitle'), '', { confirmLabel: translate('pdfa.add') }).then((text) => {
        if (dead || !text?.trim()) return
        void enqueue((b) => addNote(b, hit.pageIndex, hit.x, hit.y, text.trim(), colorRef.current))
      })
    }

    // 形状:在页面上拖拽 → 实时预览 → 松手写 /Square /Circle /Line(带 /AP)。
    let live: Drag | null = null
    const onShapeDown = (ev: PointerEvent): void => {
      const t = toolRef.current
      if (!SHAPE_TOOLS.has(t) || ev.button !== 0) return
      const hit = pageAt(state.viewer, ev.clientX, ev.clientY)
      if (!hit) return
      ev.preventDefault() // 防止拖出文字选区
      live = { pageIndex: hit.pageIndex, ax: ev.clientX, ay: ev.clientY, bx: ev.clientX, by: ev.clientY }
      setDrag(live)
      container.setPointerCapture(ev.pointerId)
    }
    const onShapeMove = (ev: PointerEvent): void => {
      if (!live) return
      live = { ...live, bx: ev.clientX, by: ev.clientY }
      setDrag(live)
    }
    const onShapeUp = (ev: PointerEvent): void => {
      const d = live
      if (!d) return
      live = null
      setDrag(null)
      try { container.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      const t = toolRef.current as ShapeKind
      if (Math.hypot(d.bx - d.ax, d.by - d.ay) < 4) return // 误点(非拖拽)不建形状
      const a = pointOnPage(state.viewer, d.pageIndex, d.ax, d.ay)
      const b = pointOnPage(state.viewer, d.pageIndex, d.bx, d.by)
      if (!a || !b) return
      const s = shapeRef.current
      const style: ShapeStyle = {
        stroke: colorRef.current,
        fill: s.fill ? colorRef.current : null,
        width: s.width,
        opacity: s.opacity,
      }
      void enqueue((by) => addShape(by, d.pageIndex, t, a, b, style))
    }

    // 手写笔:pointer 采点(压感 + getCoalescedEvents 高频轨迹)→ 预览层实时画 Excalidraw 轮廓 →
    // 笔画攒进待写桶,防抖 2.5s / 切工具 / 卸载时整批写 /Ink(每笔一次 swapDoc 会打断连续书写)。
    // 三桶数组本轮 effect 私有(ref 只是取景窗),增删一律**原地**——不换数组,身份即所有权。
    const myPending: InkStroke[] = []
    const myCommitting: InkStroke[] = []
    const myGhost: InkStroke[] = []
    pendingInk.current = myPending
    committingInk.current = myCommitting
    ghostInk.current = myGhost
    const removeAll = (arr: InkStroke[], gone: readonly InkStroke[]): void => {
      for (const s of gone) {
        const i = arr.indexOf(s)
        if (i >= 0) arr.splice(i, 1)
      }
    }
    const bumpInk = (): void => { if (!dead) setInkTick((t) => t + 1) }
    const hasInk = (): boolean =>
      myPending.length > 0 || myCommitting.length > 0 || myGhost.length > 0 || !!liveInk.current
    let inkTimer: ReturnType<typeof setTimeout> | null = null
    let inkLast: { x: number; y: number } | null = null // 客户区坐标,亚像素抖动滤点
    let inkPointer: number | null = null // 正在书写的 pointerId:第二根手指/手掌不得抢笔、不得收笔
    const commitInk = (): void => {
      if (inkTimer) { clearTimeout(inkTimer); inkTimer = null }
      const batch = myPending.splice(0) // 移出待写桶:在途批次不可再被提交/撤销(防双写)
      if (!batch.length) return
      myCommitting.push(...batch)
      void enqueue((b) => addInk(b, batch), (ok) => {
        removeAll(myCommitting, batch)
        if (ok) {
          // 已落盘。幽灵桶把笔迹在预览层撑到该页 canvas 重画出来为止(立刻撤会闪没半秒)。
          // ponytail: 半透明墨在重画完成前有一瞬双重叠加;不透明度 1(默认)看不出来。
          myGhost.push(...batch)
        } else {
          myPending.unshift(...batch) // 没写成:退回待写桶,随下次提交/尾部兜底重试
        }
        bumpInk()
      })
    }
    commitInkRef.current = commitInk
    const scheduleInkCommit = (): void => {
      if (inkTimer) clearTimeout(inkTimer)
      inkTimer = setTimeout(commitInk, 2500)
    }
    const inkSample = (live: InkStroke, e: { clientX: number; clientY: number; pressure: number }): boolean => {
      if (inkLast) {
        const dx = e.clientX - inkLast.x, dy = e.clientY - inkLast.y
        if (dx * dx + dy * dy < 1) return false
      }
      const pt = pointOnPage(state.viewer, live.pageIndex, e.clientX, e.clientY)
      if (!pt) return false
      live.pts.push([pt[0], pt[1], e.pressure || 0.5])
      inkLast = { x: e.clientX, y: e.clientY }
      return true
    }
    const onInkDown = (ev: PointerEvent): void => {
      if (toolRef.current !== 'pen' || ev.button !== 0 || liveInk.current) return
      const hit = pageAt(state.viewer, ev.clientX, ev.clientY)
      if (!hit) return
      ev.preventDefault() // 防拖出文字选区
      if (inkTimer) { clearTimeout(inkTimer); inkTimer = null } // 笔尖落着的时候绝不提交(swapDoc 会把正在写的页抽走)
      const s = penOptRef.current
      liveInk.current = {
        pageIndex: hit.pageIndex,
        pts: [[hit.x, hit.y, ev.pressure || 0.5]],
        simulate: ev.pressure === 0.5, // Excalidraw 同款判定:鼠标恒报 0.5 → 按速度模拟压感
        color: colorRef.current,
        width: s.width,
        opacity: s.opacity,
      }
      inkPointer = ev.pointerId
      inkLast = { x: ev.clientX, y: ev.clientY }
      container.setPointerCapture(ev.pointerId)
      bumpInk()
    }
    const onInkMove = (ev: PointerEvent): void => {
      const live = liveInk.current
      if (!live || ev.pointerId !== inkPointer) return
      const co = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : []
      const evs = co.length ? co : [ev]
      let added = false
      for (const e of evs) added = inkSample(live, e) || added
      if (added) bumpInk()
    }
    const onInkUp = (ev: PointerEvent): void => {
      const live = liveInk.current
      if (!live || ev.pointerId !== inkPointer) return
      inkSample(live, ev) // 抬笔点也采進去:快速收笔时最后一段 move 可能没来得及发
      liveInk.current = null
      inkPointer = null
      inkLast = null
      try { container.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      myPending.push(live)
      redoInk.length = 0 // 新笔作废逐笔恢复分支
      bumpInk()
      scheduleInkCommit()
    }
    /** 字节级撤销/恢复。⚠️不做「栈空就不入队」的快进检查,目标也必须在 **op 内**(轮到自己时)才出栈:
     *  排在前面的写入/撤销会改栈(撤销→立刻恢复 就靠撤销执行时才补进 redo 栈),提前判断/提前出栈都会乱序。
     *  轮到时真没事可做 → op 返 null,enqueue 一个字节都不写。失败把栈复原。 */
    const doUndo = (): void => {
      clearSel() // 撤销可能让选中的注释消失,别留个空框
      redoInk.length = 0 // 字节级历史动了,逐笔恢复的语义随之作废
      let prev: Uint8Array | null = null
      void enqueue(async (cur) => {
        prev = undoBytes.pop() ?? null
        if (!prev) return null
        pushHistory(redoBytes, cur)
        return prev
      }, (ok) => {
        if (!ok && prev) { undoBytes.push(prev); redoBytes.pop() }
      }, true)
    }
    const doRedo = (): void => {
      clearSel()
      redoInk.length = 0
      let next: Uint8Array | null = null
      void enqueue(async (cur) => {
        next = redoBytes.pop() ?? null
        if (!next) return null
        pushHistory(undoBytes, cur)
        return next
      }, (ok) => {
        if (!ok && next) { redoBytes.push(next); undoBytes.pop() }
      }, true)
    }
    // 键盘:⌘Z/⌘⇧Z(或 Ctrl+Y)撤销/恢复——待写笔画逐笔撤(手写的自然粒度),其余走字节快照栈(按写入批)。
    // 只在非 pdf.js 编辑器模式接管(高亮/添加文字让 pdf.js 自己的撤销来);Delete/Esc 作用于选中的注释。
    // ⚠️监听在 window 上,必须验「事件来自本实例」:dockview 里非活动 tab 的实例仍然挂着,
    // 不验的话一次 ⌘Z/Delete 会打到所有 PDF(误删后台文档)。container 有 tabIndex,
    // 在页面上按过下(focusSelf)之后按键 target 落在 container;点了工具栏/侧栏按钮则落在
    // 按钮上——都在 .pdfa-root 里,按根判归属。
    const rootEl = container.closest('.pdfa-root') ?? container
    const onPdfKey = (ev: KeyboardEvent): void => {
      if (!(ev.target instanceof Node) || !rootEl.contains(ev.target)) return
      const t = ev.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (toolRef.current === 'mouse' && selRef.current && (ev.key === 'Delete' || ev.key === 'Backspace')) { ev.preventDefault(); deleteSel(); return }
      // Escape 取消:已选中 / 拖动中 / 框选中 / 冷缓存框选待结算(框选开始前 selRef 已被清空,只看它会漏)。
      if (ev.key === 'Escape' && (selRef.current || selDragRef.current || selMarqRef.current || pendingMarq)) { clearSel(); return }
      const tool = toolRef.current
      if (modeOf(tool) !== AnnotationEditorType.NONE) return
      if (!(ev.metaKey || ev.ctrlKey)) return
      const k = ev.key.toLowerCase()
      if (k !== 'z' && k !== 'y') return
      ev.preventDefault()
      if (k === 'y' || ev.shiftKey) {
        if (INK_PAIR.has(tool) && redoInk.length) { myPending.push(redoInk.pop()!); bumpInk(); scheduleInkCommit(); return }
        doRedo()
      } else {
        if (INK_PAIR.has(tool) && myPending.length) { redoInk.push(myPending.pop()!); bumpInk(); scheduleInkCommit(); return }
        doUndo()
      }
    }
    // 滚动/缩放/页面重画会挪动页面框 → 预览层跟着重投影;页面重画完还负责清幽灵(按页,双页视口互不误伤)。
    const onInkViewChange = (): void => { if (hasInk()) bumpInk() }
    const onInkPageRendered = (e: { pageNumber: number }): void => {
      fetchAnns(e.pageNumber - 1) // 页面一渲染就预取注释:鼠标点选/橡皮命中都靠这份缓存
      let cleared = false
      for (let i = myGhost.length - 1; i >= 0; i--) {
        if (myGhost[i].pageIndex === e.pageNumber - 1) { myGhost.splice(i, 1); cleared = true }
      }
      if (cleared) { bumpInk(); return }
      onInkViewChange()
    }
    eventBus.on('scalechanging', onInkViewChange)
    eventBus.on('pagerendered', onInkPageRendered)

    // 橡皮:拖过即擦。命中=采样点到笔迹中心线的距离 <(笔宽×4.25/2 + 橡皮半径)。
    // 预览层里的待写笔画直接删;已写进 PDF 的 /Ink 收集注释 id,抬手一次性摘除(只动 Ink,
    // 高亮/形状/便签不归橡皮管)。ponytail: 在途批次(≤~1s 写入窗)擦不到,落盘后再擦即可;擦除无撤销。
    let erasing = false
    let erasePointer: number | null = null
    const eraseHits = new Set<string>()
    const pendingErase: string[] = [] // 已请求未确认落盘的擦除 id(本轮私有;卸载时尾部兜底补擦)
    const annCache = new Map<number, any[] | null>() // pageIndex → 该页全部注释(橡皮/选择共用);null=拉取中。attach 时清。
    // 缓存冷启动时擦过的采样点先记轨迹,注释一到就重放——否则快擦一下(缓存还没回来)会落空。
    let eraseTrail: { page: number; x: number; y: number; r: number }[] = []
    /** 对一页注释跑一个橡皮采样点的命中判定(只认 Ink),命中进 eraseHits。 */
    const hitDisk = (anns: any[], x: number, y: number, r: number): void => {
      for (const a of anns) {
        if (a.subtype !== 'Ink' || eraseHits.has(a.id)) continue
        // 4.25 是自家墨迹的视觉系数;外来 Ink 的 /BS W 是真实线宽,语义不同 → 视觉宽封顶防误伤。
        const rr = r + Math.min((a.borderStyle?.width || 1) * 4.25, 18) / 2
        for (const flat of inkListsOf(a)) {
          if (distToFlatSq([x, y], flat) <= rr * rr) { eraseHits.add(a.id); break }
        }
      }
    }
    const fetchAnns = (pageIndex: number): void => {
      if (annCache.has(pageIndex)) return
      annCache.set(pageIndex, null)
      const docAt = state.doc // 代际守卫:swapDoc 后旧文档的迟到结果不得污染新缓存
      void docAt?.getPage(pageIndex + 1)
        .then((pg: any) => pg.getAnnotations())
        .then((list: any[]) => {
          if (state.doc !== docAt) return
          const anns = list.filter((a) => a.id && a.subtype)
          annCache.set(pageIndex, anns)
          // 重放这页冷启动期间的擦除轨迹(重放完按页出账,别的手势的未决轨迹不受影响);
          // 若手已抬,补检出的命中立刻入队。
          const mine = eraseTrail.filter((t) => t.page === pageIndex)
          if (mine.length) {
            eraseTrail = eraseTrail.filter((t) => t.page !== pageIndex)
            for (const t of mine) hitDisk(anns, t.x, t.y, t.r)
            if (!erasing) flushErase()
          }
          // 冷缓存期间抬手的框选:注释到了才能结算(工具已切走就作废)。
          if (pendingMarq?.pageIndex === pageIndex) {
            const pm = pendingMarq
            pendingMarq = null
            if (toolRef.current === 'mouse') settleMarquee(pm.pageIndex, pm.l, pm.r, pm.b, pm.t)
          }
        })
        .catch(() => { if (state.doc === docAt) annCache.delete(pageIndex) }) // 拉挂了下次采样重试
    }
    /** 把攒下的命中 id 入队删除;确认落盘才出账,失败/中止留给尾部兜底(removeAnnots 幂等)。 */
    const flushErase = (): void => {
      if (!eraseHits.size) return
      const ids = [...eraseHits]
      eraseHits.clear()
      pendingErase.push(...ids)
      void enqueue((b) => removeAnnots(b, ids, INK_ONLY), (ok) => {
        if (ok) for (const id of ids) { const i = pendingErase.indexOf(id); if (i >= 0) pendingErase.splice(i, 1) }
      })
    }
    /** 预热可见页的注释缓存(橡皮命中/鼠标选中共用)——否则第一下操作会在缓存冷启动里落空。 */
    const warmAnns = (): void => {
      for (let p = 0; p < (state.viewer.pagesCount ?? 0); p++) {
        if (frameOf(state.viewer.getPageView(p))) fetchAnns(p)
      }
    }
    warmAnnsRef.current = warmAnns
    const eraseSample = (clientX: number, clientY: number): void => {
      const hit = pageAt(state.viewer, clientX, clientY)
      if (!hit) return
      const pv = state.viewer.getPageView(hit.pageIndex)
      const t = pv?.viewport?.transform as number[] | undefined
      const r = 8 / ((t ? Math.hypot(t[0], t[1]) : 1) || 1) // 橡皮半径:客户区 8px 折算成 PDF 单位
      for (let i = myPending.length - 1; i >= 0; i--) {
        const s = myPending[i]
        if (s.pageIndex !== hit.pageIndex) continue
        const rr = r + (s.width * 4.25) / 2
        if (distToPointsSq([hit.x, hit.y], s.pts) <= rr * rr) {
          myPending.splice(i, 1)
          bumpInk()
        }
      }
      const cached = annCache.get(hit.pageIndex)
      if (cached) hitDisk(cached, hit.x, hit.y, r)
      else {
        if (cached === undefined) fetchAnns(hit.pageIndex)
        eraseTrail.push({ page: hit.pageIndex, x: hit.x, y: hit.y, r }) // 注释还没到:记轨迹待重放
      }
    }
    const onEraseDown = (ev: PointerEvent): void => {
      if (toolRef.current !== 'eraser' || ev.button !== 0 || erasing) return
      ev.preventDefault()
      if (inkTimer) { clearTimeout(inkTimer); inkTimer = null } // 擦的过程中别让防抖提交来捣乱
      erasing = true
      erasePointer = ev.pointerId
      redoInk.length = 0 // 擦过之后「恢复那笔」语义已乱,作废
      // eraseTrail 故意不在这里清:上个手势可能还有冷缓存页没重放完,清了那次擦除就丢了(按页消费,attach 全清)。
      container.setPointerCapture(ev.pointerId)
      warmAnns() // 兜冷缓存(通常 selectTool 已预热过)
      eraseSample(ev.clientX, ev.clientY)
    }
    const onEraseMove = (ev: PointerEvent): void => {
      if (!erasing || ev.pointerId !== erasePointer) return
      const co = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : []
      for (const e of co.length ? co : [ev]) eraseSample(e.clientX, e.clientY)
    }
    const onEraseUp = (ev: PointerEvent): void => {
      if (!erasing || ev.pointerId !== erasePointer) return
      erasing = false
      erasePointer = null
      try { container.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      flushErase() // 冷缓存页迟到的命中由 fetchAnns 的轨迹重放补队
      if (myPending.length) scheduleInkCommit() // 擦剩下的待写笔画恢复正常防抖节奏
    }

    // 注释选中/移动/删除/编辑(鼠标模式):点击几何命中(注释层 section 已被 pointer-events:none 掉,
    // 不能靠 DOM 命中)→ 选中框+浮条;可移动类(手写/形状/便签/文字框)按住即拖,文本标记类(钉在字上)只选不挪。
    // ponytail: 缓存来自 worker 解析的字节——pdf.js 编辑器**刚**建的高亮/文字要等下一次 pdf-lib 写入
    // 重载后才能被选中(编辑它们本就该走对应编辑器模式);要即时得把 annotationStorage 也并进命中,不值。
    const clearSel = (): void => {
      // 拖动/框选进行中被清(Escape/撤销):连手势一起取消,便签图标的临时位移必须复位——
      // 只清 selRef 的话,抬手走 !sel 分支时已无从知道该复位哪些 section(codex:transform 永久残留)。
      if (selDrag) { shiftTextSections(selDrag.items, 0, 0); selDrag = null }
      selMarq = null
      pendingMarq = null // 未结算的冷缓存框选一并作废(否则迟到结算会盖掉之后的操作)
      if (!selRef.current && !selDragRef.current && !selMarqRef.current) return
      selRef.current = null
      selDragRef.current = null
      selMarqRef.current = null
      bumpInk()
    }
    const deleteSel = (): void => {
      const sel = selRef.current
      if (!sel) return
      const ids = sel.items.map((it) => it.id)
      clearSel()
      void enqueue((b) => removeAnnots(b, ids))
    }
    const editSel = (): void => {
      const sel = selRef.current
      const it = sel && sel.items.length === 1 ? sel.items[0] : null
      if (!it || it.subtype !== 'Text') return
      void askString(translate('pdfa.editNoteTitle'), it.contents || '', { confirmLabel: translate('pdfa.save') }).then((text) => {
        if (dead || text === null) return
        const trimmed = text.trim()
        if (!trimmed || trimmed === it.contents) return
        it.contents = trimmed // sel 里存的就是这个对象引用,已清选时改到孤儿上也无害
        void enqueue((b) => setAnnotContents(b, it.id, trimmed))
      })
    }
    selApiRef.current = { del: deleteSel, edit: editSel, clear: clearSel }
    /** 精确命中:先粗筛 Rect,再按子类型细判——大空框/斜线的包围盒不能整块吞掉框内的文字选择(codex 实锤)。 */
    const hitAnnot = (a: any, x: number, y: number, pad: number): boolean => {
      const r = a.rect
      if (!(x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad)) return false
      switch (a.subtype) {
        case 'Ink': {
          const rr = pad + Math.min((a.borderStyle?.width || 1) * 4.25, 18) / 2
          for (const flat of inkListsOf(a)) if (distToFlatSq([x, y], flat) <= rr * rr) return true
          return false
        }
        case 'Line': {
          const l = a.lineCoordinates
          if (!l) return true
          const rr = pad + (a.borderStyle?.width || 1) / 2 + 2
          return distToFlatSq([x, y], l) <= rr * rr
        }
        case 'Square': {
          // ponytail: pdf.js 不暴露 /IC,分不清空心实心 → 一律按边框带命中(实心的也只在边上能选),
          // 换来大框内部的文字选择不被吞。
          const band = (a.borderStyle?.width || 1) + pad + 4
          return !(x >= r[0] + band && x <= r[2] - band && y >= r[1] + band && y <= r[3] - band)
        }
        case 'Circle': {
          // 椭圆带:包围盒四角离椭圆很远,不算命中(否则角上的文字选择被吞)。
          const band = (a.borderStyle?.width || 1) + pad + 4
          const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2
          const rx = Math.max(1, (r[2] - r[0]) / 2), ry = Math.max(1, (r[3] - r[1]) / 2)
          const n = Math.hypot((x - cx) / rx, (y - cy) / ry)
          return Math.abs(n - 1) * Math.min(rx, ry) <= band
        }
        default:
          return true // 便签图标/文字框/文本标记:整框即本体
      }
    }
    const toItem = (a: any, pageIndex: number): SelItem =>
      ({ id: a.id, pageIndex, rect: [...a.rect], subtype: a.subtype, contents: a.contentsObj?.str, raw: a })
    /** 该页缓存里坐标命中的最上层可编辑注释(/Annots 顺序=绘制顺序,后者在上 → 取最后命中)。 */
    const annotAt = (pageIndex: number, x: number, y: number): any => {
      const cached = annCache.get(pageIndex)
      let found: any = null
      if (cached) {
        for (const a of cached) {
          if (!a.id || !a.rect || !EDITABLE_SUBTYPES.has(a.subtype)) continue
          if (hitAnnot(a, x, y, 3)) found = a
        }
      }
      return found
    }
    /** 便签图标是注释层里的真 DOM(其余类型的可见像素都烙在页 canvas 里)→ 拖动时直接位移它即时跟手;
     *  提交成功不清位移(section 随 swapDoc 整树换掉,清了反而闪回旧位置一下)。
     *  items 显式传入(拖动手势自己的快照):selRef 可能已被 Escape/撤销清掉,复位不能依赖它。 */
    const shiftTextSections = (items: SelItem[], dx: number, dy: number): void => {
      if (!items.length) return
      const t = state.viewer.getPageView(items[0].pageIndex)?.viewport?.transform as number[] | undefined
      if (!t) return
      for (const it of items) {
        if (it.subtype !== 'Text') continue
        const el = container.querySelector<HTMLElement>(`section[data-annotation-id="${it.id}"]`)
        if (el) el.style.transform = dx || dy ? `translate(${t[0] * dx + t[2] * dy}px, ${t[1] * dx + t[3] * dy}px)` : ''
      }
    }
    /** 拖动落定后把 raw 缓存里的几何一并平移:annCache 要到 swapDoc 后才重建,期间的再拖/替身/悬停
     *  用的还是这批对象。浅拷贝不碰 pdf.js 原对象,再把 annCache 里的原对象原位换成新引用——
     *  否则点选/橡皮在换档前那 ~1s 仍按旧位置命中(codex)。 */
    const shiftRaw = (it: SelItem, dx: number, dy: number): void => {
      const a = it.raw
      if (!a?.rect) return
      const patch: any = { rect: [a.rect[0] + dx, a.rect[1] + dy, a.rect[2] + dx, a.rect[3] + dy] }
      if (Array.isArray(a.inkLists)) patch.inkLists = inkListsOf(a).map((flat) => flat.map((v, i) => v + (i % 2 ? dy : dx)))
      if (Array.isArray(a.lineCoordinates)) patch.lineCoordinates = a.lineCoordinates.map((v: number, i: number) => v + (i % 2 ? dy : dx))
      it.raw = { ...a, ...patch }
      const arr = annCache.get(it.pageIndex)
      const i = arr ? arr.indexOf(a) : -1
      if (arr && i >= 0) arr[i] = it.raw
    }
    /** 整组乐观平移(rect + raw 缓存);写失败按 -dx/-dy 原样回滚。 */
    const applyShift = (items: SelItem[], dx: number, dy: number): void => {
      for (const it of items) {
        if (!MOVABLE_SUBTYPES.has(it.subtype)) continue
        it.rect = [it.rect[0] + dx, it.rect[1] + dy, it.rect[2] + dx, it.rect[3] + dy]
        shiftRaw(it, dx, dy)
      }
    }
    let selDrag: { pageIndex: number; pid: number; sx: number; sy: number; dx: number; dy: number; moved: boolean; solo: SelItem | null; items: SelItem[] } | null = null
    let selMarq: { pid: number } | null = null
    let pendingMarq: { pageIndex: number; l: number; r: number; b: number; t: number } | null = null
    /** 框选结算:该页缓存里包围盒与框相交的可编辑注释全部入选。 */
    const settleMarquee = (pageIndex: number, l: number, r: number, b: number, t: number): void => {
      const items = (annCache.get(pageIndex) ?? [])
        .filter((a: any) => a?.id && a.rect && EDITABLE_SUBTYPES.has(a.subtype)
          && a.rect[0] <= r && a.rect[2] >= l && a.rect[1] <= t && a.rect[3] >= b)
        .map((a: any) => toItem(a, pageIndex))
      selRef.current = items.length ? { pageIndex, items } : null
      bumpInk()
    }
    const onSelDown = (ev: PointerEvent): void => {
      if (readOnly || toolRef.current !== 'mouse' || ev.button !== 0 || selDrag || selMarq) return
      const target = ev.target as HTMLElement | null
      if (target?.closest?.('.pdfa-selbar')) return // 浮条按钮自己处理
      pendingMarq = null // 新的选择手势开始:上一个冷缓存框选若还没结算,作废(后发先至会盖掉本次选中)
      const hit = pageAt(state.viewer, ev.clientX, ev.clientY)
      if (!hit) { clearSel(); return }
      fetchAnns(hit.pageIndex)
      const found = annotAt(hit.pageIndex, hit.x, hit.y)
      if (!found) {
        clearSel()
        if (target?.closest?.('.textLayer span')) return // 文字上让位给原生文本选区
        ev.preventDefault() // 空白处按下 → 框选
        selMarq = { pid: ev.pointerId }
        selMarqRef.current = { pageIndex: hit.pageIndex, ax: hit.x, ay: hit.y, bx: hit.x, by: hit.y }
        container.setPointerCapture(ev.pointerId)
        bumpInk()
        return
      }
      const cur = selRef.current
      const already = cur?.pageIndex === hit.pageIndex ? cur.items.find((it) => it.id === found.id) : undefined
      if (!already) selRef.current = { pageIndex: hit.pageIndex, items: [toItem(found, hit.pageIndex)] }
      bumpInk()
      if (MOVABLE_SUBTYPES.has(found.subtype)) {
        ev.preventDefault() // 拖动注释,不是拖出文字选区
        selDrag = {
          pageIndex: hit.pageIndex, pid: ev.pointerId, sx: hit.x, sy: hit.y, dx: 0, dy: 0, moved: false,
          solo: already ?? null,
          items: [...(selRef.current?.items ?? [])], // 手势自己的快照:Escape 清选后仍要能复位/结算
        }
        container.setPointerCapture(ev.pointerId)
      }
    }
    const onSelMove = (ev: PointerEvent): void => {
      if (selMarq && ev.pointerId === selMarq.pid) {
        const m = selMarqRef.current
        const pt = m && pointOnPage(state.viewer, m.pageIndex, ev.clientX, ev.clientY)
        if (m && pt) { m.bx = pt[0]; m.by = pt[1]; bumpInk() }
        return
      }
      if (selDrag && ev.pointerId === selDrag.pid) {
        const pt = pointOnPage(state.viewer, selDrag.pageIndex, ev.clientX, ev.clientY)
        if (!pt) return
        selDrag.dx = pt[0] - selDrag.sx
        selDrag.dy = pt[1] - selDrag.sy
        if (!selDrag.moved && Math.hypot(selDrag.dx, selDrag.dy) > 1) selDrag.moved = true
        if (selDrag.moved) {
          selDragRef.current = { dx: selDrag.dx, dy: selDrag.dy }
          shiftTextSections(selDrag.items, selDrag.dx, selDrag.dy)
          bumpInk()
        }
        return
      }
      // 悬停在可编辑注释上 → 手型光标。section 被 pointer-events:none 掉(否则挡文字选区),
      // CSS :hover 到不了 → 几何命中打 data 标,样式表按标切光标。事件 target 一定在某 .page 里,
      // 用它反查页号是 O(1);挨页 getBoundingClientRect 的 pageAt 在几百页文档上会拖垮 pointermove。
      if (readOnly || toolRef.current !== 'mouse') return
      let over = false
      const pn = Number((ev.target as HTMLElement | null)?.closest?.('.page')?.getAttribute('data-page-number')) || 0
      if (pn) {
        const pv = state.viewer.getPageView(pn - 1)
        const frame = frameOf(pv)
        if (frame) {
          const [x, y] = pv.viewport.convertToPdfPoint(ev.clientX - frame.left, ev.clientY - frame.top)
          fetchAnns(pn - 1)
          over = !!annotAt(pn - 1, x, y)
        }
      }
      if (over !== (container.dataset.annhover === '1')) {
        if (over) container.dataset.annhover = '1'
        else delete container.dataset.annhover
      }
    }
    const onSelUp = (ev: PointerEvent): void => {
      if (selMarq && ev.pointerId === selMarq.pid) {
        selMarq = null
        try { container.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
        const m = selMarqRef.current
        selMarqRef.current = null
        if (!m) { bumpInk(); return }
        const L = Math.min(m.ax, m.bx), R = Math.max(m.ax, m.bx), B = Math.min(m.ay, m.by), T = Math.max(m.ay, m.by)
        if (R - L < 2 && T - B < 2) { bumpInk(); return } // 误点不算框
        // 框选按包围盒相交收人(框选本来就是粗粒度手势,不做子类型精判)。
        if (annCache.get(m.pageIndex)) settleMarquee(m.pageIndex, L, R, B, T)
        else {
          // 冷缓存(刚换档/新页):注释还在路上,记下框等 fetchAnns 回来再结算,否则首次框选必空(codex)
          fetchAnns(m.pageIndex)
          pendingMarq = { pageIndex: m.pageIndex, l: L, r: R, b: B, t: T }
          bumpInk()
        }
        return
      }
      const d = selDrag
      if (!d || ev.pointerId !== d.pid) return
      selDrag = null
      try { container.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      selDragRef.current = null
      const sel = selRef.current
      if (!d.moved) {
        // 原地点击多选集里的某一条 → 收敛为单选(标准多选交互)
        if (d.solo && sel && sel.items.length > 1) { selRef.current = { pageIndex: sel.pageIndex, items: [d.solo] }; bumpInk() }
        return
      }
      const moves = d.items.filter((it) => MOVABLE_SUBTYPES.has(it.subtype)).map((it) => ({ id: it.id, dx: d.dx, dy: d.dy }))
      if (!moves.length) { bumpInk(); return }
      applyShift(d.items, d.dx, d.dy) // 乐观:选框/缓存立刻按新位置走,替身消失后不闪回
      bumpInk()
      void enqueue((b) => translateAnnots(b, moves), (ok) => {
        if (!ok) { // 一个字节都没写(失败/中止):乐观位置整组回滚,便签图标位移复位
          applyShift(d.items, -d.dx, -d.dy)
          shiftTextSections(d.items, 0, 0)
          bumpInk()
        }
      })
    }
    const onSelCancel = (ev: PointerEvent): void => {
      // 系统级取消(窗口失焦/手势打断)= 回滚这次拖动/框选,绝不落盘半截位移。
      if (selMarq && ev.pointerId === selMarq.pid) {
        selMarq = null
        selMarqRef.current = null
        try { container.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
        bumpInk()
        return
      }
      const d = selDrag
      if (!d || ev.pointerId !== d.pid) return
      selDrag = null
      try { container.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      selDragRef.current = null
      shiftTextSections(d.items, 0, 0)
      bumpInk()
    }

    // ⌘/Ctrl+滚轮 与 触控板捏合(macOS 捏合 = ctrlKey 的 wheel 事件)缩放:
    // pdf.js **组件包不含**滚轮缩放(那是 Firefox 完整 viewer 的 webViewerWheel)→ 必须自己接。
    const onWheel = (ev: WheelEvent): void => {
      if (!ev.ctrlKey && !ev.metaKey) return
      ev.preventDefault() // 否则整个界面被浏览器缩放
      if (!state.doc) return
      const delta = -ev.deltaY
      if (!delta) return
      // 以光标为中心缩放(pdf.js updateScale 的 origin 语义:客户区坐标)。
      viewer.updateScale({
        scaleFactor: Math.max(0.8, Math.min(1.25, Math.exp(delta / 200))),
        origin: [ev.clientX, ev.clientY],
        drawingDelay: 0,
      })
    }

    container.addEventListener('pointerup', onPointerUp)
    container.addEventListener('click', onNoteClick)
    container.addEventListener('pointerdown', onShapeDown)
    container.addEventListener('pointermove', onShapeMove)
    container.addEventListener('pointerup', onShapeUp)
    container.addEventListener('pointerdown', onInkDown)
    container.addEventListener('pointermove', onInkMove)
    container.addEventListener('pointerup', onInkUp)
    container.addEventListener('pointercancel', onInkUp)
    container.addEventListener('pointerdown', onEraseDown)
    container.addEventListener('pointermove', onEraseMove)
    container.addEventListener('pointerup', onEraseUp)
    container.addEventListener('pointercancel', onEraseUp)
    container.addEventListener('pointerdown', onSelDown)
    container.addEventListener('pointermove', onSelMove)
    container.addEventListener('pointerup', onSelUp)
    container.addEventListener('pointercancel', onSelCancel)
    // 滚动不用重绘预览层:叠加层挂在滚动容器里按内容坐标定位,滚动天然跟随(缩放/重画才动矩阵)。
    // 在阅读器里按下 → 焦点收进 container(div 点击不改焦点,快捷键 target 会一直留在别处);
    // 让位给真输入目标:FreeText 编辑框等 contenteditable 要拿焦点打字。
    const focusSelf = (ev: PointerEvent): void => {
      const t = ev.target as HTMLElement | null
      if (t?.closest?.('[contenteditable], input, textarea, .annotationEditorLayer')) return
      if (document.activeElement !== container) container.focus({ preventScroll: true })
    }
    if (!readOnly) { // 只读内嵌不抢宿主(笔记编辑器)的快捷键/焦点
      window.addEventListener('keydown', onPdfKey)
      container.addEventListener('pointerdown', focusSelf)
    }
    container.addEventListener('wheel', onWheel, { passive: false })

    // 容器尺寸变化(侧栏开合/分栏拖动)时,预设缩放(适宽/适页)重排。
    const ro = new ResizeObserver(() => {
      if (dead || !state.doc) return
      const cur = viewer.currentScaleValue
      if (cur === 'page-width' || cur === 'page-fit' || cur === 'auto') viewer.currentScaleValue = cur
    })
    ro.observe(container)

    void (async () => {
      try {
        // 读字节走 IPC 再 getDocument({data}):不能用 {url:'amadeus-asset://…'} —— dev 渲染器是
        // http://localhost 源,XHR 到自定义 scheme 被 Chromium 跨源拦(内联 iframe 走导航才不受限)。
        const bytes = hostPdf ? await readHostPdfBytes(pdfPath) : await amadeus.readVaultBytes(pdfPath)
        if (dead) return
        // slice:getDocument 会把 buffer 转移进 worker(detach),原件要留给 lastBytes 当快照。
        const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
        if (dead) { void doc.destroy(); return }
        state.doc = doc
        state.lastBytes = bytes // 初始磁盘状态:首次编辑器 flush 的撤销快照从这里来
        attach(doc, { page: initialPage || 1 })
        setStatus('ready')
      } catch (e) {
        if (!dead) { console.error('[pdf] 加载失败', e); setStatus('error') }
      }
    })()

    return () => {
      dead = true
      enqueueRef.current = null
      commitInkRef.current = null
      warmAnnsRef.current = null
      selApiRef.current = null
      selRef.current = null
      selDragRef.current = null
      selMarqRef.current = null
      if (state.timer) clearTimeout(state.timer)
      if (inkTimer) clearTimeout(inkTimer)
      ro.disconnect()
      container.removeEventListener('pointerup', onPointerUp)
      container.removeEventListener('click', onNoteClick)
      container.removeEventListener('pointerdown', onShapeDown)
      container.removeEventListener('pointermove', onShapeMove)
      container.removeEventListener('pointerup', onShapeUp)
      container.removeEventListener('pointerdown', onInkDown)
      container.removeEventListener('pointermove', onInkMove)
      container.removeEventListener('pointerup', onInkUp)
      container.removeEventListener('pointercancel', onInkUp)
      container.removeEventListener('pointerdown', onEraseDown)
      container.removeEventListener('pointermove', onEraseMove)
      container.removeEventListener('pointerup', onEraseUp)
      container.removeEventListener('pointercancel', onEraseUp)
      container.removeEventListener('pointerdown', onSelDown)
      container.removeEventListener('pointermove', onSelMove)
      container.removeEventListener('pointerup', onSelUp)
      container.removeEventListener('pointercancel', onSelCancel)
      if (!readOnly) {
        window.removeEventListener('keydown', onPdfKey)
        container.removeEventListener('pointerdown', focusSelf)
      }
      container.removeEventListener('wheel', onWheel)
      dropHold?.()
      try { viewer.setDocument(null as any); linkService.setDocument(null as any) } catch { /* ignore */ }
      // 手写收尾:画到一半的笔并进待写桶;幽灵桶纯展示(已落盘)直接倒掉。
      // 三桶是本轮私有数组,新档(下一轮 effect)另起炉灶——链内收到的必然全是本档笔画。
      if (liveInk.current) { myPending.push(liveInk.current); liveInk.current = null }
      myGhost.length = 0
      // 擦到一半关掉:已命中未入队的也并进待擦账本,随尾部兜底补擦。
      // ponytail: 卸载瞬间还没拉回注释的冷缓存轨迹就不追了(要在 teardown 里做异步命中,窗口 ~百 ms)。
      pendingErase.push(...eraseHits)
      eraseHits.clear()
      // 尾部落盘:排在既有写队列后(串行),完成后统一销毁当前 doc——
      // destroy 必须等 save 完成,否则 saveDocument() 读到一半 doc 被销毁 → 快速关 tab 丢最后一次批注。
      // 待写桶必须在链**内**才收(在途批次的 after 回调可能把没写成的退回来;链后收才一个不漏不重)。
      void (readOnly ? state.chain : state.chain.then(async () => {
        const inkTail = myPending.splice(0)
        const eraseTail = pendingErase.splice(0) // 没确认落盘的擦除也要兜(removeInkAnnots 幂等,补擦无害)
        const doc = state.doc
        if (!state.dirty && !inkTail.length && !eraseTail.length) return
        try {
          let b: Uint8Array | null
          if (state.docStale && state.lastBytes) {
            // dead/异常挡了 swapDoc:磁盘比 doc 新,必须以磁盘为基线——用旧 doc.saveDocument()
            // 会把链尾刚写盘的批注/书签盖掉。此窗内编辑器未存改动本就随换档丢(同在途写入的既有语义)。
            b = state.lastBytes
          } else if (doc && (state.dirty || !state.lastBytes)) {
            b = await doc.saveDocument()
          } else {
            b = state.lastBytes
          }
          if (!b) return
          if (eraseTail.length) b = await removeAnnots(b, eraseTail, INK_ONLY)
          if (inkTail.length) b = await addInk(b, inkTail)
          await amadeus.saveVaultBytes(pdfPath, b)
        } catch { /* ignore */ }
      })).finally(() => {
        myCommitting.length = 0
        try { state.doc?.destroy() } catch { /* ignore */ }
        state.doc = null
        if (eng.current === state) eng.current = null
      })
    }
  }, [pdfPath, reloadNonce, readOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  // 已开着的 tab 被要求跳页:openPdf 激活既有 tab 后广播 amadeus:pdf-goto(避免 remount 重下 PDF)。
  useEffect(() => {
    const onGoto = (e: Event): void => {
      const d = (e as CustomEvent<{ pdfPath?: string; page?: number; q?: string }>).detail
      if (d?.pdfPath !== pdfPath || !d.page || d.page < 1) return
      pendingGoto.current = d.page // 文档没就绪时的落点(pagesinit 补跳);就绪了下面这行立刻生效
      pendingFind.current = d.q || null
      if (eng.current) {
        try { eng.current.viewer.currentPageNumber = d.page } catch { /* 装载中,交给 pagesinit */ }
        // 就绪了就当场找;没就绪时 find 会被 pdf.js 挂在 firstPageCapability 上,同样等得到,
        // 但那样是「先找后跳页」,命中点会被页码覆盖 —— 故只在有 doc 时立刻放,否则留给 pagesloaded。
        if (eng.current.doc) {
          if (d.q) { pulseArm.current = true; pulseStart.current = 0 } // 同 runFind:这条引用的落地要放提醒动画
          eng.current.eventBus.dispatch('find', {
            source: window, type: '', query: d.q || '', caseSensitive: false, entireWord: false,
            highlightAll: true, findPrevious: false, matchDiacritics: false,
          })
          pendingFind.current = null
        }
      }
    }
    window.addEventListener('amadeus:pdf-goto', onGoto)
    return () => window.removeEventListener('amadeus:pdf-goto', onGoto)
  }, [pdfPath])

  // 形参旧名 `t`,与 useI18n 的 t 撞名故改 next。
  const selectTool = (next: Tool): void => {
    // 切出 手写/橡皮 这一对 → 立即落盘攒着的笔画;笔↔橡皮之间切换不落盘(橡皮可即时擦预览层)。
    if (INK_PAIR.has(toolRef.current) && !INK_PAIR.has(next)) commitInkRef.current?.()
    if (next === 'eraser' || next === 'mouse') warmAnnsRef.current?.() // 预热可见页注释缓存(橡皮命中/点选/框选都要)
    if (next !== 'mouse') { // 隐形选中还能被 Delete 删=事故;冷缓存框选待结算的槽、悬停手型标一并清
      selApiRef.current?.clear() // 走 effect 内的 clearSel:refs + 手势局部态 + pendingMarq + 便签位移复位
      if (containerRef.current) delete containerRef.current.dataset.annhover
    }
    setTool(next)
    toolRef.current = next
    const e = eng.current
    if (e?.doc) {
      try { e.viewer.annotationEditorMode = { mode: modeOf(next) } } catch { /* ignore */ }
      if (next === 'highlight') {
        try { e.uiManager?.updateParams(AnnotationEditorParamsType.HIGHLIGHT_COLOR, colorRef.current) } catch { /* ignore */ }
      }
    }
  }
  const pickColor = (hex: string): void => {
    setColor(hex)
    colorRef.current = hex
    // 直接打 uiManager:组件包没有 switchannotationeditorparams 的监听(那是 Firefox 完整版的)。
    try { eng.current?.uiManager?.updateParams(AnnotationEditorParamsType.HIGHLIGHT_COLOR, hex) } catch { /* ignore */ }
  }
  const setShapeOpt = (patch: Partial<typeof shape>): void => {
    const next = { ...shapeRef.current, ...patch }
    shapeRef.current = next
    setShape(next)
  }
  const setPen = (patch: Partial<typeof penOpt>): void => {
    const next = { ...penOptRef.current, ...patch }
    penOptRef.current = next
    setPenOpt(next)
  }
  const zoom = (dir: 1 | -1): void => {
    const v = eng.current?.viewer
    if (v) dir > 0 ? v.increaseScale() : v.decreaseScale()
  }
  const setZoomPreset = (val: string): void => {
    const v = eng.current?.viewer
    if (v) v.currentScaleValue = val
  }
  const go = (delta: number): void => {
    const v = eng.current?.viewer
    if (v) v.currentPageNumber = Math.min(info.total, Math.max(1, info.page + delta))
  }
  const goTo = (n: number): void => {
    const v = eng.current?.viewer
    if (v && n >= 1 && n <= info.total) v.currentPageNumber = n
  }
  const copyLink = async (): Promise<void> => {
    await navigator.clipboard?.writeText(buildPdfLink(baseName(pdfPath), { page: info.page }))
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  const addBm = async (): Promise<void> => {
    const e = eng.current
    if (!e?.doc || !enqueueRef.current) return
    const pg = e.viewer.currentPageNumber || 1
    // 缺省标题只是写进 PDF 目录的**显示文案**(不参与任何比较/查找),按界面语言给即可。
    const fallback = t('pdfa.pageN', { n: pg })
    const title = await askString(t('pdfa.bookmarkTitle'), fallback, { confirmLabel: t('pdfa.add') })
    if (title === null) return
    void enqueueRef.current((b) => addBookmark(b, pg - 1, title.trim() || fallback))
  }

  const ready = status === 'ready'
  const doc = eng.current?.doc
  const isShape = SHAPE_TOOLS.has(tool)
  const isPen = tool === 'pen'

  return (
    <div className="pdfa-root">
      {!readOnly && (
      <div className="pdfa-toolbar">
        <button
          className={`pdfa-btn pdfa-tool${side ? ' on' : ''}`}
          onClick={() => setSide((s) => (s ? null : 'thumbs'))}
          title={t('pdfa.sidebar')}
        ><PanelLeft size={15} /></button>
        <span className="pdfa-sep" />
        {TOOLS.map(({ id, tip, Icon, gap }) => (
          <span key={id} style={gap ? { display: 'contents' } : undefined}>
            {gap && <span className="pdfa-sep" />}
            <button
              className={`pdfa-btn pdfa-tool${tool === id ? ' on' : ''}`}
              title={t(tip)}
              onClick={() => selectTool(id)}
            ><Icon size={15} /></button>
          </span>
        ))}
        <span className="pdfa-sep" />
        <span className="pdfa-swatches" title={t('pdfa.colorTitle')}>
          {PALETTE.map(([nameKey, hex]) => (
            <button
              key={hex}
              className={`pdfa-swatch${color === hex ? ' on' : ''}`}
              style={{ background: hex }}
              title={t('pdfa.colorNamed', { name: t(nameKey) })}
              onClick={() => pickColor(hex)}
            />
          ))}
        </span>
        {isShape && (
          <>
            <span className="pdfa-sep" />
            <button
              className={`pdfa-btn pdfa-tool${shape.fill ? ' on' : ''}`}
              title={shape.fill ? t('pdfa.fillToHollow') : t('pdfa.hollowToFill')}
              onClick={() => setShapeOpt({ fill: !shape.fill })}
              disabled={tool === 'line' || tool === 'arrow'}
            >{shape.fill ? t('pdfa.filled') : t('pdfa.hollow')}</button>
            <select className="pdfa-mini" value={shape.width} onChange={(e) => setShapeOpt({ width: Number(e.target.value) })} title={t('pdfa.strokeWidth')}>
              {WIDTHS.map((w) => <option key={w} value={w}>{w} pt</option>)}
            </select>
            <select className="pdfa-mini" value={shape.opacity} onChange={(e) => setShapeOpt({ opacity: Number(e.target.value) })} title={t('pdfa.opacity')}>
              {OPACITIES.map((o) => <option key={o} value={o}>{Math.round(o * 100)}%</option>)}
            </select>
          </>
        )}
        {isPen && (
          <>
            <span className="pdfa-sep" />
            <select className="pdfa-mini" value={penOpt.width} onChange={(e) => setPen({ width: Number(e.target.value) })} title={t('pdfa.penWidth')}>
              {PEN_WIDTHS.map((w) => <option key={w} value={w}>{w} pt</option>)}
            </select>
            <select className="pdfa-mini" value={penOpt.opacity} onChange={(e) => setPen({ opacity: Number(e.target.value) })} title={t('pdfa.opacity')}>
              {OPACITIES.map((o) => <option key={o} value={o}>{Math.round(o * 100)}%</option>)}
            </select>
          </>
        )}
        <span className="pdfa-sep" />
        <button className="pdfa-btn pdfa-tool" title={t('pdfa.addBookmark')} onClick={() => void addBm()}>
          <BookmarkPlus size={15} />
        </button>
        <span className="pdfa-flex" />
        <button className="pdfa-btn pdfa-copy" onClick={() => void copyLink()} title={t('pdfa.copyLinkTitle')}>
          {copied ? t('pdfa.copied') : t('pdfa.copyPageLink')}
        </button>
      </div>
      )}
      <div className="pdfa-body">
        {side && (
          <div className="pdfa-side">
            <div className="pdfa-sidetabs">
              <button className={side === 'thumbs' ? 'on' : ''} onClick={() => setSide('thumbs')}>{t('pdfa.thumbnails')}</button>
              <button className={side === 'outline' ? 'on' : ''} onClick={() => setSide('outline')}>{t('pdfa.outline')}</button>
            </div>
            <div className="pdfa-sidebody">
              {ready && doc ? (
                side === 'thumbs'
                  ? <Thumbs doc={doc} current={info.page} onPick={goTo} />
                  : <Outline doc={doc} onGo={(dest) => void eng.current?.linkService.goToDestination(dest)} />
              ) : null}
            </div>
          </div>
        )}
        <div className="pdfa-viewport" ref={viewportRef}>
          {/* 叠加层(手写预览/选中/框选)挂在滚动容器**里**按内容坐标定位:滚动零重绘零滞后。
              pdf.js 只认 container.firstElementChild(.pdfViewer)当页面宿主,后头的兄弟它不碰。 */}
          <div ref={containerRef} className="pdfa-container" data-tool={tool} tabIndex={readOnly ? undefined : -1}>
            <div className="pdfViewer" />
            {ready && containerRef.current && eng.current
              && (pendingInk.current.length > 0 || committingInk.current.length > 0 || ghostInk.current.length > 0 || liveInk.current) && (
              <InkPreview
                viewer={eng.current.viewer}
                container={containerRef.current}
                strokes={[...ghostInk.current, ...committingInk.current, ...pendingInk.current]}
                live={liveInk.current}
              />
            )}
            {ready && containerRef.current && eng.current && selRef.current && tool === 'mouse' && (
              <SelOverlay
                viewer={eng.current.viewer}
                container={containerRef.current}
                sel={selRef.current}
                drag={selDragRef.current}
                api={selApiRef.current}
              />
            )}
            {ready && containerRef.current && eng.current && selMarqRef.current && tool === 'mouse' && (
              <MarqueeBox viewer={eng.current.viewer} container={containerRef.current} m={selMarqRef.current} />
            )}
          </div>
          {drag && viewportRef.current && (
            <ShapePreview drag={drag} kind={tool as ShapeKind} color={color} shape={shape} host={viewportRef.current} />
          )}
          {ready && (
            <div className="pdfa-bottombar">
              <button className="pdfa-btn" onClick={() => zoom(-1)} title={t('pdfa.zoomOut')}>−</button>
              <select
                className="pdfa-zoomsel"
                value={zoomSel}
                onChange={(e) => setZoomPreset(e.target.value)}
                title={t('pdfa.zoomTitle')}
              >
                {!ZOOMS.some((z) => z.v === zoomSel) && <option value={zoomSel}>{fmtZoom(zoomSel)}</option>}
                {ZOOMS.map((z) => <option key={z.v} value={z.v}>{z.k ? t(z.k) : z.label}</option>)}
              </select>
              <button className="pdfa-btn" onClick={() => zoom(1)} title={t('pdfa.zoomIn')}>＋</button>
              <span className="pdfa-sep" />
              <button className="pdfa-btn" onClick={() => go(-1)} disabled={info.page <= 1} title={t('pdfa.prevPage')}>‹</button>
              <input
                key={info.page}
                className="pdfa-pageinput"
                defaultValue={info.page}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') goTo(parseInt((e.target as HTMLInputElement).value, 10) || 0)
                }}
                title={t('pdfa.pageInput')}
              />
              <span className="pdfa-pagetotal">/ {info.total || '…'}</span>
              <button className="pdfa-btn" onClick={() => go(1)} disabled={!info.total || info.page >= info.total} title={t('pdfa.nextPage')}>›</button>
            </div>
          )}
          {notice && <div className="pdfa-notice">{notice}</div>}
          {status === 'loading' && <div className="pdfa-state">{t('pdfa.loading')}</div>}
          {status === 'error' && (
            <div className="pdfa-state pdfa-state-err">
              <span>{t('pdfa.loadError')}</span>
              <button className="pdfa-btn" onClick={() => setReloadNonce((n) => n + 1)}>{t('pdfa.retry')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 拖拽中的形状预览(纯 SVG 覆盖层,不进 PDF)。坐标换算到 viewport 局部。 */
function ShapePreview({ drag, kind, color, shape, host }: {
  drag: Drag; kind: ShapeKind; color: string; shape: { fill: boolean; width: number; opacity: number }; host: HTMLElement
}) {
  const r = host.getBoundingClientRect()
  const ax = drag.ax - r.left, ay = drag.ay - r.top, bx = drag.bx - r.left, by = drag.by - r.top
  const fill = shape.fill && kind !== 'line' && kind !== 'arrow' ? color : 'none'
  const common = { stroke: color, strokeWidth: shape.width, fill, opacity: shape.opacity }
  return (
    <svg className="pdfa-preview" width={r.width} height={r.height}>
      {kind === 'rect' && <rect x={Math.min(ax, bx)} y={Math.min(ay, by)} width={Math.abs(bx - ax)} height={Math.abs(by - ay)} {...common} />}
      {kind === 'circle' && (
        <ellipse cx={(ax + bx) / 2} cy={(ay + by) / 2} rx={Math.abs(bx - ax) / 2} ry={Math.abs(by - ay) / 2} {...common} />
      )}
      {(kind === 'line' || kind === 'arrow') && (
        <line x1={ax} y1={ay} x2={bx} y2={by} {...common} fill="none" markerEnd={kind === 'arrow' ? 'url(#pdfa-arrow)' : undefined} />
      )}
      {kind === 'arrow' && (
        <defs>
          <marker id="pdfa-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
          </marker>
        </defs>
      )}
    </svg>
  )
}

/** 手写预览层:未落盘笔画 + 正在画的一笔,Excalidraw 同款填充轮廓。
 *  挂在滚动容器里、每页一个 svg 按内容坐标定位 → 滚动零重绘零滞后(在容器外按视口坐标挂,
 *  重绘慢一帧,快滚时笔迹肉眼可见地漂移——实报)。
 *  笔迹点存 PDF 用户空间,经 viewport.transform(PDF→页面 css px)整组投影,缩放/旋转全靠这一个矩阵。 */
function InkPreview({ viewer, container, strokes, live }: {
  viewer: any; container: HTMLElement; strokes: InkStroke[]; live: InkStroke | null
}) {
  const byPage = new Map<number, InkStroke[]>()
  for (const s of live ? [...strokes, live] : strokes) {
    const arr = byPage.get(s.pageIndex)
    if (arr) arr.push(s)
    else byPage.set(s.pageIndex, [s])
  }
  return (
    <div className="pdfa-inkov">
      {[...byPage.entries()].map(([p, list]) => {
        const box = pageBox(viewer, container, p)
        if (!box) return null
        return (
          <svg key={p} width={box.width} height={box.height} style={{ left: box.left, top: box.top }}>
            <g transform={`matrix(${box.t.join(' ')})`}>
              {list.map((s, i) => {
                const d = outlineToSvgPath(strokeOutline(s.pts, s.width, s.simulate, s !== live))
                return d ? <path key={i} d={d} fill={s.color} fillOpacity={s.opacity} /> : null
              })}
            </g>
          </svg>
        )
      })}
    </div>
  )
}

/** 拖动中的注释替身:按 raw 几何在 matrix 组里重画一份跟手(本体像素烙在页 canvas 里挪不动,
 *  落盘重载后才跳到新位置)。矩形/圆只描边(pdf.js 不暴露 /IC 分不清实心);Ink 用中心线描边近似
 *  (视觉宽=自家 4.25 系数,外来真线宽 Ink 会偏粗——只是拖动预览,落点不受影响);
 *  便签图标是真 DOM 由 shiftTextSections 位移;FreeText 只有虚线框跟随。 */
function DragGhost({ items, drag, t }: { items: SelItem[]; drag: { dx: number; dy: number }; t: number[] }) {
  return (
    <svg className="pdfa-selghost" width={0} height={0}>
      <g transform={`matrix(${t.join(' ')}) translate(${drag.dx} ${drag.dy})`}>
        {items.map((it) => {
          const a = it.raw
          if (!a) return null
          const col = rgbOf(a.color)
          const w = a.borderStyle?.width || 1
          if (it.subtype === 'Ink') {
            return inkListsOf(a).map((flat, i) => {
              let d = ''
              for (let k = 0; k + 1 < flat.length; k += 2) d += `${k ? 'L' : 'M'}${flat[k]} ${flat[k + 1]}`
              return <path key={`${it.id}-${i}`} d={d} fill="none" stroke={col} strokeWidth={w * 4.25} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
            })
          }
          if (it.subtype === 'Line' && Array.isArray(a.lineCoordinates)) {
            const l = a.lineCoordinates
            return <line key={it.id} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} stroke={col} strokeWidth={w} opacity={0.85} />
          }
          if (it.subtype === 'Square' || it.subtype === 'Circle') {
            const r = a.rect
            const x0 = Math.min(r[0], r[2]), y0 = Math.min(r[1], r[3])
            const rw = Math.abs(r[2] - r[0]), rh = Math.abs(r[3] - r[1])
            return it.subtype === 'Square'
              ? <rect key={it.id} x={x0 + w / 2} y={y0 + w / 2} width={Math.max(1, rw - w)} height={Math.max(1, rh - w)} fill="none" stroke={col} strokeWidth={w} opacity={0.85} />
              : <ellipse key={it.id} cx={x0 + rw / 2} cy={y0 + rh / 2} rx={Math.max(1, rw / 2 - w / 2)} ry={Math.max(1, rh / 2 - w / 2)} fill="none" stroke={col} strokeWidth={w} opacity={0.85} />
          }
          return null
        })}
      </g>
    </svg>
  )
}

/** 选中注释的覆盖层:每条一个虚线框(可移动类拖动中跟随位移,钉在文字上的不动)+ 一个浮条
 *  (删除;单选便签多「编辑」)。挂在滚动容器里按内容坐标定位(同 InkPreview)。 */
function SelOverlay({ viewer, container, sel, drag, api }: {
  viewer: any
  container: HTMLElement
  sel: { pageIndex: number; items: SelItem[] }
  drag: { dx: number; dy: number } | null
  api: { del: () => void; edit: () => void } | null
}) {
  const { t } = useI18n() // hook 必须在 early return 之上
  const box = pageBox(viewer, container, sel.pageIndex)
  if (!box) return null
  const mt = box.t // 页面变换矩阵(旧名 `t`,与 i18n 的 t 撞名故改)
  const proj = (x: number, y: number): [number, number] => [mt[0] * x + mt[2] * y + mt[4], mt[1] * x + mt[3] * y + mt[5]]
  let minL = Infinity, minT = Infinity, maxB = -Infinity
  const boxes = sel.items.map((it) => {
    const movable = MOVABLE_SUBTYPES.has(it.subtype)
    const dx = drag && movable ? drag.dx : 0
    const dy = drag && movable ? drag.dy : 0
    const [ax, ay] = proj(it.rect[0] + dx, it.rect[1] + dy)
    const [bx, by] = proj(it.rect[2] + dx, it.rect[3] + dy)
    const l = Math.min(ax, bx), tp = Math.min(ay, by), h = Math.abs(by - ay)
    minL = Math.min(minL, l)
    minT = Math.min(minT, tp)
    maxB = Math.max(maxB, tp + h)
    return { key: it.id, left: l, top: tp, width: Math.abs(bx - ax), height: h }
  })
  const single = sel.items.length === 1 ? sel.items[0] : null
  return (
    <div className="pdfa-selov" style={{ left: box.left, top: box.top }}>
      {drag && <DragGhost items={sel.items.filter((it) => MOVABLE_SUBTYPES.has(it.subtype) && it.subtype !== 'Text')} drag={drag} t={mt} />}
      {boxes.map((b) => <div key={b.key} className="pdfa-selbox" style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />)}
      {!drag && (
        <div className="pdfa-selbar" style={{ left: minL, top: minT < 34 ? maxB + 6 : minT - 30 }}>
          {single?.subtype === 'Text' && <button className="pdfa-btn" onClick={() => api?.edit()}>{t('pdfa.edit')}</button>}
          <button className="pdfa-btn" onClick={() => api?.del()}>
            {sel.items.length > 1 ? t('pdfa.deleteN', { n: sel.items.length }) : t('pdfa.delete')}
          </button>
        </div>
      )}
    </div>
  )
}

/** 框选矩形(鼠标模式空白处拖出):端点存 PDF 页坐标,渲染时投影——滚动/缩放中框都贴住页面。 */
function MarqueeBox({ viewer, container, m }: {
  viewer: any; container: HTMLElement; m: { pageIndex: number; ax: number; ay: number; bx: number; by: number }
}) {
  const box = pageBox(viewer, container, m.pageIndex)
  if (!box) return null
  const t = box.t
  const proj = (x: number, y: number): [number, number] => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]]
  const [ax, ay] = proj(m.ax, m.ay)
  const [bx, by] = proj(m.bx, m.by)
  return (
    <div className="pdfa-selov" style={{ left: box.left, top: box.top }}>
      <div className="pdfa-marquee" style={{ left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) }} />
    </div>
  )
}

const THUMB_W = 128

/** 页面缩略图栏:懒渲染(进入视口才画),点击跳页,当前页高亮。 */
function Thumbs({ doc, current, onPick }: { doc: any; current: number; onPick: (p: number) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    let alive = true
    const tasks = new Set<any>()
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue
        const el = en.target as HTMLCanvasElement
        io.unobserve(el)
        const n = Number(el.dataset.p)
        doc.getPage(n).then((page: any) => {
          if (!alive) return
          const base = page.getViewport({ scale: 1 })
          const vp = page.getViewport({ scale: (THUMB_W / base.width) * 2 }) // 2x 清晰度
          // 画进离屏 canvas,完成后同帧一次贴回——pdf.js 渲染开场就整块刷白,
          // 直接画在可见 canvas 上,swapDoc 后每张缩略图都要白闪一下。
          const off = document.createElement('canvas')
          off.width = vp.width
          off.height = vp.height
          const task = page.render({ canvasContext: off.getContext('2d'), viewport: vp })
          tasks.add(task)
          task.promise.then(() => {
            if (!alive) return
            el.width = off.width
            el.height = off.height
            el.getContext('2d')?.drawImage(off, 0, 0)
          }).catch(() => { /* cancelled */ }).finally(() => tasks.delete(task))
        }).catch(() => { /* doc destroyed */ })
      }
    }, { root: wrap.parentElement, rootMargin: '400px' })
    wrap.querySelectorAll('canvas').forEach((c) => io.observe(c))
    return () => {
      alive = false
      io.disconnect()
      tasks.forEach((t) => { try { t.cancel() } catch { /* ignore */ } })
    }
  }, [doc])
  useEffect(() => {
    wrapRef.current?.querySelector(`[data-t="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])
  return (
    <div ref={wrapRef} className="pdfa-thumbs">
      {Array.from({ length: doc.numPages as number }, (_, i) => (
        <div
          key={i}
          data-t={i + 1}
          className={`pdfa-thumb${current === i + 1 ? ' on' : ''}`}
          onClick={() => onPick(i + 1)}
        >
          <canvas data-p={i + 1} width={THUMB_W * 2} height={Math.round(THUMB_W * 2 * 1.414)} />
          <div className="no">{i + 1}</div>
        </div>
      ))}
    </div>
  )
}

/** PDF 大纲(目录/书签):点击跳转;「添加书签」写进这里。 */
function Outline({ doc, onGo }: { doc: any; onGo: (dest: unknown) => void }) {
  const { t } = useI18n() // hook 必须在下面两处 early return 之上
  const [items, setItems] = useState<any[] | null>(null)
  useEffect(() => {
    let alive = true
    doc.getOutline()
      .then((o: any[]) => { if (alive) setItems(o || []) })
      .catch(() => { if (alive) setItems([]) })
    return () => { alive = false }
  }, [doc])
  if (!items) return <div className="pdfa-side-empty">{t('pdfa.loading')}</div>
  if (!items.length) return <div className="pdfa-side-empty">{t('pdfa.outlineEmpty')}<br />{t('pdfa.outlineEmptyHint')}</div>
  const render = (list: any[], depth: number): ReactElement[] => list.flatMap((it, i) => [
    <button
      key={`${depth}-${i}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => { if (it.dest) onGo(it.dest) }}
    >{it.title || t('pdfa.untitled')}</button>,
    ...(it.items?.length ? render(it.items, depth + 1) : []),
  ])
  return <div className="pdfa-outline">{render(items, 0)}</div>
}
