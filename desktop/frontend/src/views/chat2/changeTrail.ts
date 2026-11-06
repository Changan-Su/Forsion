/**
 * Agent 改了哪些文件:回执行(每轮回复下面)、任务概览「改动」卡、Desk 审阅页共用的数据。
 * 方案页:仓根 docs/ToBeImproved/文件改动记录方案_2026-11-06/(2026-11-06 用户选 A + C)。
 *
 * 来源 = 引擎检查点(每轮写之前留的原样)对比之后的样子,引擎逐行算(GET /agent/sessions/:id/changes),
 * 所以增减和行号都是文件里的真数,不是工具参数片段的行数。只记 Agent 用写文件工具改的;命令(run_bash)
 * 改的检查点不记 —— 界面上如实写明,「未提交」档(会话绑了 Git 时)能看到全部但只看不撤。
 *
 * 一轮 = 一条用户消息到下一条用户消息之间;回执挂在这一轮最后一条助手消息上。分界用用户消息的时间戳,
 * 和检查点的 at 是同一台引擎的时钟(消息菜单的「回退」也是这么对的)。
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import {
  changesDiff, gitChanges, listChanges, restoreCheckpoint,
  type ChangeWindowInfo, type FileChange, type GitChangesInfo,
} from '../../services/backendService'
import { targetForSession } from '../../services/engine/targets'
import { targetCaps } from '../../services/engine/targetCaps'
import { useApp } from '../../stores/appStore'
import { registerMessages, translate } from '../../i18n'
import type { UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'

export type { FileChange, GitChangesInfo }

registerMessages({
  'changes.undo.done': { zh: '已撤销 {n} 个文件', en: 'Undid {n} file(s)' },
  'changes.undo.kept': { zh: '已撤销 {n} 个文件；{kept} 个在 Tangu 改完后又被改过，原样留着', en: 'Undid {n} file(s); {kept} changed again after Tangu’s edit were left as they are' },
  'changes.undo.skipped': { zh: '已撤销 {n} 个文件；{bad} 个当时没存下原样，撤销不了', en: 'Undid {n} file(s); {bad} had no saved copy and can’t be undone' },
  'changes.undo.failed': { zh: '{bad} 个文件撤销失败', en: '{bad} file(s) couldn’t be undone' },
  'changes.undo.busy': { zh: '正在运行，先停下再撤销', en: 'A run is in progress — stop it before undoing' },
  'changes.undo.error': { zh: '撤销失败：{e}', en: 'Undo failed: {e}' },
})

export interface TurnWindow { since: number; until: number | null }

/** 每轮的范围,和每轮的回执挂在哪条消息上。 */
export function planTurns(messages: readonly UiMessage[]): { bounds: number[]; byMsg: Record<string, TurnWindow> } {
  const bounds: number[] = []
  const byMsg: Record<string, TurnWindow> = {}
  let since: number | null = null
  let lastAsst: string | null = null
  const close = (until: number | null): void => { if (since != null && lastAsst) byMsg[lastAsst] = { since, until } }
  for (const m of messages) {
    if (m.role === 'user') {
      if (!m.timestamp) continue
      // 时间往回走(乐观消息先用本机时间、之后才换成引擎的):不另起一段,免得分界倒序
      if (since != null && m.timestamp <= since) continue
      close(m.timestamp)
      since = m.timestamp
      lastAsst = null
      bounds.push(since)
    } else if (m.role === 'assistant' && since != null) {
      lastAsst = m.id
    }
  }
  close(null)
  return { bounds, byMsg }
}

type Status = 'loading' | 'ok' | 'unsupported' | 'error'
interface SessionTrail {
  key: string
  status: Status
  /** 按段起点索引。 */
  windows: Record<number, ChangeWindowInfo>
  byMsg: Record<string, TurnWindow>
  bounds: number[]
}
interface Store {
  by: Record<string, SessionTrail>
  /** 「本会话」一段([0,∞))的列表,任务概览切到「本会话」/ 审阅页才拉。 */
  session: Record<string, { key: string; status: Status; files: FileChange[] }>
  /** 逐文件 diff 缓存:`${sid}|${since}|${until}|${path}`。 */
  diffs: Record<string, FileChange | 'loading' | 'error'>
  /** 撤销等动作之后加一,强制重拉。 */
  rev: Record<string, number>
  /** 任务概览「改动」卡看本轮还是本会话:这台电脑上全局记住(方案定的细节)。 */
  scope: CardScope
  /** 审阅页的跳转请求(点卡里某个文件 → 已经开着的审阅页就地切档、滚过去;n 每次加一)。 */
  review: Record<string, { scope: ReviewScope; focus?: string; n: number }>
}
export type CardScope = 'turn' | 'session'
export type ReviewScope = CardScope | 'git'
const SCOPE_KEY = 'forsion.changes.scope'
const readScope = (): CardScope => {
  try { return localStorage.getItem(SCOPE_KEY) === 'session' ? 'session' : 'turn' } catch { return 'turn' }
}
export const useChangeTrail = create<Store>(() => ({ by: {}, session: {}, diffs: {}, rev: {}, scope: readScope(), review: {} }))
export function setCardScope(scope: CardScope): void {
  useChangeTrail.setState({ scope })
  try { localStorage.setItem(SCOPE_KEY, scope) } catch { /* 存不下就只管这次 */ }
}
/** 让审阅页切到某一档、滚到某个文件(审阅页订阅;没开着就由打开它的人带着 params 开)。 */
export function requestReview(sid: string, scope: ReviewScope, focus?: string): void {
  useChangeTrail.setState((s) => ({ review: { ...s.review, [sid]: { scope, focus, n: (s.review[sid]?.n ?? 0) + 1 } } }))
}

const isMissing = (e: unknown): boolean => {
  const s = (e as { status?: number })?.status
  return s === 404 || s === 405 || s === 501
}

/** 引擎旧版本没有这条路由:这次运行里不再问(换版本要重启应用,自然清掉)。 */
const unsupportedTargets = new Set<string>()

async function fetchWindows(sid: string, entry: SessionTrail): Promise<void> {
  const t = targetForSession(sid)
  if (unsupportedTargets.has(t.key)) { patch(sid, { ...entry, status: 'unsupported' }); return }
  try {
    const wins = await listChanges(t, sid, entry.bounds)
    const windows: Record<number, ChangeWindowInfo> = {}
    for (const w of wins) windows[w.since] = w
    if (useChangeTrail.getState().by[sid]?.key !== entry.key) return // 期间又变了,以新的为准
    patch(sid, { ...entry, status: 'ok', windows })
  } catch (e) {
    if (isMissing(e)) unsupportedTargets.add(t.key)
    if (useChangeTrail.getState().by[sid]?.key !== entry.key) return
    // 读失败 ≠ 没改动:留着上一份(没有上一份就不画),不当成「这轮没改文件」
    const prev = useChangeTrail.getState().by[sid]
    patch(sid, { ...entry, status: isMissing(e) ? 'unsupported' : 'error', windows: prev?.windows ?? {} })
  }
}
const patch = (sid: string, entry: SessionTrail): void => useChangeTrail.setState((s) => ({ by: { ...s.by, [sid]: entry } }))

/**
 * ChatView 里调一次:按当前消息切出每一轮,运行停下 / 消息变了 / 撤销之后重拉一次。
 * 运行中不拉:最新一轮还在变,旧的几轮照用上一份。
 */
export function useChangeTrailDriver(sid: string | null | undefined, messages: readonly UiMessage[], running: boolean): void {
  const rev = useChangeTrail((s) => (sid ? s.rev[sid] ?? 0 : 0))
  // 键里只放会影响结果的:分界、最后一条的身份与状态、撤销次数。流式的正文不进键
  const plan = planTurns(messages)
  const last = messages[messages.length - 1]
  const key = `${plan.bounds.join(',')}|${last?.id ?? ''}:${last?.status ?? ''}|${rev}`
  const byMsgKey = JSON.stringify(plan.byMsg)
  useEffect(() => {
    if (!sid || !plan.bounds.length) return
    const cur = useChangeTrail.getState().by[sid]
    if (running) {
      // 跑着的时候不拉,但分界先跟上:上一轮从「最新」变成「更早」,它的回执照常挂着(改动没变,只是 until 有了);
      // 新的一轮还没有数据,回执和「本轮」都等跑完
      if (cur && cur.bounds.join(',') !== plan.bounds.join(',')) patch(sid, { ...cur, byMsg: plan.byMsg, bounds: plan.bounds })
      return
    }
    if (cur?.key === key && cur.status !== 'error') return
    const entry: SessionTrail = { key, status: 'loading', windows: cur?.windows ?? {}, byMsg: plan.byMsg, bounds: plan.bounds }
    patch(sid, entry)
    void fetchWindows(sid, entry)
    // byMsgKey 已经由 key 覆盖(分界 + 最后一条),这里只为 lint
  }, [sid, running, key, byMsgKey]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** 某条消息下面的回执:这一轮的范围与文件;没有(不是这一轮最后一条 / 没改文件 / 还没拉到)= null。 */
export function useMessageChanges(sid: string | undefined, msgId: string): { win: TurnWindow; files: FileChange[]; latest: boolean } | null {
  const win = useChangeTrail((s) => (sid ? s.by[sid]?.byMsg[msgId] : undefined))
  const info = useChangeTrail((s) => (sid && win ? s.by[sid]?.windows[win.since] : undefined))
  if (!win || !info || !info.files.length) return null
  return { win, files: info.files, latest: win.until == null }
}

/** 最新一轮(任务概览「本轮」)。 */
export function useLatestTurnChanges(sid: string | null | undefined): { win: TurnWindow; files: FileChange[] } | null {
  const tr = useChangeTrail((s) => (sid ? s.by[sid] : undefined))
  if (!tr || !tr.bounds.length) return null
  const since = tr.bounds[tr.bounds.length - 1]
  const info = tr.windows[since]
  return info ? { win: { since, until: null }, files: info.files } : null
}

/** 引擎有没有这项能力(没有 = 旧引擎 / 云端会话):卡片和审阅页据此不画。 */
export function useChangesSupported(sid: string | null | undefined): boolean {
  return useChangeTrail((s) => (sid ? s.by[sid]?.status !== 'unsupported' : false))
}

/** 这个会话里有没有哪一轮改过文件(任务概览「改动」卡在不在,不另外拉「本会话」)。 */
export function useHasChanges(sid: string | null | undefined): boolean {
  return useChangeTrail((s) => {
    const tr = sid ? s.by[sid] : undefined
    if (!tr || tr.status === 'unsupported') return false
    for (const k in tr.windows) if (tr.windows[k].files.length) return true
    return false
  })
}

/** 任务概览「改动」卡的数据:本轮 = 最新一轮;本会话 = [0,∞) 整段(切过去才拉)。 */
export function useChangesCard(sid: string | null | undefined): {
  show: boolean; scope: CardScope; win: TurnWindow | null; files: FileChange[]; loading: boolean
} {
  const show = useHasChanges(sid)
  const scope = useChangeTrail((s) => s.scope)
  const latest = useLatestTurnChanges(sid)
  const session = useSessionChanges(sid, show && scope === 'session')
  if (scope === 'session') {
    return { show, scope, win: { since: 0, until: null }, files: session.files, loading: session.status === 'loading' && !session.files.length }
  }
  return { show, scope, win: latest?.win ?? null, files: latest?.files ?? [], loading: false }
}

/** 「本会话」一段([0,∞)):按需拉,键跟着回合分界走(新一轮结束就重拉)。 */
export function useSessionChanges(sid: string | null | undefined, enabled: boolean): { status: Status; files: FileChange[] } {
  const turnKey = useChangeTrail((s) => (sid ? s.by[sid]?.key : undefined))
  const entry = useChangeTrail((s) => (sid ? s.session[sid] : undefined))
  useEffect(() => {
    if (!sid || !enabled || !turnKey) return
    if (entry?.key === turnKey && entry.status !== 'error') return
    const t = targetForSession(sid)
    if (unsupportedTargets.has(t.key)) return
    useChangeTrail.setState((s) => ({ session: { ...s.session, [sid]: { key: turnKey, status: 'loading', files: entry?.files ?? [] } } }))
    listChanges(t, sid).then((wins) => {
      useChangeTrail.setState((s) => ({ session: { ...s.session, [sid]: { key: turnKey, status: 'ok', files: wins[0]?.files ?? [] } } }))
    }, (e) => {
      if (isMissing(e)) unsupportedTargets.add(t.key)
      useChangeTrail.setState((s) => ({ session: { ...s.session, [sid]: { key: turnKey, status: isMissing(e) ? 'unsupported' : 'error', files: s.session[sid]?.files ?? [] } } }))
    })
  }, [sid, enabled, turnKey]) // eslint-disable-line react-hooks/exhaustive-deps
  return { status: entry?.status ?? 'loading', files: entry?.files ?? [] }
}

const diffKey = (sid: string, w: TurnWindow, path: string): string => `${sid}|${w.since}|${w.until ?? ''}|${path}`

/** 一个文件在一段里的 diff(展开时才拉;同一个键只拉一次,撤销后随 rev 清掉)。 */
export function useFileDiff(sid: string | undefined, w: TurnWindow, path: string, enabled: boolean): FileChange | 'loading' | 'error' | undefined {
  const k = sid ? diffKey(sid, w, path) : ''
  const v = useChangeTrail((s) => (k ? s.diffs[k] : undefined))
  useEffect(() => {
    if (!sid || !enabled || v !== undefined) return
    useChangeTrail.setState((s) => ({ diffs: { ...s.diffs, [k]: 'loading' } }))
    changesDiff(targetForSession(sid), sid, { since: w.since, until: w.until, path }).then((files) => {
      const f = files.find((x) => x.path === path) ?? files[0]
      useChangeTrail.setState((s) => ({ diffs: { ...s.diffs, [k]: f ?? 'error' } }))
    }, () => useChangeTrail.setState((s) => ({ diffs: { ...s.diffs, [k]: 'error' } })))
  }, [sid, k, enabled, v]) // eslint-disable-line react-hooks/exhaustive-deps
  return v
}

/** 一段里全部文件的 diff(审阅页一次拉)。 */
export async function loadWindowDiffs(sid: string, w: TurnWindow): Promise<FileChange[]> {
  return changesDiff(targetForSession(sid), sid, { since: w.since, until: w.until })
}
export async function loadGitChanges(sid: string): Promise<GitChangesInfo> {
  return gitChanges(targetForSession(sid), sid)
}

/** 这个会话所在的引擎能不能撤销(经 hub 的「我的电脑」不能:恢复是 deny-remote)。 */
export function canUndoChanges(sid: string | undefined): boolean {
  return !!sid && targetCaps(targetForSession(sid)).checkpointRestore
}

/** 撤销:把 paths 恢复到 at 之前(at = 那一轮的起点)。Agent 写完之后又被改过的文件不覆盖,如实报出来。 */
export async function undoChanges(sid: string, at: number, paths: string[]): Promise<boolean> {
  const app = useApp.getState()
  if (app.runningBySession[sid]) { app.toast(translate('changes.undo.busy'), true); return false }
  try {
    const r = await restoreCheckpoint(targetForSession(sid), sid, at, { paths, keepEdited: true })
    const n = r.restored.length + r.deleted.length
    if (r.failed.length) app.toast(translate('changes.undo.failed', { bad: r.failed.length }), true)
    else if (r.conflicts?.length) app.toast(translate('changes.undo.kept', { n, kept: r.conflicts.length }), true)
    else if (r.skipped.length) app.toast(translate('changes.undo.skipped', { n, bad: r.skipped.length }), true)
    else app.toast(translate('changes.undo.done', { n }))
    return true
  } catch (e) {
    app.toast(translate('changes.undo.error', { e: (e as Error)?.message || String(e) }), true)
    return false
  } finally {
    // 不管成败都重拉:失败也可能撤了一部分
    useChangeTrail.setState((s) => ({
      rev: { ...s.rev, [sid]: (s.rev[sid] ?? 0) + 1 },
      diffs: Object.fromEntries(Object.entries(s.diffs).filter(([k]) => !k.startsWith(`${sid}|`))),
    }))
  }
}

/** 合计增减(比不了的文件不计)。 */
export function totals(files: readonly FileChange[]): { adds: number; dels: number } {
  let adds = 0, dels = 0
  for (const f of files) { adds += f.adds ?? 0; dels += f.dels ?? 0 }
  return { adds, dels }
}

/** 显示用:文件名 + 相对会话目录的文件夹(不在目录里的用 ~ 缩写)。 */
export function splitPath(abs: string, cwd?: string, home?: string): { name: string; dir: string } {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = norm(abs)
  const i = p.lastIndexOf('/')
  const name = i >= 0 ? p.slice(i + 1) : p
  let dir = i > 0 ? p.slice(0, i) : ''
  const c = cwd ? norm(cwd) : ''
  if (c && (dir === c || dir.startsWith(c + '/'))) dir = dir.slice(c.length + 1)
  else if (home && dir.startsWith(norm(home) + '/')) dir = '~' + dir.slice(norm(home).length)
  return { name, dir }
}

/** 文字类文件(按字标、换行、正文字体)。 */
export const isProsePath = (p: string): boolean => /\.(md|markdown|mdx|txt|text|rst|org|adoc|tex)$/i.test(p)
