// v4 统一编辑器的块级嵌入层(2026-08-13,用户实报「![[xxx]] 嵌入触发不了」):
// v3 的八类块级嵌入全部住在 BlockHost(React/每块一宿主),unified 一类都没有 —— 本层用
// **装饰 widget + createRoot** 把 v3 组件原样桥进单实例:
//   整段只有一条 `![[…]]` 的段落(db/画板/插件/文件/PDF/跨笔记)、裸 URL 段落(书签卡)、
//   ```forsion-button``` 代码块(按钮块)。图片形态**不在本层**(wikilink.ts 行内 widget 已渲染,
//   段落独占时由 CSS 放大成块级观感,见 styles.css)。
// 交互契约(advisor 判别面):节点仍是普通段落/代码块 —— ⠿ 把手/拖拽/删除/撤销全部原生;
// **光标进入该节点(方向键/点击缝隙)→ 装饰整体让位,露出源码可编辑**(math live preview 同款,
// 这就是「编辑嵌入目标」的入口,无需 v3 的 EmbedSourceLine)。
// 规范偏离备案:spec §4 写的是「原子 nodeView」——PM nodeView 按节点类型挂,无法只对
// 「恰好是嵌入的段落」生效;装饰 widget 语义等价(原子 UX)且保住把手/撤销,记入规范修订。
import { Suspense, useEffect, useRef, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { lazyRetry } from '../../lazyRetry'
import { stripPageBasename } from '@amadeus-shared/compiler/names'
import { toAssetUrl } from '@amadeus-shared/assets'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { isPlainNoteRef } from '@amadeus-shared/builtinTypes'
import { parseMediaLinkInner, VIDEO_EXT_RE, mediaLabel, embedWidthOf, withEmbedWidth, embedUrlOf, wikiSafeUrl, type MediaLoc } from '@amadeus-shared/pdfLink'
import type { EmbedResolved } from '@amadeus-shared/ipc'
import { getBlockType } from '../blocks/registry'
import { DatabaseEmbed } from '../blocks/database/DatabaseEmbed'
import { ExcalidrawEmbed } from '../blocks/excalidraw/ExcalidrawEmbed'
import { BookmarkCard } from '../components/BookmarkCard'
import { MediaPlayer } from '../components/MediaPlayer'
import { WebEmbed } from '../components/WebEmbed'
import { ButtonBlock } from '../blocks/button/ButtonBlock'
import { parseButtonBlock, serializeButtonBlock, type ButtonSpec } from '../blocks/button/format'
import { usePageStore } from '../store/pageStore'
import { usePluginStore, findEmbedRenderer } from '../plugins/pluginStore'
import { PluginEmbed } from '../blocks/plugin/PluginEmbed'
import { amadeus } from '../api'
import { resolveFileName, isAmbiguousFileRef } from '../lib/vaultFiles'
import { attachResizeHandle } from '../lib/imageResize'
import { getAttachmentPrefs } from '../lib/attachments'

const PdfEmbedViewer = lazyRetry(() => import('../pdf/PdfAnnotator').then((m) => ({ default: m.PdfAnnotator })))
const noop = (): void => {}

// 判定常量与 BlockHost 同源同序(优先级链:image→db→draw→plugin→file→跨笔记;image 归 wikilink 层)。
const EMBED_RE = /^!\[\[([^\]\n]+)\]\]$/
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i
const FILE_EXT_RE = /\.[a-z0-9]{1,8}$/i
const DB_EXT_RE = /\.db$/i
const PDF_EXT_RE = /\.pdf$/i
// VIDEO_EXT_RE / AUDIO_EXT_RE 已搬进 @amadeus-shared/pdfLink(isMediaPath)——三份分类链共用一份,
// 免得再漂。⚠️ 那份刻意不含 mkv|avi,理由见该文件注释。
const URL_RE = /^https?:\/\/\S+$/i

export type EmbedKind =
  | { k: 'db'; name: string; view: string | null }
  | { k: 'draw'; target: string }
  | { k: 'plugin'; target: string }
  /** loc = `#t=` 媒体时刻;badAnchor = 有 `#` 但解不开(照样渲播放器 + 提示,绝不「嵌入丢失」)。
   *  w = 末段 `|宽度`(px),与图片同款口径。 */
  | { k: 'file'; name: string; fileKind: 'pdf' | 'video' | 'audio' | 'other'; loc?: MediaLoc | null; badAnchor?: boolean; w?: number }
  | { k: 'note'; target: string }
  | { k: 'bookmark'; url: string }
  /** `![[https://…]]` 独占一段 = 网页嵌入(冻结封面 → 唤醒 webview);裸 URL 仍是 bookmark。 */
  | { k: 'web'; url: string; w?: number }
  | { k: 'button'; src: string }

/** 段落/代码块 → 嵌入类别(不是嵌入 → null)。图片形态刻意返回 null(wikilink 行内层负责)。 */
export function classifyEmbed(node: ProseNode): EmbedKind | null {
  if (node.type.name === 'code_block') {
    if (node.attrs.language !== 'forsion-button') return null
    return { k: 'button', src: node.textContent }
  }
  if (node.type.name !== 'paragraph') return null
  const text = node.textContent.trim()
  const m = EMBED_RE.exec(text)
  if (!m) {
    return URL_RE.test(text) ? { k: 'bookmark', url: text } : null
  }
  const target = m[1]
  const [rawPath, extra] = target.split('|')
  const t = rawPath.trim()
  if (IMG_EXT_RE.test(t)) return null // 图片:wikilink 行内 widget 已渲染(远程图片外链同理)
  // 网页嵌入 `![[https://…]]` —— 必须排在图片之后(`![[https://…/a.png]]` 仍是图片),
  // 且排在下面一切文件判定之前(URL 里的 `.com`/`.html` 会被 FILE_EXT_RE 当成后缀)。
  // ⚠️ 吃**整条 target**:URL 里的 `|` 是合法字符,只能剥末段宽度,不能 split('|')[0]。
  const webUrl = embedUrlOf(target)
  if (webUrl) return { k: 'web', url: webUrl, w: embedWidthOf(target) }
  if (!t.includes('#') && DB_EXT_RE.test(t)) return { k: 'db', name: t, view: extra?.trim() || null }
  if (!t.includes('#') && isDrawingPath(t)) return { k: 'draw', target: t }
  const renderers = usePluginStore.getState().embedRenderers
  if (findEmbedRenderer(renderers, target.trim())) return { k: 'plugin', target: target.trim() }
  // 第二问的 base:无 `#` 时是整条,有 `#` 时**只对媒体锚点**剥出 base —— 否则插件永远认领不了
  // 带时刻的 `![[a.mp4#t=95]]`(能力对等原则)。`![[C# 日记.md]]` 这种文件名含 `#` 的仍拿不到 base,
  // 维持原样(那正是 `!t.includes('#')` 这道闸当初要防的)。
  const pluginBase = t.includes('#') ? parseMediaLinkInner(t)?.target ?? null : t
  if (pluginBase && findEmbedRenderer(renderers, pluginBase)) return { k: 'plugin', target: pluginBase }
  // 裸 `.md` = 笔记:必须先于文件卡判定,否则 `![[某笔记.md]]` 渲染成「📄 打开 ↗」的文件卡
  //(点了还去调系统默认程序)—— 2026-08-20 用户实报「md 笔记无法渲染」。复合后缀 `.x.md`
  // 仍归上面的插件/画板分支,插件缺席时才落到文件卡(它有自己的「在 Forsion 里打开」)。
  if (isPlainNoteRef(t)) return { k: 'note', target }
  // 音视频(带或不带 `#t=` 时刻锚)。**这是对 `!t.includes('#')` 闸的精确开孔**:只对音视频后缀、
  // 只让 `t=` 形态解出 loc —— 块锚点(`![[笔记#块]]`)与文件名含 `#` 的形态一律走不到这里。
  // 锚点解不开(`#t=1:35` / `#page=3`)时 loc=null + badAnchor,照样渲播放器从 0 秒起播并提示,
  // 绝不掉到下面的 note 兜底变成「嵌入丢失」——那是静默失败的另一种形态。
  const media = parseMediaLinkInner(t)
  if (media) {
    return {
      k: 'file',
      name: media.target,
      fileKind: VIDEO_EXT_RE.test(media.target) ? 'video' : 'audio',
      loc: media.loc,
      badAnchor: t.includes('#') && !media.loc,
      w: embedWidthOf(target),
    }
  }
  if (!t.includes('#') && FILE_EXT_RE.test(t)) {
    return { k: 'file', name: t, fileKind: PDF_EXT_RE.test(t) ? 'pdf' : 'other', w: embedWidthOf(target) }
  }
  return { k: 'note', target }
}

// ── 桥接组件(只吃字符串 + 回调,不读 activePage —— unified 数据安全禁令)────────────────

function FileEmbed({ name, fileKind, pagePath, loc, badAnchor, insertAfter }: {
  name: string
  fileKind: 'pdf' | 'video' | 'audio' | 'other'
  pagePath: string
  loc?: MediaLoc | null
  badAnchor?: boolean
  /** 截帧要在本块之后插入「图片 + 回源锚点」两段。 */
  insertAfter?: (md: string) => void
}): ReactElement {
  const files = usePageStore((s) => s.files)
  const openWikiLink = usePageStore((s) => s.openWikiLink)
  const [open, setOpen] = useState(true)
  const pdfVaultPath = fileKind === 'pdf' ? resolveFileName(name, files, pagePath) : null
  if (fileKind === 'other') {
    return (
      <button
        className="embed-file"
        onClick={() => {
          if (/\.[a-z0-9]+\.md$/i.test(name)) openWikiLink(name, pagePath)
          else void amadeus.openAttachment(pagePath, name)
        }}
        title={/\.[a-z0-9]+\.md$/i.test(name) ? '在 Forsion 标签页中打开' : '用系统默认程序打开'}
      >
        <span className="embed-file-ic" aria-hidden>📄</span>
        <span className="embed-file-name">{name}</span>
        <span className="embed-file-open">打开 ↗</span>
      </button>
    )
  }
  // ⚠️ name 到这里**已经是剥掉 subpath 的 base**(classifyEmbed 保证)。别把带 `#t=` 的 target
  // 直接怼进 toAssetUrl —— `#` 会被编成路径的一部分,当场 404。
  const url = toAssetUrl(name)
  return (
    <div className="embed-media">
      <div className="embed-media-head">
        <span className="embed-file-ic" aria-hidden>{fileKind === 'pdf' ? '📕' : fileKind === 'video' ? '🎬' : '🎵'}</span>
        <span className="embed-file-name">{name}</span>
        {loc && <span className="embed-media-at" title="起播时刻">@{mediaLabel(loc.at)}{loc.to ? `–${mediaLabel(loc.to)}` : ''}</span>}
        {badAnchor && (
          <span className="embed-media-warn" title="只认 #t=95 / #t=01:35 / #t=1:02:30(MM 与 SS 须两位)">锚点无效 · 从 0 秒起播</span>
        )}
        <button className="embed-media-btn" onClick={() => setOpen((o) => !o)}>{open ? '收起' : '展开'}</button>
        <button
          className="embed-media-btn"
          title={fileKind === 'pdf' ? '在 Forsion 标签页中打开(可批注)' : '用系统默认程序打开'}
          onClick={() => {
            if (fileKind === 'pdf') openWikiLink(name, pagePath)
            else void amadeus.openAttachment(pagePath, name)
          }}
        >
          打开 ↗
        </button>
      </div>
      {open && fileKind === 'pdf' && (
        pdfVaultPath ? (
          <div className="embed-pdf embed-pdf-live">
            <Suspense fallback={<div className="embed-pdf-loading">加载 PDF…</div>}>
              <PdfEmbedViewer pdfPath={pdfVaultPath} readOnly />
            </Suspense>
          </div>
        ) : (
          // webhost-ok: 固定已知嵌入(Chromium 内置 PDF 阅读器),无 sandbox 属性 → 不削能力
          <iframe className="embed-pdf" src={url} title={name} />
        )
      )}
      {open && (fileKind === 'video' || fileKind === 'audio') && (
        <MediaPlayer kind={fileKind} url={url} name={name} pagePath={pagePath} loc={loc ?? null} insertAfter={insertAfter} />
      )}
    </div>
  )
}

function CrossNoteEmbed({ target }: { target: string }): ReactElement {
  const openWikiLink = usePageStore((s) => s.openWikiLink)
  const loadPage = usePageStore((s) => s.loadPage)
  const pages = usePageStore((s) => s.pages)
  const linkVersion = usePageStore((s) => s.linkGraphVersion)
  const [embed, setEmbed] = useState<EmbedResolved | null | 'loading'>('loading')
  useEffect(() => {
    let alive = true
    setEmbed('loading')
    // IPC 面可选调用:web/harness 环境没有 resolveEmbed 时按「未解析」降级,不炸组件。
    Promise.resolve(amadeus.resolveEmbed?.(target) ?? null)
      .then((r) => { if (alive) setEmbed(r) })
      .catch(() => { if (alive) setEmbed(null) })
    return () => { alive = false }
  }, [target, linkVersion])
  const et = embed && embed !== 'loading' ? getBlockType(embed.type) : undefined
  const EmbedEditor = et?.Editor
  return (
    <div className="embed-body">
      <div className="embed-head">
        <span className="embed-badge" title="跨笔记嵌入（只读）">↪ 嵌入</span>
        {embed && embed !== 'loading' && (
          <button className="embed-src" onClick={() => void loadPage(embed.owner)} title="去源头编辑">
            {stripPageBasename(embed.owner)} ↗
          </button>
        )}
      </div>
      {embed === 'loading' ? (
        <div className="embed-loading">解析中…</div>
      ) : embed && EmbedEditor ? (
        <EmbedEditor
          blockId="uembed"
          content={embed.content}
          pagePath={embed.owner}
          readOnly
          onChange={noop}
          onInsertAfter={noop}
          onDeleteEmpty={noop}
          onMergePrev={noop}
          onArrowOut={noop}
          onMoveDir={noop}
          focusPlace={null}
          onFocused={noop}
          requestSelfFocus={noop}
          onOpenWiki={(name) => openWikiLink(name, embed.owner)}
          getPageNames={() => pages}
        />
      ) : (
        <div className="embed-missing">嵌入丢失：<code>{target}</code></div>
      )}
    </div>
  )
}

function EmbedBody({ kind, pagePath, replaceText, insertAfter }: {
  kind: EmbedKind
  pagePath: string
  /** 组件要求改写源文本(书签改 URL / db 换视图 / 按钮改配置)→ 单事务替换节点内文。 */
  replaceText: (next: string) => void
  /** 在本块之后插入若干段(截帧的「图片 + 回源锚点」)。 */
  insertAfter: (md: string) => void
}): ReactElement {
  switch (kind.k) {
    case 'db':
      return (
        <DatabaseEmbed
          target={kind.name}
          pagePath={pagePath}
          initialView={kind.view ?? undefined}
          onViewChange={(v) => replaceText(v ? `![[${kind.name}|${v}]]` : `![[${kind.name}]]`)}
        />
      )
    case 'draw':
      return <ExcalidrawEmbed target={kind.target} pagePath={pagePath} />
    case 'plugin':
      return <PluginEmbed target={kind.target} pagePath={pagePath} />
    case 'file':
      return (
        <FileEmbed
          name={kind.name} fileKind={kind.fileKind} pagePath={pagePath}
          loc={kind.loc} badAnchor={kind.badAnchor} insertAfter={insertAfter}
        />
      )
    case 'note':
      return <CrossNoteEmbed target={kind.target} />
    case 'bookmark':
      // 卡片 ⇄ 内嵌互转就是同一行文本的两种字面,可逆无损(Notion / AFFiNE 的三态互转同款)。
      return <BookmarkCard url={kind.url} onChangeUrl={(next) => replaceText(next)} onEmbed={() => replaceText(`![[${wikiSafeUrl(kind.url)}]]`)} />
    case 'web':
      return <WebEmbed url={kind.url} toCard={() => replaceText(kind.url)} />
    case 'button': {
      const spec = parseButtonBlock('```forsion-button\n' + kind.src + '\n```')
      if (!spec) return <span /> // JSON 坏:装饰层不该到这(classify 已过),兜底空
      return <ButtonBlock spec={spec} onChange={(next: ButtonSpec) => replaceText(codeBody(serializeButtonBlock(next)))} />
    }
  }
}

/** serializeButtonBlock 给的是整个 fence;code_block 内文替换只要 body。 */
function codeBody(fence: string): string {
  const m = /^```forsion-button[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(fence.trim())
  return m ? m[1] : fence
}

// ── 装饰层本体 ────────────────────────────────────────────────────────────────────────
interface WidgetEntry {
  root: Root
  dom: HTMLElement
}

export function createEmbedLayer(opts: { path: string }): MilkdownPlugin[] {
  const plugin = $prose(() => {
    const key = new PluginKey('UNIFIED_EMBED_LAYER')
    const roots = new Map<string, WidgetEntry>() // key → 活 widget(同 key 复用,PM 不重建 DOM)

    const buildDecos = (doc: ProseNode, selFrom: number, selTo: number): DecorationSet => {
      const decos: Decoration[] = []
      const seen = new Map<string, number>() // 同文嵌入按出现序号区分身份(Codex 终审 P1:同 key 共享 DOM 会互相拆台)
      const visit = (node: ProseNode, pos: number): void => {
        const kind = classifyEmbed(node)
        if (!kind) return
        const baseKey = `${kind.k}:${node.textContent}`
        const nth = seen.get(baseKey) ?? 0
        seen.set(baseKey, nth + 1)
        // 光标在节点内 → 让位露源码(编辑入口;含选区跨节点的情形按重叠算)。
        if (selTo > pos && selFrom < pos + node.nodeSize) return
        const dkey = `${baseKey}#${nth}`
        decos.push(Decoration.inline(pos + 1, pos + node.nodeSize - 1, { class: 'wikilink-src-hidden' }))
        // 本段已归块级嵌入 → 给段落打标,行内双链层渲出来的那条链接由 CSS 收掉(2026-08-22 实报:
        // 嵌入体底下多挂一条下划线的笔记名)。inline 装饰只藏得住**文本**,藏不住 wikilink.ts 的
        // widget —— 而那层不能一刀切跳过整段:嵌入体内的只读 MarkdownBlock 没装本层,那里的
        // `![[x]]` 正是靠行内双链渲的。所以判据留在这里,由「本层确实接手了」这件事本身表达。
        decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'unified-embed-host' }))
        decos.push(
          Decoration.widget(
            pos + 1,
            () => {
              const cached = roots.get(dkey)
              if (cached && cached.dom.isConnected === false) {
                // PM 复用 key 但 DOM 已摘除过:重挂同一棵
                return cached.dom
              }
              if (cached) return cached.dom
              const dom = document.createElement('div')
              dom.className = 'unified-embed'
              dom.contentEditable = 'false'
              // 双击 = 露源码编辑(v3 EmbedSourceLine 同款入口):把光标送进节点内,
              // 装饰因「选区在内」整体让位。竖直方向键会跳过 display:none 的源码行(无行盒),
              // 所以这是键盘外唯一的源码入口,别删。
              // 同文嵌入按出现序号定位(与 dkey 同口径):双击第二个不许跳进第一个的源码。
              const findNth = (v: EditorView): { at: number; size: number } | null => {
                let i = 0
                let hit: { at: number; size: number } | null = null
                v.state.doc.descendants((n, p) => {
                  if (hit) return false
                  // ⚠️ 口径必须与 buildDecos 的 `seen` **逐字一致**:那边的 key 是
                  // `${kind.k}:${textContent}`,只按 textContent 数会把**同文但类别不同**的节点
                  // 也数进来(最典型:一个 ```forsion-button 代码块的正文恰好与某段落同文)——
                  // 序号一错位,双击进错源码、replaceText 改错对象、insertAfter 插到别人后面。
                  if (classifyEmbed(n)?.k === kind.k && n.textContent === node.textContent) {
                    if (i === nth) {
                      hit = { at: p, size: n.nodeSize }
                      return false
                    }
                    i++
                    return false
                  }
                  return true
                })
                return hit
              }
              dom.addEventListener('dblclick', (e) => {
                e.preventDefault()
                e.stopPropagation()
                const v = viewRef
                if (!v) return
                const hit = findNth(v)
                if (!hit) return
                v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(hit.at + 1))))
                v.focus()
              })
              const replaceText = (next: string): void => {
                const v = viewRef // 闭包必须抓活引用:init 期建的 widget 那会儿还没有 view
                if (!v) return
                const hit = findNth(v) // 同文嵌入按出现序号回写,不许写错对象
                if (!hit) return
                v.dispatch(v.state.tr.insertText(next, hit.at + 1, hit.at + hit.size - 1))
              }
              // 宽度 `![[…|560]]`:像图片一样拖右缘把手改宽,高度交给各自的 aspect-ratio / 内容高。
              // 只给网页与媒体/PDF —— db/画板/插件/跨笔记各有自己的尺寸语义,而 `|` 段在那些形态上
              // 另有含义(视图名 / 别名)。
              const resizable = kind.k === 'web' || (kind.k === 'file' && kind.fileKind !== 'other')
              const w = kind.k === 'web' || kind.k === 'file' ? kind.w : undefined
              if (w) dom.style.width = `${w}px`
              // ⚠️ React 的 createRoot 在首次提交时会清空容器 —— 把手若是 dom 的子节点会被一起抹掉。
              // 所以可缩放时多套一层:React 只管里层,把手留在外层(它也正是被量宽度的那个元素)。
              let host: HTMLElement = dom
              if (resizable) {
                host = document.createElement('div')
                dom.appendChild(host)
                const inner = EMBED_RE.exec(node.textContent.trim())?.[1]
                if (inner !== undefined) {
                  // ponytail: 落盘即改块内文本 → dkey 变 → widget 重挂,拖完播放中的视频/网页会重载一次。
                  // 要免掉就得把宽度挪出正文(节点 attrs),那是另一套落盘格式,不值。
                  attachResizeHandle(dom, dom, (width) => replaceText(`![[${withEmbedWidth(inner, width)}]]`))
                }
              }
              const root = createRoot(host)
              root.render(
                <EmbedBody
                  kind={kind}
                  pagePath={opts.path}
                  insertAfter={(md) => {
                    // 本层的语法(`![[x]]` / `[[x#t=95|01:35]]`)都是**段落里的纯文本**,所以插入
                    // 不需要 markdown parser —— 直接建段落节点,序列化回磁盘就是原样那几行。
                    const v = viewRef
                    if (!v) return
                    const hit = findNth(v)
                    if (!hit) return
                    const para = v.state.schema.nodes.paragraph
                    if (!para) return
                    const blocks = md.split(/\n{2,}/).map((line) => para.create(null, line ? v.state.schema.text(line) : null))
                    v.dispatch(v.state.tr.insert(hit.at + hit.size, blocks))
                  }}
                  replaceText={replaceText}
                />,
              )
              roots.set(dkey, { root, dom })
              return dom
            },
            {
              key: dkey,
              side: -1,
              ignoreSelection: true,
              // ⚠️ 嵌入体里的输入控件(多维表公式框/单元格/搜索、插件表单、嵌入笔记的第二个编辑器)按键
              // **必须止步于此**:widget 装饰默认不拦事件,PM 的 eventBelongsToView 一路走到 view.dom,
              // 于是 baseKeymap 的 Backspace 拿**外层**选区跑 joinBackward —— 段落被合并、选区落进本节点,
              // 上面那句「光标在节点内 → 让位露源码」随即生效:整个嵌入退化成 `![[…]]` 源文。
              // (2026-09-01 用户实报「公式框里按删除键,整张多维表变源码」。这洞比 2.8 那批列型早,
              //  只是公式框是第一个让人连按删除键的地方。Enter 没事只因各控件自己 preventDefault 了,
              //  普通字母没事只因它压根没进 keymap —— 都不是防线。)
              // 只拦键盘/输入/剪贴板族:鼠标族留给 PM(块拖拽、宽度把手、双击进源码都在这层附近)。
              stopEvent: (e: Event) => /^(key|composition|beforeinput|input|paste|cut|copy)/.test(e.type),
              destroy: () => {
                const entry = roots.get(dkey)
                if (!entry) return
                roots.delete(dkey)
                queueMicrotask(() => entry.root.unmount()) // PM 渲染周期内不许同步 unmount
              },
            },
          ),
        )
      }
      // 整棵树都走一遍,不再逐种容器特判:分栏 cell 与**画布卡片**里的嵌入同样照渲染
      // (2026-08-22 用户实报「画布上卡里的 ![[…]] 只剩一个 ! 加个链接」—— 旧版只扫顶层 +
      // amadeusColumnRow,卡内那份根本拿不到 widget,退化成 wikilink 行内层的兜底)。
      // ⚠️ 枚举口径必须与 findNth 的 doc.descendants 逐字一致:两边错位 = 双击第 n 个嵌入
      // 会把光标送进第 m 个的源码。
      doc.descendants((node, pos) => {
        visit(node, pos)
        return true
      })
      return DecorationSet.create(doc, decos)
    }

    let viewRef: EditorView | null = null
    return new Plugin({
      key,
      view: (v) => {
        viewRef = v
        return {
          destroy: () => {
            viewRef = null
            for (const [, e] of roots) queueMicrotask(() => e.root.unmount())
            roots.clear()
          },
        }
      },
      state: {
        init: (_, state) => buildDecos(state.doc, state.selection.from, state.selection.to),
        apply: (tr, old, _oldState, newState) => {
          if (!tr.docChanged && !tr.selectionSet) return old.map(tr.mapping, tr.doc)
          return buildDecos(newState.doc, newState.selection.from, newState.selection.to)
        },
      },
      props: {
        decorations(state) {
          return key.getState(state) as DecorationSet
        },
      },
    })
  })
  return [plugin].flat()
}
