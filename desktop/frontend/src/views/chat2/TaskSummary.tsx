/**
 * 任务概览(固定摘要面板):主区够宽时贴在对话右侧,把「状态 / 需要你处理 / 计划 / 工作范围 / 产物」
 * 这几件已有事实并到一处,免得用户回滚聊天记录去找。数据来自 taskFacts.ts 的确定性投影。
 * 出现/收起是纯 CSS(容器查询 + width/opacity 过渡,见 chat2.css `.t2-tsum`),
 * 窄了就整块收掉、正文回到全宽 —— 组件始终挂着,靠 class 切换,才有进出动画。
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronRight, CircleStop, FileText, FolderOpen, Globe, Loader2, Pencil, Plus, Search, X, XCircle } from 'lucide-react'
import { describeTool } from '../../components/ToolGroup'
import { registerMessages, useI18n } from '../../i18n'
import type { DisplayFile, UiMessage } from '../../types'
import { findLiveEdit } from '../../stores/deskPlan'
import { hasFacts, summarizeTask } from './taskFacts'

registerMessages({
  'tsum.title': { zh: '任务概览', en: 'Task overview' },
  'tsum.state.running': { zh: '正在运行', en: 'Running' },
  'tsum.state.attention': { zh: '等待你处理', en: 'Waiting for you' },
  'tsum.state.error': { zh: '已失败', en: 'Failed' },
  'tsum.state.stopped': { zh: '已停止', en: 'Stopped' },
  'tsum.state.done': { zh: '已完成', en: 'Done' },
  'tsum.elapsed': { zh: '已运行 {t}', en: 'Running {t}' },
  'tsum.attention.approval': { zh: '需要批准:{name}', en: 'Approval needed: {name}' },
  'tsum.attention.inquiry': { zh: '需要你回答', en: 'Needs your answer' },
  'tsum.plan': { zh: '计划', en: 'Plan' },
  'tsum.scope': { zh: '工作范围', en: 'Scope' },
  'tsum.scope.default': { zh: '默认目录', en: 'Default folder' },
  'tsum.scope.add': { zh: '添加工作文件夹', en: 'Add working folder' },
  'tsum.scope.remove': { zh: '移出工作范围', en: 'Remove from scope' },
  'tsum.scope.hint': {
    zh: '加进来的文件夹 agent 可直接读写、不再逐次弹审批;相对路径仍只相对默认目录解析。',
    en: 'Added folders are readable/writable without per-call approval; relative paths still resolve against the default folder.',
  },
  'tsum.sources': { zh: '来源', en: 'Sources' },
  'tsum.outputs': { zh: '产物', en: 'Outputs' },
  'tsum.openFile': { zh: '打开', en: 'Open' },
  'tsum.openWeb': { zh: '在浏览器中打开', en: 'Open in browser' },
  'tsum.editing': { zh: '正在编辑', en: 'Editing' },
  'tsum.editingTip': { zh: '在 Agent Desk 中查看', en: 'Show in Agent Desk' },
  'tsum.viewAll': { zh: '显示全部 {n} 项', en: 'View all {n}' },
})

/** 来源图标按类别分:文件 / 目录 / 网页 / 搜索。 */
const SRC_ICON = { file: FileText, dir: FolderOpen, web: Globe, search: Search } as const

/** 每个分区默认最多露几条,其余折在「显示全部」后面。 */
const CAP = 3

/** 可折叠分区。用原生 <details>:折叠语义、键盘可达、读屏支持全是白拿的。
 *  action=标题行右侧、折叠箭头左边的小动作(如「＋ 添加工作文件夹」)。
 *  items=列表分区(自带滚动壳 + CAP 截断);children=自由内容分区。
 *  折叠态**故意不持久化**:面板每次露面一律全展开(用户指定),折叠只在本次可见期内有效。 */
function Sec({ title, count, action, items, children }: {
  title: string
  count?: number
  action?: { icon: React.ReactNode; label: string; run: () => void }
  items?: React.ReactNode[]
  children?: React.ReactNode
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(true)
  // 「显示全部」跟着折叠走:分区一收起就复位,下次展开又从 3 条起(用户指定行为)。
  const [all, setAll] = useState(false)
  return (
    <details
      className="t2-tsum-sec"
      open={open}
      onToggle={(e) => {
        const nowOpen = (e.currentTarget as HTMLDetailsElement).open
        setOpen(nowOpen)
        if (!nowOpen) setAll(false)
      }}
    >
      <summary className="t2-tsum-sectitle">
        <span>{title}</span>
        {count !== undefined && <span className="t2-tsum-count">{count}</span>}
        {action && (
          <button
            type="button"
            className="t2-tsum-secact"
            title={action.label}
            aria-label={action.label}
            // summary 里的按钮:不拦住事件的话点它会顺带把分区折上
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); action.run() }}
          >
            {action.icon}
          </button>
        )}
        <ChevronRight size={12} className="t2-tsum-chev" />
      </summary>
      {items ? (
        <div className="t2-tsum-scroll">
          {all ? items : items.slice(0, CAP)}
          {!all && items.length > CAP && (
            <button type="button" className="t2-tsum-more" onClick={() => setAll(true)}>
              {t('tsum.viewAll', { n: items.length })}
            </button>
          )}
        </div>
      ) : children}
    </details>
  )
}

/** m:ss(逐秒走);30 秒内整行不显示,见原型 §10.2。 */
const fmtDur = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const baseName = (p: string): string => p.split(/[/\\]/).filter(Boolean).pop() || p

export function TaskSummary({ messages, running, cwd, hostCwd, onJumpToAttention, onShowEditing, onOpenFile, extraRoots = [], onAddRoot, onRemoveRoot }: {
  messages: UiMessage[]
  running: boolean
  cwd?: string
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

  const elapsed = running && f.startedAt ? now - f.startedAt : 0
  const done = f.todos.filter((x) => x.status === 'completed').length
  const act = f.action ? describeTool(f.action) : null
  const StateIcon = f.state === 'attention' ? AlertTriangle
    : f.state === 'error' ? XCircle
    : f.state === 'stopped' ? CircleStop
    : f.state === 'running' ? Loader2
    : CheckCircle2

  return (
    // 卡本身不再单列标题(对齐 Codex:开篇即第一个分区),标题降级为无障碍名。
    <aside className={`t2-tsum${hasFacts(f) ? ' show' : ''}`} aria-hidden={!hasFacts(f)} aria-label={t('tsum.title')}>
      <div className="t2-tsum-in">
        <div className={`t2-tsum-state ${f.state}`}>
          <StateIcon size={14} className={f.state === 'running' ? 'spin' : undefined} />
          <span className="t2-tsum-state-tx">{t(`tsum.state.${f.state === 'idle' ? 'done' : f.state}`)}</span>
          {f.todos.length > 0 && <span className="t2-tsum-count">{done}/{f.todos.length}</span>}
        </div>
        {elapsed >= 30_000 && <div className="t2-tsum-sub">{t('tsum.elapsed', { t: fmtDur(elapsed) })}</div>}
        {act && <div className="t2-tsum-sub" title={act.target}>{act.verbKey ? t(act.verbKey) : f.action!.name} {act.target}</div>}

        {editing && onShowEditing && (
          <button className="t2-tsum-edit" title={`${t('tsum.editingTip')}:${editing.path}`} onClick={() => onShowEditing(editing.path)}>
            <Pencil size={11} />
            <span className="t2-tsum-edit-tx">{t('tsum.editing')} {editing.name}</span>
          </button>
        )}
        {f.state === 'error' && f.error && <div className="t2-tsum-sub err" title={f.error}>{f.error}</div>}

        {f.attention.length > 0 && (
          <button className="t2-tsum-attn" onClick={onJumpToAttention}>
            {f.attention[0].kind === 'approval'
              ? t('tsum.attention.approval', { name: f.attention[0].text })
              : t('tsum.attention.inquiry')}
            {f.attention.length > 1 && <span className="t2-tsum-count">+{f.attention.length - 1}</span>}
          </button>
        )}

        {f.todos.length > 0 && (
          <Sec
            title={t('tsum.plan')}
            items={f.todos.map((td, i) => (
              <div key={i} className={`t2-tsum-todo ${td.status}`}>
                <span className="t2-tsum-todo-mark">{td.status === 'completed' ? '✓' : td.status === 'in_progress' ? '●' : '○'}</span>
                <span className="t2-tsum-todo-tx">{td.content}</span>
              </div>
            ))}
          />
        )}

        {cwd && (
          <Sec
            title={t('tsum.scope')}
            action={onAddRoot ? { icon: <Plus size={13} />, label: `${t('tsum.scope.add')} — ${t('tsum.scope.hint')}`, run: onAddRoot } : undefined}
            items={[
              // 默认目录永远排头,截断也先保它 —— 它是相对路径的解析基准,不是可有可无的一行。
              <div key="__cwd" className="t2-tsum-row" title={`${t('tsum.scope.default')}:${cwd}`}>
                <FolderOpen size={14} /><span className="t2-tsum-row-tx">{baseName(cwd)}</span>
                <span className="t2-tsum-hits">{t('tsum.scope.default')}</span>
              </div>,
              ...extraRoots.map((r) => (
                <div key={r} className="t2-tsum-row t2-tsum-root" title={r}>
                  <FolderOpen size={14} /><span className="t2-tsum-row-tx">{baseName(r)}</span>
                  {onRemoveRoot && (
                    <button type="button" className="t2-tsum-x" title={t('tsum.scope.remove')}
                      aria-label={`${t('tsum.scope.remove')}:${baseName(r)}`} onClick={() => onRemoveRoot(r)}>
                      <X size={12} />
                    </button>
                  )}
                </div>
              )),
            ]}
          />
        )}

        {f.sources.length > 0 && (
          <Sec
            title={t('tsum.sources')}
            count={f.sources.length}
            items={f.sources.map((sc) => {
              const Icon = SRC_ICON[sc.kind]
              const key = `${sc.kind}:${sc.id}`
              const body = (
                <>
                  <Icon size={14} /><span className="t2-tsum-row-tx">{sc.label}</span>
                  {sc.hits > 1 && <span className="t2-tsum-hits">×{sc.hits}</span>}
                </>
              )
              // 网页来源用真链接:target=_blank 会被主进程的 setWindowOpenHandler 转系统浏览器
              // (electron/main.ts denyExternal),既不用新开 IPC,又天然键盘可达。
              if (sc.kind === 'web') {
                return (
                  <a key={key} className="t2-tsum-row act" href={sc.id} target="_blank" rel="noreferrer"
                    title={`${t('tsum.openWeb')}:${sc.id}`}>{body}</a>
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
          />
        )}

        {f.outputs.length > 0 && (
          <Sec
            title={t('tsum.outputs')}
            count={f.outputs.length}
            items={f.outputs.map((o) => {
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
          />
        )}
      </div>
    </aside>
  )
}
