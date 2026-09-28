/** 行内链接地址的归一 + 安全闸。用户手打的地址会原样落进 `[文字](href)` 并渲染成 `<a href>`,
 *  笔记还会被分享页独立渲染 —— 所以 `javascript:` 这类可执行 scheme 必须在入口就挡掉,不能只靠渲染层。 */
import { $inputRule } from '@milkdown/kit/utils'
import { InputRule } from '@milkdown/kit/prose/inputrules'

/** 允许出现在 `<a href>` 里的 scheme(小写)。其余带 scheme 的一律拒绝。
 *
 *  ⚠️ 只留 http(s) 是**故意的**,别再往里加 `mailto:` / `tel:` / `file:` / 自定义协议:
 *  桌面端打开外链的唯一出口是主进程的 `shell:openExternal`,而它明确只放 http(s)
 *  (「别的 scheme 经 openExternal 等于让页面唤起任意本机协议处理器」)。这里放行、那里拒绝,
 *  结果就是用户能插进去、点了却毫无反应的死链接。要支持 mailto 得先改主进程那条闸,是另一件事。 */
const SAFE_SCHEMES = ['http:', 'https:']

/** 单段路径(不含 `/`)以这些扩展名结尾 = 库内文件,**不是**裸域名(L-07:`Note.md` 被补成 `https://Note.md`,
 *  而 `.md` 恰好是真实顶级域)。只收笔记与常见附件;`.zip` / `.mov` 虽也是顶级域,拿它们当裸域名手打的几乎没有。 */
const LOCAL_FILE_RE = /^[^/?#]+\.(?:md|markdown|pdf|png|jpe?g|gif|webp|svg|bmp|heic|avif|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|flac|txt|csv|tsv|json|docx?|xlsx?|pptx?|zip|canvas|excalidraw|db)(?:[?#].*)?$/i

/**
 * 归一用户输入的链接地址;不可接受则回 null(调用方按「不加链接」处理)。
 * - 裸域名 `example.com/x` → 补 `https://`(同 Obsidian/Notion 的手感)
 * - 站内相对路径 `./a.md`、`/a`、`#锚点`,以及单段文件名 `笔记.md` / `report.pdf` 原样放行(L-07)
 * - `javascript:` / `data:` / `vbscript:` 等一律拒绝(含 tab/换行插在 scheme 中间的绕过写法)
 */
export function normalizeHref(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  // scheme 判定前先剥掉所有空白与控制字符:`java<TAB>script:alert(1)` 浏览器照样认得。
  const probe = Array.from(s)
    .filter((c) => c.charCodeAt(0) > 0x20)
    .join('')
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(probe)
  if (m) return SAFE_SCHEMES.includes(m[1].toLowerCase() + ':') ? s : null
  if (s.startsWith('//')) return 'https:' + s // 协议相对
  if (s.startsWith('/') || s.startsWith('#') || s.startsWith('./') || s.startsWith('../')) return s
  if (LOCAL_FILE_RE.test(s)) return s
  // 无 scheme 且形似域名(含点、首段非空)→ 补 https://;否则当站内相对路径原样留。
  return /^[^\s/]+\.[^\s/]/.test(s) ? 'https://' + s : s
}

/** `<a href>` 点下去该交给谁(编辑器与容器共用这一份判据,各开各的,不会同一下开两次):
 *  - external:http(s) / 协议相对 / 裸域名 → 外链路由(window.open)
 *  - note:库内 md 笔记链接 `[t](笔记.md)` → 与 `[[ ]]` 同一条打开路径(openWikiLink)
 *  - file:其余站内相对路径(附件)→ 容器的 openAttachment(系统程序)
 *  - other:`#锚点`、不放行的 scheme(mailto / amadeus-asset …)→ 谁都不接 */
export type HrefKind = 'external' | 'note' | 'file' | 'other'

const stripQueryHash = (s: string): string => s.replace(/[?#].*$/, '')
const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export function hrefKind(raw: string): HrefKind {
  const s = raw.trim()
  if (!s || s.startsWith('#')) return 'other'
  const href = normalizeHref(s)
  if (!href) return 'other'
  if (/^https?:/i.test(href)) return 'external'
  return /\.md$/i.test(safeDecode(stripQueryHash(s))) ? 'note' : 'file'
}

/**
 * 库内笔记链接 → openWikiLink 吃的目标(L-07)。解码 `%20`、去掉 `#` / `?` 尾巴;
 * `./` `../` 按源笔记所在目录解析(标准 md 相对链接语义);带 `/` 但不带 `./` 的先按源目录找,找不到当库根路径;
 * 裸名原样(openWikiLink 先找同目录、再 .fd 子笔记、再全库,与 `[[ ]]` 同口径)。
 */
export function noteLinkTarget(raw: string, sourcePath?: string | null, pages: string[] = []): string {
  const p = safeDecode(stripQueryHash(raw.trim())).replace(/\\/g, '/')
  if (p.startsWith('/')) return p.replace(/^\/+/, '')
  if (!p.includes('/')) return p
  const dir = sourcePath && sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')).split('/') : []
  const out = [...dir]
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  const joined = out.join('/')
  if (p.startsWith('./') || p.startsWith('../')) return joined
  const key = (x: string): string => x.replace(/\.md$/i, '').toLowerCase()
  return pages.some((q) => key(q.replace(/\\/g, '/')) === key(joined)) ? joined : p
}

/** 打完 `[文字](地址)` 的右括号 → 当场成链接(AFFiNE/Notion 手感)。
 *  commonmark 预设只带了 strong/em/code 的行内输入规则,链接没有 —— 于是手打的链接要等下一次
 *  「序列化→重解析」才活过来(整页一实例后那次重解析根本不会发生,只有换页/重开才有)。
 *  地址过 normalizeHref 安全闸;闸拒了就原样留字面,绝不落一个 javascript: 的 `<a>`。 */
export const linkInputRule = $inputRule(
  () =>
    new InputRule(/\[([^[\]]+)\]\((\S+)\)$/, (state, match, start, end) => {
      const linkMark = state.schema.marks.link
      if (!linkMark) return null
      const href = normalizeHref(match[2])
      if (!href) return null
      // removeStoredMark:光标停在新链接末尾,接着打的字不许带链接(link 已是 inclusive:false,这里再兜一层 stored mark)。
      return state.tr.replaceWith(start, end, state.schema.text(match[1], [linkMark.create({ href })])).removeStoredMark(linkMark)
    }),
)
