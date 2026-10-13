/**
 * 应用 / 窗口引用:聊天和笔记的文字里指向电脑上的一个应用或一扇打开的窗口。
 *
 * 落盘 / 发出的形态是一条双链:
 *   `[[app://<应用标识>|<应用名>]]`       应用
 *   `[[window://<应用标识>|<窗口标题>]]`   窗口(标题就在别名那一格)
 * 目标带 `://`,不可能是一篇笔记的名字或路径,所以各处解析都是「先认这个前缀,再去查笔记」。
 * 应用标识:macOS = bundle id;Windows = 小写的 exe 名(传统应用)或 AUMID(商店 / 打包应用),规则见 electron/appRefsWin.ts。
 * 不存 pid / 窗口号:它们过一会儿就变,点击时按「应用 + 标题」现找。
 *
 * ⚠️ 与侧边拼接的 `<forsion-app … />` 是两回事:那条的意思是「这段对话贴在这个应用上」(带 pid / windowId,
 *    电脑操作插件据此当默认操作对象);这里只是文字里提到它。两种 token 并存,别合并。
 */
export type AppRefKind = 'app' | 'window'

export interface AppRef {
  kind: AppRefKind
  /** 应用标识(macOS 的 bundle id / Windows 的 exe 名或 AUMID)。 */
  id: string
  /** 显示的名字:应用 = 应用名,窗口 = 窗口标题。 */
  name: string
}

/** 悬停卡 / 变灰用的状态。missing = 这台设备上没有这个应用(含手机、网页版)。 */
export type AppRefState = 'live' | 'closed' | 'running' | 'idle' | 'missing'

export interface AppRefStatus { state: AppRefState; appName: string }

export interface AppRefWindow { id: string; app: string; title: string }
export interface AppRefApp { id: string; name: string; running: boolean }
export interface AppRefList {
  windows: AppRefWindow[]
  apps: AppRefApp[]
  /** 本机助手不可用(没装 / 没授权)时窗口列不出来,只剩应用;原因给界面写提示用。 */
  error?: string
}

// macOS = bundle id;Windows = 小写 exe 名或 AUMID,[A-Za-z0-9._-] 之外的字符只能以 `%XX`(两位大写十六进制)出现(见 electron/appRefsWin.ts)。
const ID_RE = /^(?:[A-Za-z0-9]|%[0-9A-F]{2})(?:[A-Za-z0-9._-]|%[0-9A-F]{2}){0,254}$/
export const isAppRefId = (id: unknown): id is string => typeof id === 'string' && id.length <= 255 && ID_RE.test(id)

/** 标题是别的应用给的自由文本:`|` `[` `]` 换行都会把 [[..]] 拆坏,一律换成空格并封顶长度。幂等。 */
export function appRefLabel(name: string): string {
  const s = String(name || '').replace(/[[\]|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  // 按码点截:按 UTF-16 截会把表情切成半个,那半个字符进了 token,聊天渲染时 encodeURIComponent 直接抛错(Codex 评审)
  const cp = [...s]
  return cp.length > 60 ? cp.slice(0, 59).join('').trimEnd() + '…' : s
}

export function appRefToken(ref: AppRef): string {
  return `[[${ref.kind}://${ref.id}|${appRefLabel(ref.name) || ref.id}]]`
}

/** 双链内文(`app://com.x|名字`)→ 引用;不是这两种前缀、或标识不合法 → null(调用方照旧当笔记链接)。
 *  标识里的反斜杠一律去掉:笔记落盘时 Markdown 会把下划线写成 `\_`(编辑器读回来会还原,但直接读文件原文的地方看到的是带反斜杠的),
 *  而标识本身不可能含反斜杠。名字不动 —— 标题里可以有真的反斜杠(Windows 路径),比对时再两边一起抹(windowTitleScore)。 */
export function parseAppRefInner(inner: string): AppRef | null {
  const m = /^\s*(app|window):\/\/([^|\s]+)\s*(?:\|([\s\S]*))?$/.exec(inner)
  const id = m ? m[2].replace(/\\/g, '') : ''
  if (!m || !isAppRefId(id)) return null
  return { kind: m[1] as AppRefKind, id, name: appRefLabel(m[3] || '') || id }
}

/** 引用里的标题和此刻一扇真窗口的标题有多像(两边过同一道 appRefLabel):2 = 相同;
 *  1 = 一边是另一边加了一段**用分隔符隔开的**前缀 / 后缀 —— 应用自己拼上去的那种(「● 」「 — 已编辑」「 - Google Chrome」),
 *      文件名那段不变;0 = 对不上。
 *  只是包含不算:「Untitled」和「Untitled 2」、「报告」和「报告 v2」是两份文件(真机验证时把关掉的前者认成了开着的后者)。 */
export function windowTitleScore(label: string, liveTitle: string): 0 | 1 | 2 {
  // Markdown 转义留下的反斜杠(`my\_file`)两边一起抹掉再比:抹的是同一种东西,标题里真有反斜杠的也照样对得上
  const plain = (s: string): string => appRefLabel(s).replace(/\\(?=[_*`<>~#[\]-])/g, '')
  const a = plain(label)
  const b = plain(liveTitle)
  if (!a || !b) return 0
  if (a === b) return 2
  const cut = (s: string): string => (s.endsWith('…') ? s.slice(0, -1) : s) // 截断过的那边按没截的那段比
  const [short, long] = [cut(a), cut(b)].sort((x, y) => x.length - y.length)
  if ([...short].length < 4) return 0
  const SEP = '[-–—|·•:*●]'
  if (long.startsWith(short)) return new RegExp(`^\\s*${SEP}\\s`).test(long.slice(short.length)) ? 1 : 0
  if (long.endsWith(short)) return new RegExp(`${SEP}\\s*$`).test(long.slice(0, long.length - short.length)) ? 1 : 0
  return 0
}
export const sameWindowTitle = (label: string, liveTitle: string): boolean => windowTitleScore(label, liveTitle) === 2

/** 从**同一个应用**此刻的全部窗口里挑出引用指的那一扇:标题相同的 > 唯一一扇标题相近的。挑不出来 = null。
 *  不做「这个应用只剩一扇窗口就认它」:表格 / 文稿这类一个文件一扇窗口的应用里,那多半是另一份文件(台架实测把关掉的
 *  「竞品对比」认成了开着的「季度预算」)。同一扇窗口换了内容(浏览器换标签页)靠主进程记着的窗口号认,见 electron/appRefs.ts。 */
export function pickWindow<T extends { title: string }>(label: string, wins: readonly T[]): T | null {
  const exact = wins.find((w) => windowTitleScore(label, w.title) === 2)
  if (exact) return exact
  const near = wins.filter((w) => windowTitleScore(label, w.title) === 1)
  return near.length === 1 ? near[0] : null
}

export const appRefKey = (ref: Pick<AppRef, 'kind' | 'id' | 'name'>): string => `${ref.kind}://${ref.id}|${ref.kind === 'window' ? appRefLabel(ref.name) : ''}`

export function normalizeAppRef(raw: unknown): AppRef | null {
  const r = raw as Partial<AppRef> | null
  if (!r || (r.kind !== 'app' && r.kind !== 'window') || !isAppRefId(r.id)) return null
  return { kind: r.kind, id: r.id, name: appRefLabel(typeof r.name === 'string' ? r.name : '') || r.id }
}
