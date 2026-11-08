/**
 * 「今日简报」(Muse Space 主区,方案 D 第一期)的数据:布局、待办、在跟的、今天的手记、卜算子状态。
 * 简报页和主页上的「待你看的 / 在跟的」两张小组件共用这些 hook;每个 hook 自己串行轮询(上一次结束再等),卸载即停。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getAgentSchedules, getMuseLibraryFile, getMuseSpace, getMuseStatus, getMuseTodos, injectMuseTodos, patchMuseTodo,
  postMuseFeedback, postMuseSpacePlacement,
} from '../../services/backendService'
import { homeTarget } from '../../services/engine/targets'
import { openNewChat, openSession } from '../../sessionNav'
import { useApp } from '../../stores/appStore'
import { translate } from '../../i18n'
import type { AgentScheduleEntry, MusePlacementOp, MuseSpaceView, MuseStatusInfo, MuseTodo } from '../../types'

/** 串行轮询:上一次结束后再等 ms;fn 抛错 = 留着上一份,不清空(读失败 ≠ 空)。 */
function usePolled<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []): { data: T | undefined; error: unknown; refresh: () => Promise<void> } {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<unknown>(null)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const gen = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const g = ++gen.current
    try { const v = await fnRef.current(); if (g === gen.current) { setData(v); setError(null) } } catch (e) { if (g === gen.current) setError(e) }
  }, [])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const loop = async (): Promise<void> => {
      if (!alive) return
      await refresh()
      if (alive) timer = setTimeout(() => void loop(), ms)
    }
    void loop()
    return () => { alive = false; gen.current++; if (timer) clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error, refresh }
}

const isMissing = (e: unknown): boolean => (e as { status?: number } | null)?.status === 404

/** 布局:8 秒一轮(两份小 JSON + 三个 stat,引擎那边很便宜)。apply = 你的一下;409(别处刚改过)→ 重读,不报错。 */
export function useMuseSpaceView(): {
  view: MuseSpaceView | null | undefined
  /** 旧引擎没有这条读口:主区照画内置卡 */
  unsupported: boolean
  failed: boolean
  refresh: () => Promise<void>
  apply: (op: MusePlacementOp) => Promise<boolean>
} {
  const [local, setLocal] = useState<MuseSpaceView | null>(null)
  const { data, error, refresh } = usePolled(async () => {
    const v = await getMuseSpace(homeTarget())
    // 回了 200 却没有 view(代理 / 不认识这条路由的引擎给的空壳):当没有这条读口,否则一直停在加载态、主区空白
    if (!v || typeof v !== 'object' || !Array.isArray((v as MuseSpaceView).cards)) throw Object.assign(new Error('no muse space view'), { status: 404 })
    return v
  }, 8000)
  useEffect(() => { if (data) setLocal(data) }, [data])
  const view = local ?? data
  const apply = useCallback(async (op: MusePlacementOp): Promise<boolean> => {
    const cur = local ?? data
    if (!cur) return false
    try {
      setLocal(await postMuseSpacePlacement(homeTarget(), cur.rev.placement, op))
      // 写之前发出的那轮轮询还在路上:refresh 让它作废(usePolled 按代数丢旧结果),否则它回来会把刚摆好的盖回去
      void refresh()
      return true
    } catch (e) {
      if ((e as { status?: number }).status === 409) { await refresh(); return false }
      throw e
    }
  }, [local, data, refresh])
  return { view: view ?? (isMissing(error) ? null : undefined), unsupported: isMissing(error), failed: !!error && !isMissing(error) && !view, refresh, apply }
}

export function useMuseTodosLive(ms = 10_000): { todos: MuseTodo[] | undefined; refresh: () => Promise<void> } {
  const { data, refresh } = usePolled(async () => {
    const r = await getMuseTodos(homeTarget(), 'pending')
    return Array.isArray(r) ? r : []
  }, ms)
  return { todos: data, refresh }
}

/** 在跟的 = 卜算子自己日程里 auto 的条目(任务卡「交给 Muse 追踪」/ 它自己排的后续),按下一次发生先后;
 *  引擎按写入顺序给,不排就截前几条会漏掉刚加的明天那条。没有下一次的(一次性已过 / 没日期)排最后。 */
const SCHED_UNIT_MS = { h: 3_600_000, d: 86_400_000 } as const
/** 下一次发生的时刻(ms;一次性已过 / 没日期 → Infinity)。口径抄 components/agentScheduleLib.ts 的 nextOccurrence:
 *  那是 Tangu 模块,宿主运行时不许直引(tangu-boundary 1b);这里只为排序,算偏了只是顺序不准,不影响触发。 */
function nextTrackAt(e: Pick<AgentScheduleEntry, 'date' | 'repeat'>, now: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(String((e.date || '').split('/')[0]).trim())
  if (!m) return Number.POSITIVE_INFINITY
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0)).getTime()
  if (Number.isNaN(start)) return Number.POSITIVE_INFINITY
  if (start > now) return start
  const r = /^(\d+)([hd])$/.exec(e.repeat || '')
  const step = r ? Number(r[1]) * SCHED_UNIT_MS[r[2] as 'h' | 'd'] : 0
  return step ? start + Math.ceil((now - start) / step) * step : Number.POSITIVE_INFINITY
}
export const sortTracks = (entries: AgentScheduleEntry[], now = Date.now()): AgentScheduleEntry[] =>
  entries
    .map((e) => ({ e, at: nextTrackAt(e, now) }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.e)
export function useMuseTracksLive(ms = 30_000): AgentScheduleEntry[] | undefined {
  const { data } = usePolled(async () => {
    const all = await getAgentSchedules(homeTarget())
    const muse = (Array.isArray(all) ? all : []).find((s: { slug?: string }) => s.slug === 'muse') as { entries?: AgentScheduleEntry[] } | undefined
    return sortTracks((Array.isArray(muse?.entries) ? muse!.entries : []).filter((e) => e.auto))
  }, ms)
  return data
}

export function useMuseStatusLive(ms = 8000): MuseStatusInfo | null | undefined {
  const { data, error } = usePolled(() => getMuseStatus(homeTarget()), ms)
  return data ?? (error ? null : undefined)
}

/** 今天的手记:Library/Journal/<本地日期>.md;没有 = 空数组(还没写),读失败 = undefined 之后保持上一份。 */
export const todayJournalPath = (d = new Date()): string =>
  `Journal/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`
export function useMuseJournalToday(ms = 30_000): { segments: JournalSegment[]; path: string } | undefined {
  const { data } = usePolled(async () => {
    const path = todayJournalPath()
    try {
      const r = await getMuseLibraryFile(homeTarget(), path)
      return { segments: splitJournal(r.content), path }
    } catch (e) {
      if (isMissing(e)) return { segments: [], path }
      throw e
    }
  }, ms)
  return data
}

export interface JournalSegment {
  /** 段头里的时刻(`09:12`);段头不是时刻就是 '' */
  time: string
  /** 段头文字(去掉编号);没有段头 = '' */
  label: string
  /** 正文:去掉 Markdown 记号的纯文本,截到 MAX_SEG_CHARS */
  text: string
}
const MAX_SEG_CHARS = 280

/** Markdown → 一行纯文本:链接留字、双链留名、去掉列表 / 勾选 / 强调 / 行内代码记号。 */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, (_, p: string) => p.split('/').pop()!.replace(/\.md$/i, ''))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 手记按段切,只留最后 max 段(方案 §5:读 Library/Journal/<今天>.md 按段切,最多 4 段)。
 * 段 = `##` 段头;没有段头就按空行分的段落。段头以时刻开头(`## 09:12 …`)→ 时刻进左边那一列。顶部的 `#` 标题与空段跳过。
 */
export function splitJournal(md: string, max = 4): JournalSegment[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: JournalSegment[] = []
  const hasH2 = lines.some((l) => /^##\s+\S/.test(l))
  const push = (head: string, body: string[]): void => {
    const text = plainText(body.join('\n'))
    let label = plainText(head).replace(/^\d+[.)]\s*/, '')
    let time = ''
    const m = /^(\d{1,2}:\d{2})\s*(?:[-—–·:|]\s*)?(.*)$/.exec(label)
    if (m) { time = m[1]; label = m[2] }
    if (!text && !label) return
    out.push({ time, label, text: text.length > MAX_SEG_CHARS ? `${text.slice(0, MAX_SEG_CHARS).trimEnd()}…` : text })
  }
  if (hasH2) {
    let head: string | null = null
    let body: string[] = []
    for (const l of lines) {
      const h = /^##\s+(.*)$/.exec(l)
      if (h) { if (head !== null) push(head, body); head = h[1]; body = []; continue }
      if (head !== null && !/^#\s/.test(l)) body.push(l)
    }
    if (head !== null) push(head, body)
  } else {
    let para: string[] = []
    const flush = (): void => { if (para.length) push('', para); para = [] }
    for (const l of lines) {
      if (/^#{1,6}\s/.test(l) || !l.trim()) { flush(); continue }
      para.push(l)
    }
    flush()
  }
  return out.slice(-max)
}

/** 待办的完成 / 略过:只从 pending 改(CAS 在引擎;别处刚交给 Agent / 处理掉的回 409,当成功处理 —— 下一轮轮询它就不在了)。 */
export async function setTodoStatus(id: string, status: 'done' | 'dismissed'): Promise<void> {
  try { await patchMuseTodo(homeTarget(), id, status, 'pending') } catch (e) { if ((e as { status?: number }).status !== 409) throw e }
}

/**
 * 「交给 Agent」:放进一个已有会话(引擎把待办注入那个会话并标 injected),或开新会话照原样发出去。
 * 和右栏原来的「注入所选到会话」/「新对话里做」同一条路(MuseView.inject / runInNew)。
 */
export async function handTodosToAgent(todos: MuseTodo[], target: string | 'new'): Promise<boolean> {
  if (!todos.length) return false
  if (target !== 'new') {
    await injectMuseTodos(homeTarget(), todos.map((x) => x.id), target)
    openSession(target)
    return true
  }
  const message = `${translate('special.muse.injectPrefix')}\n\n` + todos.map((x, i) => `${i + 1}. ${x.title}${x.detail ? `\n   ${x.detail}` : ''}`).join('\n\n')
  openNewChat()
  const ok = await useApp.getState().send(message, [], undefined, undefined, undefined, null)
  if (!ok) return false // 没发出去(没模型 / 被拦):发送那边已经提示过了,这里不再报「已交给」
  for (const x of todos) await patchMuseTodo(homeTarget(), x.id, 'injected', 'pending').catch(() => {})
  void postMuseFeedback(homeTarget(), `todos run in a new session by user: ${todos.map((x) => `"${x.title}"`).join('; ')}`).catch(() => {})
  return true
}

/** 小组件放进格子用的键:已经有一张指着它(藏着的 / 正提议的)就用那个键,不另起一张;
 *  否则按名字起一个合法键(`w-` 开头,避开内置卡名),撞了加 -2、-3。 */
export function widgetCardKey(view: Pick<MuseSpaceView, 'cards' | 'hidden' | 'proposed'>, w: { id: string; name: string }): string {
  const all = [...view.cards, ...view.hidden, ...view.proposed]
  const same = all.find((c) => 'widgetId' in c.ref && c.ref.widgetId === w.id)
  if (same) return same.key
  const taken = new Set(all.map((c) => c.key))
  const base = `w-${(w.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'widget'}`.slice(0, 44).replace(/-+$/, '')
  let key = base
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`
  return key
}
