// 「打开光标处链接」的动作半身(评审 L-20;命令定义在轻模块 unified/linkCommands.ts,执行时懒取本模块)。
//
//  · linkAtCursor:光标在 `[[…]]` 里(或贴着两端)→ 双链,交与点击同一串(wikiOpenArg);在 md 链接 `[t](url)` 上 → 它的地址。
//  · 编辑器内按键:MarkdownBlock 的 handleKeyDown 用 linkKindOfEvent 比对**生效热键**(含用户改键 / 解绑),命中且光标在链接上才吞键。
//  · 命令面板 / 焦点不在正文:runLinkCommand 作用在焦点所在、否则最近一次聚焦过的编辑器上(本插件记账,口径同 foldActions)。
//  打开动作本身由宿主(MarkdownBlock)注入:双链走 onOpenWiki,md 链接按 hrefKind 分流 —— 与鼠标点击同一套。
import { $prose } from '@milkdown/kit/utils'
import { Plugin, type EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { effectiveHotkey, eventToHotkey } from '@lcl/engine'
import { wikiOpenArgAt } from './wikilink'
import { LINK_BINDINGS, type LinkCommandKind } from '../../unified/linkCommands'

export type LinkAtCursor = { kind: 'wiki'; arg: string } | { kind: 'href'; href: string }
type Opener = (target: LinkAtCursor, newTab: boolean) => void

/** 光标(选区的 head)所在的链接;不在链接上 = null。 */
export function linkAtCursor(state: EditorState): LinkAtCursor | null {
  const $h = state.selection.$head
  if (!$h.parent.isTextblock || $h.parent.type.spec.code) return null
  const arg = wikiOpenArgAt($h.parent, $h.parentOffset)
  if (arg) return { kind: 'wiki', arg }
  const linkType = state.schema.marks.link
  if (!linkType) return null
  const mark = linkType.isInSet($h.nodeAfter?.marks ?? []) ?? linkType.isInSet($h.nodeBefore?.marks ?? [])
  const href = mark?.attrs.href
  return typeof href === 'string' && href ? { kind: 'href', href } : null
}

// ── 记账:活着的编辑器 → 各自的打开动作;最近一次聚焦的那个。─────────────────────────────
const openers = new Map<EditorView, Opener>()
let lastFocused: EditorView | null = null

export function linkFollowPlugin(open: Opener) {
  return $prose(
    () =>
      new Plugin({
        view: (view) => {
          openers.set(view, open)
          return {
            destroy: () => {
              openers.delete(view)
              if (lastFocused === view) lastFocused = null
            },
          }
        },
        props: {
          handleDOMEvents: {
            focus: (view) => {
              lastFocused = view
              return false
            },
          },
        },
      }),
  )
}

function activeView(): EditorView | null {
  const ae = typeof document !== 'undefined' ? document.activeElement : null
  if (ae) for (const v of openers.keys()) if (v.dom.contains(ae)) return v
  return lastFocused && lastFocused.dom.isConnected ? lastFocused : null
}

/** 在 view 的光标处跟随链接;光标不在链接上 = false(调用方据此决定吞不吞键)。 */
export function followLinkAt(view: EditorView, newTab: boolean): boolean {
  const target = linkAtCursor(view.state)
  const open = openers.get(view)
  if (!target || !open) return false
  open(target, newTab)
  return true
}

/** linkCommands.ts 的两条命令执行到这里(命令面板 / 焦点不在正文时的全局热键)。 */
export function runLinkCommand(kind: LinkCommandKind): void {
  const view = activeView()
  if (view) followLinkAt(view, kind === 'followNewTab')
}

/** 热键串归一(修饰键排序):'alt+shift+enter' 与 eventToHotkey 产出的 'shift+alt+enter' 不必同序(同 foldActions)。 */
function normHotkey(hk: string): string {
  const parts = hk.toLowerCase().split('+').map((p) => p.trim())
  const key = parts.pop() ?? ''
  return [...parts.sort(), key].join('+')
}

/** 编辑器内按键 → 哪条链接命令(与引擎命令同一份生效热键,含用户改键 / 解绑);不是 = null。 */
export function linkKindOfEvent(event: KeyboardEvent): LinkCommandKind | null {
  if (event.isComposing) return null
  const hk = eventToHotkey(event)
  if (!hk) return null
  const got = normHotkey(hk)
  for (const b of LINK_BINDINGS) {
    const want = effectiveHotkey(b)
    if (want && normHotkey(want) === got) return b.kind
  }
  return null
}
