/**
 * 工作区侧栏 → 聊天区的「拖进来即引用」契约。
 *
 * 三种拖源(会话 / 笔记 / 文件)统一成一个 DataTransfer 载荷,聊天区落下时**结构化**交给 Composer,
 * 由它挂成输入框上方的「已选择」芯片(2026-08-14 前是拼成草稿文本;拼完还得再解析回来,
 * 工作区根目录下的裸文件名那种无分隔符路径会认不出来)。发送时 token 由 refToText 生成 ——
 * 与既有的 `[[` 笔记选择器、OS 文件粘贴完全同一套,agent 拿到路径/id 后自己用工具去读。
 *
 * 兼容:文件面板与右栏早就在用 `application/x-tangu-paths`(一串路径),这里原样认,故文件侧零改动。
 *
 * ⚠️ dragover 阶段读不到 `getData`(浏览器只在 drop 时给数据),判「这拖的是不是引用」只能看
 * `types` —— 故 hasChatRef / readChatRefs 分成两个函数,别合并。
 */
import { noteRefInsert } from '../../components/wikiChat'

export const REF_MIME = 'application/x-forsion-chatref'
/** 文件面板/右栏的既有行拖契约(JSON 字符串数组)。 */
export const PATHS_MIME = 'application/x-tangu-paths'

export type ChatRef =
  /** vault 相对路径(转文本时拼上 vaultRoot,与 [[ 选择器同形)。 */
  | { kind: 'note'; path: string }
  /** 工作区路径:本机=绝对路径,云端 Project=项目内相对路径。 */
  | { kind: 'file'; path: string }
  | { kind: 'session'; id: string; title: string }

const isRef = (v: unknown): v is ChatRef => {
  const r = v as ChatRef
  if (!r || typeof r !== 'object') return false
  if (r.kind === 'session') return typeof r.id === 'string' && !!r.id
  return (r.kind === 'note' || r.kind === 'file') && typeof r.path === 'string' && !!r.path
}

/** 挂到拖源的 onDragStart。自定义 MIME 写不进去(个别环境)就静默降级成普通拖拽,不炸原有交互。 */
export function setChatRefDrag(dt: DataTransfer | null, refs: ChatRef[]): void {
  try { dt?.setData(REF_MIME, JSON.stringify(refs)) } catch { /* 降级:本次拖拽不带引用 */ }
}

/** dragover 阶段:这次拖拽带不带可引用的东西(只能看 types,读不到数据)。 */
export function hasChatRef(dt: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  const t = dt?.types
  return !!t && (Array.from(t).includes(REF_MIME) || Array.from(t).includes(PATHS_MIME))
}

/** drop 阶段:取出引用。REF_MIME 优先,回落到文件面板的纯路径数组。 */
export function readChatRefs(dt: Pick<DataTransfer, 'getData'> | null | undefined): ChatRef[] {
  if (!dt) return []
  try {
    const raw = dt.getData(REF_MIME)
    if (raw) {
      const v = JSON.parse(raw)
      if (Array.isArray(v)) return v.filter(isRef)
    }
  } catch { /* 坏载荷 → 试下一种 */ }
  try {
    const raw = dt.getData(PATHS_MIME)
    if (raw) {
      const v = JSON.parse(raw)
      if (Array.isArray(v)) {
        return v.filter((p): p is string => typeof p === 'string' && !!p.trim()).map((path) => ({ kind: 'file' as const, path }))
      }
    }
  } catch { /* 坏载荷 → 空 */ }
  return []
}

/** 会话标题是用户自由文本:`|` `[` `]` 换行都会把 [[..]] 拆坏 —— 一律换成空格并封顶长度。 */
function safeLabel(title: string): string {
  const s = String(title || '').replace(/[[\]|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (s.length > 60 ? s.slice(0, 60) + '…' : s) || 'Chat'
}

/**
 * 一条引用发送时落进正文的文本(纯函数,仪器钉这里)。末尾恒带一个空格,便于连引多条。
 *   笔记 → `[[<vault 绝对路径>|<名字>]]`(气泡显示名字,agent 读到路径,与 [[ 选择器同契约)
 *   会话 → `[[session:<id>|<标题>]]`(agent 用 read_session 按 id 读)
 *   文件 → 路径原样,含空格则加引号(与 OS 文件拖入输入框同款)
 */
export function refToText(ref: ChatRef, vaultRoot: string): string {
  if (ref.kind === 'note') return noteRefInsert(vaultRoot, ref.path)
  if (ref.kind === 'session') return `[[session:${ref.id}|${safeLabel(ref.title)}]] `
  return (/\s/.test(ref.path) ? `"${ref.path}"` : ref.path) + ' '
}

/** `[[session:<id>|…]]` 的 target → 会话 id;不是会话引用则 null。 */
export function sessionIdOfTarget(target: string): string | null {
  const m = /^session:(.+)$/.exec(target.trim())
  return m ? m[1].trim() || null : null
}
