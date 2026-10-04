/** Publishing renderer for the Amadeus Markdown dialect. HTML is emitted only by this renderer.
 * Native editor: CommonMark + GFM + CJK emphasis, ![[media]], and Obsidian callouts.
 * No vault, Electron, editor state, script execution, arbitrary iframe, or raw HTML dependencies. */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkCjkStrike from 'remark-cjk-friendly-gfm-strikethrough/parseOnly'
import { platformPlayer } from './platformVideo'

type MdNode = {
  type: string
  value?: string
  depth?: number
  url?: string
  alt?: string
  title?: string
  lang?: string
  ordered?: boolean
  start?: number
  checked?: boolean | null
  identifier?: string
  children?: MdNode[]
}
export type PublishingOptions = {
  locale?: 'en' | 'zh'
  headingOffset?: number
  idPrefix?: string
  baseUrl?: string
  priorityFirstImage?: boolean
}
export type PublishedMarkdown = { title: string; html: string }
const parser = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkCjkFriendly)
  .use(remarkCjkStrike, { singleTilde: false })
export const escapeHtml = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  )
export function safePublicUrl(raw: string, media = false): string | null {
  if (!raw || /[\u0000-\u0020\u007f\\]/.test(raw) || raw.startsWith('//'))
    return null
  if (raw.startsWith('/') || raw.startsWith('#')) return raw
  try {
    const u = new URL(raw)
    if (
      u.protocol === 'https:' ||
      u.protocol === 'http:' ||
      (!media && u.protocol === 'mailto:')
    )
      return u.href
  } catch {
    /* relative links are useful in a static article */
  }
  return !raw.includes(':') && !raw.startsWith('.') ? raw : null
}
function text(n: MdNode): string {
  return n.value ?? (n.children ?? []).map(text).join('')
}
function embed(n: MdNode): string | null {
  if (n.type !== 'paragraph') return null
  return (
    /^!\[\[([^\]\n]+)\]\]$/.exec(text(n).trim())?.[1]?.replace(/\|\d+$/, '') ??
    null
  )
}
function image(n: MdNode): MdNode | null {
  return n.type === 'paragraph' &&
    n.children?.length === 1 &&
    n.children[0].type === 'image'
    ? n.children[0]
    : null
}
export function renderPublicMarkdown(
  markdown: string,
  options: PublishingOptions = {},
): PublishedMarkdown {
  const tree = parser.parse(markdown) as MdNode
  const zh = options.locale === 'zh'
  const safeUrl = (raw: string, mediaOnly = false): string | null => {
    const safe = safePublicUrl(raw, mediaOnly)
    if (!safe || !options.baseUrl || safe.startsWith('#')) return safe
    try {
      return safePublicUrl(new URL(safe, options.baseUrl).href, mediaOnly)
    } catch {
      return safe
    }
  }
  let firstImage = true
  const imageLoading = (): string => {
    const eager = !!options.priorityFirstImage && firstImage
    firstImage = false
    return eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'
  }
  const defs = new Map(
    (tree.children ?? [])
      .filter((n) => n.type === 'definition')
      .map((n) => [n.identifier, n]),
  )
  let heading = 0
  const renderChildren = (n: MdNode): string =>
    (n.children ?? []).map(render).join('')
  const media = (url: string, poster?: MdNode): string | null => {
    const player = platformPlayer(url),
      safe = safeUrl(
        player?.provider === 'Bilibili' && /^BV[\w]{10}$/i.test(url.trim())
          ? 'https://www.bilibili.com/video/' + url.trim()
          : url,
        true,
      )
    if (!safe) return null
    let path = safe
    try {
      path = new URL(safe, 'https://forsion.example').pathname
    } catch {
      /* keep it */
    }
    const isVideo = /\.(mp4|webm|mov|m4v|ogv)$/i.test(path),
      isAudio = /\.(mp3|m4a|ogg|wav|flac)$/i.test(path)
    if (!player && !isVideo && !isAudio) return null
    const title =
      poster?.alt ||
      player?.provider ||
      (zh ? (isAudio ? '音频' : '视频演示') : isAudio ? 'Audio' : 'Video demo')
    const posterUrl = poster?.url ? safeUrl(poster.url, true) : null
    const ratio = /^(\d{1,4})[:/](\d{1,4})$/.exec(poster?.title || '')
    const aspect = ratio && +ratio[1] > 0 && +ratio[2] > 0 ? ` style="aspect-ratio:${+ratio[1]}/${+ratio[2]}"` : ''
    const picture = posterUrl
      ? `<img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(title)}" ${imageLoading()} decoding="async">`
      : `<div class="md-media-placeholder"><span>${escapeHtml(title)}</span></div>`
    return `<figure class="md-media" data-amadeus-media="${player ? 'platform' : isAudio ? 'audio' : 'video'}" data-src="${escapeHtml(player?.src || safe)}"><div class="md-media-stage${posterUrl ? ' has-poster' : ''}"${aspect}>${picture}</div><figcaption><span>${escapeHtml(title)}</span><button type="button" class="play-button">${zh ? '播放' : 'Play'}${player ? ` · ${player.provider}` : ''}</button><a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${zh ? '打开原视频' : 'Open original'} ↗</a></figcaption><p class="md-media-error" role="status" hidden>${zh ? '暂时无法播放，请打开原视频。' : 'Playback is unavailable. Open the original video.'}</p></figure>`
  }
  function render(n: MdNode): string {
    const inner = () => renderChildren(n)
    switch (n.type) {
      case 'text':
        return escapeHtml(n.value)
      case 'strong':
        return `<strong>${inner()}</strong>`
      case 'emphasis':
        return `<em>${inner()}</em>`
      case 'delete':
        return `<del>${inner()}</del>`
      case 'inlineCode':
        return `<code>${escapeHtml(n.value)}</code>`
      case 'break':
        return '<br>'
      case 'heading': {
        const level = Math.min(6, (n.depth ?? 2) + (options.headingOffset ?? 0))
        return `<h${level} id="${escapeHtml(options.idPrefix || 'md')}-${++heading}">${inner()}</h${level}>`
      }
      case 'paragraph': {
        const e = embed(n)
        if (e) {
          const safe = safeUrl(e, true)
          if (safe && /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/i.test(safe))
            return `<figure class="md-image"><img src="${escapeHtml(safe)}" alt="${escapeHtml(e)}" ${imageLoading()} decoding="async"></figure>`
          const m = media(e)
          if (m) return m
          const url = safeUrl(e)
          return url
            ? `<p class="md-bookmark"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e)} ↗</a></p>`
            : `<p>${escapeHtml(text(n))}</p>`
        }
        return `<p>${inner()}</p>`
      }
      case 'link':
      case 'linkReference': {
        const raw = n.url ?? defs.get(n.identifier)?.url ?? ''
        const url = safeUrl(raw)
        return url
          ? `<a href="${escapeHtml(url)}"${/^https?:/.test(url) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner()}</a>`
          : inner()
      }
      case 'image':
      case 'imageReference': {
        const def = defs.get(n.identifier),
          url = safeUrl(n.url ?? def?.url ?? '', true)
        return url
          ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(n.alt || '')}" ${imageLoading()} decoding="async">`
          : escapeHtml(n.alt || '')
      }
      case 'list':
        return `<${n.ordered ? 'ol' : 'ul'}${n.ordered && n.start ? ` start="${n.start}"` : ''}>${inner()}</${n.ordered ? 'ol' : 'ul'}>`
      case 'listItem':
        return `<li>${n.checked != null ? `<input type="checkbox" disabled aria-label="${zh ? '清单项' : 'Checklist item'}"${n.checked ? ' checked' : ''}>` : ''}${inner()}</li>`
      case 'blockquote': {
        const first = n.children?.[0],
          match =
            first?.type === 'paragraph'
              ? /^\[!([\w-]+)\]([+-])?\s*(.*)/.exec(text(first))
              : null
        if (!match) return `<blockquote>${inner()}</blockquote>`
        const body = (n.children ?? []).slice(1).map(render).join(''),
          title = escapeHtml(match[3] || match[1])
        return match[2]
          ? `<details class="md-callout md-fold"${match[2] === '+' ? ' open' : ''}><summary>${title}</summary><div>${body}</div></details>`
          : `<aside class="md-callout"><p class="md-callout-title">${title}</p>${body}</aside>`
      }
      case 'table':
        return `<div class="md-table-wrap"><table>${(n.children ?? []).map((row, i) => `<${i ? 'tbody' : 'thead'}><tr>${(row.children ?? []).map((cell) => `<${i ? 'td' : 'th'}>${renderChildren(cell)}</${i ? 'td' : 'th'}>`).join('')}</tr></${i ? 'tbody' : 'thead'}>`).join('')}</table></div>`
      case 'code':
        return `<pre><code${n.lang ? ` class="language-${escapeHtml(n.lang.replace(/[^\w-]/g, ''))}"` : ''}>${escapeHtml(n.value)}</code></pre>`
      case 'thematicBreak':
        return '<hr>'
      // Internal block markers/frontmatter and arbitrary HTML stay out of the published surface.
      case 'html':
      case 'yaml':
      case 'definition':
        return ''
      default:
        return n.children ? inner() : escapeHtml(n.value)
    }
  }
  const nodes = (tree.children ?? []).filter(
    (n) => !['yaml', 'html', 'definition'].includes(n.type),
  )
  let title = ''
  if (nodes[0]?.type === 'heading' && nodes[0].depth === 1)
    title = text(nodes.shift()!)
  let html = '',
    section = false
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.type === 'heading' && node.depth === 2) {
      if (section) html += '</section>'
      html += '<section class="md-feature">'
      section = true
    }
    const poster = image(node),
      next = nodes[i + 1] && embed(nodes[i + 1])
    const pair = poster && next ? media(next, poster) : null
    if (pair) {
      html += pair
      i++
      continue
    }
    html += render(node)
  }
  if (section) html += '</section>'
  return { title, html }
}
