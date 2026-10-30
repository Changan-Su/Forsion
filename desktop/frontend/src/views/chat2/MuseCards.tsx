/**
 * Muse 发进私聊、要用户点的卡(方案 Muse与Agent升级,引擎 services/museCards.ts)。
 * 状态在引擎:按 id 读,点了只传 action,改什么由引擎按 kind 决定 —— 手机走隧道也是同一条路。
 *  - 插件卡是信息,留在那条消息里(同对话里的插件卡组件,多一个「不感兴趣」);
 *  - 其余要点的进对话末尾的卡片堆(10-23 定的规矩),流里原处留一行:待处理指路,处理完是结局。
 */
import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { ArrowDown, CircleCheck, CircleX, Puzzle, Settings } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useAttention } from '../../stores/attentionStore'
import { decideMuseCard, getMuseCard, listMuseCards } from '../../services/backendService'
import { targetForSession } from '../../services/engine/targets'
import type { MuseCardInfo, ToolEvent } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { MarketPluginCards } from '../../components/MarketPluginCards'
import { SETTINGS_TABS } from '../../components/settingsTarget'

registerMessages({
  'museCard.inDeck': { zh: '{title} · 在对话最下面', en: '{title} · at the end of the chat' },
  'museCard.notInterested': { zh: '不感兴趣', en: 'Not interested' },
  'museCard.open': { zh: '去打开', en: 'Open' },
  'museCard.feature': { zh: '功能推荐', en: 'Feature suggestion' },
  'museCard.dismissed': { zh: '不感兴趣，之后不再提', en: 'Not interested. It won’t come up again.' },
  'museCard.opened': { zh: '已打开设置', en: 'Opened in Settings' },
  'museCard.failed': { zh: '没处理成：{e}', en: 'Couldn’t do that: {e}' },
})

/** 点完一张:流里那行与卡片堆一起重读(同一张卡的两处视图不共享组件状态)。 */
const useDecided = create<{ n: number; bump: () => void }>((set) => ({ n: 0, bump: () => set((s) => ({ n: s.n + 1 })) }))

/** 卡片堆里的一张。不挂在哪条消息上:待处理的以引擎为准,旧消息没翻到也收得到(同 Muse 后台审批)。 */
export interface MuseCardItem { kind: 'muse-card'; id: string; messageId: string; card: MuseCardInfo }

/** 正文末尾的卡引用:只有 origin=proactive:card 的消息才解析(这一列只有引擎写得出,模型写同样的围栏不算数)。 */
const CARD_FENCE = /\n*```forsion-muse-card\n\{"id":"([A-Za-z0-9-]{1,64})"\}\n```\s*$/
export function museCardRef(content: string): { text: string; id: string } | null {
  const m = CARD_FENCE.exec(content)
  return m ? { text: content.slice(0, m.index), id: m[1] } : null
}

const NO_CARDS: MuseCardInfo[] = []

/** 这条私聊里还等你点的卡(插件卡留在消息里,不进卡片堆)。sig 变了就重拉:对话长了一条 / run 收尾。 */
export function useMusePendingCards(on: boolean, sessionId: string | null, sig: unknown): MuseCardInfo[] {
  const cfg = useApp((s) => s.cfg)
  const decided = useDecided((s) => s.n)
  const waitSig = useAttention((s) => Object.values(s.dm).filter((d) => d.awaiting || d.unread).length)
  const [items, setItems] = useState<MuseCardInfo[]>(NO_CARDS)
  useEffect(() => {
    if (!on || !sessionId) return
    let alive = true
    listMuseCards(targetForSession(sessionId), 'pending')
      .then((list) => { if (alive) setItems(list.filter((c) => c.kind !== 'plugin')) })
      .catch(() => {}) // 读失败 ≠ 没有卡:留着上一份
    return () => { alive = false }
  }, [cfg, decided, waitSig, on, sessionId, sig])
  return on ? items : NO_CARDS
}

function useDecide(sessionId: string | undefined): { busy: boolean; decide: (card: MuseCardInfo, action: string, extra?: Record<string, unknown>) => Promise<boolean> } {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const decide = async (card: MuseCardInfo, action: string, extra?: Record<string, unknown>): Promise<boolean> => {
    if (!sessionId || busy) return false
    setBusy(true)
    try {
      await decideMuseCard(targetForSession(sessionId), card.id, action, extra)
      useDecided.getState().bump()
      return true
    } catch (e: any) {
      if (e?.code === 'card_not_pending') useDecided.getState().bump() // 别处处理过了:跟着引擎的真状态走
      else useApp.getState().toast(t('museCard.failed', { e: e?.message || String(e) }), true)
      return false
    } finally { setBusy(false) }
  }
  return { busy, decide }
}

const openSettingsTab = (tab: string): void => {
  if ((SETTINGS_TABS as readonly string[]).includes(tab)) useApp.getState().openSettings(tab as Parameters<ReturnType<typeof useApp.getState>['openSettings']>[0])
}

/** 卡片堆里的一张。 */
export function MuseDeckCard({ card, sessionId }: { card: MuseCardInfo; sessionId?: string }) {
  const { t } = useI18n()
  const { busy, decide } = useDecide(sessionId)
  if (card.kind === 'feature') {
    return (
      <div className="t2-tasks"><div className="t2-taskcard" data-muse-card="feature">
        <div className="t2-taskcard-head"><Settings size={14} /><b>{card.payload.title}</b></div>
        {!!card.payload.why && <div className="t2-taskcard-tldr">{card.payload.why}</div>}
        <div className="t2-taskcard-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => { void decide(card, 'open').then((ok) => { if (ok) openSettingsTab(card.payload.feature) }) }}>{t('museCard.open')}</button>
          <button type="button" disabled={busy} onClick={() => void decide(card, 'dismiss')}>{t('museCard.notInterested')}</button>
        </div>
      </div></div>
    )
  }
  return null
}

const cardTitle = (card: MuseCardInfo, t: (k: string) => string): string => (card.kind === 'feature' ? t('museCard.feature') : card.payload.title || '')

/** 处理完留在流里的那一行。 */
function receipt(card: MuseCardInfo, t: (k: string) => string): { ok: boolean; text: string } {
  if (card.status === 'dismissed') return { ok: false, text: t('museCard.dismissed') }
  return { ok: true, text: t('museCard.opened') }
}

/** 流里那一行(插件卡是整张)。读不到(老数据 / 已删)就不画。 */
export function MuseCardLine({ id, sessionId, onJump }: { id: string; sessionId?: string; onJump?: () => void }) {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const decided = useDecided((s) => s.n)
  const [card, setCard] = useState<MuseCardInfo | null>(null)
  const { decide } = useDecide(sessionId)
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    getMuseCard(targetForSession(sessionId), id).then((c) => { if (alive) setCard(c) }, () => { if (alive) setCard(null) })
    return () => { alive = false }
  }, [cfg, id, sessionId, decided])
  const event = useMemo<ToolEvent | null>(() => (card?.kind === 'plugin' && card.payload.item
    ? { id: card.id, name: 'search_marketplace', done: true, result: JSON.stringify({ kind: 'marketplace', version: 1, items: [card.payload.item] }) }
    : null), [card])
  if (!card) return null
  if (card.status !== 'pending') {
    const r = receipt(card, t)
    return <div className={`t2-dim t2-dm-receipt${r.ok ? ' ok' : ''}`} data-muse-card-line={card.status}>{r.ok ? <CircleCheck size={12} /> : <CircleX size={12} />}<span>{r.text}</span></div>
  }
  if (event) return <MarketPluginCards event={event} onDismiss={() => void decide(card, 'dismiss')} />
  return (
    <button type="button" className="t2-dim t2-tasktrace t2-tasktrace-jump" data-muse-card-line="pending" onClick={onJump}>
      <Puzzle size={13} /><span>{t('museCard.inDeck', { title: cardTitle(card, t) })}</span><ArrowDown size={12} />
    </button>
  )
}
