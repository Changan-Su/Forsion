/** 收件箱正文的只读块渲染器:按 Amadeus 顶层块切分(splitIntoBlocks),整块恰为 `![[...]]` 的走
 *  嵌入卡片(图片/数据库/画板/插件文件/文件/跨笔记引用,复用 Amadeus 叶子组件 + resolveEmbed),
 *  其余块仍走现成 <Markdown/>(gfm/math/高亮,与聊天一致)。嵌入必须包一层 .am-app tangu-lovable ——
 *  收件箱是独立 leaf,不在编辑器 .am-app 作用域内,而块样式(.embed-body/.md-block/.block-body)全挂在 .am-app 下。
 *  分类顺序与门禁与 BlockHost 一致(图片→db→画板→插件→文件→跨笔记),避免文件卡吃掉 db/画板/插件。 */
import { Suspense, useEffect, useId, useMemo, useState } from 'react'
import { lazyRetry } from '../../lazyRetry'
import { splitIntoBlocks } from '@amadeus-shared/compiler/split'
import { stripPageBasename } from '@amadeus-shared/compiler/names'
import { toAssetUrl } from '@amadeus-shared/assets'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import type { EmbedResolved } from '@amadeus-shared/ipc'
import { amadeus } from '@amadeus/api'
import { getBlockType } from '@amadeus/blocks/registry'
import { DatabaseEmbed } from '@amadeus/blocks/database/DatabaseEmbed'
import { ExcalidrawEmbed } from '@amadeus/blocks/excalidraw/ExcalidrawEmbed'
import { PluginEmbed } from '@amadeus/blocks/plugin/PluginEmbed'
import { usePluginStore, findEmbedRenderer } from '@amadeus/plugins/pluginStore'
import { usePageStore } from '@amadeus/store/pageStore'
import { resolveFileName, resolveVaultPath } from '@amadeus/lib/vaultFiles'
// 判定与 embedLayer / BlockHost 同源同序:音视频后缀与 `#t=` 时刻锚都取 shared 这一份。
import { parseMediaLinkInner, VIDEO_EXT_RE, mediaLabel, type MediaLoc, embedUrlOf} from '@amadeus-shared/pdfLink'
import { isPlainNoteRef } from '@amadeus-shared/builtinTypes'
import { MediaPlayer } from '@amadeus/components/MediaPlayer'
import { BookmarkCard } from '@amadeus/components/BookmarkCard'
import { Markdown } from '../../components/Markdown'
import { openFile, openNote } from '../../amadeusNav'

const PdfEmbedViewer = lazyRetry(() => import('@amadeus/pdf/PdfAnnotator').then((m) => ({ default: m.PdfAnnotator })))

const EMBED_RE = /^!\[\[([^\]\n]+)\]\]$/
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i
const FILE_EXT_RE = /\.[a-z0-9]{1,8}$/i
const DB_EXT_RE = /\.db$/i
const PDF_EXT_RE = /\.pdf$/i
const noop = (): void => {}

export function InboxBody({ body }: { body: string }) {
  const blocks = useMemo(() => splitIntoBlocks(body || ''), [body])
  return (
    <>
      {blocks.map((content, i) => {
        const m = EMBED_RE.exec(content.trim())
        if (!m) return <Markdown key={i} content={content} />
        return (
          <div key={i} className="am-app tangu-lovable ibx-embed">
            <InboxEmbed target={m[1]} />
          </div>
        )
      })}
    </>
  )
}

/** 单个 `![[target]]` 块 → 按类型只读渲染(复用 BlockHost 的分类判定与叶子组件)。 */
function InboxEmbed({ target }: { target: string }) {
  const embedRenderers = usePluginStore((s) => s.embedRenderers)
  const [rawPath, pipe] = target.split('|')
  const p = rawPath.trim()
  const seg = pipe?.trim()

  // 图片(`![[pic.png|200]]`):裸文件名经 amadeus-asset:// 协议在全库定位(Obsidian 式)。
  if (IMG_EXT_RE.test(p)) {
    return (
      <div className="block-body embed-image-body">
        <img
          className="embed-image"
          src={toAssetUrl(p)}
          alt={p}
          draggable={false}
          style={seg && /^\d+$/.test(seg) ? { width: Number(seg) } : undefined}
        />
      </div>
    )
  }
  // `![[https://…]]` → 收件箱是**只读流**:一律书签卡,不给唤醒(在流里给每条消息挂一个渲染进程
  // 是灾难)。**位置与另外两条链逐字同序**:图片之后、一切文件判定之前 —— URL 里的 `.db`/`.html`
  // 会被下面的后缀判定当成文件后缀抢走。
  // ⚠️ 刻意与另两条链**分道**的一点:笔记里 `![[youtube…]]` 会渲成 iframe 播放器,这里不会。
  // 同一条理由 —— 一条流几十个跨源 iframe,和几十个 webview 一样是灾难。
  // ⚠️ 用 embedUrlOf 吃整条 target(只剥末段宽度):`split('|')[0]` 会截断 `?q=a|b` 这类合法 URL。
  const webUrl = embedUrlOf(target)
  if (webUrl) {
    return <div className="block-body"><BookmarkCard url={webUrl} /></div>
  }
  // 数据库(交互式表格,数据在独立 .db;pagePath='' 让裸名全库定位)。ponytail: 与笔记一致可交互,
  // 收件箱里编辑即改真 .db;如需纯只读再加门(叶子组件当前无 readOnly)。
  if (!p.includes('#') && DB_EXT_RE.test(p)) {
    return <div className="block-body"><DatabaseEmbed target={p} pagePath="" initialView={seg || null} /></div>
  }
  // 画板(Excalidraw)
  if (!p.includes('#') && isDrawingPath(p)) {
    return <div className="block-body"><ExcalidrawEmbed target={p} pagePath="" /></div>
  }
  // 思维导图(内置文件类型):必须先于插件与「非图片文件」两条 —— 后者会把它丢给系统默认程序
  // (在 TextEdit 里打开一张导图),而 `.mindmap.md` 走到最后一条又会被当成跨笔记引用渲染成生块。
  if (!p.includes('#') && /\.[a-z0-9]+\.md$/i.test(p)) {
    return <InboxPluginFileEmbed name={p} />
  }
  // 插件声明的文件类型:先拿完整 target 问一次(`#`/`|` 可能是文件名一部分),再退回 `#` 前问。
  const pluginTarget = findEmbedRenderer(embedRenderers, target.trim())
    ? target.trim()
    : !p.includes('#') && findEmbedRenderer(embedRenderers, p) ? p : null
  if (pluginTarget) {
    return <div className="block-body"><PluginEmbed target={pluginTarget} pagePath="" /></div>
  }
  // 裸 `.md` = 笔记,不是文件卡。**这道闸 v4/v3 两条链 2026-08-20 就补了,收件箱一直没同步** ——
  // 于是 `![[某笔记.md]]` 在收件箱里仍渲染成「📄 打开 ↗」文件卡(点了去调系统默认程序)。
  if (isPlainNoteRef(p)) return <InboxNoteEmbed target={target} />
  // 音视频(带或不带 `#t=` 时刻锚)。判定与另外两条链逐字同源。
  const media = parseMediaLinkInner(p)
  if (media) return <InboxFileEmbed name={media.target} loc={media.loc} badAnchor={p.includes('#') && !media.loc} />
  // 非图片文件(pdf / 其它)
  if (!p.includes('#') && FILE_EXT_RE.test(p)) {
    return <InboxFileEmbed name={p} />
  }
  // 跨笔记块/笔记引用
  return <InboxNoteEmbed target={target} />
}

/** 思维导图嵌入:收件箱不渲染画布(单活页 pageStore 装不下第二张图),给一张在应用内打开的卡片。 */
function InboxPluginFileEmbed({ name }: { name: string }) {
  const files = usePageStore((s) => s.files)
  const full = useMemo(() => resolveVaultPath(name, files, '') ?? name, [name, files])
  return (
    <div className="block-body">
      <button className="embed-file" onClick={() => openFile(full)} title="在 Forsion 标签页中打开">
        <span className="embed-file-ic" aria-hidden>🧠</span>
        <span className="embed-file-name">{name}</span>
        <span className="embed-file-open">打开 ↗</span>
      </button>
    </div>
  )
}

/** 文件嵌入:pdf 内联只读阅读器(解析不出退回 iframe),音视频原生播放器,其它 = 打开按钮。 */
function InboxFileEmbed({ name, loc, badAnchor }: { name: string; loc?: MediaLoc | null; badAnchor?: boolean }) {
  const kind = PDF_EXT_RE.test(name) ? 'pdf' : VIDEO_EXT_RE.test(name) ? 'video' : /\.(mp3|wav|ogg|m4a|flac)$/i.test(name) ? 'audio' : 'other'
  const files = usePageStore((s) => s.files)
  const pdfPath = useMemo(() => (kind === 'pdf' ? resolveFileName(name, files, '') : null), [kind, name, files])
  if (kind === 'other') {
    const full = resolveFileName(name, files, '') ?? name
    return (
      <div className="block-body">
        <button className="embed-file" onClick={() => void amadeus.openVaultFile(full).catch(() => {})} title="用系统默认程序打开">
          <span className="embed-file-ic" aria-hidden>📄</span>
          <span className="embed-file-name">{name}</span>
          <span className="embed-file-open">打开 ↗</span>
        </button>
      </div>
    )
  }
  const url = toAssetUrl(name)
  return (
    <div className="block-body">
      <div className="embed-media">
        <div className="embed-media-head">
          <span className="embed-file-ic" aria-hidden>{kind === 'pdf' ? '📕' : kind === 'video' ? '🎬' : '🎵'}</span>
          <span className="embed-file-name">{name}</span>
          {loc && <span className="embed-media-at" title="起播时刻">@{mediaLabel(loc.at)}</span>}
          {badAnchor && <span className="embed-media-warn">锚点无效 · 从 0 秒起播</span>}
        </div>
        {kind === 'pdf' && (pdfPath ? (
          <div className="embed-pdf embed-pdf-live">
            <Suspense fallback={<div className="embed-pdf-loading">加载 PDF…</div>}>
              <PdfEmbedViewer pdfPath={pdfPath} readOnly />
            </Suspense>
          </div>
        ) : (
          // webhost-ok: 固定已知嵌入(Chromium 内置 PDF 阅读器),无 sandbox 属性 → 不削能力
          <iframe className="embed-pdf" src={url} title={name} />
        ))}
        {/* 收件箱是只读流:不给截帧(insertAfter 缺席即隐藏按钮)。 */}
        {(kind === 'video' || kind === 'audio') && (
          <MediaPlayer kind={kind} url={url} name={name} pagePath="" loc={loc ?? null} />
        )}
      </div>
    </div>
  )
}

/** 跨笔记块/笔记引用:resolveEmbed → 用被引块自己的 BlockType.Editor 只读渲染(markdown 块自带
 *  Milkdown 实例,可独立挂载);头部「去源头」在编辑器打开该笔记。目标须在当前 Vault 已索引才解析得出。 */
function InboxNoteEmbed({ target }: { target: string }) {
  const blockId = useId()
  const [embed, setEmbed] = useState<EmbedResolved | null | 'loading'>('loading')
  useEffect(() => {
    let alive = true
    setEmbed('loading')
    // ponytail: 消息静态,只在 target 变时解析一次;源笔记改了重开消息即重解析(不订阅 linkGraphVersion)。
    amadeus.resolveEmbed(target).then((r) => { if (alive) setEmbed(r) }).catch(() => { if (alive) setEmbed(null) })
    return () => { alive = false }
  }, [target])
  const et = embed && embed !== 'loading' ? getBlockType(embed.type) : undefined
  const EmbedEditor = et?.Editor
  return (
    <div className="block-body embed-body">
      <div className="embed-head">
        <span className="embed-badge" title="跨笔记嵌入(只读)">↪ 嵌入</span>
        {embed && embed !== 'loading' && (
          <button className="embed-src" onClick={() => void openNote(embed.owner)} title="去源头">
            {stripPageBasename(embed.owner)} ↗
          </button>
        )}
      </div>
      {embed === 'loading' ? (
        <div className="embed-loading">解析中…</div>
      ) : embed && EmbedEditor ? (
        <EmbedEditor
          blockId={blockId}
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
          onOpenWiki={(name) => void usePageStore.getState().openWikiLink(name, embed.owner)}
          getPageNames={() => usePageStore.getState().pages}
        />
      ) : (
        <div className="embed-missing">嵌入丢失:<code>{target}</code></div>
      )}
    </div>
  )
}
