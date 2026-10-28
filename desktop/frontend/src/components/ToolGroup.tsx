/**
 * 回答里的「过程行」(10-17 用户选定,方案页 docs/ToBeImproved/借鉴Claude设计系统方案_2026-10-17/ 的 A):
 * 思考 + 一串连续的工具调用收成一行,不垫底、不画完成勾。
 * 折叠时:思考中→「思考中」;运行中→当前那一步「<动作> <目标>… · 第 N 步」;完成→「思考 N 秒 · 编辑 3 文件 · 运行 6 命令」。
 * 展开:竖排步骤(图标列 + 步骤间细线),思考原文在第一步下;每个调用一行(动作 + 目标 + 可选 +增/-删),可再展开看参数/结果。
 * 复用 .tool-card-body/.label 样式;+增/-删 best-effort(算不出就只显目标)。
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, ChevronDown, XCircle, PauseCircle, Sparkles, FilePlus2, Pencil, Terminal, FileText, Search, Globe, Wrench, type LucideIcon } from 'lucide-react'
import { AnimatedCollapse } from './AnimatedUI'
import { DiffView } from './DiffView'
import { toolDiffText } from './toolDiff'
import { registerMessages, useI18n } from '../i18n'
import type { ApprovalRequest, ToolEvent } from '../../../../tangu-agent/src/contracts/clientTypes'
import { ImageGenerationLoader } from '../views/chat2/ImageGenerationLoader'
import { MaskTag, MaskedText, collectMasked, type MaskedValue } from './MaskedValues'
import { isSelfWriteReceipt } from '../services/selfUpdates'
import '../tangu/messages' // Tangu 自己的文案片段(核心插件化 2c)

registerMessages({
  'tool.parked.waiting': { zh: '已挂起，等你批准。Agent 先做别的，拍板后结果会补在这里。', en: 'Parked until you approve it. The agent carries on meanwhile; the result lands here once you decide.' },
  'tool.parked.past': { zh: '当时挂起等你批准，结局见后面的审批结果。', en: 'This call was parked for your approval; see the approval result further down.' },
  'tool.parked.askPast': { zh: '当时挂起等你回答，Agent 没停下来；答案见后面那一行。', en: 'This question was parked while the agent kept going; see your answer further down.' },
  // 不写「在输入框上方」:紧挨着的指路行 / 计划卡 / 团队 work 行已经说了在哪答,这里再写一遍是重复
  'tool.waitingYou': { zh: '等你回复', en: 'Waiting for your reply' },
  'tool.verb.readComputerHistory': { zh: '读取电脑历史', en: 'Read computer history' },
  'tool.verb.gitStatus': { zh: '查看 Git 状况', en: 'Checked Git status' },
  'tool.verb.gitCommit': { zh: '提交', en: 'Committed' },
  'tool.verb.gitPush': { zh: '推送', en: 'Pushed' },
  'tool.verb.gitPull': { zh: '拉取', en: 'Pulled' },
  'tool.thought': { zh: '思考过程', en: 'Thought process' },
  'tool.thinkingNow': { zh: '思考中', en: 'Thinking' },
  'tool.thoughtSec': { zh: '思考 {n} 秒', en: 'Thought for {n}s' },
  'tool.thoughtMin': { zh: '思考 {m} 分 {s} 秒', en: 'Thought for {m}m {s}s' },
  'tool.step': { zh: '第 {n} 步', en: 'Step {n}' },
  'tool.sumN': { zh: '{n} 个工具', en: '{n} tool calls' },
  'tool.computerHistory.notSaved': {
    zh: '电脑历史摘录已交给模型，不会保存在对话记录里。',
    en: 'The computer history excerpt was passed to the model and isn’t saved in the conversation.',
  },
})

/**
 * 电脑历史:引擎只把占位句落库、也只把它推给渲染层(capabilities.persistPlaceholder;全文只进那一轮的模型上下文),
 * 那句英文不给人看 —— 成功结果一律换成本地化说明。认工具名不认占位原文(引擎可以改措辞);出错结果照原样显示(那是真原因)。
 */
const COMPUTER_HISTORY_TOOL = 'read_computer_history'
function toolResultText(ev: ToolEvent, t: (key: string) => string): string {
  if (ev.name === COMPUTER_HISTORY_TOOL && !ev.isError) return t('tool.computerHistory.notSaved')
  return ev.result || t('tool.empty')
}

/** 这两个工具就是「问你」本身:调用挂着 = 在等你在托盘里答,不是在跑,别用流光装忙。 */
const ASKS_YOU = new Set(['ask_user', 'exit_plan_mode'])

type Kind = 'write' | 'edit' | 'run' | 'read' | 'search' | 'browse' | 'other'
interface Desc { kind: Kind; verbKey: string; target: string; adds?: number; dels?: number; isFile: boolean }

/** 行数(末尾空行不计)。 */
function lineCount(s: string): number {
  if (!s) return 0
  const n = s.split('\n').length
  return s.endsWith('\n') ? n - 1 : n
}
/** 统一 diff 文本里的 +增/-删 行数(忽略 +++/--- 文件头)。 */
function diffStat(patch: string): { adds: number; dels: number } {
  let adds = 0, dels = 0
  for (const ln of patch.split('\n')) {
    if (/^\+(?!\+\+)/.test(ln)) adds++
    else if (/^-(?!--)/.test(ln)) dels++
  }
  return { adds, dels }
}
const baseName = (p: string): string => p.split(/[/\\]/).filter(Boolean).pop() || p

/** 把一次工具调用描述成「动作 + 目标(+增/-删)」,供分组摘要与逐行展示。 */
export function describeTool(ev: ToolEvent): Desc {
  let a: any = {}
  try { a = ev.arguments ? JSON.parse(ev.arguments) : {} } catch { /* keep {} */ }
  const path = typeof a.path === 'string' ? a.path : ''
  switch (ev.name) {
    case 'write_file':
      return { kind: 'write', verbKey: 'tool.verb.wrote', target: baseName(path), adds: lineCount(String(a.content ?? '')), dels: 0, isFile: true }
    case 'edit_file':
      return { kind: 'edit', verbKey: 'tool.verb.edited', target: baseName(path), adds: lineCount(String(a.new_string ?? '')), dels: lineCount(String(a.old_string ?? '')), isFile: true }
    case 'multi_edit': {
      let adds = 0, dels = 0
      if (Array.isArray(a.edits)) for (const e of a.edits) { adds += lineCount(String(e?.new_string ?? '')); dels += lineCount(String(e?.old_string ?? '')) }
      return { kind: 'edit', verbKey: 'tool.verb.edited', target: baseName(path), adds, dels, isFile: true }
    }
    case 'apply_patch': {
      const patch = String(a.patch ?? a.input ?? a.diff ?? ev.arguments ?? '')
      const { adds, dels } = diffStat(patch)
      const m = patch.match(/(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ |--- )([^\n]+)/)
      return { kind: 'edit', verbKey: 'tool.verb.edited', target: m ? baseName(m[1].trim()) : 'patch', adds, dels, isFile: true }
    }
    case 'run_bash': case 'run_background':
      return { kind: 'run', verbKey: 'tool.verb.ran', target: String(a.command ?? a.cmd ?? '').split('\n')[0], isFile: false }
    case 'run_python':
      return { kind: 'run', verbKey: 'tool.verb.ran', target: 'python: ' + String(a.code ?? '').split('\n')[0], isFile: false }
    case 'read_file': case 'read_document': case 'read_log': case 'view_image': case 'display_file':
      return { kind: 'read', verbKey: 'tool.verb.read', target: baseName(path || String(a.name ?? a.file ?? '')), isFile: true }
    case 'intelligent_ui':
      return { kind: 'other', verbKey: 'tool.verb.sketched', target: 'Intelligent UI', isFile: false }
    case 'intelligent_ui_html':
    case 'sketch': // 10-20 之前的名字
      return { kind: 'other', verbKey: 'tool.verb.sketched', target: String(a.title ?? '') || 'Intelligent UI', isFile: false }
    case 'desk_present': {
      const views = Array.isArray(a.views) ? a.views : []
      const names = views.map((v: any) => baseName(String(v?.path || ''))).filter(Boolean).join(', ')
      return { kind: 'read', verbKey: 'tool.verb.presented', target: names || 'Agent Desk', isFile: true }
    }
    case 'list_dir': case 'list_files':
      return { kind: 'read', verbKey: 'tool.verb.listed', target: baseName(path || '.'), isFile: true }
    case 'search_files': case 'glob_files':
      return { kind: 'search', verbKey: 'tool.verb.searched', target: String(a.query ?? a.pattern ?? a.glob ?? ''), isFile: false }
    case 'web_search':
      return { kind: 'search', verbKey: 'tool.verb.searched', target: String(a.query ?? ''), isFile: false }
    case 'web_fetch':
      return { kind: 'browse', verbKey: 'tool.verb.browsed', target: String(a.url ?? ''), isFile: false }
    // 当前项目的 git(tangu-agent tools/builtin/git.ts):提交那行带信息首行,推送那行带「只推这一次」的远端名
    case 'git_status':
      return { kind: 'read', verbKey: 'tool.verb.gitStatus', target: '', isFile: false }
    case 'git_commit':
      return { kind: 'run', verbKey: 'tool.verb.gitCommit', target: String(a.message ?? '').split('\n')[0], isFile: false }
    case 'git_push':
      return { kind: 'run', verbKey: 'tool.verb.gitPush', target: typeof a.remote === 'string' ? a.remote : '', isFile: false }
    case 'git_pull':
      return { kind: 'run', verbKey: 'tool.verb.gitPull', target: '', isFile: false }
    case COMPUTER_HISTORY_TOOL:
      return { kind: 'read', verbKey: 'tool.verb.readComputerHistory', target: String(a.query ?? a.app ?? ''), isFile: false }
    default:
      if (ev.name.startsWith('browser_')) return { kind: 'browse', verbKey: 'tool.verb.browsed', target: String(a.url ?? a.text ?? ev.name.replace('browser_', '')), isFile: false }
      return { kind: 'other', verbKey: '', target: typeof a.command === 'string' ? a.command : typeof a.path === 'string' ? a.path : typeof a.query === 'string' ? a.query : (ev.arguments || '').slice(0, 80), isFile: false }
  }
}

const fmtArgs = (s: string): string => { try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s } }

const Stat: React.FC<{ d: Desc }> = ({ d }) =>
  (d.adds || d.dels) ? (
    <span className="tool-row-stat">
      {d.adds ? <span className="add">+{d.adds}</span> : null}
      {d.dels ? <span className="del">-{d.dels}</span> : null}
    </span>
  ) : null

const KIND_ICON: Record<Kind, LucideIcon> = { write: FilePlus2, edit: Pencil, run: Terminal, read: FileText, search: Search, browse: Globe, other: Wrench }

/** 正在进行的那一步:三个小点(纯 CSS,减少动态效果时静止)。 */
const Dots: React.FC = () => <span className="proc-dots" aria-hidden="true"><i /><i /><i /></span>

/** 「思考 N 秒」;没有用时(历史消息,用时只在本次运行里记)就写「思考过程」。 */
export function thoughtLabel(t: (key: string, vars?: Record<string, string | number>) => string, ms?: number): string {
  if (!ms || ms <= 0) return t('tool.thought')
  const sec = Math.max(1, Math.floor(ms / 1000)) // 与回答下方统计行(fmtElapsed)同样取整,两处不差一秒
  return sec < 60 ? t('tool.thoughtSec', { n: sec }) : t('tool.thoughtMin', { m: Math.floor(sec / 60), s: sec % 60 })
}

/** 过程行换一步时滚动替换(借鉴 Comma 方案 §6,10-24):旧行上滑淡出、新行从下面进。`k` 变了才滚;挂上时不入场。
 *  两行叠在同一个 grid 格子里,不挤动后面的状态图标;动效与时长全在 base.css 的 .tool-roll。 */
const RollLine: React.FC<{ k: string; children: React.ReactNode }> = ({ k, children }) => {
  const cur = useRef({ k, node: children })
  const moved = useRef(false)
  const [out, setOut] = useState<{ k: string; node: React.ReactNode } | null>(null)
  if (cur.current.k !== k) moved.current = true
  useLayoutEffect(() => {
    if (cur.current.k === k) { cur.current.node = children; return }
    setOut(cur.current)
    cur.current = { k, node: children }
  })
  // 兜底:藏起来的容器里动画不放、animationend 不来,旧行别一直叠在那儿
  useEffect(() => { if (!out) return; const id = setTimeout(() => setOut(null), 250); return () => clearTimeout(id) }, [out])
  return (
    <span className="tool-roll">
      {out && <span key={`out-${out.k}`} className="tool-roll-item is-out" aria-hidden onAnimationEnd={() => setOut(null)}>{out.node}</span>}
      <span key={k} className={`tool-roll-item${moved.current ? ' is-in' : ''}`}>{children}</span>
    </span>
  )
}

const ThinkRow: React.FC<{ reasoning: string; label: string; thinking: boolean }> = ({ reasoning, label, thinking }) => {
  const [open, setOpen] = useState(true)
  return (
    <div className="tool-row tool-row--think">
      <button className="tool-row-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tool-row-ic">{thinking ? <Dots /> : <Sparkles size={13} />}</span>
        <span className="tool-row-copy"><span className={`tool-row-verb${thinking ? ' chat-run-shimmer-text' : ''}`}>{label}</span></span>
        {open ? <ChevronDown size={12} className="tool-row-chev" /> : <ChevronRight size={12} className="tool-row-chev" />}
      </button>
      <AnimatedCollapse open={open}><div className="t2-think-body">{reasoning}</div></AnimatedCollapse>
    </div>
  )
}

const ToolRow: React.FC<{ ev: ToolEvent; desc: Desc; running: boolean; waiting: boolean; asking?: boolean; masked: MaskedValue[] }> = ({ ev, desc, running, waiting, asking, masked }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  // 只在展开时构造 diff(P1:文件修改类工具详情渲染 diff 而非裸 JSON)
  const diff = useMemo(() => (open ? toolDiffText(ev.name, ev.arguments) : null), [open, ev.name, ev.arguments])
  const verb = desc.verbKey ? t(desc.verbKey) : ev.name
  // 工具结果帧可能在用户停止 run 时来不及抵达。此时 ev.done 仍为 false，
  // 但父消息已不再运行，不能继续显示「正在执行」的流光或 busy 语义。
  const active = running && !ev.done && !asking
  const Icon = KIND_ICON[desc.kind]
  return (
    <div className="tool-row">
      <button className="tool-row-head" aria-busy={active} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tool-row-ic">{active ? <Dots /> : <Icon size={13} />}</span>
        <span className="tool-row-copy">
          <span className={`tool-row-copy-text${active ? ' chat-run-shimmer-text' : ''}`}>
            <span className="tool-row-verb">{verb}</span>
            <span className={`tool-row-target${desc.isFile ? ' file' : ''}`}><MaskedText text={desc.target} masked={masked} /></span>
          </span>
        </span>
        <Stat d={desc} />
        <span className="tool-row-status">
          {asking ? <PauseCircle size={11} style={{ color: 'var(--accent-ink)' }} data-waiting-you="1" aria-label={t('tool.waitingYou')}><title>{t('tool.waitingYou')}</title></PauseCircle>
            : ev.parked ? <PauseCircle size={11} style={{ color: waiting ? 'var(--accent-ink)' : 'var(--text-faint)' }} />
            : ev.done && ev.isError ? <XCircle size={11} style={{ color: 'var(--danger)' }} /> : null}
        </span>
        {open ? <ChevronDown size={12} className="tool-row-chev" /> : <ChevronRight size={12} className="tool-row-chev" />}
      </button>
      <AnimatedCollapse open={open}>
        <div className="tool-card-body">
          {diff ? (
            <>
              <DiffView text={diff} side={false} />
              {ev.arguments && (
                <details className="tool-raw-args">
                  <summary>{t('tool.argsLabel')}</summary>
                  <MaskedText text={fmtArgs(ev.arguments)} masked={masked} />
                </details>
              )}
            </>
          ) : ev.arguments ? (<><div className="label">{t('tool.argsLabel')}</div><MaskedText text={fmtArgs(ev.arguments)} masked={masked} /></>) : null}
          {/* 挂起的占位结果是写给模型的英文说明,对人换成一句本地化的状态 */}
          {ev.parked ? (<><div className="label">{t('tool.resultLabel')}</div>{t(ASKS_YOU.has(ev.name) ? (asking ? 'tool.waitingYou' : 'tool.parked.askPast') : waiting ? 'tool.parked.waiting' : 'tool.parked.past')}</>)
            : ev.result !== undefined && (<><div className="label">{t('tool.resultLabel')}</div><MaskedText text={toolResultText(ev, t)} masked={masked} /></>)}
        </div>
      </AnimatedCollapse>
    </div>
  )
}

export const ToolGroup: React.FC<{
  events: ToolEvent[]
  running?: boolean
  approvals?: ApprovalRequest[]
  /** 这条消息有待答的提问 / 计划拍板(托盘里):挂着的 ask_user / exit_plan_mode 显示「等你回复」而不是在跑。 */
  awaitingAnswer?: boolean
  /** 这一条带着的思考原文(整条消息只有一份,挂在回答里第一条过程行上);没有工具时也画,只剩思考那一步。 */
  reasoning?: string
  /** 思考用时(本次运行里由 appStore 记;历史消息没有)。 */
  reasoningMs?: number
  /** 思考正在进行(这一行是消息里最后一块时才传 true)。 */
  thinking?: boolean
  /** 这组调用所在的会话(「从不遮住」写进跑这个会话的那台引擎)。 */
  sessionId?: string
}> = ({ events: allEvents, running, approvals, awaitingAnswer, reasoning, reasoningMs, thinking: thinkingProp, sessionId }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  // Agent 自己写成了的记忆 / 进化记录 / 协作说明,由回复下面的回执行和请求卡呈现,这里不再重复列一行(没写成的照旧留着)。
  // 唯一不带回执行的调用方是外观预览(ChatPreview),它的样例消息里没有这三种调用。
  const events = allEvents.filter((ev) => !isSelfWriteReceipt(ev))
  if (!events.length && !reasoning) return null

  // generate_image gets a full-size dot field while the request is in flight. Completed calls return
  // to the ordinary audit trail; only the active row is replaced, so mixed/parallel tool groups keep context.
  const activeImageJobs = running ? events.filter((event) => (event.name === 'generate_image' || event.name === 'edit_image') && !event.done) : []
  const groupedEvents = activeImageJobs.length ? events.filter((event) => !activeImageJobs.includes(event)) : events
  const descs = groupedEvents.map(describeTool)
  const counts = { write: 0, edit: 0, run: 0, read: 0, search: 0, browse: 0, other: 0 } as Record<Kind, number>
  descs.forEach((d) => { counts[d.kind]++ })
  const SUM: Record<Kind, string> = {
    write: 'tool.sum.wrote', edit: 'tool.sum.edited', run: 'tool.sum.ran', read: 'tool.sum.read',
    search: 'tool.sum.searched', browse: 'tool.sum.browsed', other: 'tool.sum.other',
  }
  const order: Kind[] = ['write', 'edit', 'run', 'read', 'search', 'browse', 'other']
  const thinking = !!running && !!thinkingProp && !!reasoning
  const thinkLabel = reasoning ? (thinking ? t('tool.thinkingNow') : thoughtLabel(t, reasoningMs)) : ''
  const summary = [...(thinking ? [] : [thinkLabel]), ...order.filter((k) => counts[k] > 0).map((k) => t(SUM[k], { n: counts[k] }))].filter(Boolean).join(' · ')
  const shortSummary = [...(thinking ? [] : [thinkLabel]), groupedEvents.length ? t('tool.sumN', { n: groupedEvents.length }) : ''].filter(Boolean).join(' · ') || thinkLabel

  // 挂起的 ask_user(托盘 run,10-23)已经有占位结果(done),仍在等你答 —— 它那一段可能已经收尾(切段),不看 running
  const asksYou = (e: ToolEvent): boolean => !!awaitingAnswer && ASKS_YOU.has(e.name) && (!!e.parked || (!!running && !e.done))
  const allDone = groupedEvents.every((e) => e.done)
  const anyErr = groupedEvents.some((e) => e.isError)
  // 挂起的调用「还在等你」= 它那张审批仍 pending(审批与工具卡按 toolCallId 对上;重载后审批不在 → 只算「当时挂起」)
  const waitingIds = new Set((approvals || []).filter((a) => a.status === 'pending' && a.toolCallId).map((a) => a.toolCallId!))
  const anyParked = groupedEvents.some((e) => e.parked)
  // 挂起的提问还在等你答:agent 在干别的(当前步骤照常写在头上),暂停图标标出「这组里有个问题等你」
  const parkedAsk = groupedEvents.some((e) => e.parked && asksYou(e))
  // 运行中:展示第一个未完成的调用作为「当前」;都完成则无。思考中优先(它是这一行最新的动静)。
  const curIdx = running && !thinking ? groupedEvents.findIndex((e) => !e.done) : -1
  const curAsks = curIdx >= 0 && asksYou(groupedEvents[curIdx])
  const active = !!running && groupedEvents.length > 0 && !allDone && !curAsks
  const busy = active || thinking
  const curDesc = curIdx >= 0 ? descs[curIdx] : null
  const curVerb = curDesc ? (curDesc.verbKey ? t(curDesc.verbKey) : groupedEvents[curIdx].name) : ''
  const showList = !!reasoning || groupedEvents.length > 0
  const masked = collectMasked(groupedEvents)

  return (
    <>
      {showList && (
        <div className="tool-group">
          <button className="tool-group-head" aria-busy={busy} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span className="tool-group-ic">{open ? <ChevronDown size={13} /> : busy ? <Dots /> : <ChevronRight size={13} />}</span>
            <RollLine k={open ? 'sum' : thinking ? 'think' : curAsks ? 'ask' : curDesc ? `cur-${groupedEvents[curIdx].id}` : 'sum'}>
            {!open && thinking ? (
              <span className="tool-group-cur"><span className="tool-group-cur-copy chat-run-shimmer-text">{thinkLabel}</span></span>
            ) : !open && curAsks ? (
              <span className="tool-group-cur" data-waiting-you="1">
                <span className="tool-group-cur-copy">{t('tool.waitingYou')}</span>
              </span>
            ) : !open && curDesc ? (
              <span className="tool-group-cur">
                <span className="tool-group-cur-copy chat-run-shimmer-text">
                  {curVerb}{' '}
                  <span className={curDesc.isFile ? 'file' : undefined}>{curDesc.target}</span>…
                </span>
                {groupedEvents.length > 1 && <span className="tool-group-step"> · {t('tool.step', { n: curIdx + 1 })}</span>}
              </span>
            ) : (
              // key:「正在做」和「汇总」不共用节点,换态时旧节点上的流光随节点一起拆掉
              <span key="sum" className={`tool-group-sum${busy ? ' chat-run-shimmer-text' : ''}`}>
                <span className="tool-group-sum-long">{summary || thinkLabel}</span>
                <span className="tool-group-sum-short">{shortSummary}</span>
              </span>
            )}
            </RollLine>
            {masked.length > 0 && <MaskTag masked={masked} sessionId={sessionId} />}
            <span className="tool-group-status">
              {anyParked ? (parkedAsk
                ? <PauseCircle size={13} style={{ color: 'var(--accent-ink)' }} data-waiting-you="1" aria-label={t('tool.waitingYou')}><title>{t('tool.waitingYou')}</title></PauseCircle>
                : <PauseCircle size={13} style={{ color: groupedEvents.some((e) => e.parked && waitingIds.has(e.id)) ? 'var(--accent-ink)' : 'var(--text-faint)' }} />)
                : allDone && anyErr ? <XCircle size={13} style={{ color: 'var(--danger)' }} /> : null}
            </span>
          </button>
          <AnimatedCollapse open={open}>
            <div className="tool-group-list">
              {!!reasoning && <ThinkRow reasoning={reasoning} label={thinkLabel} thinking={thinking} />}
              {groupedEvents.map((ev, i) => <ToolRow key={ev.id} ev={ev} desc={descs[i]} running={!!running} waiting={waitingIds.has(ev.id)} asking={asksYou(ev)} masked={masked} />)}
            </div>
          </AnimatedCollapse>
        </div>
      )}
      {!!activeImageJobs.length && (
        <div className="image-generation-jobs" aria-busy="true">
          {activeImageJobs.map((event) => <ImageGenerationLoader key={event.id} />)}
        </div>
      )}
    </>
  )
}
