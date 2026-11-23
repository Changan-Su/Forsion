/** Human Desk:你动手、Agent 跟着看(2026-11-23 用户定第三轮,方案页仓根 docs/ToBeImproved/HumanTask实时协作方案_2026-11-20/r3.html)。
 *  和 Agent Desk 各自独立:摘要栏卡片栈里一张卡(排在 Agent Desk 卡上面),右边那块一次只展开一块,展开的那块最左上是
 *  「你 / Agent」切换件。Human Desk 只放一样东西;放上来就「在看」:这条会话的输入框自动挂一枚引用芯片(走今天的引用,
 *  发出去的 token 和 [[ 选择器同一份)。状态在 appStore.humanDeskBySession(纯决策 stores/humanDeskPlan.ts)。
 *  这一步不做:拿到主区 / 放到 Human Desk / 在外面的那张卡、引擎里的现场(<human_activity>)、停笔说一句、白板可画。 */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Copy, Eye, FilePlus, FileText, FolderOpen, MapPin, Maximize2, Minimize2, NotebookPen, Pause, Play, Plus, Sparkles, X, ExternalLink } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { getView } from '@lcl/engine'
import { ViewModeSwitch } from '@lcl/components'
import { useApp, type DeskItem } from '../../stores/appStore'
import { deskItemFor } from '../../stores/deskPlan'
import { deskSection, deskSideOf, humanMenuRows, humanWatching, type HumanDeskState } from '../../stores/humanDeskPlan'
import { registerMessages, translate, useI18n } from '../../i18n'
import { iconForFile } from '../../services/fileKinds'
import { usePageStore, birthNoteFile } from '@amadeus/store/pageStore'
import { findFileType, usePluginStore } from '@amadeus/plugins/pluginStore'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { ensureAmadeusReady } from '../../amadeusPlugins'
import { openDb, openNote } from '../../amadeusNav'
import type { CtxItem } from '../../components/RightPanel'
import { DeskChromeContext, DeskMenuButton, DeskMoreButton, DeskPickButton, type DeskChrome, type DeskPickRow } from './deskChrome'
import { DeskFilePane, DeskShimView, openDeskItemInMain, useDeskPathDrop, vaultRelOf } from './AgentDesk'
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

/** 名字胶囊 / 卡头的图标跟着内容类型走:注册视图用视图自己登记的图标,文件按扩展名(services/fileKinds)。 */
function itemIcon(it: DeskItem): LucideIcon {
  if (it.view) return (getView(it.view.type)?.icon as LucideIcon | undefined) ?? FileText
  return iconForFile('', it.name || it.path)
}

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
async function pickHumanFile(sessionId: string): Promise<void> {
  const files = await window.tangu?.pickFiles?.()
  const f = files?.[0]
  if (!f) return
  let p = ''
  try { p = window.tangu?.getPathForFile?.(f) || '' } catch { p = '' }
  if (p) put(sessionId, deskItemFor(p, Date.now()))
}

function addItems(sessionId: string, t: (k: string) => string): CtxItem[] {
  return [
    { label: t('humanDesk.newNote'), icon: <FilePlus size={14} />, run: () => void newHumanNote(sessionId) },
    // 「新建白板」这一步不放:Desk 上的白板是只读预览(走查续七 7.7 A),Human Desk 上可画要用户点头
    ...(window.tangu?.pickFiles ? [{ label: t('humanDesk.pickFile'), icon: <FolderOpen size={14} />, run: () => void pickHumanFile(sessionId) }] : []),
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

const HEADING_SEL = '.page-view h1, .page-view h2, .page-view h3' // 同 NoteFloatingToc
const headingsIn = (root: HTMLElement): HTMLElement[] => {
  const own = Array.from(root.querySelectorAll<HTMLElement>(HEADING_SEL))
  const list = own.length ? own : Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3'))
  return list.filter((h) => !h.closest('[aria-hidden="true"], .desk-caps'))
}

/** 展开态:光标在这篇笔记里就按光标,否则按滚动位置(胶囊带下面那条线以上最后一个标题)算「第几节」,记进 store(内存)。 */
function useSectionTracker(paneRef: React.RefObject<HTMLDivElement | null>, sessionId: string, on: boolean, itemKey: string | undefined): void {
  useEffect(() => {
    const pane = paneRef.current
    if (!pane || !on) return
    let raf = 0
    const compute = (): void => {
      raf = 0
      const hs = headingsIn(pane)
      let at = -1
      const sel = document.getSelection()
      const node = sel && sel.rangeCount ? sel.anchorNode : null
      if (node && pane.contains(node)) {
        for (let i = 0; i < hs.length; i++) {
          const h = hs[i]
          if (h === node || h.contains(node) || (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) at = i
          else break
        }
      } else {
        const line = pane.getBoundingClientRect().top + 58 // 胶囊带(46)+ 一点余量
        for (let i = 0; i < hs.length; i++) { if (hs[i].getBoundingClientRect().top <= line) at = i; else break }
      }
      const sec = deskSection(hs.map((h) => ({ level: Number(h.tagName.slice(1)) || 2, text: h.textContent || '' })), at)
      useApp.getState().humanDeskAct(sessionId, { type: 'section', section: sec ?? undefined })
    }
    const kick = (): void => { if (!raf) raf = requestAnimationFrame(compute) }
    const doc = pane.ownerDocument
    doc.addEventListener('selectionchange', kick)
    pane.addEventListener('scroll', kick, true)
    const mo = new MutationObserver(kick)
    mo.observe(pane, { childList: true, subtree: true, characterData: true })
    kick()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      doc.removeEventListener('selectionchange', kick)
      pane.removeEventListener('scroll', kick, true)
      mo.disconnect()
    }
  }, [paneRef, sessionId, on, itemKey])
}

/** 卡片预览跟到你在的那一节:预览挂上来、小节变了 → 把那个标题滚到预览顶上(只滚预览自己的滚动容器,不带着栈一起滚)。 */
function useFollowSection(bodyRef: React.RefObject<HTMLDivElement | null>, idx: number | undefined, on: boolean): void {
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
      sc.scrollTop += (h.getBoundingClientRect().top - sc.getBoundingClientRect().top - 6) / zoom
    }, 80)
    return () => window.clearInterval(id)
  }, [bodyRef, idx, on])
}

// ── 内容(卡片态与展开态共用) ──

function HumanContent({ item, allowNative }: { item: DeskItem; allowNative: boolean }): React.ReactElement {
  return item.view
    ? <DeskShimView key={item.key} type={item.view.type} params={item.view.params ?? {}} k={`human-view:${item.key}`} />
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
    if (it.view) return viewChip(it.view.type, it.name)
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
  useDeskPathDrop(cardRef, true, false, (p) => put(sessionId, deskItemFor(p, Date.now())))
  const note = isNote(item) ? h?.section : undefined
  useFollowSection(bodyRef, note?.idx, open && !gone && hasContent)
  const pickRows = useHumanPickRows(sessionId)
  const expand = (): void => { touchDesk(sessionId, 'humandesk'); useApp.getState().setDeskSide(sessionId, 'human') }
  const Icon = item ? itemIcon(item) : null
  // 右边是 Agent Desk 在演时卡片预览让出原生编辑器(同一时间只有一处能开,见 AgentDesk.useClaimKey)
  const allowNative = side !== 'agent'
  const pickable = (h?.recent?.length ?? 0) > 1
  return (
    <SummaryCard
      id="humandesk"
      className={`human-desk-card${gone ? ' gone' : ''}${hasContent ? '' : ' empty'}`}
      rootProps={{ ref: (el: HTMLElement | null) => { cardRef.current = el }, 'data-human-desk-session': sessionId, 'data-want': want ? '1' : '0', 'data-watching': watching || undefined }}
      open={open}
      onToggle={(o) => { touchDesk(sessionId, 'humandesk'); if (hasContent) setUserOpen(sessionId, 'humandesk', o); else setPeek(o) }}
      head={<>
        <YouMark />
        <span className="human-desk-card-name">{t('humanDesk.title')}</span>
        {item && Icon && (pickable ? (
          <span className="human-desk-card-pickwrap" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
            <DeskPickButton className="human-desk-card-pick" title={item.path || item.name} rows={pickRows}>
              <span className="t2-card-hint human-desk-card-title">{item.name}</span><ChevronDown size={11} className="desk-cap-caret" />
            </DeskPickButton>
          </span>
        ) : <span className="t2-card-hint human-desk-card-title" title={item.path || item.name}>{item.name}</span>)}
      </>}
      actions={item ? <>
        {watching && <span className="human-desk-eye" title={t('humanDesk.watching')} aria-label={t('humanDesk.watching')}><Eye size={13} /></span>}
        {watching
          ? <CardAction className="icon-btn" icon={<Pause size={13} />} label={t('humanDesk.stop')} run={() => useApp.getState().humanDeskAct(sessionId, { type: 'stop' })} />
          : <CardAction className="icon-btn" icon={<Play size={13} />} label={t('humanDesk.resume')} run={() => useApp.getState().humanDeskAct(sessionId, { type: 'resume' })} />}
        <CardAction className="icon-btn" icon={<Maximize2 size={13} />} label={t('desk.expand')} run={expand} />
      </> : <HumanAddButton sessionId={sessionId} />}
      bodyClassName={`human-desk-card-frame${item ? ' act' : ''}`}
      bodyProps={{ onClick: item ? expand : undefined, title: item ? t('desk.expand') : undefined }}
    >
      {open && !gone && (item ? (
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
  const fileTypes = usePluginStore((s) => s.fileTypes)
  const pickRows = useHumanPickRows(sessionId)
  useEffect(() => { ensureAmadeusReady() }, [])
  useDeskPathDrop(paneRef, true, false, (p) => put(sessionId, deskItemFor(p, Date.now())))
  useSectionTracker(paneRef, sessionId, isNote(item), item?.key)
  const collapse = (): void => { touchDesk(sessionId, 'humandesk'); useApp.getState().setDeskSide(sessionId, null) }
  const path = item?.path || ''
  const rel = vaultRelOf(path, vaultRoot)
  const amadeus = rel && (/\.(md|db)$/i.test(rel) || isDrawingPath(rel) || !!findFileType(fileTypes, rel)) ? rel : null
  const moreItems = (): CtxItem[] => {
    if (!item) return []
    const mine: CtxItem[] = [
      ...addItems(sessionId, t),
      { label: t('humanDesk.remove'), icon: <X size={14} />, separatorBefore: true, run: () => useApp.getState().humanDeskAct(sessionId, { type: 'remove' }) },
      { label: t('desk.openMain'), icon: <ExternalLink size={14} />, run: () => openDeskItemInMain(item, vaultRoot) },
    ]
    const orig: CtxItem[] = [
      ...more.current,
      ...(amadeus ? [{ label: t('preview.openInAmadeus'), icon: <NotebookPen size={14} />, run: () => { if (/\.db$/i.test(amadeus)) openDb(amadeus); else void openNote(amadeus) } }] : []),
      ...(path ? [{ label: t('panel.action.copyPath'), icon: <Copy size={14} />, run: () => void navigator.clipboard?.writeText(path) }] : []),
    ]
    return [...mine, ...orig.map((x, i) => (i === 0 ? { ...x, separatorBefore: true } : x))]
  }
  const Icon = item ? itemIcon(item) : null
  const pickable = (h?.recent?.length ?? 0) > 1
  const inner = item && Icon ? <><Icon size={13} className="desk-cap-ic" /><span className="desk-cap-label">{item.name || path.split(/[/\\]/).pop()}</span></> : null
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
                  ? <DeskPickButton className="desk-cap-pick" title={path || item.name} rows={pickRows}>{inner}<ChevronDown size={12} className="desk-cap-caret" /></DeskPickButton>
                  : <span className="desk-cap-pick" title={path || item.name}>{inner}</span>}
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
          {item ? <HumanContent item={item} allowNative /> : (
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
