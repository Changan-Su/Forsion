/**
 * Chat 正文里的网页链接:悬停 300ms 出预览卡(LCL 悬停卡,相邻链接接力),手机上长按出同一张(借鉴 Comma 方案 §2.6)。
 *
 * - 富卡:GitHub / Forsion Git 的 PR、issue。卡**第一次打开**时才问引擎要数据(GET /agent/link-preview,引擎用这台机器上
 *   绑定的凭据去问;渲染层不直连外站)。同一条链接再悬停用组件里那份;别处的同一条链接再问一次本机引擎,引擎按「用户 + 地址」
 *   缓存着。渲染层不另存一份按地址的缓存:换了账号它不知道,会把上一个人私有仓的卡给下一个人看(Codex 评审 P1)。
 * - 素卡:其余链接,以及富卡问不到的(没绑定且限流、私有仓、老引擎、远端设备不放行):图标 + 链接文字 + 站名 · 路径。
 *   只看 URL,不联网,不报错。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { FileText, Globe } from 'lucide-react'
import { useHoverCard } from '@lcl/components'
import { registerMessages, useI18n } from '../i18n'
import { getLinkPreview, type LinkPreview } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { ChatWebLink, textOf } from './ChatWikiLink'
import './chatLinkCard.css'

registerMessages({
  'chatLink.state.open': { zh: '进行中', en: 'Open' },
  'chatLink.state.draft': { zh: '草稿', en: 'Draft' },
  'chatLink.state.merged': { zh: '已合并', en: 'Merged' },
  'chatLink.state.closed': { zh: '已关闭', en: 'Closed' },
  'chatLink.file': { zh: '{n} 个文件', en: '{n} file' },
  'chatLink.files': { zh: '{n} 个文件', en: '{n} files' },
  'chatLink.comment': { zh: '{n} 条评论', en: '{n} comment' },
  'chatLink.comments': { zh: '{n} 条评论', en: '{n} comments' },
})

/** 站点认得的才写站名;别的只写主机 + 路径。 */
const SITES: Record<string, string> = {
  'github.com': 'GitHub',
  'www.github.com': 'GitHub',
  'git.forsion.net': 'Forsion Git',
  'forsion.net': 'Forsion',
  'www.forsion.net': 'Forsion',
}

/** 可能是 PR / issue 的形状才去问引擎(主机认不认由引擎定),别的链接一次请求都不发。 */
export const mayHaveRichCard = (href: string): boolean => /^https:\/\/[^/?#]+(?:\/[^/?#]+)*?\/[^/?#]+\/[^/?#]+\/(?:pull|pulls|issues)\/\d+(?:[/?#]|$)/i.test(href)

const decode = (s: string): string => { try { return decodeURIComponent(s) } catch { return s } }

/** 素卡第二行:站名 + 主机 / 路径;路径长了留头两段和最后一段(文件名最有用)。 */
export function linkPlace(href: string): { host: string; site?: string; dest: string; file: boolean } {
  let u: URL
  try { u = new URL(href) } catch { return { host: href, dest: href, file: false } }
  const segs = u.pathname.split('/').filter(Boolean).map(decode)
  const shown = segs.length > 4 ? [...segs.slice(0, 2), '…', segs[segs.length - 1]!] : segs
  return { host: u.host, site: SITES[u.hostname.toLowerCase()], dest: [u.host, ...shown].join('/'), file: /\.[a-z0-9]{1,8}$/i.test(segs[segs.length - 1] ?? '') }
}

/** 今年的写 MM-DD,别的年份带上年。 */
function day(iso: string | undefined): string | null {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return null
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`
}

function LinkCard({ href, label, preview }: { href: string; label: string; preview: LinkPreview | null }) {
  const { t } = useI18n()
  if (preview) {
    const n = (key: string, v: number): string => t(v === 1 ? `chatLink.${key}` : `chatLink.${key}s`, { n: v })
    const facts = [
      preview.additions != null && preview.deletions != null ? `+${preview.additions} −${preview.deletions}` : null,
      preview.changedFiles != null ? n('file', preview.changedFiles) : null,
      preview.comments ? n('comment', preview.comments) : null,
    ].filter((f): f is string => !!f)
    const when = day(preview.at)
    return (
      <div className="chat-link-card-rich" data-state={preview.state}>
        <div className="chat-link-card-top">
          <span className="chat-link-card-pill">{t(`chatLink.state.${preview.state}`)}</span>
          <span className="chat-link-card-repo">{preview.repo} #{preview.number}</span>
          {when && <span className="chat-link-card-day">{when}</span>}
        </div>
        <b className="chat-link-card-title">{preview.title}</b>
        {preview.author && (
          <div className="chat-link-card-who"><span className="chat-link-card-av" aria-hidden>{[...preview.author][0]!.toUpperCase()}</span>{preview.author}</div>
        )}
        {facts.length > 0 && <div className="chat-link-card-facts">{facts.map((f) => <span key={f}>{f}</span>)}</div>}
      </div>
    )
  }
  const place = linkPlace(href)
  const Icon = place.file ? FileText : Globe
  return (
    <div className="chat-link-card-plain">
      <span className="chat-link-card-ico"><Icon size={15} aria-hidden /></span>
      <span className="chat-link-card-main">
        <b>{label && label !== href ? label : place.host}</b>
        <small>{place.site ? `${place.site} · ${place.dest}` : place.dest}</small>
      </span>
    </div>
  )
}

/** 带预览卡的 ChatWebLink(点击行为不变)。只在聊天回答里用(Markdown 的 linkCards 开关);市场 README、收件箱这些第三方文本不出卡。 */
export function ChatLinkWithCard({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) {
  // 拿到的数据带着它的地址:流式输出时同一个位置的链接会变(#1 → #15),旧数据不能顶着新地址出现
  const [got, setGot] = useState<{ href: string; preview: LinkPreview } | null>(null)
  const preview = got?.href === href ? got.preview : null
  const card = useHoverCard(<LinkCard href={href} label={textOf(children).trim()} preview={preview} />, {
    className: 'chat-link-card',
    side: 'bottom',
    rect: (el) => el.getClientRects()[0] ?? el.getBoundingClientRect(), // 折行的链接贴第一行
    longPress: true, // 手机包里 UI_MODE 恒为 desktop(只换了壳),所以不按它判;鼠标不发触屏事件
  })
  const open = card.portal != null
  useEffect(() => {
    if (!open || preview || !mayHaveRichCard(href)) return
    let live = true
    void getLinkPreview(homeTarget(), href).then((v) => { if (live && v) setGot({ href, preview: v }) })
    return () => { live = false }
  }, [open, preview, href])
  return (
    <>
      <ChatWebLink href={href} {...rest} {...card.triggerProps}>{children}</ChatWebLink>
      {card.portal}
    </>
  )
}
