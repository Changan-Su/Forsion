/**
 * 工具调用分组(参考 Codex):一条助手消息内的连读工具调用聚合成一张可折叠卡。
 * 折叠时:运行中→显示「正在 <动作> <目标>」当前那一个;完成→聚合摘要(如「编辑3文件 · 运行6命令」)。
 * 展开:每个调用一紧凑行(动作 + 目标 + 可选 +增/-删),每行可再展开看完整参数/结果。
 * 复用 .tool-card-body/.label 样式;+增/-删 best-effort(算不出就只显目标)。
 */
import React, { useMemo, useState } from 'react'
import { ChevronRight, ChevronDown, XCircle, CheckCircle2, Terminal, PauseCircle } from 'lucide-react'
import { AnimatedCollapse } from './AnimatedUI'
import { DiffView } from './DiffView'
import { toolDiffText } from './toolDiff'
import { registerMessages, useI18n } from '../i18n'
import type { ApprovalRequest, ToolEvent } from '../types'
import { ImageGenerationLoader } from '../views/chat2/ImageGenerationLoader'

registerMessages({
  'tool.parked.waiting': { zh: '已挂起，等你在输入框上方批准。Agent 先做别的，拍板后结果会补在这里。', en: 'Parked until you approve it above the input box. The agent carries on meanwhile; the result lands here once you decide.' },
  'tool.parked.past': { zh: '当时挂起等你批准，结局见后面的审批结果。', en: 'This call was parked for your approval; see the approval result further down.' },
  // 不写「在输入框上方」:紧挨着的指路行 / 计划卡 / 团队 work 行已经说了在哪答,这里再写一遍是重复
  'tool.waitingYou': { zh: '等你回复', en: 'Waiting for your reply' },
  'tool.verb.readComputerHistory': { zh: '读取电脑历史', en: 'Read computer history' },
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
    case 'sketch':
      return { kind: 'other', verbKey: 'tool.verb.sketched', target: String(a.title ?? '') || 'sketch', isFile: false }
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

const ToolRow: React.FC<{ ev: ToolEvent; desc: Desc; running: boolean; waiting: boolean; asking?: boolean }> = ({ ev, desc, running, waiting, asking }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  // 只在展开时构造 diff(P1:文件修改类工具详情渲染 diff 而非裸 JSON)
  const diff = useMemo(() => (open ? toolDiffText(ev.name, ev.arguments) : null), [open, ev.name, ev.arguments])
  const verb = desc.verbKey ? t(desc.verbKey) : ev.name
  // 工具结果帧可能在用户停止 run 时来不及抵达。此时 ev.done 仍为 false，
  // 但父消息已不再运行，不能继续显示「正在执行」的流光或 busy 语义。
  const active = running && !ev.done && !asking
  return (
    <div className="tool-row">
      <button className="tool-row-head" aria-busy={active} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="tool-row-copy">
          <span className={`tool-row-copy-text${active ? ' chat-run-shimmer-text' : ''}`}>
            <span className="tool-row-verb">{verb}</span>
            <span className={`tool-row-target${desc.isFile ? ' file' : ''}`}>{desc.target}</span>
          </span>
        </span>
        <Stat d={desc} />
        <span className="tool-row-status">
          {asking ? <PauseCircle size={11} style={{ color: 'var(--accent-ink)' }} data-waiting-you="1" aria-label={t('tool.waitingYou')}><title>{t('tool.waitingYou')}</title></PauseCircle>
            : ev.parked ? <PauseCircle size={11} style={{ color: waiting ? 'var(--accent-ink)' : 'var(--text-faint)' }} />
            : ev.done && ev.isError ? <XCircle size={11} style={{ color: 'var(--danger)' }} /> : null}
        </span>
      </button>
      <AnimatedCollapse open={open}>
        <div className="tool-card-body">
          {diff ? (
            <>
              <DiffView text={diff} side={false} />
              {ev.arguments && (
                <details className="tool-raw-args">
                  <summary>{t('tool.argsLabel')}</summary>
                  {fmtArgs(ev.arguments)}
                </details>
              )}
            </>
          ) : ev.arguments ? (<><div className="label">{t('tool.argsLabel')}</div>{fmtArgs(ev.arguments)}</>) : null}
          {/* 挂起的占位结果是写给模型的英文说明,对人换成一句本地化的状态 */}
          {ev.parked ? (<><div className="label">{t('tool.resultLabel')}</div>{t(waiting ? 'tool.parked.waiting' : 'tool.parked.past')}</>)
            : ev.result !== undefined && (<><div className="label">{t('tool.resultLabel')}</div>{toolResultText(ev, t)}</>)}
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
}> = ({ events, running, approvals, awaitingAnswer }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  if (!events.length) return null

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
  const summary = order.filter((k) => counts[k] > 0).map((k) => t(SUM[k], { n: counts[k] })).join(' · ')

  const asksYou = (e: ToolEvent): boolean => !!awaitingAnswer && !!running && !e.done && ASKS_YOU.has(e.name)
  const allDone = groupedEvents.every((e) => e.done)
  const anyErr = groupedEvents.some((e) => e.isError)
  // 挂起的调用「还在等你」= 它那张审批仍 pending(审批与工具卡按 toolCallId 对上;重载后审批不在 → 只算「当时挂起」)
  const waitingIds = new Set((approvals || []).filter((a) => a.status === 'pending' && a.toolCallId).map((a) => a.toolCallId!))
  const anyParked = groupedEvents.some((e) => e.parked)
  // 运行中:展示第一个未完成的调用作为「当前」;都完成则无。
  const curIdx = running ? groupedEvents.findIndex((e) => !e.done) : -1
  const curAsks = curIdx >= 0 && asksYou(groupedEvents[curIdx])
  const active = !!running && groupedEvents.length > 0 && !allDone && !curAsks
  const curDesc = curIdx >= 0 ? descs[curIdx] : null
  const curVerb = curDesc ? (curDesc.verbKey ? t(curDesc.verbKey) : groupedEvents[curIdx].name) : ''

  return (
    <>
      {!!groupedEvents.length && (
        <div className="tool-group">
          <button className="tool-group-head" aria-busy={active} onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Terminal size={12} className="tool-group-ic" />
            {!open && curAsks ? (
              <span className="tool-group-cur" data-waiting-you="1">
                <span className="tool-group-cur-copy">{t('tool.waitingYou')}</span>
              </span>
            ) : !open && curDesc ? (
              <span className="tool-group-cur">
                <span className="tool-group-cur-copy chat-run-shimmer-text">
                  {curVerb}{' '}
                  <span className={curDesc.isFile ? 'file' : undefined}>{curDesc.target}</span>…
                </span>
              </span>
            ) : (
              <span className={`tool-group-sum${active ? ' chat-run-shimmer-text' : ''}`}>{summary}</span>
            )}
            <span className="tool-group-status">
              {anyParked ? <PauseCircle size={13} style={{ color: groupedEvents.some((e) => e.parked && waitingIds.has(e.id)) ? 'var(--accent-ink)' : 'var(--text-faint)' }} />
                : allDone ? (anyErr ? <XCircle size={13} style={{ color: 'var(--danger)' }} /> : <CheckCircle2 size={13} style={{ color: 'var(--green)' }} />) : null}
            </span>
          </button>
          <AnimatedCollapse open={open}>
            <div className="tool-group-list">
              {groupedEvents.map((ev, i) => <ToolRow key={ev.id} ev={ev} desc={descs[i]} running={!!running} waiting={waitingIds.has(ev.id)} asking={asksYou(ev)} />)}
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
