/**
 * 应用 / 窗口引用:聊天和笔记的文字里指向电脑上的一个应用或一扇打开的窗口。
 *
 * 落盘 / 发出的形态是一条双链:
 *   `[[app://<应用标识>|<应用名>]]`       应用
 *   `[[window://<应用标识>|<窗口标题>]]`   窗口(标题就在别名那一格)
 * 目标带 `://`,不可能是一篇笔记的名字或路径,所以各处解析都是「先认这个前缀,再去查笔记」。
 * 应用标识 = macOS 的 bundle id。不存 pid / 窗口号:它们过一会儿就变,点击时按「应用 + 标题」现找。
 *
 * ⚠️ 与侧边拼接的 `<forsion-app … />` 是两回事:那条的意思是「这段对话贴在这个应用上」(带 pid / windowId,
 *    电脑操作插件据此当默认操作对象);这里只是文字里提到它。两种 token 并存,别合并。
 */
export type AppRefKind = 'app' | 'window'

export interface AppRef {
  kind: AppRefKind
  /** 应用标识(bundle id)。 */
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

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
export const isAppRefId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id)

/** 标题是别的应用给的自由文本:`|` `[` `]` 换行都会把 [[..]] 拆坏,一律换成空格并封顶长度。幂等。 */
export function appRefLabel(name: string): string {
  const s = String(name || '').replace(/[[\]|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > 60 ? s.slice(0, 59).trimEnd() + '…' : s
}

export function appRefToken(ref: AppRef): string {
  return `[[${ref.kind}://${ref.id}|${appRefLabel(ref.name) || ref.id}]]`
}

/** 双链内文(`app://com.x|名字`)→ 引用;不是这两种前缀、或标识不合法 → null(调用方照旧当笔记链接)。 */
export function parseAppRefInner(inner: string): AppRef | null {
  const m = /^\s*(app|window):\/\/([^|\s]+)\s*(?:\|([\s\S]*))?$/.exec(inner)
  if (!m || !isAppRefId(m[2])) return null
  return { kind: m[1] as AppRefKind, id: m[2], name: appRefLabel(m[3] || '') || m[2] }
}

/** 引用里的窗口标题和此刻真窗口的标题是不是同一个(两边过同一道 appRefLabel)。
 *  ponytail: 只认标题完全相同;浏览器切了标签页标题就变,那时按「窗口已关」处理。要更宽再加相似度。 */
export const sameWindowTitle = (label: string, liveTitle: string): boolean => !!label && appRefLabel(liveTitle) === appRefLabel(label)

export const appRefKey = (ref: Pick<AppRef, 'kind' | 'id' | 'name'>): string => `${ref.kind}://${ref.id}|${ref.kind === 'window' ? appRefLabel(ref.name) : ''}`

export function normalizeAppRef(raw: unknown): AppRef | null {
  const r = raw as Partial<AppRef> | null
  if (!r || (r.kind !== 'app' && r.kind !== 'window') || !isAppRefId(r.id)) return null
  return { kind: r.kind, id: r.id, name: appRefLabel(typeof r.name === 'string' ? r.name : '') || r.id }
}
