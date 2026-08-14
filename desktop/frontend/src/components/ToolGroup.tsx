/**
 * 工具调用分组(参考 Codex):一条助手消息内的连读工具调用聚合成一张可折叠卡。
 * 折叠时:运行中→显示「正在 <动作> <目标>」当前那一个;完成→聚合摘要(如「编辑3文件 · 运行6命令」)。
 * 展开:每个调用一紧凑行(动作 + 目标 + 可选 +增/-删),每行可再展开看完整参数/结果。
 * 复用 .tool-card-body/.label 样式;+增/-删 best-effort(算不出就只显目标)。
 */
import React, { useMemo, useState } from 'react'
import { ChevronRight, ChevronDown, Loader2, XCircle, CheckCircle2, Terminal } from 'lucide-react'
import { AnimatedCollapse } from './AnimatedUI'
import { DiffView } from './DiffView'
import { toolDiffText } from './toolDiff'
import { useI18n } from '../i18n'
import type { ToolEvent } from '../types'

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

const ToolRow: React.FC<{ ev: ToolEvent; desc: Desc }> = ({ ev, desc }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  // 只在展开时构造 diff(P1:文件修改类工具详情渲染 diff 而非裸 JSON)
  const diff = useMemo(() => (open ? toolDiffText(ev.name, ev.arguments) : null), [open, ev.name, ev.arguments])
  const verb = desc.verbKey ? t(desc.verbKey) : ev.name
  return (
    <div className="tool-row">
      <button className="tool-row-head" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="tool-row-verb">{verb}</span>
        <span className={`tool-row-target${desc.isFile ? ' file' : ''}`}>{desc.target}</span>
        <Stat d={desc} />
        <span className="tool-row-status">
          {!ev.done ? <Loader2 size={11} className="spin" /> : ev.isError ? <XCircle size={11} style={{ color: 'var(--danger)' }} /> : null}
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
          {ev.result !== undefined && (<><div className="label">{t('tool.resultLabel')}</div>{ev.result || t('tool.empty')}</>)}
        </div>
      </AnimatedCollapse>
    </div>
  )
}

export const ToolGroup: React.FC<{ events: ToolEvent[]; running?: boolean }> = ({ events, running }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  if (!events.length) return null

  const descs = events.map(describeTool)
  const counts = { write: 0, edit: 0, run: 0, read: 0, search: 0, browse: 0, other: 0 } as Record<Kind, number>
  descs.forEach((d) => { counts[d.kind]++ })
  const SUM: Record<Kind, string> = {
    write: 'tool.sum.wrote', edit: 'tool.sum.edited', run: 'tool.sum.ran', read: 'tool.sum.read',
    search: 'tool.sum.searched', browse: 'tool.sum.browsed', other: 'tool.sum.other',
  }
  const order: Kind[] = ['write', 'edit', 'run', 'read', 'search', 'browse', 'other']
  const summary = order.filter((k) => counts[k] > 0).map((k) => t(SUM[k], { n: counts[k] })).join(' · ')

  const allDone = events.every((e) => e.done)
  const anyErr = events.some((e) => e.isError)
  // 运行中:展示第一个未完成的调用作为「当前」;都完成则无。
  const curIdx = running ? events.findIndex((e) => !e.done) : -1
  const curDesc = curIdx >= 0 ? descs[curIdx] : null
  const curVerb = curDesc ? (curDesc.verbKey ? t(curDesc.verbKey) : events[curIdx].name) : ''

  return (
    <div className="tool-group">
      <button className="tool-group-head" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Terminal size={12} className="tool-group-ic" />
        {!open && curDesc ? (
          <span className="tool-group-cur">{curVerb} <span className={curDesc.isFile ? 'file' : ''}>{curDesc.target}</span>…</span>
        ) : (
          <span className="tool-group-sum">{summary}</span>
        )}
        <span className="tool-group-status">
          {!allDone ? <Loader2 size={13} className="spin" /> : anyErr ? <XCircle size={13} style={{ color: 'var(--danger)' }} /> : <CheckCircle2 size={13} style={{ color: 'var(--green)' }} />}
        </span>
      </button>
      <AnimatedCollapse open={open}>
        <div className="tool-group-list">
          {events.map((ev, i) => <ToolRow key={ev.id} ev={ev} desc={descs[i]} />)}
        </div>
      </AnimatedCollapse>
    </div>
  )
}
