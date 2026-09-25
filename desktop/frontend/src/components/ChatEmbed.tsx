// 聊天气泡里独占一段的 `![[…]]` = 内联嵌入(图片 / 音视频)—— Agent Desk 之外的第二条展示通道:
// Desk 是聊天旁「一件大东西」,这里是正文里「N 件小东西」。解析口径与 ChatWikiLink 同源(库内相对路径 /
// 库外绝对路径、裸文件名撞名不猜);判不出、读不到、渲不了的一律退回那条引用条,绝不留空白或转圈。
import { useEffect, useMemo, useState } from 'react'
import { embedWidthOf, isHostPath, parseMediaLinkInner, splitLinkInner, VIDEO_EXT_RE } from '@amadeus-shared/pdfLink'
import { toAssetUrl } from '@amadeus-shared/assets'
import { isAmbiguousFileRef, resolveFileName } from '@amadeus/lib/vaultFiles'
import { usePageStore } from '../amadeus/store/pageStore'
import { b64ToBytes, mimeForExt } from '../services/fileKinds'
import { ChatWikiLink, openFileCitation } from './ChatWikiLink'

/** 开嵌入的调用点给的上下文(只有 EditorialMessage 给,见 Markdown 的 EmbedContext)。 */
export interface EmbedCtx {
  /** 库外绝对路径只在 host 会话读本机盘:sandbox 会话写的 `/workspace/x.png` 是云工作区里的文件。 */
  execMode?: 'sandbox' | 'host'
}

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i // 与 wikilink.ts / embedLayer.tsx 同口径

type Hit = { kind: 'image' | 'video' | 'audio'; abs: string; vault: string | null; name: string; frag: string }

export function ChatEmbed({ inner, ctx }: { inner: string; ctx: EmbedCtx }) {
  const files = usePageStore((s) => s.files)
  const root = usePageStore((s) => s.vaultRoot)
  const hit = useMemo((): Hit | null => {
    const { target } = splitLinkInner(inner)
    const media = parseMediaLinkInner(inner)
    const kind = media ? (VIDEO_EXT_RE.test(media.target) ? 'video' : 'audio') : IMG_EXT_RE.test(target) ? 'image' : null
    if (!kind) return null
    // 起播时刻交给浏览器原生 Media Fragments(`#t=95,120` 连「到点暂停」都管),不写 seek 代码。
    const loc = media?.loc
    const frag = loc ? `#t=${loc.at}${loc.to ? `,${loc.to}` : ''}` : ''
    const rel = root && target.startsWith(root + '/') ? target.slice(root.length + 1) : target
    const name = rel.split(/[\\/]/).pop() || rel
    if (isHostPath(rel)) return ctx.execMode === 'host' ? { kind, abs: rel, vault: null, name, frag } : null
    if (!root || isAmbiguousFileRef(rel, files)) return null // 撞名多份:宁可引用条也不静默挑一份
    const p = resolveFileName(rel, files)
    return p ? { kind, abs: `${root}/${p}`, vault: p, name, frag } : null
  }, [inner, root, files, ctx.execMode])
  const [blob, setBlob] = useState<{ abs: string; url: string } | null>(null)
  const [failed, setFailed] = useState(false)
  const hostAbs = hit && !hit.vault ? hit.abs : null
  useEffect(() => {
    setFailed(false)
    if (!hostAbs) return
    // ponytail: 库外走 readHostFile 整文件 base64(与 InlineFiles / WsFileView 同一条路、同一个 50MB 闸);
    // 超了退引用条。>50MB 视频真成刚需时,给 amadeus-asset:// 加一个按「agent 摆出来过的路径」白名单放行的 host 面做流式读。
    const read = window.tangu?.readHostFile
    if (!read) { setFailed(true); return }
    let alive = true
    let url: string | null = null
    read(hostAbs).then((r) => {
      if (!alive) return
      if (r.tooLarge) { setFailed(true); return }
      url = URL.createObjectURL(new Blob([b64ToBytes(r.content) as BlobPart], { type: mimeForExt(hostAbs) || r.mimeType }))
      setBlob({ abs: hostAbs, url })
    }, () => { if (alive) setFailed(true) })
    return () => { alive = false; if (url) URL.revokeObjectURL(url) }
  }, [hostAbs])
  if (!hit || failed) return <ChatWikiLink inner={inner} />
  const src = hit.vault ? toAssetUrl(hit.vault) : blob?.abs === hit.abs ? blob.url : null
  const w = embedWidthOf(inner)
  const style = w ? { width: w } : undefined
  if (!src) return <div className={`t2-embed t2-embed-${hit.kind} t2-embed-pending`} style={style} title={hit.abs} />
  const fail = (): void => setFailed(true)
  if (hit.kind === 'image') {
    return (
      <img
        className="t2-embed t2-embed-image" src={src} alt={hit.name} title={hit.abs} style={style} draggable={false}
        onClick={() => { void openFileCitation(hit.abs, hit.name, null) }} onError={fail}
      />
    )
  }
  if (hit.kind === 'video') {
    return <video className="t2-embed t2-embed-video" src={src + hit.frag} controls preload="metadata" title={hit.abs} style={style} onError={fail} />
  }
  return <audio className="t2-embed t2-embed-audio" src={src + hit.frag} controls preload="metadata" title={hit.abs} style={style} onError={fail} />
}
