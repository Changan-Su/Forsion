/**
 * Chat 画布(方案 docs/ToBeImproved/Chat画布分支方案_2026-10-18 第二步、Chat画布第三轮方案_2026-10-20):同一棵会话树的另一种看法。
 * 会话照旧存 DB,这里只记本机偏好(每棵树用不用画布、竖排还是横排、兄弟分支的左右顺序、没发出去的那张草稿提问卡)。
 *
 *  - 舞台 / 平移缩放 / 手势 / 缩略图 / 缩放胶囊全用 canvasKit(Amadeus 画布、仪表盘、自动化同一套),外观照 Amadeus 画布。
 *  - 一轮 = 一个格子里上下两张卡:提问卡(用户气泡的配方)+ 回答卡(真消息渲染器 EditorialMessage)。
 *    竖排缺省:接着问的那一轮长在下面,兄弟并排;横排:往右长,兄弟上下叠。长回答在卡里只露一段预览。
 *  - ⊕(照 Amadeus 卡边那颗):回答卡下面 = 接着问 —— 是某一支的最后一张就聚焦输入框,否则在画布上开一张草稿提问卡;
 *    提问卡左右 = 换个问法(旁边并排一张草稿,和它共用同一段上文)。草稿只在本机,发出去那一刻才建分支会话。
 *  - 单击卡 = 选中(不在当前这一支上就切到那一支,主区就地换);双击 = 右边开阅读栏(对话页那套排版),
 *    镜头让开阅读栏;回对话走头行的「对话 / 画布」胶囊(停在当前这一支)。
 *  - 自动跟随:当前这一支有卡在生成时,像 Chat View 一样跟着往下走(卡底停在输入框上方);一滚走 / 拖走就停,
 *    那张卡出了可读区就出一颗箭头(同「回到底部」),点了飞回去并恢复跟随。
 *  - 镜头只有一个写手:逐帧追目标(每帧走剩下的 18%,和帧率无关,单帧位移封顶)。跟随、箭头、阅读让位、草稿露出都走它。
 *  - 右键:回答卡 / 提问卡 / 空白处各一份菜单(现成 ContextMenu);卡下面的子树能收起,收起后挂一颗「+N」。
 *  - 子会话(方案 docs/ToBeImproved/画布子会话显示方案_2026-10-26,A):「视图」里一项开关,开着时 start_session 开出的子会话
 *    整支挂在开出它的回答卡下(主线、分支之后),第一张是简报卡;只画一层。开出它的那块「从这里分出」就不再列它。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BookOpen, ChevronDown, ChevronUp, CircleHelp, ChevronsDownUp, ChevronsUpDown, Copy, CornerDownRight, GitBranch,
  Hand, ListTree, Locate, Map as MapIcon, Maximize2, MessageCircleQuestion, MessageSquare, MoveDown, MoveRight, Pencil, PenLine, Sparkles, Split, X,
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { SessionRecord, UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { useApp } from '../../stores/appStore'
import { useSessionAttention } from '../../stores/attentionStore'
import { recordToUi } from '../../tangu/store/tanguSlice'
import { listMessages } from '../../services/backendService'
import { targetForSession } from '../../services/engine/targets'
import { registerMessages, useI18n } from '../../i18n'
import { useChatWaitDetailsEnabled } from '../../chatWaitDetails'
import {
  CanvasChrome, CanvasMiniMap, fitViewport, gridLayerStyle, hostSize, recallViewport, rememberViewport, useCanvasGestures, useCanvasViewport, zoomAt,
  type Box, type CanvasViewportApi, type Viewport,
} from '../../amadeus/unified/canvasKit'
import { OverlayAt } from '@lcl/engine'
import { EditorialMessage, type FileCtx, type MessageHandlers } from './EditorialMessage'
import { openBtw } from './btwStore'
import { ForkBlock, ForkScope, childIdsOf, type ForkScopeValue } from './ChildSessions'
import { StatusMark } from './AttentionDot'
import { rowStatus, type RowStatus } from './sessionTree'
import { splitLeadingRefs } from './RefChipView'
import { splitLeadingQuotes } from './quotes'
import { buildTurnTree, readSteps, type KidSpec, type TurnTree } from './canvasTree'
import { ContextMenu, type CtxItem, type CtxMenu } from '../../components/RightPanel'
import { SELBAR_VIEWPORT_MOVED } from '../../components/selectionBar/ViewSelectionBar'

registerMessages({
  'chatcanvas.seg.aria': { zh: '对话的看法', en: 'Chat layout' },
  'chatcanvas.seg.chat': { zh: '对话', en: 'Chat' },
  'chatcanvas.seg.canvas': { zh: '画布', en: 'Canvas' },
  'chatcanvas.aria': { zh: '对话画布', en: 'Chat canvas' },
  'chatcanvas.vertical': { zh: '竖排', en: 'Vertical layout' },
  'chatcanvas.horizontal': { zh: '横排', en: 'Horizontal layout' },
  'chatcanvas.focus': { zh: '只看这一支', en: 'Focus on this branch' },
  'chatcanvas.hand': { zh: '抓手：拖到哪都是平移', en: 'Hand: drag anywhere to pan' },
  'chatcanvas.follow': { zh: '回到正在生成的那张卡', en: 'Back to the reply being written' },
  'chatcanvas.attach': { zh: '接在', en: 'Continues after' },
  'chatcanvas.empty': { zh: '还没有对话。在下面输入第一句。', en: 'No messages yet. Type the first one below.' },
  'chatcanvas.you': { zh: '你', en: 'You' },
  'chatcanvas.read': { zh: '阅读', en: 'Read' },
  'chatcanvas.readHint': { zh: '双击在右边阅读', en: 'Double-click to read on the right' },
  'chatcanvas.read.aria': { zh: '阅读这一轮', en: 'Reading this turn' },
  'chatcanvas.read.pos': { zh: '第 {n} 轮 / 共 {m} 轮', en: 'Turn {n} of {m}' },
  'chatcanvas.read.prev': { zh: '上一轮', en: 'Previous turn' },
  'chatcanvas.read.next': { zh: '下一轮', en: 'Next turn' },
  'chatcanvas.read.close': { zh: '关闭阅读', en: 'Close reader' },
  'chatcanvas.add.next': { zh: '从这里分出一支', en: 'Branch from here' },
  'chatcanvas.add.follow': { zh: '接着问', en: 'Ask a follow-up' },
  'chatcanvas.add.sibling': { zh: '换个问法', en: 'Ask it differently' },
  'chatcanvas.draft.from': { zh: '你 · 从「{q}」这里分出', en: 'You · branching from "{q}"' },
  'chatcanvas.draft.ph': { zh: '问点什么…', en: 'Ask something…' },
  'chatcanvas.draft.hint': { zh: 'Enter 发送 · Esc 放弃', en: 'Enter to send · Esc to discard' },
  'chatcanvas.draft.send': { zh: '发送', en: 'Send' },
  'chatcanvas.draft.discard': { zh: '放弃这张草稿', en: 'Discard this draft' },
  'chatcanvas.hint.read': { zh: '双击卡片：在右边阅读', en: 'Double-click a card to read it on the right' },
  'chatcanvas.hint.add': { zh: '悬停卡片点 ⊕：接着问，或另起一支', en: 'Hover a card and click ⊕ to follow up or branch off' },
  'chatcanvas.hint.back': { zh: '左上角切到「对话」：回到正在看的这一支', en: 'Switch to Chat at the top left to go back to this branch' },
  'chatcanvas.hint.menu': { zh: '右键：更多操作', en: 'Right-click for more' },
  'chatcanvas.menu.copyAnswer': { zh: '复制回答', en: 'Copy answer' },
  'chatcanvas.menu.aside': { zh: '顺便问', en: 'Ask on the side' },
  'chatcanvas.menu.fold': { zh: '收起下面的卡', en: 'Collapse cards below' },
  'chatcanvas.menu.unfold': { zh: '展开下面的 {n} 张', en: 'Expand {n} cards below' },
  'chatcanvas.menu.rewrite': { zh: '改写这句再问', en: 'Rewrite and ask again' },
  'chatcanvas.menu.copyQuestion': { zh: '复制问题', en: 'Copy question' },
  'chatcanvas.menu.rename': { zh: '重命名这一支', en: 'Rename this branch' },
  'chatcanvas.menu.archive': { zh: '归档这一支', en: 'Archive this branch' },
  'chatcanvas.menu.latest': { zh: '回到最新', en: 'Go to latest' },
  'chatcanvas.menu.fit': { zh: '看全部', en: 'Fit everything' },
  'chatcanvas.menu.showAll': { zh: '看全部分支', en: 'Show all branches' },
  'chatcanvas.menu.miniOn': { zh: '显示缩略图', en: 'Show minimap' },
  'chatcanvas.menu.miniOff': { zh: '隐藏缩略图', en: 'Hide minimap' },
  'chatcanvas.menu.kidsOn': { zh: '显示子会话', en: 'Show child sessions' },
  'chatcanvas.menu.kidsOff': { zh: '隐藏子会话', en: 'Hide child sessions' },
  'chatcanvas.kid': { zh: '子会话', en: 'Child session' },
  'chatcanvas.kid.brief': { zh: '简报 · Tangu 写的', en: 'Brief · written by Tangu' },
  'chatcanvas.rename.aria': { zh: '这一支的名字', en: 'Branch name' },
  'chatcanvas.read.resize': { zh: '拖动调整阅读栏宽度', en: 'Drag to resize the reader' },
  'chatcanvas.read.turns': { zh: '这一支的每一轮', en: 'Turns on this branch' },
  'chatcanvas.read.turnN': { zh: '第 {n} 轮', en: 'Turn {n}' },
  'chatcanvas.read.inChat': { zh: '在对话里打开', en: 'Open in chat' },
  'chatcanvas.view': { zh: '视图', en: 'View' },
  'chatcanvas.help': { zh: '画布怎么用', en: 'How the canvas works' },
  'chatcanvas.menu.handOn': { zh: '抓手（拖到哪都是平移）', en: 'Hand tool (drag anywhere to pan)' },
  'chatcanvas.menu.handOff': { zh: '关掉抓手', en: 'Turn off hand tool' },
})

// 缩略图:Tangu 画布自己记,缺省关(在「视图」里开);Amadeus 画布那份(canvasPrefs)不受影响
const MINI_KEY = 'tangu.chatCanvas.minimap'
const miniPref = (): boolean => { try { return localStorage.getItem(MINI_KEY) === '1' } catch { return false } }
const setMiniPref = (on: boolean): void => { try { localStorage.setItem(MINI_KEY, on ? '1' : '0') } catch { /* 隐私模式:本次照样生效 */ } }
// 子会话进不进画布:全局一份(同缩略图),缺省开;对话页(认树根)和画布(画不画)都要跟着变,所以是个小外部 store
const KIDS_KEY = 'tangu.chatCanvas.children'
const kidsSubs = new Set<() => void>()
const kidsPref = (): boolean => { try { return localStorage.getItem(KIDS_KEY) !== '0' } catch { return true } }
let kidsNow = kidsPref()
const setKidsPref = (on: boolean): void => {
  kidsNow = on
  try { localStorage.setItem(KIDS_KEY, on ? '1' : '0') } catch { /* 隐私模式:本次照样生效 */ }
  for (const f of kidsSubs) f()
}
export const useCanvasKids = (): boolean => useSyncExternalStore((f) => { kidsSubs.add(f); return () => { kidsSubs.delete(f) } }, () => kidsNow)

// 左上那几行说明:前几次打开画布时露出来,之后收进胶囊上的「?」
const HINTS_KEY = 'tangu.chatCanvas.hintsSeen', HINTS_TIMES = 3
const hintsSeen = (): number => { try { return Number(localStorage.getItem(HINTS_KEY)) || 0 } catch { return HINTS_TIMES } }

// ── 每棵树的本机偏好(按树根记;切到分支不翻回对话) ──
export type CanvasDir = 'v' | 'h'
/** 没发出去的草稿提问卡:挂在 parent 那一轮下面,排在它(按 order 排好的)子卡里的第 at 个。 */
export interface CanvasDraft { parent: string; at: number; text: string; /** 分支已建、这句还没发成:重试接着用它 */ sid?: string }
export interface CanvasPref {
  on: boolean
  dir: CanvasDir
  /** 父卡 key → 子卡所在会话 id 的左右顺序(从草稿发出去时记下;没记的排在后面,照建的先后) */
  order: Record<string, string[]>
  draft: CanvasDraft | null
  /** 收起了下面子树的卡 key */
  fold: string[]
}
const PREF_KEY = 'tangu.chatCanvas'
const NO_ORDER: Record<string, string[]> = Object.freeze({}) as Record<string, string[]>
const NO_FOLD: string[] = Object.freeze([]) as unknown as string[]
const NO_KIDS: SessionRecord[] = []
const PREF_CAP = 200 // ponytail: 只留最近 200 棵树,超出按写入先后丢
type SavedPref = Partial<Omit<CanvasPref, 'draft'>> & { draft?: CanvasDraft | null }
function readPrefs(): Record<string, SavedPref> {
  try { const v = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
const isDraft = (d: unknown): d is CanvasDraft => !!d && typeof d === 'object' && typeof (d as CanvasDraft).parent === 'string'
  && typeof (d as CanvasDraft).at === 'number' && typeof (d as CanvasDraft).text === 'string'
export function useChatCanvasPref(rootId: string | null): [CanvasPref, (patch: Partial<CanvasPref>) => void] {
  const [all, setAll] = useState(readPrefs)
  const set = useCallback((patch: Partial<CanvasPref>): void => {
    if (!rootId) return
    // 以存着的那份为准:对话页和画布各挂一份这个 hook,各写各的字段,拿自己的旧状态合并会把对方刚写的冲掉
    const prev = readPrefs()
    const next = { ...prev }
    delete next[rootId] // 删了再放 = 排到最后,裁掉的是最久没碰的
    next[rootId] = { ...prev[rootId], ...patch }
    for (const k of Object.keys(next).slice(0, -PREF_CAP)) delete next[k]
    try { localStorage.setItem(PREF_KEY, JSON.stringify(next)) } catch { /* 隐私模式 / 存满:本次会话内照样生效 */ }
    setAll(next)
  }, [rootId])
  const saved = rootId ? all[rootId] : undefined
  const order = saved?.order && typeof saved.order === 'object' ? saved.order : NO_ORDER // 同一个空对象:排版的 memo 认它,每次新建会死循环
  const fold = Array.isArray(saved?.fold) ? saved.fold : NO_FOLD
  return [{ on: !!saved?.on, dir: saved?.dir === 'h' ? 'h' : 'v', order, draft: isDraft(saved?.draft) ? saved.draft : null, fold }, set]
}

// ── 自动排版 ──
const CARD_W = 340
const GAP = { v: { x: 40, y: 56 }, h: { x: 72, y: 28 } }
const EST_H = 180 // 还没量到的卡先按这个高排
const PREVIEW_H = 260 // 约 8 行;更长的回答在卡里只露这一段,全文进阅读栏
const START_Z = 0.9 // 竖排正好放下三张并排的卡
const READ_GUTTER = 24 // 阅读栏和让开它的卡之间的空
const DRAFT = 'draft' // 草稿提问卡在排版里的 key(真卡的 key 都带冒号,撞不上)
const READ_W_KEY = 'tangu.chatCanvas.readW' // 阅读栏宽度(本机)
const READ_W_MIN = 360, READ_W_MAX = 1600 // 上限另按画布宽的 70% 收(拖的时候 + CSS)
const READ_OPEN_MS = 240, READ_CLOSE_MS = 200, READ_FLY_MS = 420 // 卡长成栏 / 往右淡出 / 镜头让位(方案 画布交互统一方案_2026-10-24 read.html A)
const JUMP_MS = 300 // 缩放 / 看全部 / 回到最新:同一条「跳到某处」曲线,短一点(unify.html §2)
const ENTER_MS = 420, EXIT_MS = 360 // 对话 ↔ 画布(motion.html §1 A 镜头拉远)

/** 对话 ↔ 画布对齐的那条回答:对话流可读区里最下面那条(停在末尾 = 这一支最后一轮)。left / top 是它正文列的屏幕坐标。 */
export interface CanvasAnchor { msgId: string; left: number; top: number }
export function chatAnchor(view: Element | null | undefined, has?: (msgId: string) => boolean): CanvasAnchor | null {
  const body = view?.querySelector<HTMLElement>(':scope > .t2-chat-col > .t2-chat-body')
  if (!body) return null
  const r = body.getBoundingClientRect()
  const bottom = r.bottom - (parseFloat(getComputedStyle(body).getPropertyValue('--t2-composer-h')) || 96)
  // 从末尾往前找,只量消息本身的框:离得远的消息 content-visibility 跳过了排版,量它里面的东西会逼它整段排一遍
  const all = body.querySelectorAll<HTMLElement>('.t2-asst[id^="tocmsg-"]')
  for (let i = all.length - 1; i >= 0; i--) {
    const b = all[i].getBoundingClientRect()
    if (!b.height || b.top >= bottom) continue
    if (b.bottom <= r.top) return null
    const msgId = all[i].id.slice('tocmsg-'.length)
    if (has && !has(msgId)) continue // 分支开头复制过来的那段:画布上不重画,往上找
    const c = (all[i].querySelector<HTMLElement>('.t2-asst-col') ?? all[i]).getBoundingClientRect()
    return { msgId, left: c.left, top: c.top }
  }
  return null
}
// 点「对话 / 画布」胶囊 / ⌥⌘V 进画布时记一下对齐哪条;画布挂上就取走(1s 内有效)。直接打开一个本来就在画布的会话不记,落位不播
let pendingEnter: { at: number; anchor: CanvasAnchor } | null = null
export function armCanvasEnter(anchor: CanvasAnchor | null): void { pendingEnter = anchor ? { at: performance.now(), anchor } : null }
const NARROW = 900 // 舞台窄于这个:阅读栏直接盖在画布上,不让位
const CHASE = 0.18 // 每帧(16.7ms)走剩下距离的这一截
const CHASE_CAP = 160 // 单帧位移封顶(px/16.7ms):飞很远也不会一闪而过

/** 朴素的子树宽度排法:竖排 = 子卡在下、兄弟并排、父卡居中;横排 = 子卡在右、兄弟上下叠、父卡与第一张子卡齐顶。
 *  ponytail: 子树按包围盒占位(O(n)),宽树会比 Reingold-Tilford 松;兄弟多了再换紧凑排法。 */
export function layoutTree(tree: TurnTree, heights: ReadonlyMap<string, number>, dir: CanvasDir,
  kids: (k: string) => string[] = (k) => tree.cards.get(k)?.children ?? []): Map<string, Box> {
  const out = new Map<string, Box>()
  const h = (k: string): number => heights.get(k) ?? EST_H
  const span = new Map<string, number>()
  const gap = GAP[dir]
  // 竖排量宽、横排量高
  const measure = (k: string): number => {
    const cs = kids(k)
    const sum = cs.reduce((s, c, i) => s + measure(c) + (i ? (dir === 'v' ? gap.x : gap.y) : 0), 0)
    const own = dir === 'v' ? CARD_W : h(k)
    const v = Math.max(own, sum)
    span.set(k, v)
    return v
  }
  const kidsSpan = (k: string): number => kids(k).reduce((s, c, i) => s + span.get(c)! + (i ? (dir === 'v' ? gap.x : gap.y) : 0), 0)
  const place = (k: string, a: number, b: number): void => {
    if (dir === 'v') {
      const w = span.get(k)!
      out.set(k, { x: a + (w - CARD_W) / 2, y: b, w: CARD_W, h: h(k) })
      let x = a + (w - kidsSpan(k)) / 2
      for (const c of kids(k)) { place(c, x, b + h(k) + gap.y); x += span.get(c)! + gap.x }
    } else {
      out.set(k, { x: a, y: b, w: CARD_W, h: h(k) })
      let y = b
      for (const c of kids(k)) { place(c, a + CARD_W + gap.x, y); y += span.get(c)! + gap.y }
    }
  }
  let at = 0
  for (const r of tree.roots) {
    const s = measure(r)
    if (dir === 'v') place(r, at, 0)
    else place(r, 0, at)
    at += s + (dir === 'v' ? gap.x : gap.y) * 2
  }
  return out
}

/** 父格子 → 子格子的线。竖排:父格子底(回答卡底)→ 子格子顶(提问卡顶);横排:父格子的回答卡 → 子格子的提问卡。 */
function edgePath(a: Box, b: Box, dir: CanvasDir, aTop: number): string {
  if (dir === 'v') {
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, m = (y2 - y1) / 2
    return `M${x1},${y1} C${x1},${y1 + m} ${x2},${y2 - m} ${x2},${y2}`
  }
  const x1 = a.x + a.w, y1 = a.y + aTop + 24, x2 = b.x, y2 = b.y + 24, m = (x2 - x1) / 2
  return `M${x1},${y1} C${x1 + m},${y1} ${x2 - m},${y2} ${x2},${y2}`
}

/** 卡头那句问题:剥掉开头的「已选择」芯片行和引用块(和用户气泡同一套解析)。 */
function questionText(m: UiMessage): string {
  const lead = splitLeadingRefs(m.content)
  const quoted = splitLeadingQuotes(lead ? lead.body : m.content)
  const body = (quoted ? quoted.body : lead ? lead.body : m.content).trim()
  return body || lead?.refs.map((r) => r.name).join(' ') || quoted?.quotes[0] || ''
}
/** 草稿卡头上「从哪里分出」:那张回答开头的几个字(去掉 markdown 记号)。 */
function answerLead(c: { answers: UiMessage[]; user?: UiMessage }): string {
  const raw = c.answers.find((m) => m.content.trim())?.content || (c.user ? questionText(c.user) : '')
  const s = raw.replace(/[#*`>_~[\]|-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return [...s].length > 16 ? `${[...s].slice(0, 16).join('')}…` : s
}
// 卡里:「从这里分出」不画在消息里(会被折起的正文裁掉),画在卡底,分支不列(已经是卡);阅读栏:照常画在消息里,分支不列
const reduceMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
/** 「跳到某处」那条曲线:快出、落点带一点点过冲(约 1.5%),同 Amadeus 画布聚焦 */
const settleCurve = (t: number): number => { const u = t - 1; return 1 + 1.5 * u ** 3 + 0.5 * u ** 2 }

export function ChatCanvas({ rootId, activeId, dir, onDir, onChat, exiting, onExited }: {
  rootId: string
  activeId: string
  dir: CanvasDir
  onDir: (dir: CanvasDir) => void
  /** 切回对话(阅读栏「在对话里打开」那一下) */
  onChat: () => void
  /** 已经切回对话、画布还留着播退场(卡放大回对话里那一条的位置);播完叫 onExited 卸掉 */
  exiting?: boolean
  onExited?: () => void
}) {
  const { t } = useI18n()
  const showWaitDetails = useChatWaitDetailsEnabled()
  const sessions = useApp((s) => s.sessions)
  const branches = useMemo(() => sessions.filter((x) => x.parent_session_id === rootId && !!x.fork_message_id), [sessions, rootId])
  // 子会话:父会话是树根或某一支、自己不是分支(只画一层,孙会话不进);按开出的先后
  const kidsOn = useCanvasKids()
  const allKids = useMemo(() => {
    const inTree = new Set([rootId, ...branches.map((b) => b.id)])
    return sessions.filter((x) => !x.fork_message_id && x.id !== rootId && !!x.parent_session_id && inTree.has(x.parent_session_id))
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
  }, [sessions, rootId, branches])
  const kids = kidsOn ? allKids : NO_KIDS
  const ids = useMemo(() => [rootId, ...branches.map((b) => b.id), ...kids.map((k) => k.id)], [rootId, branches, kids])
  const msgs = useApp(useShallow((s) => Object.fromEntries(ids.map((id) => [id, s.messagesBySession[id]])) as Record<string, UiMessage[] | undefined>))
  const loading = useApp((s) => !!s.historyLoading[rootId])
  const cfg = useApp((s) => s.cfg)
  const execModes = useApp(useShallow((s) => Object.fromEntries(ids.map((id) => [id, s.configBySession[id]?.execMode]))))
  // 分支的历史不在内存里(只看过主线):画布一开就把整棵树拉齐;拉到一支画一支
  useEffect(() => { for (const id of ids) void useApp.getState().loadSessionHistory(id) }, [ids])
  // 子会话在后台又跑了一轮(主会话 send_to_session 等):它不是当前会话,没人轮询它的历史(pollSession 只管 activeId)。
  // 会话列表里它的 updated_at / 在跑 / 等你一变就重拉一次,并进 store(同 ChildChatPanel 那份合并);正在跑 / 正看着的由流和轮询管
  const kidSig = kids.map((k) => `${k.id}:${k.updated_at}:${k.busy ? 1 : 0}:${k.awaiting_user ? 1 : 0}`).join(',')
  const kidSeen = useRef(new Map<string, string>())
  useEffect(() => {
    for (const k of kids) {
      const sig = `${k.updated_at}:${k.busy ? 1 : 0}:${k.awaiting_user ? 1 : 0}`
      const prev = kidSeen.current.get(k.id)
      kidSeen.current.set(k.id, sig)
      const st = useApp.getState()
      if (prev === undefined || prev === sig || st.activeId === k.id || st.runningBySession[k.id]) continue
      void listMessages(targetForSession(k.id), k.id).then((records) => useApp.setState((state) => {
        const restored = records.map((r) => recordToUi(r, undefined, (slug) => state.agentDefs.find((a) => a.slug === slug)?.name))
        const got = new Set(restored.map((m) => m.id))
        return { messagesBySession: { ...state.messagesBySession, [k.id]: [...restored, ...(state.messagesBySession[k.id] || []).filter((m) => !got.has(m.id))].sort((a, b) => a.timestamp - b.timestamp) } }
      })).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kidSig])
  const kidSpecs = useMemo<KidSpec[]>(() => kids.map((k) => {
    const from = k.parent_session_id!
    // 开出它的那条回答:start_session 的工具结果里有它的 id(同卡底那块的认法);认不到 = 挂在那一支最后一张卡下
    const at = msgs[from]?.find((m) => childIdsOf(m.toolEvents).includes(k.id))?.id
    return { sid: k.id, from, at }
  }), [kids, msgs])
  const tree = useMemo(() => buildTurnTree(rootId, branches, (sid) => msgs[sid], kidSpecs), [rootId, branches, msgs, kidSpecs])
  const kidSet = useMemo(() => new Set(kidSpecs.filter((k) => tree.paths[k.sid]).map((k) => k.sid)), [kidSpecs, tree])
  const [pref, setPref] = useChatCanvasPref(rootId)
  const cardForks = useMemo<ForkScopeValue>(() => ({ inline: false, hideBranches: true, host: activeId, hideKids: kidSet }), [activeId, kidSet])
  const readForks = useMemo<ForkScopeValue>(() => ({ inline: true, hideBranches: true, host: activeId, hideKids: kidSet }), [activeId, kidSet])
  // 子会话卡上的状态(同左栏 / 卡底那行的 rowStatus)
  const running = useApp((s) => s.runningBySession)
  const unread = useApp((s) => s.unread)
  const attention = useSessionAttention()
  const kidStatus = (sid: string): RowStatus => {
    const k = kids.find((x) => x.id === sid)
    return k ? rowStatus(k, !!attention.get(sid), !!running[sid], unread.has(sid)) : ''
  }
  const draft = pref.draft && tree.cards.has(pref.draft.parent) ? pref.draft : null

  // ── 量格子高(布局用)、回答卡在格子里的偏移(横排的线用)、正文是否超长(预览用):一个 ResizeObserver ──
  const [heights, setHeights] = useState<Map<string, number>>(() => new Map())
  const [aTops, setATops] = useState<Map<string, number>>(() => new Map())
  const [tall, setTall] = useState<Set<string>>(() => new Set())
  const roRef = useRef<ResizeObserver | null>(null)
  if (!roRef.current && typeof ResizeObserver !== 'undefined') {
    let raf = 0
    const dirty = new Set<HTMLElement>()
    roRef.current = new ResizeObserver((entries) => {
      for (const e of entries) dirty.add(e.target as HTMLElement)
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const hs: Array<[string, number]> = []
        const as: Array<[string, number]> = []
        const ts: Array<[string, boolean]> = []
        for (const el of dirty) {
          if (!el.isConnected) continue
          const key = el.dataset.cvNode || el.dataset.cvInner
          if (!key) continue
          if (el.dataset.cvNode) {
            hs.push([key, el.offsetHeight])
            as.push([key, el.querySelector<HTMLElement>(':scope > .t2cv-acard')?.offsetTop ?? 0])
          } else ts.push([key, el.offsetHeight > PREVIEW_H + 4])
        }
        dirty.clear()
        if (hs.length) setHeights((prev) => (hs.some(([k, v]) => prev.get(k) !== v) ? new Map([...prev, ...hs]) : prev))
        if (as.length) setATops((prev) => (as.some(([k, v]) => prev.get(k) !== v) ? new Map([...prev, ...as]) : prev))
        if (ts.length) setTall((prev) => {
          if (ts.every(([k, v]) => prev.has(k) === v)) return prev
          const next = new Set(prev)
          for (const [k, v] of ts) { if (v) next.add(k); else next.delete(k) }
          return next
        })
      })
    })
  }
  useEffect(() => () => roRef.current?.disconnect(), [])
  const track = useCallback((el: HTMLElement | null): void => { if (el) roRef.current?.observe(el) }, [])
  // 收起的子树:正在看的这一支要穿过它时不算(只认这一支最后一张往下收),不然焦点那张卡没了
  const folds = useMemo(() => {
    const path = tree.paths[activeId] ?? []
    return new Set(pref.fold.filter((k) => tree.cards.has(k) && !(path.includes(k) && k !== path[path.length - 1])))
  }, [pref.fold, tree, activeId])
  // 子卡的左右顺序:记过的照记的排,没记的照建的先后排在后面;草稿插在它该在的位置
  const order = pref.order
  const kidsOf = useCallback((k: string): string[] => {
    const c = tree.cards.get(k)
    if (!c) return []
    if (folds.has(k)) return draft?.parent === k ? [DRAFT] : []
    let ks = c.children
    const o = order[k]
    if (o?.length) {
      const idx = (x: string): number => { const i = o.indexOf(tree.cards.get(x)!.sid); return i < 0 ? o.length : i }
      ks = [...ks].sort((a, b) => idx(a) - idx(b))
    }
    if (draft && draft.parent === k) { ks = [...ks]; ks.splice(Math.min(Math.max(0, draft.at), ks.length), 0, DRAFT) }
    return ks
  }, [tree, order, folds, draft?.parent, draft?.at]) // eslint-disable-line react-hooks/exhaustive-deps
  const countUnder = (k: string): number => (tree.cards.get(k)?.children ?? []).reduce((n, c) => n + 1 + countUnder(c), 0)
  const setFold = (k: string, on: boolean): void => {
    const rest = pref.fold.filter((x) => x !== k && tree.cards.has(x)) // 顺手清掉已经不在树里的
    setPref({ fold: on ? [...rest, k] : rest })
  }
  const boxes = useMemo(() => layoutTree(tree, heights, dir, kidsOf), [tree, heights, dir, kidsOf])
  const boxesRef = useRef(boxes)
  boxesRef.current = boxes

  // ── 选中 / 当前这一支 / 阅读栏 ──
  const activePath = tree.paths[activeId] ?? []
  const [sel, setSel] = useState<{ key: string; part: 'q' | 'a' } | null>(null)
  const selected = sel && activePath.includes(sel.key) ? sel.key : activePath[activePath.length - 1] ?? null
  const selPart = sel && sel.key === selected ? sel.part : (selected && !tree.cards.get(selected)?.answers.length ? 'q' : 'a')
  const hot = new Set<string>() // 树根 → 选中卡这条路上的卡(它们头上那根线加深)
  for (let k: string | null = selected; k; k = tree.cards.get(k)?.parent ?? null) hot.add(k)
  const [focus, setFocus] = useState(false)
  const [hand, setHand] = useState(false)
  // 按住空格 = 临时抓手(拖到哪都是平移);轻按松开、中间没拖 = 开 / 关阅读栏(unify.html §2 三种画布的约定)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const spaceRef = useRef(false)
  const spaceUsed = useRef(false)
  const handRef = useRef(hand)
  handRef.current = hand
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [reading, setReading] = useState<string | null>(null)
  const readCard = reading ? tree.cards.get(reading) : undefined
  const [readDir, setReadDir] = useState(0) // 换轮是往下(1)还是往上(-1):正文按这个方向滑进来;0 = 刚打开,不滑
  const [leaving, setLeaving] = useState<string | null>(null) // 刚关掉、还在往右淡出的那一张
  const paneCard = readCard ?? (leaving ? tree.cards.get(leaving) : undefined)
  const readRef = useRef<HTMLElement>(null)
  const hintsEl = useRef<HTMLDivElement>(null)
  const pick = (key: string, part: 'q' | 'a' = 'a'): void => {
    const c = tree.cards.get(key)
    if (!c) return
    setSel({ key, part })
    setExpanded((s) => (s.size && !s.has(key) ? new Set() : s)) // 刚写完还展开着的那张:选了别的卡就收回预览
    // 不在当前这一支上:主区就地换成它那一支。子会话那一支经过的主线卡没有它的副本(at 里没有它),按路径认,别被切回主会话
    if (!c.at[activeId] && !activePath.includes(key)) useApp.getState().setActiveId(c.sid)
    if (reading && reading !== key) { // 阅读栏开着:跟着换成这一张,正文按先后从下 / 上滑进来
      const p = tree.paths[activeId] ?? [], i0 = p.indexOf(reading), i1 = p.indexOf(key)
      setReadDir(i0 >= 0 && i1 >= 0 ? Math.sign(i1 - i0) || 1 : 1)
      setReading(key)
    }
  }

  // ── 舞台:canvasKit 的视口 + 手势(空白拖 = 平移;卡里照常选字,不拖不框选) ──
  const host = useRef<HTMLDivElement>(null)
  const memoKey = `chat-canvas:${rootId}:${dir}`
  const followRef = useRef(true)
  const [follow, setFollow] = useState(true)
  const landed = useRef(!!recallViewport(memoKey))
  // 落位后卡还会再长一点(卡里的内容晚一拍渲染完):1.5s 内、用户没碰过、还是同一张卡,就跟着再落一次
  const settle = useRef<{ key: string; until: number } | null>(null)
  // 刚写完的那张:写完后卡底还会长出一行操作条,跟着的话 1.5s 内接着把卡底贴在阅读线上
  const afterglow = useRef<{ key: string; until: number } | null>(null)
  const flyRaf = useRef(0)
  const flyTo = useRef<Viewport | null>(null) // 正在追的目标(null = 没在飞)
  const followed = useRef<string | null>(null) // 跟随上一次贴的是哪张卡:还是它 = 卡在长,刚性跟;换了 = 追过去
  const flyDone = useRef<(() => void) | undefined>(undefined)
  const flyKind = useRef<'chase' | 'fly'>('chase') // 正在跑的是逐帧追,还是定时的「跳到某处」(fly)
  // 用户自己挪了视口(滚轮 / 拖空白 / 捏合 / 缩略图 / 适应内容):停跟;正在飞的那一下也作废;刚写完展开着的那张收回预览
  const release = useCallback((): void => {
    cancelAnimationFrame(flyRaf.current)
    flyTo.current = null
    flyDone.current = undefined
    followed.current = null
    setExpanded((s) => (s.size ? new Set() : s))
    settle.current = null
    afterglow.current = null
    if (followRef.current) { followRef.current = false; setFollow(false) }
  }, [])
  const view = useCanvasViewport(host, memoKey, release, { x: 0, y: 0, z: START_Z })
  // 手势层的平移 / 捏合也算「用户挪走了」:包一层 setVp。跟随自己用原版 setVp,不会把自己停掉。
  const userView: CanvasViewportApi = { ...view, setVp: (next: Viewport) => { release(); view.setVp(next) } }
  const openReadingRef = useRef<(key: string) => void>(() => {})
  const onMenuRef = useRef<(key: string | null, at: { clientX: number; clientY: number }) => void>(() => {})
  const gesture = useCanvasGestures(host, userView, {
    boxes: () => boxesRef.current,
    commit: () => {}, // 位置不存(拖动摆位还没做)
    hitKey: (el) => {
      if (spaceRef.current) { spaceUsed.current = true; return null } // 按着空格按下去了:这一下是平移,松开空格不再开阅读栏
      return handRef.current ? null : el.closest<HTMLElement>('[data-cv-node]')?.dataset.cvNode ?? null
    },
    isEditing: () => true, // 卡里的字照常选、按钮照常点:手势层对卡整个让路
    blankPan: true,
    rightPan: true, // 空白处右键按住拖 = 平移,没拖才弹菜单(用户 10-24 定)
    // 在卡里的输入框(改名)里双击 = 选词,不算双击卡片
    onDoubleClick: (key) => { if (key && key !== DRAFT && !document.activeElement?.closest('.t2cv input, .t2cv textarea')) openReadingRef.current(key) },
    onContextMenu: (key, at) => onMenuRef.current(key, at),
    minW: CARD_W,
    minH: 40,
  }, false)
  useEffect(() => gesture.bind(host.current), [gesture.bind])
  useEffect(() => view.bindWheel(host.current), [view.bindWheel])
  const [mini, setMini] = useState(miniPref)
  const [hintsAuto] = useState(() => hintsSeen() < HINTS_TIMES)
  useEffect(() => { try { localStorage.setItem(HINTS_KEY, String(hintsSeen() + 1)) } catch { /* ignore */ } }, [])
  const [helpAt, setHelpAt] = useState<{ x: number; y: number; top: number } | null>(null)

  const composerInset = (): number => {
    const v = host.current ? parseFloat(getComputedStyle(host.current).getPropertyValue('--t2-composer-h')) : NaN
    return (Number.isFinite(v) ? v : 96) + 44 // 让开输入框上方「接在 · …」那一行
  }
  /** 阅读栏开着时右边被它占掉的那一截(舞台坐标) */
  const paneSpace = (): number => {
    const el = readRef.current
    if (!el || !host.current) return 0
    const { w, u } = hostSize(host.current)
    if (w < NARROW) return 0 // 窄:阅读栏直接盖在画布上,不让位
    return el.getBoundingClientRect().width / u + READ_GUTTER
  }
  /** 舒服的阅读位置:卡底停在输入框上方(和 Chat View 贴底一样,新出来的字在最下面);卡在横向视野外就居中。 */
  const readingVp = (b: Box, vp: Viewport): Viewport => {
    const { h } = hostSize(host.current)
    const w = hostSize(host.current).w - paneSpace()
    const z = vp.z
    const left = b.x * z + vp.x
    const x = left < 16 || left + b.w * z > w - 16 ? w / 2 - (b.x + b.w / 2) * z : vp.x
    return { z, x, y: h - composerInset() - (b.y + b.h) * z }
  }
  /** 追到某个视口:每帧走剩下的 CHASE(和帧率无关),单帧位移封顶;飞的途中再叫就只换目标、不重起。
   *  track = 同一张卡在长(目标一点点挪):没在飞就直接贴上;在飞就连当前位置一起平移,剩下那段照常追 —— 不然追法天生落后,
   *  新长出来的字压在输入框底下(台架实测落后 20~50px)。用户一碰就作废(release);系统开了「减少动态效果」直接到。 */
  const chase = (to: Viewport, done?: () => void, track = false): void => {
    if (flyKind.current === 'fly') { cancelAnimationFrame(flyRaf.current); flyTo.current = null } // 定时那一下没走完:从当前位置接着追
    flyKind.current = 'chase'
    flyDone.current = done
    if (reduceMotion()) { cancelAnimationFrame(flyRaf.current); flyTo.current = null; flyDone.current = undefined; view.setVp(to); done?.(); return }
    const prev = flyTo.current
    if (track && !prev) { view.setVp(to); flyDone.current = undefined; done?.(); return }
    if (track && prev) { const cur = view.vpRef.current; view.setVp({ z: cur.z, x: cur.x + to.x - prev.x, y: cur.y + to.y - prev.y }) }
    flyTo.current = to
    if (prev) return
    let last = performance.now()
    const step = (now: number): void => {
      const goal = flyTo.current
      if (!goal) return
      const dt = Math.min(64, Math.max(0, now - last)) // 切走标签页回来别一步跨完
      last = now
      const cur = view.vpRef.current
      const k = 1 - (1 - CHASE) ** (dt / 16.7)
      let dx = (goal.x - cur.x) * k, dy = (goal.y - cur.y) * k
      const d = Math.hypot(dx, dy), cap = CHASE_CAP * (dt / 16.7)
      if (d > cap) { dx *= cap / d; dy *= cap / d }
      const z = cur.z + (goal.z - cur.z) * k
      if (Math.hypot(goal.x - cur.x - dx, goal.y - cur.y - dy) < 0.5 && Math.abs(goal.z - z) < 1e-3) {
        flyTo.current = null
        view.setVp(goal)
        const f = flyDone.current
        flyDone.current = undefined
        f?.()
        return
      }
      view.setVp({ z, x: cur.x + dx, y: cur.y + dy })
      flyRaf.current = requestAnimationFrame(step)
    }
    flyRaf.current = requestAnimationFrame(step)
  }
  /** 「跳到某处」(阅读栏让位):定时走完、落点带一点点过冲。和 chase 共用 flyRaf / flyTo:用户一碰(release)或别处再叫 chase 就让出来。 */
  const fly = (to: Viewport, ms = READ_FLY_MS): void => {
    cancelAnimationFrame(flyRaf.current)
    flyDone.current = undefined
    if (reduceMotion()) { flyTo.current = null; view.setVp(to); return }
    flyKind.current = 'fly'
    flyTo.current = to
    const from = { ...view.vpRef.current }, t0 = performance.now()
    const step = (now: number): void => {
      const to = flyTo.current // 进场途中卡又长了一点:落点跟着改(见 retarget),曲线照走
      if (!to) return
      const t = Math.min(1, (now - t0) / ms), k = settleCurve(t)
      view.setVp({ z: from.z + (to.z - from.z) * k, x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k })
      if (t < 1) flyRaf.current = requestAnimationFrame(step)
      else flyTo.current = null
    }
    flyRaf.current = requestAnimationFrame(step)
  }
  /** 让一张卡露出来:不在阅读栏左边那块可见区里就挪过去(横向居中在那块里;卡头出了上下边才动纵向)。smooth = 用 fly 那条曲线(阅读栏让位)。 */
  const reveal = (key: string, smooth = false): void => {
    const b = boxesRef.current.get(key)
    if (!b || !host.current) return
    const { w, h } = hostSize(host.current)
    const right = w - paneSpace()
    const vp = flyTo.current ?? view.vpRef.current
    const z = vp.z
    const left = b.x * z + vp.x, top = b.y * z + vp.y, cw = b.w * z
    let { x, y } = vp
    if (left < 16 || left + cw > right - 16) x = cw > right - 32 ? 16 - b.x * z : right / 2 - (b.x + b.w / 2) * z
    if (top < 48 || top > h - composerInset() - 60) y = 56 - b.y * z
    if (Math.abs(x - vp.x) > 0.5 || Math.abs(y - vp.y) > 0.5) (smooth ? fly : chase)({ z, x, y })
  }
  // 右边开 / 关顺便问、子会话面板(它在画布旁边占位,舞台变窄 / 变宽):正看着的那张卡别被切在边上,镜头按阅读栏那套让一下。
  // 正在跟着生成时不管(下一段字进来跟随自己会贴好)。
  const latest = useRef({ reveal, key: reading ?? selected })
  latest.current = { reveal, key: reading ?? selected }
  useEffect(() => {
    const el = host.current
    if (!el) return
    // 等宽度停下来再比(面板开合有动画、分隔条会被慢慢拖):跟上一次处理过的宽度比,不跟上一帧比 —— 一帧挪几像素永远够不到 24(Codex 评审)
    let done = 0, timer = 0
    const ro = new ResizeObserver(() => {
      if (!done) { done = hostSize(el).w; return }
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        const { w } = hostSize(el)
        if (Math.abs(w - done) < 24) return
        done = w
        const { reveal: go, key } = latest.current
        if (key && !followRef.current) go(key, true)
      }, 120)
    })
    ro.observe(el)
    return () => { ro.disconnect(); clearTimeout(timer) }
  }, [])
  const openReading = (key: string): void => {
    if (!tree.cards.has(key)) return
    release() // 要读这一张了:别再跟着生成跑
    if (!reading) setReadDir(0)
    setLeaving(null)
    pick(key, sel?.key === key ? sel.part : 'a')
    setReading(key)
  }
  openReadingRef.current = openReading
  const leaveT = useRef(0)
  useEffect(() => () => clearTimeout(leaveT.current), [])
  /** 关阅读栏:往右淡出 READ_CLOSE_MS 再拿掉(减少动态效果就直接拿掉) */
  const closeReading = (): void => {
    if (!reading) return
    // 焦点在栏里:先交回舞台(栏还要淡出一会儿才拿掉,等它没了焦点才掉回 body,下面「回舞台」那段就接不住了)
    if (readRef.current?.contains(document.activeElement)) host.current?.focus({ preventScroll: true })
    if (!reduceMotion()) {
      setLeaving(reading)
      clearTimeout(leaveT.current)
      leaveT.current = window.setTimeout(() => setLeaving(null), READ_CLOSE_MS)
    }
    setReading(null)
  }
  /** 打开:一个卡框从那张卡长到阅读栏的位置,栏里的字最后淡进来 */
  const growFrom = (key: string): void => {
    const pane = readRef.current, root = pane?.parentElement
    const node = `.t2cv-turn[data-cv-node="${key}"]`
    const card = host.current?.querySelector(`${node} > .t2cv-acard`) ?? host.current?.querySelector(`${node} > .t2cv-qcard`)
    if (!pane || !root || !card || reduceMotion()) return
    const u = hostSize(host.current).u || 1, o = root.getBoundingClientRect()
    const at = (r: DOMRect): Keyframe => ({ left: `${(r.left - o.left) / u}px`, top: `${(r.top - o.top) / u}px`, width: `${r.width / u}px`, height: `${r.height / u}px` })
    const g = document.createElement('div')
    g.className = 't2cv-read-ghost'
    root.append(g)
    const a = g.animate([at(card.getBoundingClientRect()), at(pane.getBoundingClientRect())], { duration: READ_OPEN_MS, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' })
    a.onfinish = a.oncancel = () => g.remove()
    pane.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: READ_OPEN_MS })
  }
  // 阅读栏换了一张(或刚打开):等它画出来量到宽,再让那张卡让开它
  const wasReading = useRef(false)
  useLayoutEffect(() => {
    if (reading) {
      reveal(reading, true)
      if (!wasReading.current) growFrom(reading)
      // 焦点给阅读栏:↑↓ 翻轮、Esc 关都要焦点在画布里(双击后焦点常在 body);在输入框 / 草稿里打字时别抢
      if (!document.activeElement?.closest('textarea, input, [contenteditable="true"]')) readRef.current?.focus({ preventScroll: true })
    } else if (wasReading.current && (!document.activeElement || document.activeElement === document.body)) host.current?.focus({ preventScroll: true }) // 焦点跟着阅读栏没了:回舞台
    wasReading.current = !!reading
  }, [reading]) // eslint-disable-line react-hooks/exhaustive-deps
  const readPath = activePath
  const readIdx = reading ? readPath.indexOf(reading) : -1
  const stepRead = (d: number): void => {
    const k = readPath[readIdx + d]
    if (k) pick(k) // 阅读栏开着,pick 顺手换过去
  }
  /** 「在对话里打开」:切回对话、停在这一支,滚到这一轮的提问(同搜索命中那套:先落目标再切,对话页一渲染出来就滚过去) */
  const openInChat = (key: string): void => {
    const c = tree.cards.get(key)
    if (!c) return
    const sid = c.at[activeId] ? activeId : c.sid
    const first = c.at[sid]?.first
    const app = useApp.getState()
    if (first) app.setJumpTarget(sid, first)
    if (sid !== activeId) app.setActiveId(sid)
    onChat()
  }

  // 换了排法:这个排法记过视口就回到那里,没记过就重新落位。⚠️ 排在跟随之前:跟随一写视口就落进新排法的记忆,
  // 后读就把记着的那份冲掉了(Codex 评审)
  const lastDir = useRef(dir)
  useLayoutEffect(() => {
    if (lastDir.current === dir) return
    lastDir.current = dir
    const r = recallViewport(memoKey)
    settle.current = null
    cancelAnimationFrame(flyRaf.current) // 换排法:还在飞的那一下目标是旧排法的
    flyTo.current = null
    if (r) { landed.current = true; view.setVp(r) } else landed.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir])

  // ── 自动跟随:当前这一支上那张在生成的卡 ──
  // 取这一支上最靠后的那张:子会话那一支里,开出它的主线回答和子会话自己可能同时在写,跟的是正看着的子会话
  const streamKey = [...activePath].reverse().find((k) => tree.cards.get(k)!.answers.some((m) => m.status === 'streaming')) ?? null
  const lastStream = useRef<string | null>(null)
  useLayoutEffect(() => {
    // 这一支上新冒出一张在生成的卡(= 刚发出去一句):重新跟上
    if (streamKey && streamKey !== lastStream.current) { followRef.current = true; setFollow(true) }
    // 刚写完的那张不折起:正跟着读到它的末尾,一折视野就落到卡下面的空白里(Codex 评审实测卡跳出视口上方一千多像素)
    const done = lastStream.current
    // 只认真写完的:切到别的支时 streamKey 也会变空,那张其实还在写(Codex 复核)
    if (done && done !== streamKey && !tree.cards.get(done)?.answers.some((m) => m.status === 'streaming')) {
      setExpanded((s) => (s.has(done) ? s : new Set(s).add(done)))
      afterglow.current = followRef.current ? { key: done, until: performance.now() + 1500 } : null
    }
    lastStream.current = streamKey
  }, [streamKey])
  useLayoutEffect(() => {
    const g = afterglow.current
    const k = streamKey ?? (g && performance.now() < g.until && activePath.includes(g.key) ? g.key : null)
    if (!k || !followRef.current || !heights.has(k)) return
    const b = boxes.get(k)
    if (!b) return
    const cur = flyTo.current ?? view.vpRef.current // 正在飞:按目标算,半路的位置会让横向停在一半
    const next = readingVp(b, cur)
    landed.current = true // 跟着生成落过位了,生成完不再跳回「最后一张卡顶」
    settle.current = null
    const same = followed.current === k
    followed.current = k
    if (Math.abs(next.x - cur.x) > 0.5 || Math.abs(next.y - cur.y) > 0.5 || Math.abs(next.z - cur.z) > 1e-3) chase(next, undefined, same)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, streamKey, follow])
  // 第一次打开(这棵树、这个排法没记过视口):同 Chat View 打开在末尾 —— 这一支最后一张卡的卡底落在阅读线上,
  // 上面露出前几轮;卡比视口高就卡顶留一点边
  useLayoutEffect(() => {
    if (!selected || streamKey) return
    const s = settle.current
    if (landed.current && !(s && s.key === selected && performance.now() < s.until)) return
    for (let k: string | null = selected; k; k = tree.cards.get(k)?.parent ?? null) if (!heights.has(k)) return // 上面的卡还没量完,位置还会变
    const b = boxes.get(selected)
    const { w, h } = hostSize(host.current)
    if (!b || !w) return
    if (!landed.current) settle.current = { key: selected, until: performance.now() + 1500 }
    landed.current = true
    const at = { z: START_Z, x: w / 2 - (b.x + b.w / 2) * START_Z, y: Math.max(32 - b.y * START_Z, h - composerInset() - (b.y + b.h) * START_Z) }
    if (switchRef.current === 'enter' && flyTo.current) flyTo.current = at // 正在拉远:只改落点
    else view.setVp(at)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, selected])

  // ── 对话 ↔ 画布(motion.html §1 A):那条回答原地变成这张卡(100%,字一样大),镜头拉到落位;别的卡、线、胶囊随后浮现 ──
  const [enterFrom] = useState(() => (pendingEnter && performance.now() - pendingEnter.at < 1000 && !reduceMotion() ? pendingEnter.anchor : null))
  useEffect(() => { pendingEnter = null }, [])
  const [switching, setSwitching] = useState<{ phase: 'enter' | 'exit'; key: string } | null>(null)
  const switchRef = useRef<'enter' | 'exit' | null>(null)
  switchRef.current = switching?.phase ?? null
  const cardOf = (msgId: string): string | undefined => [...tree.cards.values()].find((c) => c.answers.some((m) => m.id === msgId))?.key
  /** 让这张卡里那条回答的正文列在 z=1 时正好压在对话流里它的位置上 */
  const alignVp = (key: string, a: CanvasAnchor): Viewport | null => {
    const el = host.current?.querySelector(`[data-cv-node="${key}"] [id="tocmsg-${a.msgId}"] .t2-asst-col`)
    const world = host.current?.querySelector('.t2cv-world')
    if (!el || !world || !host.current) return null
    const e = el.getBoundingClientRect(), w = world.getBoundingClientRect(), hr = host.current.getBoundingClientRect(), z0 = view.vp.z // DOM 上是这一帧画出来的视口
    const u = hostSize(host.current).u // 屏幕像素 ÷ 整窗缩放 = 视口用的 CSS 像素(用户开发版常年 110%)
    return { z: 1, x: (a.left - hr.left) / u - (e.left - w.left) / (z0 * u), y: (a.top - hr.top) / u - (e.top - w.top) / (z0 * u) }
  }
  const entered = useRef(!enterFrom)
  useLayoutEffect(() => {
    if (entered.current || !landed.current || !enterFrom) return
    const key = cardOf(enterFrom.msgId)
    for (let k: string | null | undefined = key; k; k = tree.cards.get(k)?.parent) if (!heights.has(k)) return // 位置还没落定
    entered.current = true
    const start = key ? alignVp(key, enterFrom) : null
    if (!key || !start) return
    const to = { ...(flyTo.current ?? view.vpRef.current) }
    view.setVp(start)
    fly(to, ENTER_MS)
    setSwitching({ phase: 'enter', key })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, heights, follow])
  const onExitedRef = useRef(onExited)
  onExitedRef.current = onExited
  useLayoutEffect(() => {
    if (!exiting) return
    const a = reduceMotion() ? null : chatAnchor(host.current?.closest('.t2-chat-view'), (id) => !!cardOf(id))
    const key = a ? cardOf(a.msgId) : undefined
    const to = key && a ? alignVp(key, a) : null
    if (!to) { onExitedRef.current?.(); return }
    const back = { ...(flyTo.current ?? view.vpRef.current) }
    release()
    fly(to, EXIT_MS)
    setSwitching({ phase: 'exit', key: key! })
    return () => { // 播完卸掉 / 半路又切回画布:视口记忆回到切走前那一份
      cancelAnimationFrame(flyRaf.current)
      flyTo.current = null
      view.setVp(back)
      rememberViewport(memoKey, back)
      setSwitching(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exiting])
  // 播放中碰任何一下:进场直接到终点,退场直接卸掉;到时间自己收
  useEffect(() => {
    const el = host.current
    if (!switching || !el) return
    const end = (): void => {
      if (switching.phase === 'exit') { onExitedRef.current?.(); return }
      const goal = flyTo.current
      cancelAnimationFrame(flyRaf.current)
      flyTo.current = null
      if (goal) view.setVp(goal)
      setSwitching(null)
    }
    const timer = setTimeout(switching.phase === 'exit' ? end : () => setSwitching(null), (switching.phase === 'exit' ? EXIT_MS : ENTER_MS) + 30)
    for (const ev of ['pointerdown', 'wheel', 'keydown'] as const) el.addEventListener(ev, end, true)
    return () => { clearTimeout(timer); for (const ev of ['pointerdown', 'wheel', 'keydown'] as const) el.removeEventListener(ev, end, true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switching])

  // 生成中的那张卡出了可读区:出箭头(朝它在的方向)
  let arrow: 'up' | 'down' | 'left' | 'right' | null = null
  const sb = streamKey ? boxes.get(streamKey) : undefined
  if (!follow && sb && host.current) {
    const { w, h } = hostSize(host.current)
    const vp = view.vp
    const top = sb.y * vp.z + vp.y, bottom = top + sb.h * vp.z, left = sb.x * vp.z + vp.x, right = left + sb.w * vp.z
    if (right < 0) arrow = 'left'
    else if (left > w - paneSpace()) arrow = 'right'
    else if (bottom < 0) arrow = 'up'
    else if (bottom > h - composerInset() + 8) arrow = 'down'
  }
  // 箭头 / 右键「回到最新」:在生成就恢复跟随(跟随那段自己追过去);没在生成就追到这一支最后一张
  const toLatest = (): void => {
    if (streamKey) { followRef.current = true; setFollow(true); return }
    const k = activePath[activePath.length - 1]
    const b = k ? boxesRef.current.get(k) : undefined
    // 不 release:它会把刚写完、还展开着的那张收回预览,落点却是按展开的高度算的 → 落进卡下面的空白(Codex 评审)
    if (b) fly(readingVp(b, view.vpRef.current), JUMP_MS)
  }
  /** 缩放胶囊 / ⌘+ ⌘− ⌘0:以舞台中心为锚,走「跳到某处」那条曲线;连按几下按上一次的终点接着算 */
  const zoomStep = (f: number): void => {
    const { w, h } = hostSize(host.current)
    const cur = flyTo.current ?? view.vpRef.current
    release()
    fly(zoomAt(cur, cur.z * f, w / 2, h / 2), JUMP_MS)
  }
  /** 看全部(胶囊 ⤢ / ⇧1 / 视图菜单) */
  const fitAll = (): void => {
    const v = fitViewport(host.current, [...boxesRef.current.values()], 64)
    if (v) { release(); fly(v, JUMP_MS) }
  }
  useEffect(() => () => cancelAnimationFrame(flyRaf.current), [])
  // 划线条是固定定位、画布动的是变换:视口一挪就告诉条收起(平移 / 缩放 / 跟随 / 镜头飞)
  const vpNow = view.vp
  useEffect(() => { host.current?.dispatchEvent(new Event(SELBAR_VIEWPORT_MOVED, { bubbles: true })) }, [vpNow.x, vpNow.y, vpNow.z])

  // ── ⊕:接着问 / 草稿提问卡 ──
  /** 这张卡是哪一支的最后一张(优先当前这一支):在这里接着问 = 用输入框发到那一支。 */
  const tailOf = (key: string): string | null => {
    const c = tree.cards.get(key)
    if (!c) return null
    if (tree.paths[activeId]?.at(-1) === key) return activeId
    return Object.keys(c.at).find((sid) => tree.paths[sid]?.at(-1) === key) ?? null
  }
  const [flash, setFlash] = useState(false)
  const flashT = useRef(0)
  useEffect(() => () => clearTimeout(flashT.current), [])
  const followUp = (key: string, sid: string): void => {
    setSel({ key, part: 'a' })
    if (sid !== activeId) useApp.getState().setActiveId(sid)
    host.current?.closest('.t2-chat-view')?.querySelector<HTMLTextAreaElement>('.composer-anchor .t2c-ta')?.focus({ preventScroll: true })
    setFlash(true)
    clearTimeout(flashT.current)
    flashT.current = window.setTimeout(() => setFlash(false), 900)
  }
  const draftTa = useRef<HTMLTextAreaElement>(null)
  const revealDraft = useRef(false)
  const openDraft = (parent: string, at: number, text = ''): void => {
    // 已经有一张写了字的:先飞过去,由你决定发还是放弃(同一时间只有一张)
    const raw = pref.draft
    if (raw?.text.trim()) {
      if (draft) { reveal(DRAFT); draftTa.current?.focus({ preventScroll: true }); return }
      text = raw.text // 原来挂的那张卡没了(别处归档 / 删了那一支):字搬到这张新草稿上,不丢
    }
    release()
    setPref({ draft: { parent, at, text }, ...(pref.fold.includes(parent) ? { fold: pref.fold.filter((x) => x !== parent) } : {}) })
    revealDraft.current = true
  }
  // 新开的草稿量到位置以后再露出来、聚焦(聚焦不许滚:舞台 overflow:hidden,浏览器会自己去滚它)
  useLayoutEffect(() => {
    if (!revealDraft.current || !heights.has(DRAFT) || !draftTa.current) return
    revealDraft.current = false
    reveal(DRAFT)
    draftTa.current.focus({ preventScroll: true })
  }, [heights, draft]) // eslint-disable-line react-hooks/exhaustive-deps
  const discardDraft = (): void => setPref({ draft: null })
  const [sending, setSending] = useState(false)
  const sendDraft = async (): Promise<void> => {
    const d = draft
    const text = d?.text.trim()
    const p = d && tree.cards.get(d.parent)
    if (!d || !text || !p || sending) return
    setSending(true)
    try {
      // 草稿只在本机:到这一刻才在引擎里建分支(从那张回答的最后一条分出),再把这句发进新分支
      const app = useApp.getState()
      const id = d.sid && app.sessions.some((x) => x.id === d.sid) ? d.sid : await app.branchFromMessage(p.at[p.sid].last, p.sid)
      if (!id) return // 没建成:store 已 toast,草稿留着
      if (id !== d.sid) {
        const sids = kidsOf(d.parent).filter((k) => k !== DRAFT).map((k) => tree.cards.get(k)!.sid)
        sids.splice(Math.min(d.at, sids.length), 0, id)
        setPref({ order: { ...order, [d.parent]: sids }, draft: { ...d, sid: id } })
      }
      // 等历史和配置都到了再发:复制段先到、继承来的 Agent / 模型不被空配置冲掉(建分支时 setActiveId 已经开始拉,这里等同一份)
      await useApp.getState().loadSessionHistory(id)
      // 发成了才清草稿;没发成(断网 / 引擎拒绝)字留着,分支 id 也记着,再按一次就接着发
      if (await useApp.getState().send(text, [], undefined, undefined, undefined, id)) setPref({ draft: null })
    } finally { setSending(false) }
  }

  // ── 卡里消息的上下文与动作(按会话 / 消息缓存,EditorialMessage 的 memo 才挡得住流式重渲) ──
  const setFilePreview = useApp((s) => s.setFilePreview)
  const ctxCache = useMemo(() => new Map<string, FileCtx>(), [cfg, setFilePreview])
  const ctxFor = (sid: string): FileCtx => {
    const k = `${sid}:${execModes[sid] ?? ''}`
    let c = ctxCache.get(k)
    if (!c) { c = { cfg, sessionId: sid, execMode: execModes[sid], onOpenPreview: setFilePreview }; ctxCache.set(k, c) }
    return c
  }
  const handlerCache = useRef(new Map<string, MessageHandlers>())
  const handlersFor = (sid: string, id: string): MessageHandlers => {
    const k = `${sid}:${id}:${kidSet.has(sid) ? 'kid' : ''}`
    let h = handlerCache.current.get(k)
    if (!h) {
      h = {
        onCopy: (text) => { try { void navigator.clipboard.writeText(text) } catch { /* ignore */ } },
        onBranch: kidSet.has(sid) ? undefined : () => void useApp.getState().branchFromMessage(id, sid),
        onAside: () => {
          const s = useApp.getState().sessions.find((x) => x.id === sid)
          openBtw({ sessionId: sid, title: s?.title, modelId: s?.model_id || undefined, messageId: id })
        },
      }
      handlerCache.current.set(k, h)
    }
    return h
  }

  // ── 右键:回答卡 / 提问卡 / 空白处 ──
  const [menu, setMenu] = useState<CtxMenu>(null)
  // 「视图」菜单(胶囊上那颗)开着时焦点进菜单、方向键能走;关掉时焦点还在菜单里就回到那颗钮(Codex 评审)
  const [menuFocus, setMenuFocus] = useState(false)
  const viewBtn = useRef<HTMLButtonElement>(null)
  const closeMenu = (): void => {
    setMenu(null)
    if (!menuFocus) return
    setMenuFocus(false)
    const a = document.activeElement
    if (!a || a === document.body || a.closest('.ctx-menu')) viewBtn.current?.focus({ preventScroll: true })
  }
  const [renaming, setRenaming] = useState<string | null>(null) // 正在改名的那一支(卡 key)
  const copy = (text: string): void => { try { void navigator.clipboard.writeText(text) } catch { /* ignore */ } }
  /** 这张卡是不是一支的开头(这一支自己的第一轮):重命名 / 归档挂在它上面 */
  const isHead = (c: { sid: string; parent: string | null }): boolean => c.sid !== rootId && (!c.parent || tree.cards.get(c.parent)?.sid !== c.sid)
  const archiveBranch = (key: string): void => {
    const c = tree.cards.get(key)
    if (!c) return
    // 正看着这一支(或它下面):先回到它的上一支,别让对话区空掉
    const up = c.parent ? tree.cards.get(c.parent) : undefined
    if (up && activePath.includes(key)) useApp.getState().setActiveId(up.sid)
    // 草稿挂在这一支的卡下面:挪到这一支的上一张卡下面(字留着;分支 id 作废,发的时候重建)
    const d = pref.draft
    if (d && c.parent && tree.cards.get(d.parent)?.sid === c.sid) setPref({ draft: { parent: c.parent, at: kidsOf(c.parent).filter((k) => k !== DRAFT).length, text: d.text } })
    void useApp.getState().archiveSession(c.sid, true)
  }
  const menuFor = (key: string | null, part: 'q' | 'a'): CtxItem[] => {
    const c = key && key !== DRAFT ? tree.cards.get(key) : undefined
    if (!c) {
      return [
        { label: t('chatcanvas.menu.latest'), icon: <Locate size={14} />, disabled: !activePath.length, run: toLatest },
        { label: t('chatcanvas.menu.fit'), icon: <Maximize2 size={14} />, shortcut: '⇧1', run: fitAll },
        { label: t(dir === 'v' ? 'chatcanvas.horizontal' : 'chatcanvas.vertical'), icon: dir === 'v' ? <MoveRight size={14} /> : <MoveDown size={14} />, separatorBefore: true, run: () => onDir(dir === 'v' ? 'h' : 'v') },
        { label: t(focus ? 'chatcanvas.menu.showAll' : 'chatcanvas.focus'), icon: <ListTree size={14} />, run: () => setFocus((v) => !v) },
        { label: t(mini ? 'chatcanvas.menu.miniOff' : 'chatcanvas.menu.miniOn'), icon: <MapIcon size={14} />, run: () => { setMini(!mini); setMiniPref(!mini) } },
        { label: t(kidsOn ? 'chatcanvas.menu.kidsOff' : 'chatcanvas.menu.kidsOn'), icon: <Split size={14} />, disabled: !allKids.length, run: () => {
          // 正看着某个子会话时关掉:先回到开出它的那一支,不然这棵树里没有它了,画布会被换成它自己的对话
          const from = kidsOn ? kids.find((k) => k.id === activeId)?.parent_session_id : undefined
          if (from) useApp.getState().setActiveId(from)
          setKidsPref(!kidsOn)
        } },
        { label: t(hand ? 'chatcanvas.menu.handOff' : 'chatcanvas.menu.handOn'), icon: <Hand size={14} />, run: () => setHand((v) => !v) },
      ]
    }
    const sibs = c.parent ? kidsOf(c.parent).filter((k) => k !== DRAFT) : []
    const me = sibs.indexOf(c.key)
    const kid = kidSet.has(c.sid)
    if (part === 'q' && c.user) {
      const q = questionText(c.user)
      const head = isHead(c)
      return [
        { label: t('chatcanvas.add.sibling'), icon: <GitBranch size={14} />, disabled: kid || !c.parent || me < 0, run: () => openDraft(c.parent!, me + 1) },
        { label: t('chatcanvas.menu.rewrite'), icon: <PenLine size={14} />, disabled: kid || !c.parent || me < 0, run: () => openDraft(c.parent!, me + 1, q) },
        { label: t('chatcanvas.menu.copyQuestion'), icon: <Copy size={14} />, run: () => copy(q) },
        ...(head ? [
          { label: t('chatcanvas.menu.rename'), icon: <Pencil size={14} />, separatorBefore: true, run: () => setRenaming(c.key) },
          { label: t('chatcanvas.menu.archive'), icon: <Archive size={14} />, run: () => archiveBranch(c.key) },
        ] : []),
      ]
    }
    const tailSid = c.answers.length ? tailOf(c.key) : null
    const last = c.answers[c.answers.length - 1]
    const n = countUnder(c.key)
    const folded = folds.has(c.key)
    const onPath = activePath.includes(c.key) && activePath[activePath.length - 1] !== c.key
    return [
      { label: t(tailSid ? 'chatcanvas.add.follow' : 'chatcanvas.add.next'), icon: <GitBranch size={14} />, disabled: !c.answers.length || (kid && !tailSid),
        run: () => { if (tailSid) followUp(c.key, tailSid); else openDraft(c.key, kidsOf(c.key).filter((k) => k !== DRAFT).length) } },
      { label: t('chatcanvas.menu.copyAnswer'), icon: <Copy size={14} />, disabled: !c.answers.length, run: () => copy(c.answers.map((m) => m.content).join('\n\n')) },
      { label: t('chatcanvas.menu.aside'), icon: <MessageCircleQuestion size={14} />, disabled: !last, run: () => { if (last) handlersFor(c.sid, last.id).onAside?.() } },
      { label: t('chatcanvas.read'), icon: <BookOpen size={14} />, shortcut: 'Space', separatorBefore: true, run: () => openReading(c.key) },
      { label: t('chatcanvas.focus'), icon: <ListTree size={14} />, run: () => { pick(c.key); setFocus(true) } },
      ...(n ? [folded
        ? { label: t('chatcanvas.menu.unfold', { n }), icon: <ChevronsUpDown size={14} />, run: () => setFold(c.key, false) }
        : { label: t('chatcanvas.menu.fold'), icon: <ChevronsDownUp size={14} />, disabled: onPath, run: () => setFold(c.key, true) }] : []),
    ]
  }
  onMenuRef.current = (key, at) => {
    if (key === DRAFT) return // 草稿卡里是在打字
    const part = document.elementFromPoint(at.clientX, at.clientY)?.closest('[data-cv-part="q"]') ? 'q' : 'a'
    // 右键只弹菜单、不选中:选中别的支上的卡会把主区切过去,那张卡就落到当前这一支上,「收起」永远收不了
    setMenuFocus(false)
    setMenu({ x: at.clientX, y: at.clientY, items: menuFor(key, part) })
  }
  const commitRename = (key: string, title: string): void => {
    setRenaming(null)
    const c = tree.cards.get(key)
    if (c) void useApp.getState().renameSession(c.sid, title.trim())
  }

  // 阅读栏宽度:左边缘拖,记在本机
  const [readW, setReadW] = useState<number | null>(() => {
    try { const v = Number(localStorage.getItem(READ_W_KEY)); return v >= READ_W_MIN && v <= READ_W_MAX ? v : null } catch { return null }
  })
  const onGrip = (e: React.PointerEvent): void => {
    const el = readRef.current
    if (!el || e.button !== 0) return
    e.preventDefault()
    const grip = e.currentTarget as HTMLElement
    grip.setPointerCapture(e.pointerId)
    const u = hostSize(host.current).u || 1
    const x0 = e.clientX, w0 = el.getBoundingClientRect().width / u
    const max = Math.min(READ_W_MAX, ((el.parentElement?.getBoundingClientRect().width ?? 0) / u) * 0.7) // 最宽到画布的 70%
    let w = w0
    const move = (ev: PointerEvent): void => { w = Math.round(Math.min(max, Math.max(READ_W_MIN, w0 + (x0 - ev.clientX) / u))); setReadW(w) }
    const up = (): void => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      try { localStorage.setItem(READ_W_KEY, String(w)) } catch { /* ignore */ }
      if (reading) requestAnimationFrame(() => reveal(reading))
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  }

  // 焦点掉回了 body(比如点「上一轮」到头,按钮变灰失焦):Esc 照样关阅读栏。画布里的按键由下面的 onKey 先处理(它 preventDefault)
  useEffect(() => {
    if (!reading) return
    const onDocKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !e.defaultPrevented && e.target === document.body) closeReading() }
    document.addEventListener('keydown', onDocKey)
    return () => document.removeEventListener('keydown', onDocKey)
  }, [reading])
  // 键盘(焦点在舞台上时;卡里 / 草稿里打字不拦):空格开关阅读栏,Esc 关,↑↓ 换到这一支的上一轮 / 下一轮
  const onKey = (e: React.KeyboardEvent): void => {
    const el = e.target as HTMLElement
    if (el.closest('textarea, input, select, [contenteditable="true"]')) return
    // 视口键(同 Amadeus 画布):⌘= ⌘− ⌘0 缩放 / 回 100%,⇧1 看全部。⚠️ preventDefault 就是接管:整窗缩放(uiZoom)先看 defaultPrevented
    const mod = e.metaKey || e.ctrlKey
    if (!e.altKey && (mod ? e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0' : e.shiftKey && e.code === 'Digit1')) {
      e.preventDefault()
      if (!mod) fitAll()
      else zoomStep(e.key === '0' ? 1 / (flyTo.current ?? view.vpRef.current).z : e.key === '-' ? 1 / 1.2 : 1.2)
      return
    }
    // Esc 一层层退:菜单 / 说明(它们自己收)→ 抓手 → 阅读栏
    if (e.key === 'Escape' && (menu || helpAt)) return
    if (e.key === 'Escape' && hand) { e.preventDefault(); setHand(false); return }
    if (e.key === 'Escape' && reading) { e.preventDefault(); closeReading(); return }
    if (reading && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); stepRead(e.key === 'ArrowUp' ? -1 : 1); return }
    if (el.closest('button, a[href]')) return
    if (e.key === ' ') {
      e.preventDefault()
      if (!e.repeat && !spaceRef.current) { spaceRef.current = true; spaceUsed.current = false; setSpaceHeld(true) }
    }
  }
  // 空格松开:中间没拖过 = 开 / 关阅读栏;焦点跑了、窗口失焦也要放掉抓手
  useEffect(() => {
    if (!spaceHeld) return
    const let_go = (): void => { spaceRef.current = false; setSpaceHeld(false) }
    const up = (e: KeyboardEvent): void => {
      if (e.key !== ' ') return
      let_go()
      if (spaceUsed.current) return
      if (reading) closeReading()
      else if (selected) openReading(selected)
    }
    document.addEventListener('keyup', up)
    window.addEventListener('blur', let_go)
    return () => { document.removeEventListener('keyup', up); window.removeEventListener('blur', let_go) }
  }, [spaceHeld]) // eslint-disable-line react-hooks/exhaustive-deps

  const tail = activePath.length ? tree.cards.get(activePath[activePath.length - 1]) : undefined
  const paneIdx = paneCard ? readPath.indexOf(paneCard.key) : -1
  const paneTail = paneCard?.answers.length ? tailOf(paneCard.key) : null
  const paneLast = paneCard?.answers[paneCard.answers.length - 1]
  const questionOf = (k: string): string => { const u = tree.cards.get(k)?.user; return u ? questionText(u) : '' }
  const tailText = tail ? (tail.user ? questionText(tail.user) : tail.answers[0]?.content || '') : ''
  const vp = view.vp
  const items = [...boxes].map(([key, box]) => ({ key, kind: 'card' as const, box }))
  const parentOf = (k: string): string | null => (k === DRAFT ? draft?.parent ?? null : tree.cards.get(k)?.parent ?? null)
  const draftBox = draft ? boxes.get(DRAFT) : undefined
  const draftParent = draft ? tree.cards.get(draft.parent) : undefined
  // 说明只在左上角真空着时露出来:有卡挪进那块就淡掉(上一帧量到的大小,够用)
  const hr = hintsEl.current, hw = 16 + (hr?.offsetWidth ?? 320), hh = 44 + (hr?.offsetHeight ?? 60)
  // 一屏装得下所有卡:缩略图没用,不出
  const stageWH = hostSize(host.current)
  const fitsAll = [...boxes.values()].every((b) => b.x * vp.z + vp.x >= 0 && (b.x + b.w) * vp.z + vp.x <= stageWH.w && b.y * vp.z + vp.y >= 0 && (b.y + b.h) * vp.z + vp.y <= stageWH.h)
  const hintsCovered = [...boxes.values()].some((b) => b.x * vp.z + vp.x < hw && (b.x + b.w) * vp.z + vp.x > 0 && b.y * vp.z + vp.y < hh && (b.y + b.h) * vp.z + vp.y > 0)
  return (
    <div
      className="t2cv" data-switch={switching?.phase} data-dir={dir} data-hand={hand || spaceHeld ? '' : undefined} data-follow={follow ? '' : undefined} data-reading={readCard ? '' : undefined} onKeyDown={onKey}
      style={readW ? { ['--t2cv-read-w' as string]: `min(${readW}px, 70%, calc(100% - 64px))` } : undefined}
    >
      <div className="t2cv-stage" ref={host} tabIndex={-1} aria-label={t('chatcanvas.aria')}>
        <div className="am-app t2cv-am"><div className="amx-stage-grid" style={gridLayerStyle(vp)} /></div>
        {/* 空白处的几句说明:不接事件 */}
        {tree.cards.size > 0 && hintsAuto && (
          <div ref={hintsEl} className="t2cv-hints" data-covered={hintsCovered ? '' : undefined} aria-hidden="true">
            <span>{t('chatcanvas.hint.read')}</span>
            <span>{t('chatcanvas.hint.add')}</span>
            <span>{t('chatcanvas.hint.back')}</span>
            <span>{t('chatcanvas.hint.menu')}</span>
          </div>
        )}
        <ForkScope.Provider value={cardForks}>
        <div className="t2cv-world" style={{ transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.z})` }}>
          <svg className="t2cv-edges" aria-hidden="true">
            {[...boxes.keys()].map((k) => {
              const pk = parentOf(k)
              const a = pk ? boxes.get(pk) : undefined
              const b = boxes.get(k)
              if (!a || !b || !pk) return null
              return <path key={k} className={k === DRAFT ? 'draft' : hot.has(k) ? 'hot' : kidSet.has(tree.cards.get(k)?.sid ?? '') ? 'kid' : undefined} d={edgePath(a, b, dir, aTops.get(pk) ?? 0)} />
            })}
          </svg>
          {[...tree.cards.values()].map((c) => {
            const b = boxes.get(c.key)
            if (!b) return null // 收在别的卡下面
            const dim = focus && !activePath.includes(c.key)
            const streaming = c.answers.some((m) => m.status === 'streaming')
            // 一上来就限高(短卡不受影响):等量出「长」再折,先量到的是展开高,镜头按它落位后卡一缩就落空了
            const clamp = !dim && !streaming && !expanded.has(c.key)
            const folded = clamp && tall.has(c.key)
            const isSel = c.key === selected
            const adds = !hand && !dim && !streaming
            const foldN = folds.has(c.key) ? countUnder(c.key) : 0
            const sibs = c.parent ? kidsOf(c.parent).filter((k) => k !== DRAFT) : []
            const me = sibs.indexOf(c.key)
            const tailSid = c.answers.length ? tailOf(c.key) : null
            // 子会话的卡:不从这里分支 / 换个问法(第一句是简报,分支也不在这棵树里),只在这一支末尾接着问(= 去回复)
            const kid = kidSet.has(c.sid)
            const kidHead = kid && isHead(c)
            const kidSt = kid ? kidStatus(c.sid) : ''
            const kidWait = kid && kidSt === 'wait' && tree.paths[c.sid]?.at(-1) === c.key && !!tailSid
            return (
              <div
                key={c.key}
                ref={track}
                className="t2cv-turn"
                data-cv-node={c.key}
                data-kid={kidHead ? 'head' : kid ? '' : undefined}
                data-anchor={c.key === switching?.key ? '' : undefined}
                data-dim={dim ? '' : undefined}
                data-hot={hot.has(c.key) ? '' : undefined}
                data-reading={c.key === reading ? '' : undefined}
                data-streaming={streaming ? '' : undefined}
                data-measured={heights.has(c.key) ? '' : undefined}
                style={{ left: b.x, top: b.y, width: b.w }}
                onMouseDown={(e) => { if (e.detail > 1 && !(e.target as HTMLElement).closest('input, textarea')) e.preventDefault() }} // 双击 = 打开阅读,别顺手选中一个词(拖选照旧;输入框里照常选词)
                onClick={(e) => {
                  const el = e.target as HTMLElement
                  if (el.closest('button, a[href], input, textarea, summary')) return
                  if (!window.getSelection()?.isCollapsed) return // 在卡里选字,不算点卡
                  pick(c.key, el.closest('[data-cv-part="q"]') ? 'q' : 'a')
                }}
              >
                {c.user && (
                  <div className="t2cv-card t2cv-qcard" data-cv-part="q" data-sel={isSel && selPart === 'q' ? '' : undefined}>
                    {renaming === c.key ? (
                      <input
                        className="t2cv-rename" autoFocus aria-label={t('chatcanvas.rename.aria')} data-testid="cv-rename"
                        defaultValue={sessions.find((x) => x.id === c.sid)?.title || ''}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); commitRename(c.key, e.currentTarget.value) }
                          else if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) }
                        }}
                        onBlur={(e) => commitRename(c.key, e.currentTarget.value)}
                      />
                    ) : kidHead ? (
                      <div className="t2cv-qlabel t2cv-kidlabel" data-testid="cv-kid-label">
                        <span className="t2cv-kidtag"><MessageSquare size={12} /><b>{t('chatcanvas.kid')}</b><span className="t2cv-kidtitle">{sessions.find((x) => x.id === c.sid)?.title || ''}</span>
                          {kidSt && kidSt !== 'done' && <span className="t2cv-kidst" data-st={kidSt}>{t(kidSt === 'run' ? 'childs.st.run' : 'childs.st.wait')}<StatusMark status={kidSt} /></span>}
                          {(kidSt === 'done' || !kidSt) && <span className="t2cv-kidst" data-st="done">{t('childs.st.done')}</span>}
                        </span>
                        <span className="t2cv-kidbrief">{t('chatcanvas.kid.brief')}</span>
                      </div>
                    ) : <div className="t2cv-qlabel">{t('chatcanvas.you')}</div>}
                    <div className="t2cv-q" title={t('chatcanvas.readHint')}>{questionText(c.user)}</div>
                    {adds && !kid && c.parent && me >= 0 && (<>
                      <button type="button" className="t2cv-add" data-add="before" title={t('chatcanvas.add.sibling')} aria-label={t('chatcanvas.add.sibling')} onClick={() => openDraft(c.parent!, me)}>+</button>
                      <button type="button" className="t2cv-add" data-add="after" title={t('chatcanvas.add.sibling')} aria-label={t('chatcanvas.add.sibling')} onClick={() => openDraft(c.parent!, me + 1)}>+</button>
                    </>)}
                  </div>
                )}
                {c.user && c.answers.length > 0 && <div className="t2cv-link" aria-hidden="true" />}
                {c.answers.length > 0 && (
                  <div className="t2cv-card t2cv-acard" data-cv-part="a" data-sel={isSel && selPart === 'a' ? '' : undefined}>
                    <div className="t2cv-body" data-clamp={clamp ? '' : undefined} data-folded={folded ? '' : undefined}>
                      <div className="t2cv-inner" ref={track} data-cv-inner={c.key}>
                        {c.answers.map((m) => (
                          <EditorialMessage key={m.id} msg={m} fileCtx={ctxFor(c.sid)} handlers={handlersFor(c.sid, m.id)} showWaitDetails={showWaitDetails} />
                        ))}
                      </div>
                    </div>
                    {folded && (
                      <button type="button" className="t2cv-readbtn" data-testid="cv-readbtn" onClick={() => openReading(c.key)}><BookOpen size={13} />{t('chatcanvas.read')}</button>
                    )}
                    {/* 顺便问 / 子会话:对话页那块「从这里分出」,挨着卡底(在正文外面,折起不裁它) */}
                    {c.answers.map((m) => <ForkBlock key={m.id} sessionId={c.sid} messageId={m.id} childIds={childIdsOf(m.toolEvents)} />)}
                    {kidWait && (
                      <div className="t2-taskcard-actions t2cv-kidacts">
                        <button type="button" className="primary" onClick={() => followUp(c.key, tailSid!)}><CornerDownRight size={12} /> {t('childs.reply')}</button>
                        <button type="button" onClick={() => {
                          const k = kids.find((x) => x.id === c.sid)
                          if (k?.parent_session_id) void useApp.getState().send(t('childs.letAnswerMsg', { title: k.title || '' }), [], undefined, undefined, undefined, k.parent_session_id)
                        }}><Sparkles size={12} /> {t('childs.letAnswer')}</button>
                      </div>
                    )}
                    {adds && !foldN && (!kid || tailSid) && (
                      <button
                        type="button" className="t2cv-add" data-add="next"
                        title={t(tailSid ? 'chatcanvas.add.follow' : 'chatcanvas.add.next')} aria-label={t(tailSid ? 'chatcanvas.add.follow' : 'chatcanvas.add.next')}
                        onClick={() => { if (tailSid) followUp(c.key, tailSid); else openDraft(c.key, kidsOf(c.key).filter((k) => k !== DRAFT).length) }}
                      >+</button>
                    )}
                  </div>
                )}
                {foldN > 0 && (
                  <button type="button" className="t2cv-foldpill" data-testid="cv-foldpill" title={t('chatcanvas.menu.unfold', { n: foldN })} aria-label={t('chatcanvas.menu.unfold', { n: foldN })} onClick={() => setFold(c.key, false)}>+{foldN}</button>
                )}
              </div>
            )
          })}
          {draft && draftBox && draftParent && (
            <div ref={track} className="t2cv-turn" data-cv-node={DRAFT} data-measured={heights.has(DRAFT) ? '' : undefined} style={{ left: draftBox.x, top: draftBox.y, width: draftBox.w }}>
              <div className="t2cv-card t2cv-qcard t2cv-draft" data-cv-part="q">
                <div className="t2cv-qlabel">{t('chatcanvas.draft.from', { q: answerLead(draftParent) })}</div>
                <textarea
                  ref={draftTa} className="t2cv-draft-ta" rows={2} value={draft.text} placeholder={t('chatcanvas.draft.ph')} readOnly={sending} // 发送中只读、不 disabled:没发成时焦点还在这里,直接再按 Enter
                  data-testid="cv-draft"
                  onChange={(e) => setPref({ draft: { ...draft, text: e.target.value } })}
                  onKeyDown={(e) => {
                    // 输入法选字时的回车不算发送
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendDraft() }
                    else if (e.key === 'Escape') { e.preventDefault(); discardDraft() }
                  }}
                  onBlur={(e) => { if (!e.currentTarget.value.trim() && !sending) discardDraft() }}
                />
                <div className="t2cv-draft-foot">
                  <span>{t('chatcanvas.draft.hint')}</span>
                  <button type="button" className="t2-iconbtn" title={t('chatcanvas.draft.discard')} aria-label={t('chatcanvas.draft.discard')} onMouseDown={(e) => e.preventDefault()} onClick={discardDraft}><X size={14} /></button>
                  <button type="button" className="t2cv-send" title={t('chatcanvas.draft.send')} aria-label={t('chatcanvas.draft.send')} disabled={!draft.text.trim() || sending} onMouseDown={(e) => e.preventDefault()} onClick={() => void sendDraft()}><ArrowUp size={14} /></button>
                </div>
              </div>
            </div>
          )}
        </div>
        </ForkScope.Provider>
        <div className="am-app t2cv-am">
          {/* 胶囊 = Amadeus 画布同一个:− % + ⤢,再加「视图 ▾」(= 空白处右键那份菜单)和「?」(那几行说明) */}
          <CanvasChrome
            zoom={vp.z}
            onZoomBy={zoomStep}
            onFit={fitAll}
            extra={<>
              <button
                ref={viewBtn} type="button" className="t2cv-hud-view" aria-haspopup="menu" data-testid="cv-view" title={t('chatcanvas.view')}
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenuFocus(true); setMenu({ x: r.left, y: r.bottom + 6, anchorTop: r.top - 6, items: menuFor(null, 'a') }) }}
              ><span>{t('chatcanvas.view')}</span><ChevronDown size={11} /></button>
              <button
                type="button" className={helpAt ? 'is-on' : ''} aria-pressed={!!helpAt} aria-label={t('chatcanvas.help')} title={t('chatcanvas.help')} data-testid="cv-help"
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHelpAt(helpAt ? null : { x: r.right, y: r.bottom + 6, top: r.top - 6 }) }}
              ><CircleHelp size={12} /></button>
            </>}
          />
          {mini && !readCard && !fitsAll && <CanvasMiniMap hostRef={host} vp={vp} items={items} onCenter={view.centerOn} />}
        </div>
      </div>
      {/* 阅读栏:舞台外面(手势层不吞它的滚动和点击),对话页那套排版。顶上这一支的每一轮,底下一排操作(同卡边 ⊕ 的规则);关掉时还留 READ_CLOSE_MS 往右淡出 */}
      {paneCard && (
        <aside
          ref={readCard ? readRef : undefined} tabIndex={-1} className="t2cv-read" aria-label={t('chatcanvas.read.aria')} data-testid="cv-read" data-cv-read={paneCard.key}
          data-out={readCard ? undefined : ''}
        >
          <div className="t2cv-read-grip" role="separator" aria-orientation="vertical" aria-label={t('chatcanvas.read.resize')} title={t('chatcanvas.read.resize')} onPointerDown={onGrip} />
          <div className="t2cv-read-h">
            <div className="t2cv-read-t">
              <b title={paneCard.user ? questionText(paneCard.user) : undefined}>{paneCard.user ? questionText(paneCard.user) : t('chatcanvas.read')}</b>
              {paneIdx >= 0 && (
                <div className="t2cv-read-steps" role="group" aria-label={t('chatcanvas.read.turns')}>
                  {readSteps(readPath.length, paneIdx).map((i, j) => (i < 0
                    ? <span key={`gap${j}`} className="t2cv-read-gap" aria-hidden="true">…</span>
                    : (
                      <button
                        key={readPath[i]} type="button" aria-current={i === paneIdx ? 'true' : undefined} aria-label={t('chatcanvas.read.turnN', { n: i + 1 })}
                        title={questionOf(readPath[i])} onClick={() => pick(readPath[i])}
                      >{i + 1}</button>
                    )))}
                  <span className="t2cv-read-pos">{t('chatcanvas.read.pos', { n: paneIdx + 1, m: readPath.length })}</span>
                </div>
              )}
            </div>
            <button type="button" className="t2-iconbtn" title={t('chatcanvas.read.prev')} aria-label={t('chatcanvas.read.prev')} disabled={paneIdx <= 0} onClick={() => stepRead(-1)}><ChevronUp size={15} /></button>
            <button type="button" className="t2-iconbtn" title={t('chatcanvas.read.next')} aria-label={t('chatcanvas.read.next')} disabled={paneIdx < 0 || paneIdx >= readPath.length - 1} onClick={() => stepRead(1)}><ChevronDown size={15} /></button>
            <button type="button" className="t2-iconbtn" title={t('chatcanvas.read.close')} aria-label={t('chatcanvas.read.close')} data-testid="cv-read-close" onClick={closeReading}><X size={15} /></button>
          </div>
          {/* 换一轮 = 换一块正文(从头读、按方向滑进来) */}
          <div key={paneCard.key} className="t2cv-read-b" data-dir={readDir || undefined}>
            <ForkScope.Provider value={readForks}>
              {paneCard.answers.map((m) => (
                <EditorialMessage key={m.id} msg={m} fileCtx={ctxFor(paneCard.sid)} handlers={handlersFor(paneCard.sid, m.id)} showWaitDetails={showWaitDetails} />
              ))}
            </ForkScope.Provider>
          </div>
          <div className="t2cv-read-acts">
            {paneTail
              ? <button type="button" className="t2-iconbtn t2-textbtn" data-testid="cv-read-follow" onClick={() => followUp(paneCard.key, paneTail)}><CornerDownRight size={14} />{t('chatcanvas.add.follow')}</button>
              : (
                <button type="button" className="t2-iconbtn t2-textbtn" data-testid="cv-read-branch" disabled={!paneCard.answers.length || kidSet.has(paneCard.sid)} onClick={() => openDraft(paneCard.key, kidsOf(paneCard.key).filter((k) => k !== DRAFT).length)}>
                  <GitBranch size={14} />{t('chatcanvas.add.next')}
                </button>
              )}
            <button type="button" className="t2-iconbtn t2-textbtn" data-testid="cv-read-aside" disabled={!paneLast} onClick={() => { if (paneLast) handlersFor(paneCard.sid, paneLast.id).onAside?.() }}>
              <MessageCircleQuestion size={14} />{t('chatcanvas.menu.aside')}
            </button>
            <button type="button" className="t2-iconbtn t2-textbtn" data-testid="cv-read-copy" disabled={!paneCard.answers.length} onClick={() => copy(paneCard.answers.map((m) => m.content).join('\n\n'))}>
              <Copy size={14} />{t('chatcanvas.menu.copyAnswer')}
            </button>
            <span className="t2cv-read-grow" />
            <button type="button" className="t2-iconbtn" title={t('chatcanvas.read.inChat')} aria-label={t('chatcanvas.read.inChat')} data-testid="cv-read-chat" onClick={() => openInChat(paneCard.key)}>
              <MessageSquare size={15} />
            </button>
          </div>
        </aside>
      )}
      {/* 舞台外面:手势层在舞台上拿指针捕获(空白拖 = 平移),放在里面这颗箭头就点不动 */}
      {arrow && (
        <button type="button" className="jump-bottom t2-jump t2cv-jump" data-dir={arrow} title={t('chatcanvas.follow')} aria-label={t('chatcanvas.follow')} onClick={toLatest}>
          {arrow === 'up' ? <ArrowUp size={16} /> : arrow === 'left' ? <ArrowLeft size={16} /> : arrow === 'right' ? <ArrowRight size={16} /> : <ArrowDown size={16} />}
        </button>
      )}
      {!tree.cards.size && !loading && <div className="t2cv-empty">{t('chatcanvas.empty')}</div>}
      {menu && <ContextMenu menu={menu} autoFocus={menuFocus} onClose={closeMenu} />}
      {helpAt && (
        <HelpPop at={helpAt} onClose={() => setHelpAt(null)}>
          <span>{t('chatcanvas.hint.read')}</span>
          <span>{t('chatcanvas.hint.add')}</span>
          <span>{t('chatcanvas.hint.back')}</span>
          <span>{t('chatcanvas.hint.menu')}</span>
        </HelpPop>
      )}
      {tailText && (
        <div className="t2cv-attach-row"><div className="t2cv-attach" data-flash={flash ? '' : undefined}><CornerDownRight size={12} /><span>{t('chatcanvas.attach')}</span><b>{tailText}</b></div></div>
      )}
    </div>
  )
}

/** 胶囊上「?」点开的那几行说明:按钮右对齐、下面放不下就翻到上面;点外面 / Esc 收。 */
function HelpPop({ at, onClose, children }: { at: { x: number; y: number; top: number }; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const out = (e: PointerEvent): void => { if (!box.current?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-testid="cv-help"]')) onClose() }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', out, true)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('pointerdown', out, true); window.removeEventListener('keydown', esc) }
  }, [onClose])
  return createPortal(
    <OverlayAt x={at.x - 280} y={at.y} anchorTop={at.top} innerRef={(el) => { box.current = el }} className="t2cv-helppop" role="note" data-testid="cv-helppop">{children}</OverlayAt>,
    document.body,
  )
}
