/** Human Desk:你动手、Agent 跟着看(2026-11-23 用户定第三轮,方案页仓根 docs/ToBeImproved/HumanTask实时协作方案_2026-11-20/r3.html)。
 *  和 Agent Desk 各自独立:摘要栏卡片栈里一张卡(排在 Agent Desk 卡上面),右边那块一次只展开一块,展开的那块最左上是
 *  「你 / Agent」切换件。Human Desk 只放一样东西;放上来就「在看」:这条会话的输入框自动挂一枚引用芯片(走今天的引用,
 *  发出去的 token 和 [[ 选择器同一份)。状态在 appStore.humanDeskBySession(纯决策 stores/humanDeskPlan.ts)。
 *  第 1 步后半(11-24,叠在 #852 上):拿到主区(⋯ 四项 / 名字胶囊拖出去 = 拿走)、在外面时那张卡(摘要栏 / 右栏对话顶上)、
 *  放回来(标签右键「放到 Human Desk」/ 把标签拖到 Human Desk 上)。这一步仍不做:引擎里的现场(<human_activity>)、
 *  停笔说一句、白板可画。 */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Copy, Eye, FilePlus, FolderOpen, MapPin, Maximize2, Minimize2, Pause, Play, Plus, Sparkles, SquareArrowOutUpRight, X } from 'lucide-react'
import { ViewModeSwitch } from '@lcl/components'
import { onLeafClose, registerTabDropZone, registerTabMenuItems, useWorkspace, type ViewRef } from '@lcl/engine'
import { useApp, type DeskItem } from '../../stores/appStore'
import { deskItemFor } from '../../stores/deskPlan'
import { deskSection, deskSideOf, humanMenuRows, humanWatching, type HumanDeskState } from '../../stores/humanDeskPlan'
import { registerMessages, translate, useI18n } from '../../i18n'
import { usePageStore, birthNoteFile, onNotePathGone } from '@amadeus/store/pageStore'
import { ensureAmadeusReady } from '../../amadeusPlugins'
import type { CtxItem } from '../../components/RightPanel'
import { DeskChromeContext, DeskMenuButton, DeskMoreButton, DeskPickButton, type DeskChrome, type DeskPickRow } from './deskChrome'
import { DeskFilePane, DeskViewPane, openDeskItemInMain, useDeskPathDrop, vaultRelOf } from './AgentDesk'
import { DeskItemIcon, canDragDeskItem, deskDragTip, deskOpenItems, deskViewRef, startDeskItemDrag } from './deskOpen'
import { fileViewRef } from '../../amadeusNav'
import { CardAction, DeskSqueezeContext, SummaryCard } from './TaskSummary'
import { bumpOpen, openOf, setUserOpen, touchDesk, useSummaryOpen } from './summaryOpen'
import { fileChip, refChipOf, viewChip, type RefChip } from './Composer2'
import '../../tangu/messages'

registerMessages({
  // 名字不翻译:中英文界面都叫 Human Desk(和 Agent Desk 一样,r3 §5)
  'humanDesk.title': { zh: 'Human Desk', en: 'Human Desk' },
  'humanDesk.segYou': { zh: '你', en: 'You' },
  'humanDesk.segAgent': { zh: 'Agent', en: 'Agent' },
  'humanDesk.segTip': { zh: '切到另一块 Desk', en: 'Switch desk' },
  'humanDesk.newOnAgent': { zh: 'Agent Desk 上有新东西', en: 'New on Agent Desk' },
  'humanDesk.watching': { zh: '在看', en: 'Watching' },
  'humanDesk.stop': { zh: '停止', en: 'Stop' },
  'humanDesk.resume': { zh: '继续看', en: 'Watch again' },
  'humanDesk.empty': { zh: '把你正在做的东西放到这里，Agent 会跟着看', en: 'Put what you’re working on here and the agent will follow along' },
  'humanDesk.add': { zh: '放到 Human Desk', en: 'Add to Human Desk' },
  'humanDesk.newNote': { zh: '新建笔记', en: 'New note' },
  'humanDesk.pickFile': { zh: '选一个文件', en: 'Choose a file' },
  'humanDesk.remove': { zh: '从 Human Desk 拿掉', en: 'Remove from Human Desk' },
  'humanDesk.where': { zh: '你在第 {n} 节 · {title}', en: 'You’re in section {n} · {title}' },
  'humanDesk.live': { zh: '{name} · 第 {n} 节', en: '{name} · Section {n}' },
  'humanDesk.noVault': { zh: '先在 Amadeus 里打开一个智库，才能新建笔记', en: 'Open a vault in Amadeus first to create a note' },
  // 拿到主区之后(r3 ⑦ / r2-details §4):卡头「名字 · 在主区」,点卡 = 转到那个标签
  'humanDesk.inMain': { zh: '在主区', en: 'In a tab' },
  'humanDesk.goTab': { zh: '转到标签页', en: 'Go to tab' },
  'humanDesk.outHere': { zh: '{name} 在主区的标签页里', en: '{name} is open in a tab' },
})

/** 「你」= 对话里用户头像缩到 16px(有头像用头像,没有就是名字的第一个字,同 EditorialMessage)。 */
export function YouMark({ className }: { className?: string }): React.ReactElement {
  const { t } = useI18n()
  const avatar = useApp((s) => s.authInfo?.avatar)
  const name = useApp((s) => s.authInfo?.nickname || s.authInfo?.username)
  const first = Array.from((name || t('chat.you')).trim())[0]?.toUpperCase() || '?'
  return <span className={`hd-you${className ? ' ' + className : ''}`} aria-hidden="true">{avatar ? <img src={avatar} alt="" /> : first}</span>
}

const isNote = (it: DeskItem | undefined): boolean => !!it && !it.view && /\.md$/i.test(it.path)


const put = (sessionId: string, item: DeskItem): void => {
  touchDesk(sessionId, 'humandesk')
  bumpOpen(sessionId, 'humandesk')
  useApp.getState().humanDeskAct(sessionId, { type: 'put', item })
}

/** ＋ 里的「新建笔记」:库根下按当前语言的缺省名建一篇空笔记(重名接 -2…),只新建不覆盖(birthNoteFile),放上 Human Desk。 */
async function newHumanNote(sessionId: string): Promise<void> {
  ensureAmadeusReady()
  const root = usePageStore.getState().vaultRoot
  if (!root) { useApp.getState().toast(translate('humanDesk.noVault'), true); return }
  const base = translate('amadeus.default.note').replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim() || 'Note'
  for (let n = 1; n <= 20; n++) {
    const rel = n === 1 ? `${base}.md` : `${base}-${n}.md`
    const r = await birthNoteFile(rel, { ask: true })
    if (r === 'exists') continue
    if (r === 'failed') return
    await usePageStore.getState().refreshStructure?.()
    put(sessionId, deskItemFor(`${root.replace(/[\\/]+$/, '')}/${rel}`, Date.now()))
    return
  }
}

/** ＋ 里的「选一个文件」:系统选择框选一个本机文件放上来。 */
/** 选一个文件:桌面走系统选择框(pickPaths,同 Chat Box 的「添加文件」);只取第一个文件,文件夹不收。网页 / 手机没有本机路径 → 不给这一项。 */
async function pickHumanFile(sessionId: string): Promise<void> {
  const picked = await window.tangu?.pickPaths?.()
  const f = picked?.find((x) => !x.isDirectory)
  if (f?.path) put(sessionId, deskItemFor(f.path, Date.now()))
}

function addItems(sessionId: string, t: (k: string) => string): CtxItem[] {
  return [
    { label: t('humanDesk.newNote'), icon: <FilePlus size={14} />, run: () => void newHumanNote(sessionId) },
    // 「新建白板」这一步不放:Desk 上的白板是只读预览(走查续七 7.7 A),Human Desk 上可画要用户点头
    ...(window.tangu?.pickPaths ? [{ label: t('humanDesk.pickFile'), icon: <FolderOpen size={14} />, run: () => void pickHumanFile(sessionId) }] : []),
  ]
}

/** ＋:新建笔记 / 选一个文件(卡头、空态共用)。包一层吃掉 click:放在 <summary> 里时不顺带开合卡片。 */
function HumanAddButton({ sessionId, className }: { sessionId: string; className?: string }): React.ReactElement {
  const { t } = useI18n()
  return (
    <span className="human-desk-addwrap" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
      <DeskMenuButton items={() => addItems(sessionId, t)} title={t('humanDesk.add')} className={className ?? 'icon-btn'}>
        <Plus size={className?.includes('human-desk-plus') ? 16 : 13} />
      </DeskMenuButton>
    </span>
  )
}

/** ▾ 里「最近放过的」(正放着的那样灰着排第一)。 */
function useHumanPickRows(sessionId: string): () => DeskPickRow[] {
  const { t } = useI18n()
  return () => {
    const h = useApp.getState().humanDeskBySession[sessionId]
    if (!h) return []
    const rows = humanMenuRows(h)
    return [
      { head: t('desk.recent') },
      ...rows.map((r) => ({ label: r.item.name || r.item.path, disabled: r.current, run: () => put(sessionId, { ...r.item, at: Date.now() }) })),
    ]
  }
}

// ── 库里改名 / 挪走 / 删掉:Human Desk 上放着的跟过去 ──
// 在 store 层跟(同 followPathGone 之于工作区标签):卡和展开态没挂着时也收得到。不跟的话,笔记改了名(新建的「未命名」改标题
// 就会改文件名)之后 Desk 里的编辑器攥着已退休的旧路径,再打的字不落盘。广播的是库相对路径,条目存的是绝对路径。
let pathFollowInstalled = false
function installHumanDeskPathFollow(): void {
  if (pathFollowInstalled) return
  pathFollowInstalled = true
  onNotePathGone((from, kind, to) => {
    const root = usePageStore.getState().vaultRoot
    if (!root) return
    const abs = (rel: string): string => `${root.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`
    const app = useApp.getState()
    for (const sid of Object.keys(app.humanDeskBySession)) {
      app.humanDeskAct(sid, { type: 'retarget', from: abs(from), to: to ? abs(to) : null, prefix: kind === 'prefix' })
    }
  })
}
installHumanDeskPathFollow()

// ── 拿到主区 / 放回来(第 1 步后半,11-24) ──
// Human Desk 是「你正在做的那一样」,只能在一处:⋯ 里的四项、名字胶囊拖出去都是拿走 —— 东西变成主区的标签页,卡留着、指向它。
// 共用件 deskOpen.tsx 只管「开出去」(Agent Desk 那格留着),拿走由这边在开出来之后做(takeHumanOut)。

/** 东西已经在主区开出来了 → 记成「在主区」;这扇窗的展开收回。 */
export const takeHumanOut = (sessionId: string): void => useApp.getState().humanDeskAct(sessionId, { type: 'takeOut' })

// Windows 盘符路径大小写不敏感(C:\Vault\A.md 与 c:\vault\a.md 是同一份):比对前整串转小写(Codex 评审)
const normAbs = (p: string): string => { const s = p.replace(/\\/g, '/').replace(/\/+$/, ''); return /^[a-zA-Z]:\//.test(s) ? s.toLowerCase() : s }
const isAbs = (p: string): boolean => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p)
/** 主区标签装着的那份文件的绝对路径:笔记是库相对路径(接上库根),工作区文件 / PDF 是绝对路径。 */
function tabAbs(filePath: string | undefined, root: string | null): string | null {
  if (!filePath || /^[a-z][a-z0-9+.-]+:\/\//i.test(filePath)) return null
  if (isAbs(filePath)) return normAbs(filePath)
  return root ? normAbs(`${root.replace(/[\\/]+$/, '')}/${filePath}`) : null
}
const itemAbs = (it: DeskItem): string | null => (it.path && isAbs(it.path) ? normAbs(it.path) : null)

/** 这扇窗当前 Space 的主区里装着这样东西的标签(按文件认)。 */
function humanTabsOf(it: DeskItem): Array<{ id: string; front: boolean }> {
  const want = itemAbs(it)
  if (!want) return []
  const root = usePageStore.getState().vaultRoot
  return useWorkspace.getState().mainTabs.filter((t) => tabAbs(t.filePath, root) === want)
}

/** 点「在主区」的卡:转到装着它的那个标签;这扇窗里没有(关了、在另一扇窗、在别的 Space)→ 在这里打开。 */
export function goToHumanTab(sessionId: string): void {
  const it = useApp.getState().humanDeskBySession[sessionId]?.item
  if (!it) return
  const tab = humanTabsOf(it)[0]
  if (tab) useWorkspace.getState().activateLeaf(tab.id)
  else openDeskItemInMain(it, usePageStore.getState().vaultRoot)
}

/** 展开的那块上点「放到 Human Desk」(东西在主区时):放回来,这扇窗里装着它的标签关掉(先放后关,理由同 putFromTab)。 */
function putBackHere(sessionId: string): void {
  const it = useApp.getState().humanDeskBySession[sessionId]?.item
  if (!it) return
  const tabs = humanTabsOf(it)
  put(sessionId, it)
  for (const tab of tabs) useWorkspace.getState().closeLeaf(tab.id)
  stillOpen(sessionId, tabs.map((x) => x.id))
}

/** 关不掉的(固定 View 的最后一个,closeLeaf 拒关)→ 东西仍记成在主区,别让它两处都开着(Codex 评审)。 */
function stillOpen(sessionId: string, leafIds: string[]): void {
  const api = useWorkspace.getState().api
  if (leafIds.some((id) => api?.getPanel(id))) takeHumanOut(sessionId)
}

/** 标签 → Human Desk 上的一样东西:只收有文件的标签(笔记、工作区文件、PDF、图片……);对话、启动器、网页这些不是「你在做的那一样」。 */
function tabItem(view: ViewRef): DeskItem | null {
  const params = (view.params ?? {}) as Record<string, unknown>
  for (const k of ['notePath', 'drawingPath', 'dbPath', 'pdfPath', 'imagePath', 'dashPath', 'filePath', 'path'] as const) {
    const v = params[k]
    if (typeof v !== 'string' || !v) continue
    const abs = tabAbs(v, usePageStore.getState().vaultRoot)
    return abs ? deskItemFor(abs, Date.now()) : null
  }
  return null
}

/** 能往哪条会话的 Human Desk 上放(标签右键用):当前那条会话,且 Human Desk 对它开着(同 Agent Desk 的门:开关开着、有过消息)。 */
function putTargetSession(): string | null {
  const app = useApp.getState()
  const sid = app.activeId
  if (!sid || !app.desktopConfig?.agentDeskEnabled || !(app.messagesBySession[sid]?.length)) return null
  return sid
}

/** 放回来 / 放上来(标签右键、把标签拖到 Human Desk 上):先放(在主区的那样 = 放回来,清掉「在主区」),再关掉那个标签 —— 顺序别反:
 *  先关的话标签监视会把它当成「你关掉了」、从 Human Desk 拿掉。 */
function putFromTab(sessionId: string, item: DeskItem, leafId: string): void {
  put(sessionId, item)
  useWorkspace.getState().closeLeaf(leafId)
  stillOpen(sessionId, [leafId])
}

/** 这扇窗当前 Space 的主区里有没有这条会话的对话(Human Desk 长在主区对话上;别的 Space 的右栏对话没有 Desk)。 */
function deskReachable(sessionId: string): boolean {
  const api = useWorkspace.getState().api
  if (!api) return false
  const active = useApp.getState().activeId
  return api.panels.some((p) => {
    const q = (p.params ?? {}) as Record<string, unknown>
    return q.__type === 'chat' && q.__loc === 'main' && (q.followActive !== false ? active === sessionId : q.sessionId === sessionId)
  })
}

// 标签右键第一项「放到 Human Desk」(方案 r2-out-put:主区标签右键第一项;放回去以后主区那个标签关掉)。
// 这扇窗里没有这条会话的 Desk(Amadeus 等别的 Space,对话在右栏)时,关掉标签东西就没处看了:改成就地认领 ——
// 放上 Human Desk、记成「在主区」、标签留着(r3 ⑦:右栏对话顶上一张「你 定价调研.md · 在主区」)。
registerTabMenuItems((tab) => {
  const sid = putTargetSession()
  const item = sid ? tabItem({ type: tab.type, params: tab.params }) : null
  if (!sid || !item) return []
  return [{ id: 'human-desk-put', label: translate('humanDesk.add'), icon: <Eye size={13} />,
    run: () => { if (deskReachable(sid)) putFromTab(sid, item, tab.id); else { put(sid, item); takeHumanOut(sid) } } }]
})

/** 卡 / 展开的那块接标签:把主区标签拖上来 = 放到 Human Desk(落点提示用 Desk 现成的淡染 data-drop,同拖文件进来)。 */
function useHumanTabDrop(ref: React.RefObject<HTMLElement | null>, sessionId: string, mounted = true): void {
  useEffect(() => {
    const el = ref.current
    if (!el || !mounted) return
    return registerTabDropZone(el, {
      accepts: (view) => !!tabItem(view),
      hover: (on) => el.toggleAttribute('data-drop', on),
      drop: (view, leafId) => { const it = tabItem(view); if (it) putFromTab(sessionId, it, leafId) },
    })
  }, [ref, sessionId, mounted])
}

// 拿到主区之后:那个标签看不看得见、你在第几节、你关没关掉它。每扇窗一份,模块级(卡、右栏都可能不在屏上)。只认这扇窗当前 Space 的主区:
//  · 看得见(是所在组的前台标签)= 在场 → tabHere;看不见满时长 → 暂停(计时在 tanguSlice,同离开 Human Desk);
//  · 你关掉了它(LCL onLeafClose:只有真的关才发,切 Space、移到新窗口、标签里换了文件都不发),也没有别的标签装着它 = 做完了
//    → 从 Human Desk 拿掉(进「最近放过的」,▾ 还能拿回来);
//  · 笔记:在那个标签的内容(LCL .wb-view[data-leaf-id])里算第几节,同展开态。
const OUT_SECTION_LINE = 24
let outWatchInstalled = false
function installHumanOutWatch(): void {
  if (outWatchInstalled) return
  outWatchInstalled = true
  onLeafClose((leaf) => {
    const closed = tabItem({ type: leaf.type, params: leaf.params })
    if (!closed) return
    const app = useApp.getState()
    for (const [sid, h] of Object.entries(app.humanDeskBySession)) {
      if (!h?.out || !h.item || itemAbs(h.item) !== itemAbs(closed)) continue
      if (humanTabsOf(h.item).some((t) => t.id !== leaf.id)) continue // 还有别的标签装着它
      app.humanDeskAct(sid, { type: 'remove' })
    }
  })
  let tracking: { sid: string; leaf: string; key: string; el: Element; stop: () => void } | null = null
  let retry = 0
  const run = (): void => {
    const app = useApp.getState()
    let want: { sid: string; leaf: string; key: string; keep: boolean } | null = null
    for (const [sid, h] of Object.entries(app.humanDeskBySession)) {
      if (!h?.out || !h.item) continue
      const front = humanTabsOf(h.item).find((t) => t.front)
      if (!!h.tabHere !== !!front) app.humanDeskAct(sid, { type: 'tabHere', here: !!front })
      if (front && isNote(h.item) && !want) want = { sid, leaf: front.id, key: h.item.key, keep: !!h.section }
    }
    const el = want ? document.querySelector(`.wb-view[data-leaf-id="${CSS.escape(want.leaf)}"]`) : null
    if (tracking && (!want || tracking.sid !== want.sid || tracking.leaf !== want.leaf || tracking.key !== want.key || tracking.el !== el || !el?.isConnected)) {
      tracking.stop(); tracking = null
    }
    if (want && el && !tracking) tracking = { ...want, el, stop: trackSections(el as HTMLElement, want.sid, OUT_SECTION_LINE, want.keep) }
    // 标签刚开出来、内容还没挂上:过一会儿再找一次(有上限)
    if (want && !el && retry < 20) { retry++; setTimeout(schedule, 150) } else if (!want || el) retry = 0
  }
  let pending = false
  const schedule = (): void => { if (!pending) { pending = true; queueMicrotask(() => { pending = false; run() }) } }
  useWorkspace.subscribe(schedule)
  useApp.subscribe((s, prev) => { if (s.humanDeskBySession !== prev.humanDeskBySession) schedule() })
  usePageStore.subscribe((s, prev) => { if (s.vaultRoot !== prev.vaultRoot) schedule() })
}
installHumanOutWatch()

// ── 切换件「你 / Agent」(两块展开态最左上;LCL 看法胶囊装在 Desk 的浮动胶囊皮里) ──

const SegState = createContext<{ eye: boolean; dot: boolean; dotTitle: string }>({ eye: false, dot: false, dotTitle: '' })
/** 「你」那段:宽档只在你切走了、Human Desk 还在看时带小眼睛(排在字后面);紧凑档换成「你」头像。 */
function YouSegIcon({ className }: { size?: number; className?: string }): React.ReactElement {
  const c = useContext(SegState)
  return <span className={`${className ?? ''} desk-seg-ic desk-seg-you`}><YouMark />{c.eye && <Eye size={11} className="desk-seg-eye" />}</span>
}
/** 「Agent」那段:带 Agent Desk 卡头同一个 ✦;Human Desk 展开着时 Agent 放了新东西 → 右上一个点。 */
function AgentSegIcon({ className }: { size?: number; className?: string }): React.ReactElement {
  const c = useContext(SegState)
  return <span className={`${className ?? ''} desk-seg-ic desk-seg-agent`}><Sparkles size={12} className="desk-seg-spark" />{c.dot && <span className="desk-switch-dot" title={c.dotTitle} />}</span>
}

/** 胶囊条比这窄就只留图标(切换件收成紧凑态),保证 ⋯ 和收起始终看得到。 */
export const DESK_SWITCH_COMPACT_W = 420

export function DeskSwitch({ sessionId }: { sessionId: string }): React.ReactElement {
  const { t } = useI18n()
  const side = useApp((s) => deskSideOf(s.deskBySession[sessionId]?.mode, s.humanDeskBySession[sessionId]?.open))
  const watching = useApp((s) => humanWatching(s.humanDeskBySession[sessionId]))
  const dot = useApp((s) => !!s.humanDeskBySession[sessionId]?.agentDot)
  const ref = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    const bar = ref.current?.closest<HTMLElement>('.desk-caps')
    if (!bar || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setCompact(e.contentRect.width < DESK_SWITCH_COMPACT_W))
    ro.observe(bar)
    return () => ro.disconnect()
  }, [])
  const you = t('humanDesk.segYou')
  const agent = t('humanDesk.segAgent')
  const spec = useMemo(() => ({
    modes: [{ value: 'human', label: you, icon: YouSegIcon }, { value: 'agent', label: agent, icon: AgentSegIcon }],
    value: side === 'agent' ? 'agent' : 'human',
    onChange: (v: string) => {
      touchDesk(sessionId, v === 'agent' ? 'desk' : 'humandesk')
      useApp.getState().setDeskSide(sessionId, v === 'agent' ? 'agent' : 'human')
    },
    ariaLabel: t('humanDesk.segTip'),
  }), [you, agent, side, sessionId, t])
  const seg = useMemo(() => ({ eye: watching && side !== 'human', dot: dot && side === 'human', dotTitle: t('humanDesk.newOnAgent') }), [watching, side, dot, t])
  return (
    <SegState.Provider value={seg}>
      <div ref={ref} className="desk-cap desk-switch" data-dot={seg.dot || undefined} data-eye={seg.eye || undefined}>
        <ViewModeSwitch spec={spec} compact={compact} />
      </div>
    </SegState.Provider>
  )
}

// ── 你在第几节(笔记) ──

/** 展开态「滚到哪」那条线:整块顶往下这么多(胶囊带 46 + 一点余量)。滚回上次那一节时标题也停在这条线上方一点。 */
const SECTION_LINE = 58
const HEADING_SEL = '.page-view h1, .page-view h2, .page-view h3' // 同 NoteFloatingToc
const headingsIn = (root: HTMLElement): HTMLElement[] => {
  const own = Array.from(root.querySelectorAll<HTMLElement>(HEADING_SEL))
  const list = own.length ? own : Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3'))
  return list.filter((h) => !h.closest('[aria-hidden="true"], .desk-caps'))
}

/** 展开态:光标在这篇笔记里就按光标,否则按滚动位置(胶囊带下面那条线以上最后一个标题)算「第几节」,记进 store(内存)。 */
function useSectionTracker(paneRef: React.RefObject<HTMLDivElement | null>, sessionId: string, on: boolean, itemKey: string | undefined, keep = false): void {
  useEffect(() => {
    const pane = paneRef.current
    if (!pane || !on) return
    return trackSections(pane, sessionId, SECTION_LINE, keep)
  }, [paneRef, sessionId, on, itemKey]) // eslint-disable-line react-hooks/exhaustive-deps -- keep 只在挂上那一下有意义
}

/** 在一块内容里算「第几节」(展开态的 Human Desk、拿到主区后那个标签的内容共用)。line = 「滚到哪」那条线离这块顶的距离。
 *  返回撤销。 */
function trackSections(pane: HTMLElement, sessionId: string, line: number, keep: boolean): () => void {
  {
    let raf = 0
    // 光标在这块里 → 按光标;你滚了 → 按滚到哪;光标去了别处(比如去输入框打字)→ 留着上一次,不按滚动位置重算
    let why: 'scroll' | 'auto' = 'auto'
    let known = keep // 回到同一样东西(切走又切回 / 收起又展开):先留着上次那一节,等你点进去或滚动再算
    const caretIn = (): Node | null => {
      const sel = pane.ownerDocument.getSelection()
      const node = sel && sel.rangeCount ? sel.anchorNode : null
      return node && pane.contains(node) ? node : null
    }
    const compute = (): void => {
      raf = 0
      const scrolled = why === 'scroll'
      why = 'auto'
      const hs = headingsIn(pane)
      let at = -1
      const node = scrolled ? null : caretIn()
      if (!node && !scrolled && known) return
      if (hs.length) known = true // 编辑器还没挂好(没有标题)不算数,挂好那一下的变动再按滚动位置算一次
      if (node) {
        for (let i = 0; i < hs.length; i++) {
          const h = hs[i]
          if (h === node || h.contains(node) || (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) at = i
          else break
        }
      } else {
        const y = pane.getBoundingClientRect().top + line
        for (let i = 0; i < hs.length; i++) { if (hs[i].getBoundingClientRect().top <= y) at = i; else break }
      }
      const sec = deskSection(hs.map((h) => ({ level: Number(h.tagName.slice(1)) || 2, text: h.textContent || '' })), at)
      useApp.getState().humanDeskAct(sessionId, { type: 'section', section: sec ?? undefined })
    }
    const kick = (): void => { if (!raf) raf = requestAnimationFrame(compute) }
    const onScroll = (): void => { why = 'scroll'; kick() }
    const doc = pane.ownerDocument
    doc.addEventListener('selectionchange', kick)
    pane.addEventListener('scroll', onScroll, true)
    const mo = new MutationObserver(kick)
    mo.observe(pane, { childList: true, subtree: true, characterData: true })
    kick()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      doc.removeEventListener('selectionchange', kick)
      pane.removeEventListener('scroll', onScroll, true)
      mo.disconnect()
    }
  }
}

/** 卡片预览跟到你在的那一节:预览挂上来、小节变了 → 把那个标题滚到预览顶上(只滚预览自己的滚动容器,不带着栈一起滚)。
 *  展开态也用它,只在挂上那一下把你上次那一节滚回来(offset 让出浮动胶囊带)。 */
function useFollowSection(bodyRef: React.RefObject<HTMLDivElement | null>, idx: number | undefined, on: boolean, offset = 6, fromBody = false): void {
  useEffect(() => {
    const body = bodyRef.current
    if (!body || !on || idx === undefined) return
    let tries = 0
    const id = window.setInterval(() => {
      const h = headingsIn(body)[idx]
      if (!h && ++tries < 25) return // 编辑器还在挂载
      window.clearInterval(id)
      if (!h) return
      let sc: HTMLElement | null = h.parentElement
      while (sc && sc !== body && !(sc.scrollHeight > sc.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement
      if (!sc || sc === body) return
      const zoom = (sc as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1 // 卡片预览是 zoom 0.75:矩形是缩放后的,scrollTop 是本地 px
      // 卡片预览:标题贴预览顶(滚动容器顶 + offset);展开态:offset 量自整块的顶(胶囊带浮在上面),和 useSectionTracker 的「滚到哪」那条线同一把尺
      const top = (fromBody ? body.getBoundingClientRect().top : sc.getBoundingClientRect().top) + offset
      sc.scrollTop += (h.getBoundingClientRect().top - top) / zoom
    }, 80)
    return () => window.clearInterval(id)
  }, [bodyRef, idx, on, offset, fromBody])
}

// ── 内容(卡片态与展开态共用) ──

// 视图条目走 DeskViewPane(#848):Agent 给成笔记编辑器的 .db / 插件文件 / 白板经「我来改」挪过来,照样按文件重新分派,不进笔记编辑器
function HumanContent({ item, allowNative }: { item: DeskItem; allowNative: boolean }): React.ReactElement {
  return item.view
    ? <DeskViewPane key={item.key} item={item} k={`human-view:${item.key}`} />
    : <DeskFilePane key={item.key} item={item} allowNative={allowNative} />
}

/** 引用芯片(在看时挂在这条会话的输入框上):笔记 = 「文件名 · 第 N 节」,别的 = 文件名;token 与 [[ 选择器 / 拖进来的同一份
 *  (笔记 `[[绝对路径|名字]]`、文件 = 路径、视图 = <forsion-view>),发给模型的格式不变 —— 第几节只写在芯片的名字上。 */
export function useHumanLiveChip(sessionId: string | null | undefined): RefChip | null {
  const { t } = useI18n()
  const h = useApp((s) => (sessionId ? s.humanDeskBySession[sessionId] : undefined))
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  return useMemo(() => {
    if (!sessionId || !humanWatching(h) || !h?.item) return null
    const it = h.item
    // 带路径的视图(引用点开的 PDF 等)照文件给路径;纯视图才给 <forsion-view>(否则 Agent 只看到一个没有路径的视图名)
    if (it.view && !it.path) return viewChip(it.view.type, it.name)
    const rel = vaultRoot ? vaultRelOf(it.path, vaultRoot) : null
    const chip = rel && /\.md$/i.test(rel) ? refChipOf({ kind: 'note', path: rel }, vaultRoot!) : fileChip(it.path)
    return isNote(it) && h.section ? { ...chip, name: t('humanDesk.live', { name: chip.name, n: String(h.section.n) }) } : chip
  }, [sessionId, h, vaultRoot, t])
}

// ── 卡片态 ──

/** 摘要栏卡片栈里的 Human Desk 卡(Agent Desk 卡同一套 SummaryCard):卡头「你」+ Human Desk + 名字 ▾ + 小眼睛 + 停止 + 展开;
 *  下面一行「你在第 N 节 · 标题」(只有笔记),再下面小预览(跟到你在的那一节)。空着时缺省折叠成卡头,点开是空态那句话,＋ 在卡头。
 *  卡不可关闭。展开 Human Desk 时卡隐身(.gone,同 Agent Desk 卡)。两张 Desk 卡都开着放不下 → 最近碰过的那张开着(DeskSqueezeContext)。 */
export function HumanDeskCard({ sessionId }: { sessionId: string }): React.ReactElement {
  const { t } = useI18n()
  const h: HumanDeskState | undefined = useApp((s) => s.humanDeskBySession[sessionId])
  const side = useApp((s) => deskSideOf(s.deskBySession[sessionId]?.mode, s.humanDeskBySession[sessionId]?.open))
  const item = h?.item
  const watching = humanWatching(h)
  const gone = side === 'human'
  const hasContent = !!item
  const pref = useSummaryOpen((s) => openOf(s.by[sessionId], 'humandesk', true))
  const squeezed = useContext(DeskSqueezeContext) === 'humandesk'
  const [peek, setPeek] = useState(false)
  useEffect(() => { if (hasContent) setPeek(false) }, [hasContent])
  const want = hasContent ? pref : peek
  const open = want && !squeezed
  const cardRef = useRef<HTMLElement | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => { ensureAmadeusReady() }, [])
  useDeskPathDrop(cardRef, true, false, (p) => put(sessionId, deskItemFor(p, Date.now())), sessionId)
  useHumanTabDrop(cardRef, sessionId)
  // 拿到主区了:卡留着、指向它 ——「名字 · 在主区」,点卡 = 转到那个标签;不再有小预览(原生编辑器归主区那个标签)
  const out = !!h?.out && !!item
  const note = isNote(item) ? h?.section : undefined
  useFollowSection(bodyRef, note?.idx, open && !gone && hasContent && !out)
  const pickRows = useHumanPickRows(sessionId)
  const expand = (): void => { touchDesk(sessionId, 'humandesk'); useApp.getState().setDeskSide(sessionId, 'human') }
  // 右边是 Agent Desk 在演时卡片预览让出原生编辑器(同一时间只有一处能开,见 AgentDesk.useClaimKey)
  const allowNative = side !== 'agent'
  const pickable = (h?.recent?.length ?? 0) > 1
  return (
    <SummaryCard
      id="humandesk"
      className={`human-desk-card${gone ? ' gone' : ''}${hasContent ? '' : ' empty'}${out ? ' out' : ''}`}
      rootProps={{ ref: (el: HTMLElement | null) => { cardRef.current = el }, 'data-human-desk-session': sessionId, 'data-want': want ? '1' : '0', 'data-watching': watching || undefined }}
      open={open}
      onToggle={(o) => { touchDesk(sessionId, 'humandesk'); if (hasContent) setUserOpen(sessionId, 'humandesk', o); else setPeek(o) }}
      head={<>
        <YouMark />
        <span className="human-desk-card-name">{t('humanDesk.title')}</span>
        {item && (pickable ? (
          <span className="human-desk-card-pickwrap" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
            <DeskPickButton className="human-desk-card-pick" title={item.path || item.name} rows={pickRows}>
              <span className="t2-card-hint human-desk-card-title">{item.name}</span><ChevronDown size={11} className="desk-cap-caret" />
            </DeskPickButton>
          </span>
        ) : <span className="t2-card-hint human-desk-card-title" title={item.path || item.name}>{item.name}</span>)}
        {out && <span className="t2-card-hint human-desk-inmain">· {t('humanDesk.inMain')}</span>}
      </>}
      actions={item ? <>
        {watching && <span className="human-desk-eye" title={t('humanDesk.watching')} aria-label={t('humanDesk.watching')}><Eye size={13} /></span>}
        {watching
          ? <CardAction className="icon-btn" icon={<Pause size={13} />} label={t('humanDesk.stop')} run={() => useApp.getState().humanDeskAct(sessionId, { type: 'stop' })} />
          : <CardAction className="icon-btn" icon={<Play size={13} />} label={t('humanDesk.resume')} run={() => useApp.getState().humanDeskAct(sessionId, { type: 'resume' })} />}
        {out
          ? <CardAction className="icon-btn" icon={<SquareArrowOutUpRight size={13} />} label={t('humanDesk.goTab')} run={() => goToHumanTab(sessionId)} />
          : <CardAction className="icon-btn" icon={<Maximize2 size={13} />} label={t('desk.expand')} run={expand} />}
      </> : <HumanAddButton sessionId={sessionId} />}
      bodyClassName={`human-desk-card-frame${item ? ' act' : ''}${out ? ' out' : ''}`}
      bodyProps={{ onClick: item ? (out ? () => goToHumanTab(sessionId) : expand) : undefined, title: item ? t(out ? 'humanDesk.goTab' : 'desk.expand') : undefined }}
    >
      {open && !gone && (out ? (
        note ? <div className="human-desk-where"><MapPin size={12} /><span>{t('humanDesk.where', { n: String(note.n), title: note.title })}</span></div> : null
      ) : item ? (
        <>
          {note && <div className="human-desk-where"><MapPin size={12} /><span>{t('humanDesk.where', { n: String(note.n), title: note.title })}</span></div>}
          <div ref={bodyRef} className="human-desk-card-body">
            <div className="agent-desk-pane"><HumanContent item={item} allowNative={allowNative} /></div>
          </div>
        </>
      ) : (
        <div className="human-desk-card-empty">
          <Eye size={18} />
          <span>{t('humanDesk.empty')}</span>
        </div>
      ))}
    </SummaryCard>
  )
}

/** 对话顶上的那张卡(r2-details §4):摘要栏卡片栈不在场时 —— 别的 Space 的右栏里、主区对话窄过 760(如向右拆分之后)、画布 ——
 *  卡挪到对话顶上(栏在场时 CSS 把它让掉,见 chat2.css .human-desk-side)。
 *  只在东西拿到了主区时出现,同摘要栏那张卡的「在主区」态:「你 名字 · 在主区」+ 小眼睛 + 停止 / 继续看,下面一行你在第几节;
 *  点卡 = 转到装着它的标签(这个 Space 里没有就在这里打开)。 */
export function HumanDeskSideCard({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const { t } = useI18n()
  const h = useApp((s) => s.humanDeskBySession[sessionId])
  const ref = useRef<HTMLDivElement>(null)
  const shown = !!h?.out && !!h.item
  useHumanTabDrop(ref, sessionId, shown) // 主区那个标签拖回这张卡 = 放回来(同摘要栏那张卡)
  if (!shown || !h?.item) return null
  const watching = humanWatching(h)
  const note = isNote(h.item) ? h.section : undefined
  const go = (): void => goToHumanTab(sessionId)
  return (
    <div ref={ref} className="human-desk-side" data-human-desk-session={sessionId} title={t('humanDesk.goTab')} onClick={go}>
      <div className="human-desk-side-head">
        <YouMark />
        <span className="t2-card-hint human-desk-card-title" title={`${t('humanDesk.title')} · ${h.item.path || h.item.name}`}>{h.item.name}</span>
        <span className="t2-card-hint human-desk-inmain">· {t('humanDesk.inMain')}</span>
        <span className="human-desk-side-acts" onClick={(e) => e.stopPropagation()}>
          {watching && <span className="human-desk-eye" title={t('humanDesk.watching')} aria-label={t('humanDesk.watching')}><Eye size={13} /></span>}
          {watching
            ? <button type="button" className="icon-btn human-desk-stop" title={t('humanDesk.stop')} aria-label={t('humanDesk.stop')} onClick={() => useApp.getState().humanDeskAct(sessionId, { type: 'stop' })}><Pause size={13} /></button>
            : <button type="button" className="icon-btn human-desk-stop" title={t('humanDesk.resume')} aria-label={t('humanDesk.resume')} onClick={() => useApp.getState().humanDeskAct(sessionId, { type: 'resume' })}><Play size={13} /></button>}
          <button type="button" className="icon-btn" title={t('humanDesk.goTab')} aria-label={t('humanDesk.goTab')} onClick={go}><SquareArrowOutUpRight size={13} /></button>
        </span>
      </div>
      {note && <div className="human-desk-where"><MapPin size={12} /><span>{t('humanDesk.where', { n: String(note.n), title: note.title })}</span></div>}
    </div>
  )
}

// ── 展开态 ──

/** 展开的 Human Desk:占满右边那块,只放一样东西。胶囊:左 = 切换件 +「你」+ 类型图标 + 名字 ▾ + 小眼睛;右 = 视图控件槽 │ 停止 · ⋯ │ 收起。
 *  空着 = 整块空态(那句话 + ＋),右上只留收起。库里的笔记是真的 Amadeus 编辑器(展开着时原生编辑器归它)。 */
export function HumanDeskPanel({ sessionId, switcher }: { sessionId: string; switcher?: React.ReactNode }): React.ReactElement {
  const { t } = useI18n()
  const h = useApp((s) => s.humanDeskBySession[sessionId])
  const item = h?.item
  const watching = humanWatching(h)
  const paneRef = useRef<HTMLDivElement>(null)
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null)
  const more = useRef<CtxItem[]>([])
  const chrome = useMemo<DeskChrome>(() => ({ slot: slotEl, more }), [slotEl])
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const pickRows = useHumanPickRows(sessionId)
  useEffect(() => { ensureAmadeusReady() }, [])
  useDeskPathDrop(paneRef, true, false, (p) => put(sessionId, deskItemFor(p, Date.now())), sessionId)
  useHumanTabDrop(paneRef, sessionId)
  const out = !!h?.out
  const onDesk = !!item && !out // 东西在 Human Desk 上(拿到主区了 = 这块只剩一句「在主区」)
  // 挂上时记下上次那一节(同一样东西才算):滚回去,并且不让「编辑器挂好那一下」按顶上那一节覆盖掉
  const back = useRef<{ key?: string; idx?: number }>({ key: item?.key, idx: h?.section?.idx })
  if (back.current.key !== item?.key) back.current = { key: item?.key, idx: undefined }
  useFollowSection(paneRef, back.current.idx, onDesk && isNote(item), SECTION_LINE - 6, true)
  useSectionTracker(paneRef, sessionId, onDesk && isNote(item), item?.key, back.current.idx !== undefined)
  const collapse = (): void => { touchDesk(sessionId, 'humandesk'); useApp.getState().setDeskSide(sessionId, null) }
  const path = item?.path || ''
  const rel = vaultRelOf(path, vaultRoot)
  // 拿走只认开出去的那一样:拖出窗外要等对面回话(异步),这期间你换了东西,别把新换上的记成在主区(Codex 评审)
  const takeKey = item?.key
  const take = (): void => { if (takeKey && useApp.getState().humanDeskBySession[sessionId]?.item?.key === takeKey) takeHumanOut(sessionId) }
  // 开得成主区标签才算拿走;库里没人认领的类型交给系统默认程序打开 —— 那不是拿到了主区,东西留在 Human Desk(Codex 评审)
  const canTake = !!item && (rel && !item.view ? !!fileViewRef(rel) : !!deskViewRef(item, rel))
  const moreItems = (): CtxItem[] => {
    if (!item) return []
    const mine: CtxItem[] = [
      ...addItems(sessionId, t),
      { label: t('humanDesk.remove'), icon: <X size={14} />, separatorBefore: true, run: () => useApp.getState().humanDeskAct(sessionId, { type: 'remove' }) },
    ]
    if (out) return [{ label: t('humanDesk.goTab'), icon: <SquareArrowOutUpRight size={14} />, run: () => goToHumanTab(sessionId) }, ...mine]
    // 打开的四项同 Agent Desk(#842 deskOpen.tsx 的共用函数),但 Human Desk 是拿走:开出去之后从这边拿掉、卡留着指向它(第 1 步后半)。
    // 「在 Amadeus 中打开」不再给:那是再开一份,和「一件事只有一张卡」打架;四项里的「在新标签页打开」就是它
    const opens = deskOpenItems({ item, rel, anchor: paneRef.current, openTab: () => openDeskItemInMain(item, vaultRoot), t })
      .map((x) => ({ ...x, run: () => { x.run(); if (canTake) take() } }))
    const orig: CtxItem[] = [
      ...more.current,
      ...(path ? [{ label: t('panel.action.copyPath'), icon: <Copy size={14} />, run: () => void navigator.clipboard?.writeText(path) }] : []),
    ]
    const after = (xs: CtxItem[]): CtxItem[] => xs.map((x, i) => (i === 0 ? { ...x, separatorBefore: true } : x))
    return [...mine, ...after(opens), ...after(orig)]
  }
  const pickable = (h?.recent?.length ?? 0) > 1
  // 名字胶囊拖得起来(同 Agent Desk,#842):拖进标签栏 / 主区 = 拿到主区(落下成功才拿掉);拖进输入框 = 一枚引用(不拿走)
  const drag = onDesk && canDragDeskItem(item!)
    ? (e: React.DragEvent<HTMLElement>): void => startDeskItemDrag(e, { sessionId, item: item!, rel, openVault: () => openDeskItemInMain(item!, vaultRoot), ...(canTake ? { taken: take } : {}) })
    : undefined
  const tip = item ? [path || item.name, onDesk && deskDragTip(item, t)].filter(Boolean).join('\n') : undefined
  // 图标跟着种类走,同 Agent Desk 的名字胶囊(#842 DeskItemIcon)
  const inner = item ? <><DeskItemIcon item={item} rel={rel} size={13} className="desk-cap-ic" /><span className="desk-cap-label">{item.name || path.split(/[/\\]/).pop()}</span></> : null
  return (
    <div className="human-desk-body" data-human-desk-session={sessionId}>
      <div ref={paneRef} className="agent-desk-pane has-caps human-desk-pane">
        <div className="desk-caps">
          <div className="desk-caps-left">
            {switcher}
            {item && (
              <div className="desk-cap desk-cap-name human-desk-name">
                <YouMark className="human-desk-capyou" />
                {pickable
                  ? <DeskPickButton className="desk-cap-pick" title={tip ?? ""} rows={pickRows} onDragStart={drag}>{inner}<ChevronDown size={12} className="desk-cap-caret" /></DeskPickButton>
                  : <span className="desk-cap-pick" title={tip} draggable={drag ? true : undefined} onDragStart={drag}>{inner}</span>}
                {out && <span className="human-desk-inmain">{t('humanDesk.inMain')}</span>}
                {watching && <span className="human-desk-eye" title={t('humanDesk.watching')} aria-label={t('humanDesk.watching')}><Eye size={12} /></span>}
              </div>
            )}
          </div>
          <div className="desk-cap">
            {item && <>
              <span ref={setSlotEl} className="desk-cap-slot" />
              {watching
                ? <button type="button" className="icon-btn human-desk-stop" title={t('humanDesk.stop')} aria-label={t('humanDesk.stop')} onClick={() => useApp.getState().humanDeskAct(sessionId, { type: 'stop' })}><Pause size={14} /></button>
                : <button type="button" className="icon-btn human-desk-stop" title={t('humanDesk.resume')} aria-label={t('humanDesk.resume')} onClick={() => useApp.getState().humanDeskAct(sessionId, { type: 'resume' })}><Play size={14} /></button>}
              <DeskMoreButton items={moreItems} />
              <span className="desk-cap-div" />
            </>}
            <button type="button" className="icon-btn" title={t('desk.collapse')} aria-label={t('desk.collapse')} onClick={collapse}><Minimize2 size={14} /></button>
          </div>
        </div>
        <DeskChromeContext.Provider value={chrome}>
          {out && item ? (
            // 拿到主区了:这块不再演它(一件事只有一张卡,原生编辑器归主区那个标签);转到它 / 放回来
            <div className="human-desk-empty human-desk-outpane">
              <SquareArrowOutUpRight size={24} />
              <span className="human-desk-empty-tx">{t('humanDesk.outHere', { name: item.name })}</span>
              <span className="human-desk-outacts">
                <button type="button" className="t2-btn ghost" onClick={() => goToHumanTab(sessionId)}>{t('humanDesk.goTab')}</button>
                <button type="button" className="t2-btn ghost" onClick={() => putBackHere(sessionId)}>{t('humanDesk.add')}</button>
              </span>
            </div>
          ) : item ? <HumanContent item={item} allowNative /> : (
            <div className="human-desk-empty">
              <Eye size={28} />
              <span className="human-desk-empty-tx">{t('humanDesk.empty')}</span>
              <HumanAddButton sessionId={sessionId} className="icon-btn human-desk-plus" />
            </div>
          )}
        </DeskChromeContext.Provider>
      </div>
    </div>
  )
}
