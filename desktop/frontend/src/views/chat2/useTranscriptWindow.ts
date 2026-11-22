import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { targetForSession } from '../../services/engine/targets'
import { compareHistoryRows, withInterruptedTurns } from '../../tangu/store/tanguSlice'
import { useApp } from '../../stores/appStore'
import type { UiMessage } from '../../types'
import { registerMessages } from '../../i18n'
import { captureChatPosition, restoreChatPosition, type ChatReadingPosition } from './chatReadingPosition'
import type { ChatPageCursor } from '../../services/backendService'

registerMessages({
  'chat.history.editRecovered': { zh: '原消息已删除，编辑中的文字已放回输入框。', en: 'The original message was deleted. Your edit is in the composer.' },
  'chat.history.earlier': { zh: '较早的消息', en: 'Earlier messages' },
  'chat.history.newer': { zh: '较新的消息', en: 'Newer messages' },
})

interface WindowPage {
  scope: string
  rows: UiMessage[]
  first?: string
  last?: string
  older: boolean
  newer: boolean
  detached: boolean
}

function joinMessages(left: UiMessage[], right: UiMessage[]): UiMessage[] {
  const rows = new Map(left.map(m => [m.id, m]))
  for (const row of right) rows.set(row.id, row)
  return withInterruptedTurns([...rows.values()].sort(compareHistoryRows))
}

/** Older reading windows belong to the leaf. A split showing the live tail keeps
 * streaming while another split browses the same conversation's history. */
export function useTranscriptWindow(sid: string | null, live: UiMessage[], target: string | undefined,
  root: RefObject<HTMLDivElement | null>, follow: RefObject<boolean>) {
  const account = useApp(s => s.authInfo?.accountId || s.authInfo?.username)
  const engine = sid ? targetForSession(sid) : undefined
  const scope = JSON.stringify([sid, account, engine?.key, engine?.base])
  const [local, setLocal] = useState<WindowPage>()
  const [attempted, setAttempted] = useState('')
  const [cards, setCards] = useState<{ scope: string; rows: UiMessage[] }>()
  const token = useRef(0)
  const busy = useRef(false)
  const hold = useRef<ChatReadingPosition | null>(null)
  const page = local?.scope === scope ? local : undefined
  const tail = sid ? useApp.getState().historyTail(sid) : undefined
  const needsCards = !!tail?.older
  useEffect(() => {
    if (!sid || !needsCards) { setCards(undefined); return }
    let valid = true
    void useApp.getState().readTranscriptPage(sid, { cards: true }).then(result => {
      if (valid) setCards({ scope, rows: result.messages })
    }).catch(() => {})
    return () => { valid = false }
  }, [sid, scope, needsCards])
  const cardRows = useMemo(() => cards?.scope === scope && cards.rows.length ? joinMessages(cards.rows, live) : live, [scope, cards, live])
  // A canvas/export may have populated a much larger shared cache. Keep each
  // newly mounted reader at its own initial boundary and retain streamed additions.
  const floor = useRef<{ scope: string; id: string; older: boolean } | null>(null)
  if (sid && tail?.ids.length && (floor.current?.scope !== scope || !live.some(m => m.id === floor.current?.id))) {
    floor.current = { scope, id: tail.ids[0], older: tail.older }
  } else if (floor.current?.scope !== scope) floor.current = null
  const first = floor.current?.id
  const hasEarlier = floor.current?.older ?? tail?.older
  const recent = useMemo(() => {
    const start = first ? live.findIndex(m => m.id === first) : -1
    return start > 0 ? live.slice(start) : live
  }, [live, first])
  const rows = useMemo(() => page?.detached ? page.rows : page ? joinMessages(page.rows, recent) : recent, [page, recent])
  const missing = !!target && !rows.some(m => m.id === target)
  const lookup = target ? JSON.stringify([sid, target]) : ''
  const awaiting = missing && attempted !== lookup
  const reset = useCallback(() => {
    token.current++
    busy.current = false
    hold.current = null
    setLocal(undefined)
    setAttempted('')
  }, [])
  useLayoutEffect(() => { reset(); return () => { token.current++; busy.current = false } }, [scope, reset])

  const fetchPage = async (cursor: ChatPageCursor, mode: 'around' | 'earlier' | 'newer') => {
    if (!sid || (mode !== 'around' && busy.current)) return
    const request = ++token.current
    busy.current = true
    try {
      const result = await useApp.getState().readTranscriptPage(sid, cursor)
      if (request !== token.current || !result.page) return
      if (result.page.missing) {
        if (mode !== 'around' || page?.detached) {
          setLocal(undefined)
          follow.current = true
          void useApp.getState().pollSession(sid)
        }
        return
      }
      const p = result.page
      if (root.current && mode !== 'around') {
        follow.current = false
        hold.current = captureChatPosition(root.current, false)
      }
      if (mode === 'around') {
        setLocal({ scope, rows: result.messages, first: p.ids[0], last: p.ids.at(-1), older: p.older, newer: p.newer, detached: true })
      } else if (mode === 'earlier') {
        setLocal({ scope, rows: joinMessages(result.messages, page?.rows ?? []), first: p.ids[0], last: page?.last,
          older: p.older, newer: page?.newer ?? false, detached: page?.detached ?? false })
      } else {
        const joined = joinMessages(page?.rows ?? [], result.messages)
        const joinedLive = !p.newer || p.ids.some(id => tail?.ids.includes(id))
        setLocal({ scope, rows: joined, first: page?.first, last: p.ids.at(-1), older: page?.older ?? false,
          newer: !joinedLive, detached: !joinedLive })
      }
    } catch (e: any) {
      if (request === token.current) useApp.getState().toast(useApp.getState().tr('app.historyLoadFail', { e: e?.message || e }), true)
    } finally {
      if (request === token.current) {
        busy.current = false
        if (mode === 'around') setAttempted(lookup)
      }
    }
  }
  const actions = useRef({ fetchPage, page, first, hasEarlier })
  actions.current = { fetchPage, page, first, hasEarlier }
  useEffect(() => {
    if (target && awaiting) void actions.current.fetchPage({ aroundId: target }, 'around')
    return () => { if (target) { token.current++; busy.current = false } }
  }, [scope, lookup, awaiting, target])

  const removed = tail?.removed
  const removedKey = removed?.length ? JSON.stringify(removed) : ''
  useEffect(() => {
    if (!removedKey || !actions.current.page) return
    const anchor = root.current && captureChatPosition(root.current, false)
    const id = anchor?.messageId?.replace(/^tocmsg-/, '')
    if (id) {
      hold.current = anchor
      void actions.current.fetchPage({ aroundId: id }, 'around')
    }
  }, [removedKey, root])

  useLayoutEffect(() => {
    if (hold.current && root.current) restoreChatPosition(root.current, hold.current)
    hold.current = null
  }, [page, root])
  const earlier = useCallback(() => {
    const { page, first, hasEarlier, fetchPage } = actions.current
    const beforeId = page ? page.first : first
    if (beforeId && (page?.older ?? hasEarlier)) void fetchPage({ beforeId }, 'earlier')
  }, [])
  const newer = useCallback(() => {
    const { page, fetchPage } = actions.current
    if (page?.newer && page.last) void fetchPage({ afterId: page.last }, 'newer')
  }, [])
  // A gesture can start at the boundary of a short page, without producing a scroll event.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const nearEdge = (dy: number) => {
      if (dy < 0 && el.scrollTop < el.clientHeight) earlier()
      if (dy > 0 && el.scrollHeight - el.scrollTop < el.clientHeight * 2) newer()
    }
    const wheel = (e: WheelEvent) => nearEdge(e.deltaY)
    let top = el.scrollTop
    const scroll = () => { const y = el.scrollTop; if (!follow.current) nearEdge(y - top); top = y }
    el.addEventListener('wheel', wheel, { passive: true })
    el.addEventListener('scroll', scroll, { passive: true })
    return () => { el.removeEventListener('wheel', wheel); el.removeEventListener('scroll', scroll) }
  }, [sid, root, follow, earlier, newer])
  return { rows, cardRows, awaiting, earlier, newer, reset, hasEarlier: page?.older ?? hasEarlier,
    hasNewer: !!page?.newer, detached: !!page?.detached, browsing: !!page }
}
