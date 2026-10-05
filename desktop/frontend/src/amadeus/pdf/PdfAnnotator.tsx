/**
 * 内置 PDF 阅读器(只读):左缩略图 / 目录栏 + 顶部工具条 + 底部悬浮缩放 / 页码胶囊。
 * 2026-10-05 起不再批注 —— 内置阅读器是兜底,批注交给接管 `.pdf` 的插件(`registerFileType` 的 `override`)。
 * 这里一个字节都不写;PDF 里已有的注释照常由 pdf.js 的注释层画出来。文件被别处改写时原地重载(见 reload)。
 * 文件名与 `pdfa-` 类名沿用旧称:台架的选择器和各处 mock 都认它们。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
// ⚠️必须用 legacy 构建:pdf.js 5.7 用了 TC39 `Map.prototype.getOrInsertComputed`(upsert 提案),
// Electron 40 的 V8 未提供 → 非 legacy 版运行时崩「getOrInsertComputed is not a function」(主线程 + worker 都用到)。
// legacy 版内置 core-js polyfill(主/worker 各自打)。故 core/viewer/worker/css 全部走 legacy 路径。
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { AnnotationEditorType, AnnotationMode } from 'pdfjs-dist/legacy/build/pdf.mjs'
// pdf_viewer.mjs = pdf.js 官方组件包(PDFViewer 全家桶);类型在同目录 .d.mts。
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
// ⚠️?inline + @scope:pdf_viewer.css 抢了 .dialog / .sidebar 等通用类名并**直接画背景色**,
// 全局注入会接管 Amadeus 全 App 共用的 Dialogs.tsx(className="dialog",23 处)——表现为「打开过 PDF 后
// 输入弹窗配色不对」。故不 import 副作用版,改注入 @scope 关进阅读器内。见 ensureScopedCss。
import pdfViewerCss from 'pdfjs-dist/legacy/web/pdf_viewer.css?inline'
import './pdfAnnotator.css'
import { PanelLeft } from 'lucide-react'
import { isHostPath, buildPdfLink } from '@amadeus-shared/pdfLink'
import { amadeus } from '../api'
import { registerMessages, useI18n } from '../../i18n'
import { paintHlBands } from './hlBand'
/** 引语落地提醒动画的时长,必须与 pdfAnnotator.css 里 .pdfa-citehl-band.is-pulse 的一致。 */
const PULSE_MS = 1000

// ⚠️模块级的 ZOOMS 只存**键**,渲染时才 t() —— 存字面量会在模块加载那一刻冻住,切语言不再更新。
registerMessages({
  'pdfa.zoomFitWidth': { zh: '适宽', en: 'Fit width' },
  'pdfa.zoomFitPage': { zh: '适页', en: 'Fit page' },
  'pdfa.sidebar': { zh: '侧栏（缩略图/目录）', en: 'Sidebar (thumbnails and outline)' },
  'pdfa.copyLinkTitle': { zh: '复制指向本页的笔记链接', en: 'Copy a note link to this page' },
  'pdfa.copied': { zh: '已复制', en: 'Copied' },
  'pdfa.copyPageLink': { zh: '复制本页链接', en: 'Copy link to this page' },
  'pdfa.thumbnails': { zh: '缩略图', en: 'Thumbnails' },
  'pdfa.outline': { zh: '目录', en: 'Outline' },
  'pdfa.zoomOut': { zh: '缩小', en: 'Zoom out' },
  'pdfa.zoomTitle': { zh: '缩放（⌘/Ctrl+滚轮 或 触控板捏合）', en: 'Zoom (⌘/Ctrl + scroll wheel, or trackpad pinch)' },
  'pdfa.zoomIn': { zh: '放大', en: 'Zoom in' },
  'pdfa.prevPage': { zh: '上一页', en: 'Previous page' },
  'pdfa.pageInput': { zh: '页码（回车跳转）', en: 'Page number (press Enter to jump)' },
  'pdfa.nextPage': { zh: '下一页', en: 'Next page' },
  'pdfa.loading': { zh: '加载中…', en: 'Loading…' },
  'pdfa.loadError': { zh: '无法加载此 PDF', en: 'Could not load this PDF' },
  'pdfa.retry': { zh: '重试', en: 'Retry' },
  'pdfa.outlineEmpty': { zh: '无目录/书签', en: 'No outline or bookmarks' },
  'pdfa.untitled': { zh: '（无标题）', en: '(untitled)' },
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

/** k = i18n 键(两个预设档);百分比档与语言无关,直接用 label。 */
const ZOOMS: ReadonlyArray<{ v: string; label?: string; k?: string }> = [
  { v: 'page-width', k: 'pdfa.zoomFitWidth' }, { v: 'page-fit', k: 'pdfa.zoomFitPage' },
  { v: '0.5', label: '50%' }, { v: '0.75', label: '75%' }, { v: '1', label: '100%' },
  { v: '1.25', label: '125%' }, { v: '1.5', label: '150%' }, { v: '2', label: '200%' }, { v: '3', label: '300%' },
]
const fmtZoom = (v: string): string => (Number.isNaN(parseFloat(v)) ? v : `${Math.round(parseFloat(v) * 100)}%`)

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p

interface Engine {
  viewer: any
  linkService: any
  eventBus: any
  doc: any
}

const sameBytes = (a: Uint8Array, b: Uint8Array | null): boolean => {
  if (!b || a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}
/** 与主进程广播的路径同形(vault 相对、`/` 分隔、无前导斜杠)再比。 */
const normRel = (p: string): string => p.replace(/\\/g, '/').replace(/^\/+/, '')

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

/** embed:笔记内嵌预览形态 —— 没有工具条和侧栏,不抢宿主(笔记编辑器)的焦点。 */
export function PdfAnnotator({ pdfPath, initialPage, initialQuote, embed }: { pdfPath: string; initialPage?: number; initialQuote?: string; embed?: boolean }) {
  // 库外的 PDF(引用条给的是绝对路径):字节走主进程 fs 直读;文件监听只盯库内,所以不订阅重载;
  // 「复制本页链接」也不给 —— 笔记链接按库内文件名解析,库外的落不了地。
  const { t } = useI18n()
  const hostPdf = isHostPath(pdfPath)
  const containerRef = useRef<HTMLDivElement>(null)
  const eng = useRef<Engine | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [info, setInfo] = useState({ page: initialPage || 1, total: 0 })
  // 待跳页码:amadeus:pdf-goto 可能在文档还没就绪时到(点第二条引用时阅读器正在装载),
  // 当场跳是空操作 —— 记下来,等 pagesinit/pagesloaded 补跳。丢了就停在上一条引用的页(Codex 实证)。
  const pendingGoto = useRef<number | null>(null)
  // 待高亮的引语(引用条带 `&q=`):**临时高亮**,走 pdf.js 的 find —— 只在文本层加个 .highlight,
  // 一个字节都不写进 PDF。同 pendingGoto:文档没就绪时先记下,pagesloaded 再放。
  const pendingFind = useRef<string | null>(initialQuote || null)
  // 引语落地时给高亮带子放一次提醒动画(见 hlBand.ts 的 pulseAge)。两段:
  // ① pulseArm = 「已发 find,等落地」。find 到重画之间隔着 pdf.js 抽全文的异步过程(300 页几秒钟),
  //    期间会先来几次一个命中都没有的 textlayerrendered —— 只有真画出带子的那次才算落地,
  //    所以这里不能用固定时限,得等到 painted > 0。
  // ② pulseStart = 落地时刻。动画期内的重画按「已播毫秒数」用负 animation-delay 接着播(不是重来);
  //    过了 PULSE_MS 就再也不挂类 —— 滚动引发的重画绝不会二次放动画。
  const pulseArm = useRef(false)
  const pulseStart = useRef(0)
  const [side, setSide] = useState<'thumbs' | 'outline' | null>(embed ? null : 'thumbs')
  const [zoomSel, setZoomSel] = useState('page-width')
  const [, setDocVersion] = useState(0) // swapDoc 后催重渲染拿新 doc;不作 key——重挂会把缩略图清白闪一下
  const [copied, setCopied] = useState(false)
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
      // 这里不写盘,所以两处都关到底:编辑器 DISABLE(NONE 下选中文本仍会弹 pdf.js 的浮动「高亮」按钮),
      // 表单按外观静态渲染(默认的 ENABLE_FORMS 会给出能打字、却存不下来的输入框)。
      annotationEditorMode: AnnotationEditorType.DISABLE,
      annotationMode: AnnotationMode.ENABLE,
      imageResourcesPath: 'pdfjs-annot/', // /Text 便签图标(public/pdfjs-annot/annotation-*.svg)
      // annotationEditorMode / imageResourcesPath 在 v5.7 运行时被读取(pdf_viewer.mjs),.d.mts 类型未收录 → 断言。
    } as any)
    linkService.setViewer(viewer)
    const state: Engine = { viewer, linkService, eventBus, doc: null }
    eng.current = state

    let curScale = 'page-width' // 用户当前缩放(scalechanging 维护);换档恢复只信它,不读 viewer(见 swapDoc 注释)

    /** 临时高亮一段引语:pdf.js find(只在文本层画高亮,绝不写盘)。空串 = 清掉上一次的高亮。 */
    const runFind = (q: string): void => {
      if (q) { pulseArm.current = true; pulseStart.current = 0 } // 落地那一次要放提醒动画(清高亮的空串不算)
      eventBus.dispatch('find', {
        source: window, type: '', query: q, caseSensitive: false, entireWord: false,
        highlightAll: true, findPrevious: false, matchDiacritics: false,
      })
    }

    /** 挂载文档(初载与文件变化后的重载共用)。
     *  keep='preserve'(重载):滚动位置全程**物理保留**——快照层的撑高垫片让内容不塌缩,
     *  scrollTop 从头到尾没变过,一个坐标都不写回。写回才是偏移/回跳的来源:塌缩把 scrollTop 钳到 0,
     *  惯性滚动又从 0 接着滚,这时「恢复」与「不恢复」都错(拽回=偏移,放着=回到首页)。
     *  只在 pagesloaded 后补一个合成 scroll 让 pdf.js 按真实 scrollTop 重算页码
     *  (setDocument 会把内部页码直写回 1,不广播;scroll 监听是它自己绑在 container 上的)。
     *  keep={page}(初载):跳到目标页;pagesloaded 且用户没翻页时再钉一次(pagesinit 的页高还是占位值)。 */
    let offAttach: (() => void) | null = null
    const attach = (doc: any, keep: { page: number } | 'preserve'): void => {
      offAttach?.() // 连续换档时上一轮 attach 的 once 监听可能还没触发,不摘会拿着旧 keep 在新文档上乱跳
      viewer.setDocument(doc)
      linkService.setDocument(doc, null)
      findController.setDocument(doc) // 不接的话 find 事件被 firstPageCapability 永远挂住
      const target = keep === 'preserve' ? 0 : Math.min(doc.numPages, Math.max(1, keep.page))
      // 装载期间到的 goto 优先于 attach 时的目标页(用户后点的那条引用才是他要看的)
      const wanted = (): number => Math.min(doc.numPages, Math.max(1, pendingGoto.current ?? target))
      const onInit = (): void => {
        if (dead) return
        viewer.currentScaleValue = curScale
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

    /** 重载防闪:把当前可见页的 canvas 拷成静态快照压在上面,新文档哪页重画完成就撤哪页的快照——
     *  没有它,setDocument 会先清空再异步重画,每次重载都白闪一下。
     *  返回 arm:attach 装上新文档后才调用——旧文档迟到的 pagerendered 不许撤快照(否则闪回);
     *  连续重载时,还没重画完的页复用上一张快照的像素(此刻活 canvas 可能是半张白纸)。 */
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

    /** 换成新字节的文档(旧 doc 销毁)。滚动/缩放的保持见 attach('preserve')——
     *  这里**不采集也不恢复**任何视图坐标:采集时机永远不可靠(await 期间用户在滚动;连续换档时
     *  viewer 可能正处于上一轮 setDocument 的重置窗,读到 page=1/scale=null 的假值 → 实报「莫名回到首页」)。 */
    const swapDoc = async (bytes: Uint8Array): Promise<void> => {
      const hold = holdPages()
      const old = state.doc
      let doc: any
      try {
        // ⚠️必须给 getDocument 复制件:pdf.js 会把 buffer **转移**进 worker(detach)——
        // 调用方还要拿这份字节当「当前磁盘内容」去重(diskBytes),传原件等于把它掏空。
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

    // 在阅读器里按下 → 焦点收进 container(div 点击不改焦点),方向键 / PageDown / 空格才滚得动这份 PDF。
    // 内嵌形态不抢宿主(笔记编辑器)的焦点。
    const focusSelf = (ev: PointerEvent): void => {
      const el = ev.target as HTMLElement | null
      if (el?.closest?.('[contenteditable], input, textarea, select')) return
      if (document.activeElement !== container) container.focus({ preventScroll: true })
    }
    if (!embed) container.addEventListener('pointerdown', focusSelf)
    container.addEventListener('wheel', onWheel, { passive: false })

    // 文件被别处改写(接管 .pdf 的插件、外部工具)→ 原地换成新字节,滚动与缩放不动(见 swapDoc)。
    // 主进程对 PDF 只报「变了」、不读内容(watcher.ts),这里自己重读。
    let diskBytes: Uint8Array | null = null // 当前文档对应的磁盘字节:内容没变的事件(只动了 mtime)不重载
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    let reloading = false
    let again = false // 重载途中又来了变更:跑完再来一轮,不并发 getDocument
    let stale = false // 面板不在前台时到的变更:此刻没有版面可保,等它回来(下面的 ResizeObserver)再重载
    const reload = async (): Promise<void> => {
      if (dead) return
      if (!state.doc) { setReloadNonce((n) => n + 1); return } // 初载失败 / 还在路上:整个重来
      if (!container.offsetParent) { stale = true; return }
      if (reloading) { again = true; return }
      reloading = true
      stale = false
      try {
        do {
          again = false
          const bytes = await amadeus.readVaultBytes(pdfPath)
          if (dead) return
          if (sameBytes(bytes, diskBytes)) continue
          await swapDoc(bytes)
          diskBytes = bytes
        } while (again && !dead)
      } catch (e) {
        // 写到一半被读到 / 文件刚被挪走:留着旧画面,下一次变更再试
        console.warn('[pdf] 重载失败,保留当前画面', e)
      } finally {
        reloading = false
      }
    }
    const offChange = hostPdf ? undefined : amadeus.onFileExternalChange?.((p) => {
      if (normRel(p) !== normRel(pdfPath)) return
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => { reloadTimer = null; void reload() }, 300)
    })

    // 容器尺寸变化(侧栏开合/分栏拖动)时,预设缩放(适宽/适页)重排;回到前台时补上欠着的重载。
    const ro = new ResizeObserver(() => {
      if (dead || !state.doc) return
      const cur = viewer.currentScaleValue
      if (cur === 'page-width' || cur === 'page-fit' || cur === 'auto') viewer.currentScaleValue = cur
      if (stale) void reload()
    })
    ro.observe(container)

    void (async () => {
      try {
        // 读字节走 IPC 再 getDocument({data}):不能用 {url:'amadeus-asset://…'} —— dev 渲染器是
        // http://localhost 源,XHR 到自定义 scheme 被 Chromium 跨源拦(内联 iframe 走导航才不受限)。
        const bytes = hostPdf ? await readHostPdfBytes(pdfPath) : await amadeus.readVaultBytes(pdfPath)
        if (dead) return
        // slice:getDocument 会把 buffer 转移进 worker(detach),原件留给 diskBytes 去重。
        const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
        if (dead) { void doc.destroy(); return }
        state.doc = doc
        diskBytes = bytes
        attach(doc, { page: initialPage || 1 })
        setStatus('ready')
      } catch (e) {
        if (!dead) { console.error('[pdf] 加载失败', e); setStatus('error') }
      }
    })()

    return () => {
      dead = true
      if (reloadTimer) clearTimeout(reloadTimer)
      offChange?.()
      ro.disconnect()
      if (!embed) container.removeEventListener('pointerdown', focusSelf)
      container.removeEventListener('wheel', onWheel)
      dropHold?.()
      try { viewer.setDocument(null as any); linkService.setDocument(null as any) } catch { /* ignore */ }
      try { void state.doc?.destroy() } catch { /* ignore */ }
      state.doc = null
      if (eng.current === state) eng.current = null
    }
  }, [pdfPath, reloadNonce, embed]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const ready = status === 'ready'
  const doc = eng.current?.doc

  return (
    <div className="pdfa-root">
      {!embed && (
      <div className="pdfa-toolbar">
        <button
          className={`pdfa-btn pdfa-tool${side ? ' on' : ''}`}
          onClick={() => setSide((s) => (s ? null : 'thumbs'))}
          title={t('pdfa.sidebar')}
        ><PanelLeft size={15} /></button>
        <span className="pdfa-flex" />
        {!hostPdf && (
          <button className="pdfa-btn pdfa-copy" onClick={() => void copyLink()} title={t('pdfa.copyLinkTitle')}>
            {copied ? t('pdfa.copied') : t('pdfa.copyPageLink')}
          </button>
        )}
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
        <div className="pdfa-viewport">
          {/* pdf.js 只认 container.firstElementChild(.pdfViewer)当页面宿主,后头的兄弟(重载时的防闪快照层)它不碰。 */}
          <div ref={containerRef} className="pdfa-container" tabIndex={embed ? undefined : -1}>
            <div className="pdfViewer" />
          </div>
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
          // 直接画在可见 canvas 上,重载(swapDoc)后每张缩略图都要白闪一下。
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

/** PDF 大纲(目录/书签):点击跳转。 */
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
  if (!items.length) return <div className="pdfa-side-empty">{t('pdfa.outlineEmpty')}</div>
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
