/**
 * 任务概览 = 对话右侧的摘要栏:把「状态 / 需要你处理 / 计划 / 后台 / 产物 / 来源 / 工作范围」这几件已有事实并到一处,
 * 免得用户回滚聊天记录去找。数据来自 taskFacts.ts 的确定性投影 + processStore(后台进程)。
 *
 * 2026-10-25 用户改为多卡片栈(方案 A,仓根 docs/ToBeImproved/后台任务与服务面板方案_2026-10-24/round2.html):
 * 每段一张卡,Agent Desk 也是栈里的一张(ChatView 经 `desk` 递进来);卡片可折叠(收起状态按种类全局记住)、
 * 悬停露拖动块换顺序(顺序全局记住,右键卡头有「移到最上 / 最下 / 恢复默认」)、没内容的卡不画,
 * 插件经 ctx.summary.registerCard 加卡(amadeus/plugins/summaryCards.ts)。
 * 出现/收起仍是纯 CSS(容器查询 + 过渡,见 chat2.css `.t2-tsum`);窄了整栈收掉,后台进程退到输入框上方那一行。
 */
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowDownToLine, ArrowUpToLine, CheckCircle2, ChevronRight, CircleStop, FileText, FolderOpen, Globe, GripVertical, Pencil, Plus, RotateCcw, Search, X, XCircle } from 'lucide-react'
import { createDropIndicator, land, landWhenMoved } from '@lcl/engine'
import { describeTool } from '../../components/ToolGroup'
import { ContextMenu, type CtxMenu } from '../../components/RightPanel'
import { humanizeRunError, ReloginChip } from './EditorialMessage'
import { registerMessages, useI18n } from '../../i18n'
import type { DisplayFile, UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { findLiveEdit } from '../../stores/deskPlan'
import { hasFacts, summarizeTask } from './taskFacts'
import { ChatWebLink } from '../../components/ChatWikiLink'
import { fullOrder, moveCard, orderCards, setCardOpen, setCardOrder, useSummaryPrefs } from './summaryPrefs'
import { useSummaryCards, type SummaryCardEntry } from '../../amadeus/plugins/summaryCards'
import { refreshProcesses, useProcessPolling, useSessionProcesses } from './processStore'
import { BgRow, PROCESS_CAP } from './BackgroundProcs'

registerMessages({
  'tsum.title': { zh: '任务概览', en: 'Task overview' },
  'tsum.progress': { zh: '进度', en: 'Progress' },
  'tsum.state.running': { zh: '正在运行', en: 'Running' },
  'tsum.state.attention': { zh: '等待你处理', en: 'Waiting for you' },
  'tsum.state.error': { zh: '已失败', en: 'Failed' },
  'tsum.state.stopped': { zh: '已停止', en: 'Stopped' },
  'tsum.state.done': { zh: '已完成', en: 'Done' },
  'tsum.elapsed': { zh: '已运行 {t}', en: 'Running {t}' },
  'tsum.attention.approval': { zh: '需要批准：{name}', en: 'Approval needed: {name}' },
  'tsum.attention.inquiry': { zh: '需要你回答', en: 'Needs your answer' },
  'tsum.scope': { zh: '工作范围', en: 'Scope' },
  'tsum.scope.default': { zh: '默认目录', en: 'Default folder' },
  'tsum.scope.add': { zh: '添加工作文件夹', en: 'Add working folder' },
  'tsum.scope.remove': { zh: '移出工作范围', en: 'Remove from scope' },
  'tsum.scope.hint': {
    zh: '加进来的文件夹 Agent 可直接读写、不再逐次弹审批；相对路径仍只相对默认目录解析。',
    en: 'Added folders are readable/writable without per-call approval; relative paths still resolve against the default folder.',
  },
  'tsum.sources': { zh: '来源', en: 'Sources' },
  'tsum.outputs': { zh: '产物', en: 'Outputs' },
  'tsum.bg': { zh: '后台', en: 'Background' },
  'tsum.bg.cap': { zh: '后台进程已满 {n} 个，新的会被拒绝', en: '{n} of {n} background processes running; new ones will be refused' },
  'tsum.openFile': { zh: '打开', en: 'Open' },
  'tsum.openWeb': { zh: '在浏览器中打开', en: 'Open in browser' },
  'tsum.editing': { zh: '正在编辑', en: 'Editing' },
  'tsum.editingTip': { zh: '在 Agent Desk 中查看', en: 'Show in Agent Desk' },
  'tsum.card.drag': { zh: '拖动调整顺序', en: 'Drag to reorder' },
  'tsum.card.top': { zh: '移到最上', en: 'Move to top' },
  'tsum.card.bottom': { zh: '移到最下', en: 'Move to bottom' },
  'tsum.card.reset': { zh: '恢复默认顺序', en: 'Reset order' },
})

/** dockview 搬完主区 DOM 后多久才放开摘要栏的进出场:盖住新分栏 setSize + 右栏补间(200 ms)。 */
const MOVE_HOLD_MS = 600

/** 来源图标按类别分:文件 / 目录 / 网页 / 搜索。 */
const SRC_ICON = { file: FileText, dir: FolderOpen, web: Globe, search: Search } as const

/** 栈里的卡片(含 Desk)向栈要的两样:拖动块按下、卡头右键菜单。 */
interface RailApi { grip(id: string, e: React.PointerEvent): void; menu(id: string, e: React.MouseEvent): void }
const RailCtx = createContext<RailApi | null>(null)

/** 一张卡:原生 <details>(折叠语义、键盘可达、读屏全白拿)。点卡头折叠;卡头里的按钮自己拦住事件,不顺带折叠。
 *  计数 / 动作 / 折叠箭头收在卡头末尾同一个 .t2-card-end 里,只有它带 margin-left:auto ——
 *  两个 auto 会平分剩余空间把计数推到中间(第二轮 demo 被用户点名「放在中间太丑」)。 */
export function SummaryCard({ id, head, count, countTitle, actions, open, onToggle, className = '', bodyClassName = '', bodyProps, rootProps, children }: {
  id: string
  head: React.ReactNode
  count?: React.ReactNode
  countTitle?: string
  actions?: React.ReactNode
  open: boolean
  onToggle: (open: boolean) => void
  className?: string
  bodyClassName?: string
  bodyProps?: React.HTMLAttributes<HTMLDivElement>
  rootProps?: React.HTMLAttributes<HTMLElement> & Record<string, unknown>
  children?: React.ReactNode
}) {
  const { t } = useI18n()
  const rail = useContext(RailCtx)
  return (
    <details
      {...rootProps}
      className={`t2-card ${className}`}
      data-card={id}
      open={open}
      onToggle={(e) => { const now = (e.currentTarget as HTMLDetailsElement).open; if (now !== open) onToggle(now) }}
    >
      <summary className="t2-card-head" onContextMenu={rail ? (e) => rail.menu(id, e) : undefined}>
        {rail && (
          <span className="t2-card-grip" aria-hidden title={t('tsum.card.drag')}
            onPointerDown={(e) => rail.grip(id, e)}
            onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
            <GripVertical size={12} />
          </span>
        )}
        <span className="t2-card-title">{head}</span>
        <span className="t2-card-end">
          {count !== undefined && count !== null && <span className="t2-tsum-count" title={countTitle}>{count}</span>}
          {actions}
          <ChevronRight size={12} className="t2-tsum-chev" />
        </span>
      </summary>
      <div {...bodyProps} className={`t2-card-body ${bodyClassName}`}>{children}</div>
    </details>
  )
}

/** 卡头里的小按钮(「＋ 添加工作文件夹」、Desk 的清空 / 放大):在 summary 里,不拦事件会顺带折叠。 */
export function CardAction({ icon, label, run, className = 't2-tsum-secact' }: { icon: React.ReactNode; label: string; run: () => void; className?: string }) {
  return (
    <button type="button" className={className} title={label} aria-label={label}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); run() }}>
      {icon}
    </button>
  )
}

/** 拖卡片换位:真卡跟着指针走(独立 translate 属性,不碰布局),落点线走 LCL createDropIndicator(--signal-line,
 *  换落点原地淡入淡出 —— DESIGN §6 拖入提示那条)。线挂在车道上,不挂在会滚动的栈里。
 *  松手落位走 LCL land:卡从松手处滑进新位置(换了位置等重排后再落);原地放下 / 取消也从松手处滑回去,不硬跳。
 *  ponytail: 栈超出车道时拖到边上不自动滚;真有人卡在这再加。 */
function dragCard(stack: HTMLElement | null, id: string, e: React.PointerEvent, drop: (before: string | null) => void): (() => void) | undefined {
  if (!stack || e.button !== 0) return
  const card = [...stack.children].find((c) => (c as HTMLElement).dataset.card === id) as HTMLElement | undefined
  if (!card) return
  e.preventDefault()
  const shown = [...stack.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !!c.dataset.card && c.offsetParent !== null)
  const others = shown.filter((c) => c !== card)
  const after = shown[shown.indexOf(card) + 1]?.dataset.card ?? null // 原地 = 落在自己后面那张前面
  const z = (card as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1
  const y0 = e.clientY
  const ind = createDropIndicator({ host: stack.parentElement ?? undefined })
  let before: string | null | undefined
  card.classList.add('t2-card-lifted')
  const move = (ev: PointerEvent): void => {
    card.style.translate = `0 ${(ev.clientY - y0) / z}px`
    const next = others.find((c) => { const r = c.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2 })
    before = next ? next.dataset.card! : null
    if (before === after) { ind.hide(); return }
    const s = stack.getBoundingClientRect()
    const y = next ? next.getBoundingClientRect().top - 6 * z : others[others.length - 1].getBoundingClientRect().bottom + 4 * z
    ind.line({ x: s.left + 10 * z, y, w: s.width - 20 * z }, { key: String(before) })
  }
  let done = false
  const end = (commit: boolean): void => {
    if (done) return
    done = true
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', esc, true)
    window.removeEventListener('blur', cancel)
    card.classList.remove('t2-card-lifted')
    // 真卡就是拖影:撤掉拿起时的 scale、还带着拖动位移时的左上角 = 落位起点(带 scale 量会横向偏 2px)
    const r = card.getBoundingClientRect()
    const from = { x: r.left, y: r.top }
    card.style.translate = ''
    ind.destroy()
    if (commit && before !== undefined && before !== after) {
      // 在重排提交之前布置:等这张卡换了前一个兄弟再落,新位置一帧都不先画出来
      landWhenMoved(() => [...stack.children].find((c) => (c as HTMLElement).dataset.card === id) as HTMLElement | undefined, from, { timeout: 400 })
      drop(before)
    } else land(card, from)
  }
  const up = (): void => end(true)
  const cancel = (): void => end(false)
  const esc = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { ev.preventDefault(); end(false) } }
  if (!others.length) { end(false); return }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', esc, true)
  // 松手在窗口外 / 切走窗口:pointerup 到不了,按取消收
  window.addEventListener('blur', cancel)
  return cancel
}

/** 插件卡:换会话 = 卸载重挂(mount 拿到的 sessionId 恒定)。update({count, hidden}) 只改这一份,状态由栈托管
 *  (栈要知道它藏没藏,才判得出「还有没有卡在场」)。 */
function PluginCard({ entry, sessionId, cwd, state, setState }: {
  entry: SummaryCardEntry
  sessionId: string
  cwd: string | null
  state: { count?: number | null; hidden?: boolean } | undefined
  setState: (key: string, patch: { count?: number | null; hidden?: boolean }) => void
}) {
  const { locale } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const open = useSummaryPrefs((s) => s.open[entry.key]) ?? !entry.defaultCollapsed
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let alive = true
    let off: void | (() => void)
    try {
      off = entry.mount(el, {
        sessionId,
        cwd,
        update: (p) => {
          if (!alive || !p || typeof p !== 'object') return
          const patch: { count?: number | null; hidden?: boolean } = {}
          if ('count' in p) patch.count = typeof p.count === 'number' && Number.isFinite(p.count) ? p.count : null
          if ('hidden' in p) patch.hidden = !!p.hidden
          setState(entry.key, patch)
        },
      })
    } catch (err) { console.warn(`[summary] 插件卡 ${entry.key} mount 抛错`, err) }
    return () => {
      alive = false
      try { if (typeof off === 'function') off() } catch (err) { console.warn(`[summary] 插件卡 ${entry.key} 卸载抛错`, err) }
      el.replaceChildren()
      setState(entry.key, { count: null, hidden: false })
    }
  }, [entry, sessionId, cwd, setState])
  const title = typeof entry.title === 'string' ? entry.title : locale === 'en' ? entry.title.en : entry.title.zh
  return (
    <SummaryCard id={entry.key} head={<span>{title}</span>} count={state?.count ?? undefined} open={open}
      onToggle={(o) => setCardOpen(entry.key, o)} bodyClassName="t2-card-plugin"
      rootProps={state?.hidden ? { hidden: true } : undefined}>
      <div ref={ref} className="t2-card-plugin-root" />
    </SummaryCard>
  )
}

/** m:ss(逐秒走);30 秒内整行不显示,见原型 §10.2。 */
const fmtDur = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const baseName = (p: string): string => p.split(/[/\\]/).filter(Boolean).pop() || p
/** 内置卡的默认顺序;插件卡按注册顺序插在 Desk 前面(用户定)。 */
const BUILTIN = ['progress', 'bg', 'outputs', 'sources', 'scope'] as const
const PROC_TOOLS = new Set(['run_background', 'kill_process'])

export function TaskSummary({ sessionId, desk, messages, running, cwd, hostCwd, onJumpToAttention, onShowEditing, onOpenFile, extraRoots = [], lockedRoots = [], onAddRoot, onRemoveRoot, modelId, teamStatus }: {
  /** 当前会话;新对话草稿 = null(没有后台进程,也不挂插件卡)。 */
  sessionId?: string | null
  /** Agent Desk 卡(DeskCard);栈里的一张,和别的卡一起排序。 */
  desk?: React.ReactNode
  teamStatus?: React.ReactNode
  messages: UiMessage[]
  running: boolean
  cwd?: string
  /** 本会话实际用的模型(仅用于认出订阅直连过期 → 给重登按钮;缺省=不给)。 */
  modelId?: string
  /** 仅 host 会话给的 cwd:让工具参数里的相对路径拼成绝对路径,和 display_file 归并成一行。 */
  hostCwd?: string
  /** 点「需要你处理」时把对话滚到底(审批/询问卡就在那儿)。 */
  onJumpToAttention: () => void
  /** 点「正在编辑 <文件>」→ 在 Agent Desk 展开该文件;缺省(实验开关关)=不显示该行。 */
  onShowEditing?: (path: string) => void
  /** 点来源/产物里的文件行:按设置在新标签页或 Agent Desk 打开。 */
  onOpenFile?: (f: DisplayFile) => void
  /** 额外工作文件夹(绝对路径):并入引擎可写根 + 写进系统提示。cwd 仍是默认目录。 */
  extraRoots?: string[]
  /** 产品系统注入的工作根(如活动 Amadeus Vault):照常展示,但不能当成用户临时根删除。 */
  lockedRoots?: string[]
  /** 缺省(非 host 会话)=不显示添加/移除入口 —— 沙箱会话没有本机目录可言。 */
  onAddRoot?: () => void
  onRemoveRoot?: (path: string) => void
}) {
  const { t } = useI18n()
  const f = useMemo(() => summarizeTask(messages, running, hostCwd), [messages, running, hostCwd])
  // 「正在编辑」事实:进行中的编辑类工具调用的目标文件(参数还在流式时也尽力提取)。
  const editing = useMemo(() => (running && onShowEditing ? findLiveEdit(messages, cwd) : null), [messages, running, cwd, onShowEditing])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    // 1s 一跳:m:ss 的秒位必须逐秒走,5s 一档会跳着数。运行中 messages 本就在流式重渲,这点开销可忽略。
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])
  useProcessPolling()
  const procs = useSessionProcesses(sessionId)
  // Agent 起 / 停后台进程(工具结果回来)→ 立刻刷一次,不等下一轮轮询
  const procToolsDone = useMemo(() => messages.reduce((n, m) => n + (m.toolEvents || []).filter((e) => e.done && PROC_TOOLS.has(e.name)).length, 0), [messages])
  useEffect(() => { if (procToolsDone) void refreshProcesses() }, [procToolsDone])
  const plugins = useSummaryCards()
  const [pluginState, setPluginState] = useState<Record<string, { count?: number | null; hidden?: boolean }>>({})
  const patchPlugin = useMemo(() => (key: string, patch: { count?: number | null; hidden?: boolean }) =>
    setPluginState((s) => ({ ...s, [key]: { ...s[key], ...patch } })), [])
  const prefs = useSummaryPrefs()
  const isOpen = (id: string, dflt: boolean): boolean => prefs.open[id] ?? dflt
  const toggle = (id: string) => (o: boolean) => setCardOpen(id, o)

  const elapsed = running && f.startedAt ? now - f.startedAt : 0
  const done = f.todos.filter((x) => x.status === 'completed').length
  const act = f.action ? describeTool(f.action) : null
  const StateIcon = f.state === 'attention' ? AlertTriangle
    : f.state === 'error' ? XCircle
    : f.state === 'stopped' ? CircleStop
    : f.state === 'running' ? null
    : CheckCircle2
  // 助手一句都没回过的会话不报「已完成」:空会话是 idle、只有用户消息的是 done,原先都显示「已完成」(W-03 / Codex r3a-3)
  const showState = !((f.state === 'idle' || f.state === 'done') && !messages.some((m) => m.role === 'assistant'))
  const runningProcs = procs.filter((p) => p.status === 'running').length

  const cards: Record<string, React.ReactNode> = {}
  if (hasFacts(f) || teamStatus) {
    cards.progress = (
      <SummaryCard key="progress" id="progress" className="t2-tsum-in" open={isOpen('progress', true)} onToggle={toggle('progress')}
        head={showState ? (
          <span className={`t2-tsum-state ${f.state}`} role="status" aria-live="polite">
            {StateIcon && <StateIcon size={14} />}
            <span className={`t2-tsum-state-tx${f.state === 'running' ? ' chat-run-shimmer-text' : ''}`}>{t(`tsum.state.${f.state === 'idle' ? 'done' : f.state}`)}</span>
          </span>
        ) : <span>{t('tsum.progress')}</span>}
        count={f.todos.length > 0 ? `${done}/${f.todos.length}` : undefined}
      >
        {teamStatus}
        {elapsed >= 30_000 && <div className="t2-tsum-sub">{t('tsum.elapsed', { t: fmtDur(elapsed) })}</div>}
        {act && <div className="t2-tsum-sub" title={act.target}>{act.verbKey ? t(act.verbKey) : f.action!.name} {act.target}</div>}
        {editing && onShowEditing && (
          <button className="t2-tsum-edit" title={`${t('tsum.editingTip')}:${editing.path}`} onClick={() => onShowEditing(editing.path)}>
            <Pencil size={11} />
            <span className="t2-tsum-edit-tx">{t('tsum.editing')} {editing.name}</span>
          </button>
        )}
        {f.state === 'error' && f.error && <div className="t2-tsum-sub err" title={f.error}>{humanizeRunError(f.error, t)}</div>}
        {f.state === 'error' && <ReloginChip error={f.error ?? undefined} modelId={modelId} />}
        {f.attention.length > 0 && (
          <button className="t2-tsum-attn" onClick={onJumpToAttention}>
            {f.attention[0].kind === 'approval'
              ? t('tsum.attention.approval', { name: f.attention[0].text })
              : t('tsum.attention.inquiry')}
            {f.attention.length > 1 && <span className="t2-tsum-count">+{f.attention.length - 1}</span>}
          </button>
        )}
        {f.todos.map((td, i) => (
          <div key={i} className={`t2-tsum-todo ${td.status}`}>
            <span className="t2-tsum-todo-mark">{td.status === 'completed' ? '✓' : td.status === 'in_progress' ? '●' : '○'}</span>
            <span className="t2-tsum-todo-tx">{td.content}</span>
          </div>
        ))}
      </SummaryCard>
    )
  }

  if (sessionId && procs.length) {
    const full = runningProcs >= PROCESS_CAP
    cards.bg = (
      // 有在跑的才默认展开(用户点过就按用户的);满 10 个时计数换成 10/10,提示新的会被拒
      <SummaryCard key="bg" id="bg" open={isOpen('bg', runningProcs > 0)} onToggle={toggle('bg')} head={<span>{t('tsum.bg')}</span>}
        count={full ? `${runningProcs}/${PROCESS_CAP}` : procs.length} countTitle={full ? t('tsum.bg.cap', { n: PROCESS_CAP }) : undefined}>
        {procs.map((p) => <BgRow key={p.id} p={p} sessionId={sessionId} />)}
      </SummaryCard>
    )
  }

  if (f.outputs.length > 0) {
    cards.outputs = (
      <SummaryCard key="outputs" id="outputs" open={isOpen('outputs', true)} onToggle={toggle('outputs')} head={<span>{t('tsum.outputs')}</span>} count={f.outputs.length}>
        {f.outputs.map((o) => {
          const label = baseName(o.name || o.path || '')
          const body = <><FileText size={14} /><span className="t2-tsum-row-tx">{label}</span></>
          // 可点的行必须是 <button>:<div onClick> 键盘 Tab 不到、读屏也不认。
          return onOpenFile ? (
            <button key={o.path || o.name} type="button" className="t2-tsum-row act" title={o.path || o.name}
              aria-label={`${t('tsum.openFile')}:${label}`}
              onClick={() => onOpenFile(o)}>{body}</button>
          ) : (
            <div key={o.path || o.name} className="t2-tsum-row" title={o.path || o.name}>{body}</div>
          )
        })}
      </SummaryCard>
    )
  }

  if (f.sources.length > 0) {
    cards.sources = (
      <SummaryCard key="sources" id="sources" open={isOpen('sources', false)} onToggle={toggle('sources')} head={<span>{t('tsum.sources')}</span>} count={f.sources.length}>
        {f.sources.map((sc) => {
          const Icon = SRC_ICON[sc.kind]
          const key = `${sc.kind}:${sc.id}`
          const body = (
            <>
              <Icon size={14} /><span className="t2-tsum-row-tx">{sc.label}</span>
              {sc.hits > 1 && <span className="t2-tsum-hits">×{sc.hits}</span>}
            </>
          )
          // 网页来源与聊天正文里的网页引用**同一条路**:「应用内链接」开关勾着且 Desk 能显示就在 Desk 里开,
          // 否则退回原出口(主区标签 / 系统浏览器,按同一个开关;缺省交给系统浏览器)。
          // ⚠️ 早先这里是 `<a target="_blank">` 直接交给主进程转外链 —— 于是同一张卡里文件来源进
          //    Desk、网页来源开新标签,用户实报「有时候 Desk 有时候新标签」。别改回去。
          // quote 给空串:来源行的标签是**主机名 + ×N 命中数**,拿它当引语搜索纯属噪音。
          if (sc.kind === 'web') {
            return (
              <ChatWebLink key={key} className="t2-tsum-row act" href={sc.id} quote=""
                title={`${t('tsum.openWeb')}:${sc.id}`}>{body}</ChatWebLink>
            )
          }
          // 目录/搜索没有「打开」的对应物,保持纯展示。
          if (sc.kind !== 'file' || !onOpenFile) return <div key={key} className="t2-tsum-row" title={sc.id}>{body}</div>
          return (
            <button key={key} type="button" className="t2-tsum-row act" title={sc.id}
              aria-label={`${t('tsum.openFile')}:${sc.label}`}
              onClick={() => onOpenFile({ name: sc.label, path: sc.id })}>{body}</button>
          )
        })}
      </SummaryCard>
    )
  }

  if (cwd) {
    cards.scope = (
      <SummaryCard key="scope" id="scope" open={isOpen('scope', false)} onToggle={toggle('scope')} head={<span>{t('tsum.scope')}</span>}
        count={1 + extraRoots.length}
        actions={onAddRoot ? <CardAction icon={<Plus size={13} />} label={`${t('tsum.scope.add')} — ${t('tsum.scope.hint')}`} run={onAddRoot} /> : undefined}>
        {/* 默认目录永远排头 —— 它是相对路径的解析基准,不是可有可无的一行。 */}
        <div className="t2-tsum-row" title={`${t('tsum.scope.default')}:${cwd}`}>
          <FolderOpen size={14} /><span className="t2-tsum-row-tx">{baseName(cwd)}</span>
          <span className="t2-tsum-hits">{t('tsum.scope.default')}</span>
        </div>
        {extraRoots.map((r) => (
          <div key={r} className="t2-tsum-row t2-tsum-root" title={r}>
            <FolderOpen size={14} /><span className="t2-tsum-row-tx">{baseName(r)}</span>
            {onRemoveRoot && !lockedRoots.includes(r) && (
              <button type="button" className="t2-tsum-x" title={t('tsum.scope.remove')}
                aria-label={`${t('tsum.scope.remove')}:${baseName(r)}`} onClick={() => onRemoveRoot(r)}>
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </SummaryCard>
    )
  }

  if (sessionId) {
    for (const p of plugins) {
      cards[p.key] = <PluginCard key={`${p.key}:${sessionId}`} entry={p} sessionId={sessionId} cwd={cwd ?? null} state={pluginState[p.key]} setState={patchPlugin} />
    }
  }
  if (desk) cards.desk = desk

  const defaults = [...BUILTIN, ...(sessionId ? plugins.map((p) => p.key) : []), 'desk']
  const ordered = orderCards(Object.keys(cards), defaults, prefs.order)
  // .show = 有 Desk 之外的卡在场(藏起来的插件卡不算);Desk 自己在不在场由 CSS 的 :has(.agent-desk-card:not(.gone)) 判
  const show = ordered.some((k) => k !== 'desk' && !pluginState[k]?.hidden)

  const stackRef = useRef<HTMLElement>(null)
  // 8.9(DESIGN §3 动效规矩 6):挂上 / 换会话之后、用户还没动过之前,栈与 Desk 卡直接到位 ——
  // ⌘J 开底栏会把聊天视图整个重挂一次,不能让摘要栏「又进场一遍」。用户在这个会话里点过 / 按过键之后,
  // 因内容出现的栈、新到的卡才进场。草稿发出第一条变成会话不算换会话。
  const sessKey = sessionId ?? ''
  const [movedIn, setMovedIn] = useState<string | null>(null)
  if (movedIn === '' && sessKey) setMovedIn(sessKey)
  const still = movedIn !== sessKey
  useEffect(() => {
    if (!still) return
    const on = (): void => setMovedIn(sessKey)
    window.addEventListener('pointerdown', on, true)
    window.addEventListener('keydown', on, true)
    return () => { window.removeEventListener('pointerdown', on, true); window.removeEventListener('keydown', on, true) }
  }, [still, sessKey])
  // 第一次 ⌘J 开底栏:dockview 把主区 DOM 整个搬进新分栏(React 实例不换,上面的 still 拦不住),新分栏先按旧尺寸挂、
  // 随后才 setSize,容器查询跨 760 来回一次,栈按 @starting-style 又进场一遍(实测在搬家后 2 帧之外)。
  // 在 MutationObserver 回调里(渲染之前)挂 data-moved 压掉,搬家停下 MOVE_HOLD_MS 后摘掉。
  // ponytail: 盯整个 body 的子树增删,每批只对新增节点做一次 contains;真成了热点再收窄到 dockview 根
  useEffect(() => {
    const stack = stackRef.current
    if (!stack) return
    let t = 0
    const mo = new MutationObserver((recs) => {
      if (!recs.some((r) => Array.prototype.some.call(r.addedNodes, (n: Node) => n.contains(stack)))) return
      stack.setAttribute('data-moved', '')
      window.clearTimeout(t)
      t = window.setTimeout(() => stack.removeAttribute('data-moved'), MOVE_HOLD_MS)
    })
    mo.observe(document.body, { childList: true, subtree: true })
    return () => { mo.disconnect(); window.clearTimeout(t) }
  }, [])
  // 栈已在场时新到的卡:错开 20 ms 淡入上来(第 6 张起与第 5 张同时),已经在的不动;整栈刚出现时随栈一起进。
  const prevCards = useRef<{ keys: Set<string>; show: boolean } | null>(null)
  useLayoutEffect(() => {
    const prev = prevCards.current
    prevCards.current = { keys: new Set(ordered), show }
    if (still || !prev?.show || !show) return
    let i = 0
    for (const k of ordered) {
      if (prev.keys.has(k) || k === 'desk') continue // Desk 卡有自己的进出场
      const el = stackRef.current?.querySelector<HTMLElement>(`:scope > [data-card="${CSS.escape(k)}"]`)
      if (!el) continue
      el.style.animationDelay = `${Math.min(i++, 4) * 20}ms`
      el.dataset.motion = 'enter'
      const done = (e: AnimationEvent): void => {
        if (e.target !== el) return
        el.removeEventListener('animationend', done)
        delete el.dataset.motion
        el.style.animationDelay = ''
      }
      el.addEventListener('animationend', done)
    }
  })
  const defaultsRef = useRef(defaults)
  defaultsRef.current = defaults
  const [menu, setMenu] = useState<CtxMenu>(null)
  // 拖到一半摘要栏没了(关对话 / 切画布 / 插件卡被撤):收掉窗口上的监听,别留着拖一张已脱离的卡
  const dragOff = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => dragOff.current?.(), [])
  const orderedRef = useRef(ordered)
  orderedRef.current = ordered
  const api = useMemo<RailApi>(() => {
    const seq = (): string[] => fullOrder(defaultsRef.current, useSummaryPrefs.getState().order)
    return {
      grip: (id, e) => {
        dragOff.current?.()
        dragOff.current = dragCard(stackRef.current, id, e, (before) => setCardOrder(moveCard(seq(), id, before)))
      },
      menu: (id, e) => {
        e.preventDefault(); e.stopPropagation()
        const vis = orderedRef.current
        // 键盘弹出的 contextmenu 没有指针坐标:贴卡头左下角
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: r.left + 12, y: r.bottom }
        setMenu({ ...at, items: [
          { label: t('tsum.card.top'), icon: <ArrowUpToLine size={13} />, disabled: vis[0] === id,
            run: () => { const s = seq(); setCardOrder(moveCard(s, id, s.find((k) => k !== id) ?? null)) } },
          { label: t('tsum.card.bottom'), icon: <ArrowDownToLine size={13} />, disabled: vis[vis.length - 1] === id,
            run: () => setCardOrder(moveCard(seq(), id, null)) },
          { label: t('tsum.card.reset'), icon: <RotateCcw size={13} />, separatorBefore: true, disabled: !useSummaryPrefs.getState().order,
            run: () => setCardOrder(undefined) },
        ] })
      },
    }
  }, [t])

  return (
    <RailCtx.Provider value={api}>
      <aside ref={stackRef} className={`t2-tsum${show ? ' show' : ''}`} data-still={still || undefined} aria-hidden={!show && !desk} aria-busy={f.state === 'running'} aria-label={t('tsum.title')}>
        {ordered.map((k) => cards[k])}
      </aside>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} autoFocus />}
    </RailCtx.Provider>
  )
}

