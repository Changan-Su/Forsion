/**
 * Muse 发进私聊、要用户点的卡(方案 Muse与Agent升级,引擎 services/museCards.ts)。
 * 状态在引擎:按 id 读,点了只传 action,改什么由引擎按 kind 决定 —— 手机走隧道也是同一条路。
 *  - 插件卡是信息,留在那条消息里(同对话里的插件卡组件,多一个「不感兴趣」);
 *  - 其余要点的进对话末尾的卡片堆(10-23 定的规矩),流里原处留一行:待处理指路,处理完是结局。
 */
import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { AlarmClock, ArrowDown, CircleCheck, CircleX, Gift, Inbox, MessageCircle, Puzzle, Settings, Sparkles } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useAttention } from '../../stores/attentionStore'
import { claimOnEngine, decideMuseCard, editMuseSummary, getMuseCard, getMuseStatus, listMuseCards, museMessageFeedback } from '../../services/backendService'
import { currentClientId } from '../../services/agentRunService'
import { useInbox } from '../../stores/inboxStore'
import { setActiveSpace, useWorkspace } from '@lcl/engine'
import { HOME_REF, sameRef, targetForSession } from '../../services/engine/targets'
import type { MuseCardInfo, ToolEvent } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { MarketPluginCards } from '../../components/MarketPluginCards'
import { SETTINGS_TABS } from '../../components/settingsTarget'
import { useAutomation } from '../../stores/automationStore'
import { condText, onlyText } from '../automation/lib'

registerMessages({
  'museCard.inDeck': { zh: '{title} · 在对话最下面', en: '{title} · at the end of the chat' },
  'museCard.notInterested': { zh: '不感兴趣', en: 'Not interested' },
  'museCard.open': { zh: '去打开', en: 'Open' },
  'museCard.feature': { zh: '功能推荐', en: 'Feature suggestion' },
  'museCard.dismissed': { zh: '不感兴趣，之后不再提', en: 'Not interested. It won’t come up again.' },
  'museCard.opened': { zh: '已打开设置', en: 'Opened in Settings' },
  'museCard.yes': { zh: '好', en: 'Yes' },
  'museCard.later': { zh: '先不用', en: 'Not now' },
  'museCard.ignore': { zh: '这类以后都别管', en: 'Ignore this kind' },
  'museCard.askDefault': { zh: '这类以后帮你直接标已读？', en: 'Mark these as read for you from now on?' },
  'museCard.ask': { zh: '收件箱：这类信怎么办', en: 'Inbox: what to do with these' },
  'museCard.askYes': { zh: '这类以后替你标已读', en: 'These get marked as read for you from now on' },
  'museCard.askLater': { zh: '先不用，还是你自己看', en: 'Not now. You’ll keep reading these yourself.' },
  'museCard.askIgnore': { zh: '这类以后不提醒也不标', en: 'These won’t be flagged or marked from now on' },
  'museCard.list': { zh: '收件箱里要你动手的 {n} 件', en: '{n} inbox items need you' },
  'museCard.expires': { zh: '{date} 过期', en: 'Expires {date}' },
  'museCard.claim': { zh: '领取', en: 'Claim' },
  'museCard.openMail': { zh: '打开', en: 'Open' },
  'museCard.gotIt': { zh: '知道了', en: 'Got it' },
  'museCard.listDone': { zh: '收件箱清单已处理', en: 'Inbox list handled' },
  'museCard.channel': { zh: '连一个通道', en: 'Connect a channel' },
  'museCard.connect': { zh: '去连接', en: 'Connect' },
  'museCard.noThanks': { zh: '不用', en: 'Keep as is' },
  'museCard.channelOpened': { zh: '已打开通道设置', en: 'Opened channel settings' },
  'museCard.failed': { zh: '没处理成：{e}', en: 'Couldn’t do that: {e}' },
  'museCard.change': { zh: '改', en: 'Change' },
  'museCard.settingsDone': { zh: '已改成 {list}', en: 'Changed to {list}' },
  'museCard.settingsKept': { zh: '设置没改', en: 'Settings kept as they were' },
  'museCard.field.heartbeatMinutes': { zh: '心跳间隔', en: 'Heartbeat' },
  'museCard.field.activeHours': { zh: '作息时段', en: 'Active hours' },
  'museCard.field.notify': { zh: '通知方式', en: 'Notifications' },
  'museCard.field.maxDmPerDay': { zh: '每天最多主动找你', en: 'Daily message limit' },
  'museCard.val.scheduleOnly': { zh: '只在定时和规则时醒', en: 'Only for schedules and rules' },
  'museCard.val.minutes': { zh: '每 {n} 分钟', en: 'Every {n} min' },
  'museCard.val.hours': { zh: '每 {n} 小时', en: 'Every {n} h' },
  'museCard.val.allDay': { zh: '全天', en: 'All day' },
  'museCard.val.hourRange': { zh: '{start}–{end} 点', en: '{start}:00–{end}:00' },
  'museCard.val.immediate': { zh: '即时', en: 'Right away' },
  'museCard.val.digest': { zh: '日报', en: 'Daily digest' },
  'museCard.val.noLimit': { zh: '不限', en: 'No limit' },
  'museCard.val.perDay': { zh: '{n} 条', en: '{n} a day' },
  'museCard.intro': { zh: '先认识一下', en: 'Getting to know you' },
  'museCard.introBody': { zh: '我是 Muse。我在后台替你盯事情、整理东西，有要紧的才来找你。先问三句，不答就按缺省来。', en: 'I’m Muse. I work in the background, keeping an eye on things and tidying up, and come to you when something matters. Three quick questions; skip them and I’ll use the defaults.' },
  'museCard.q.when': { zh: '什么时候能找你', en: 'When can I reach you?' },
  'museCard.when.anytime': { zh: '随时', en: 'Anytime' },
  'museCard.when.daytime': { zh: '白天 9–21 点', en: 'Daytime, 9:00–21:00' },
  'museCard.when.open': { zh: '只在我开着 Forsion 时', en: 'Only while Forsion is open' },
  'museCard.q.pace': { zh: '多久说一次', en: 'How often should I speak up?' },
  'museCard.pace.as-needed': { zh: '有事才说', en: 'Only when it matters' },
  'museCard.pace.daily': { zh: '每天一条', en: 'Once a day' },
  'museCard.pace.free': { zh: '想到就说', en: 'Whenever something comes up' },
  'museCard.q.focus': { zh: '最想让我盯什么（可多选）', en: 'What should I watch most? (pick any)' },
  'museCard.focus.schedule': { zh: '日程', en: 'Schedule' },
  'museCard.focus.study': { zh: '学习', en: 'Study' },
  'museCard.focus.projects': { zh: '项目', en: 'Projects' },
  'museCard.focus.inbox': { zh: '收件箱', en: 'Inbox' },
  'museCard.done': { zh: '好了', en: 'Done' },
  'museCard.skip': { zh: '跳过', en: 'Skip' },
  'museCard.introDone': { zh: '记下了，就按你说的来', en: 'Got it. I’ll work that way.' },
  'museCard.introSkipped': { zh: '跳过了，按缺省来', en: 'Skipped. Using the defaults.' },
  'museCard.summary': { zh: '这两周学到的配合方式', en: 'What I’ve learned in two weeks' },
  'museCard.edit': { zh: '改', en: 'Edit' },
  'museCard.remove': { zh: '删', en: 'Delete' },
  'museCard.save': { zh: '保存', en: 'Save' },
  'museCard.allGood': { zh: '都对', en: 'All good' },
  'museCard.summaryDone': { zh: '两周小结已确认', en: 'Two-week summary confirmed' },
  'museCard.helpful': { zh: '有用', en: 'Helpful' },
  'museCard.lessOfThis': { zh: '少来点这种', en: 'Less of this' },
  'museCard.noted': { zh: '记下了', en: 'Got it' },
  'museCard.notedLess': { zh: '记下了：这类少来', en: 'Got it: fewer of these' },
  'museCard.rule': { zh: '新的醒来时机', en: 'New wake-up rule' },
  'museCard.ruleWhen': { zh: '当', en: 'When' },
  'museCard.ruleOnly': { zh: '只在', en: 'Only' },
  'museCard.ruleDo': { zh: '做', en: 'Do' },
  'museCard.ruleRemind': { zh: '直接提醒「{text}」（不叫模型、不花额度）', en: 'Remind you: “{text}” (no model, no budget)' },
  'museCard.ruleNotify': { zh: '发通知「{text}」', en: 'Send a notification: “{text}”' },
  'museCard.ruleWake': { zh: '叫醒 Muse', en: 'Wake Muse' },
  'museCard.ruleWakeWith': { zh: '叫醒 Muse：{text}', en: 'Wake Muse: {text}' },
  'museCard.ruleOk': { zh: '好', en: 'OK' },
  'museCard.ruleEdit': { zh: '改一下', en: 'Change it' },
  'museCard.ruleNo': { zh: '不用', en: 'No thanks' },
  'museCard.ruleDone': { zh: '规则已建好', en: 'Rule created' },
  'museCard.ruleEditing': { zh: '已打开画布，规则暂停着', en: 'Opened in the canvas, rule paused' },
  'museCard.ruleDeclined': { zh: '不用这条规则', en: 'Rule declined' },
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

function useDecide(sessionId: string | undefined) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const send = async (call: (target: ReturnType<typeof targetForSession>) => Promise<unknown>): Promise<boolean> => {
    if (!sessionId || busy) return false
    setBusy(true)
    try {
      await call(targetForSession(sessionId))
      useDecided.getState().bump()
      return true
    } catch (e: any) {
      if (e?.code === 'card_not_pending') useDecided.getState().bump() // 别处处理过了:跟着引擎的真状态走
      else useApp.getState().toast(t('museCard.failed', { e: e?.message || String(e) }), true)
      return false
    } finally { setBusy(false) }
  }
  /** 规则卡的「改一下」要拿到建出来的规则 id 去开画布;别的卡只看成没成。 */
  const decide = async (card: MuseCardInfo, action: string, extra?: Record<string, unknown>): Promise<boolean | string> => {
    let trigger: string | undefined
    const ok = await send(async (target) => { trigger = (await decideMuseCard(target, card.id, action, extra)).trigger?.id })
    return ok && (trigger ?? true)
  }
  return { busy, decide, send }
}

const openSettingsTab = (tab: string): void => {
  if ((SETTINGS_TABS as readonly string[]).includes(tab)) useApp.getState().openSettings(tab as Parameters<ReturnType<typeof useApp.getState>['openSettings']>[0])
}

/** 卡片堆里的一张。 */
export function MuseDeckCard({ card, sessionId }: { card: MuseCardInfo; sessionId?: string }) {
  const { t } = useI18n()
  const { busy, decide } = useDecide(sessionId)
  if (card.kind === 'rule') {
    const r = card.payload.rule ?? {}
    const only = onlyText(t, r, true)
    const step = r.actions?.[0]
    const act = step?.type === 'remind' ? t('museCard.ruleRemind', { text: step.title })
      : step?.type === 'notify' ? t('museCard.ruleNotify', { text: step.title })
      : r.prompt ? t('museCard.ruleWakeWith', { text: r.prompt }) : t('museCard.ruleWake')
    const row = (k: string, v: string) => <div className="t2-rulecard-row"><span>{k}</span><span>{v}</span></div>
    return (
      <div className="t2-tasks"><div className="t2-taskcard" data-muse-card="rule">
        <div className="t2-taskcard-head"><AlarmClock size={14} /><b>{r.desc || t('museCard.rule')}</b></div>
        {row(t('museCard.ruleWhen'), r.cond ? condText(t, r.cond) : '—')}
        {!!only && row(t('museCard.ruleOnly'), only)}
        {row(t('museCard.ruleDo'), act)}
        <div className="t2-taskcard-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void decide(card, 'accept')}>{t('museCard.ruleOk')}</button>
          <button type="button" disabled={busy} onClick={() => { void decide(card, 'edit').then((id) => { if (typeof id === 'string') { setActiveSpace('automation'); useAutomation.getState().openBuilder(id) } }) }}>{t('museCard.ruleEdit')}</button>
          <button type="button" disabled={busy} onClick={() => void decide(card, 'dismiss')}>{t('museCard.ruleNo')}</button>
        </div>
      </div></div>
    )
  }
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
  if (card.kind === 'inbox-ask') {
    return (
      <div className="t2-tasks"><div className="t2-taskcard" data-muse-card="inbox-ask">
        <div className="t2-taskcard-head"><Inbox size={14} /><b>{card.payload.question || t('museCard.askDefault')}</b></div>
        <div className="t2-taskcard-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void decide(card, 'yes')}>{t('museCard.yes')}</button>
          <button type="button" disabled={busy} onClick={() => void decide(card, 'later')}>{t('museCard.later')}</button>
          <button type="button" disabled={busy} onClick={() => void decide(card, 'ignore')}>{t('museCard.ignore')}</button>
        </div>
      </div></div>
    )
  }
  if (card.kind === 'inbox-list') return <InboxListCard card={card} sessionId={sessionId} />
  if (card.kind === 'intro') return <IntroCard card={card} sessionId={sessionId} />
  if (card.kind === 'summary') return <SummaryCard card={card} sessionId={sessionId} />
  if (card.kind === 'settings') {
    const changes: SettingChange[] = card.payload.changes || []
    return (
      <div className="t2-tasks"><div className="t2-taskcard" data-muse-card="settings">
        <div className="t2-taskcard-head"><Settings size={14} /><b>{t('muse.settings')}</b></div>
        {changes.map((c) => (
          <div key={c.field} className="t2-musecard-row"><div><b>{t(`museCard.field.${c.field}`)}</b><span>{settingValue(c.field, c.from, t)} → {settingValue(c.field, c.to, t)}</span></div></div>
        ))}
        <div className="t2-taskcard-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void decide(card, 'apply')}>{t('museCard.change')}</button>
          <button type="button" disabled={busy} onClick={() => void decide(card, 'dismiss')}>{t('museCard.noThanks')}</button>
        </div>
      </div></div>
    )
  }
  if (card.kind === 'channel') {
    return (
      <div className="t2-tasks"><div className="t2-taskcard" data-muse-card="channel">
        <div className="t2-taskcard-head"><MessageCircle size={14} /><b>{t('museCard.channel')}</b></div>
        {!!card.payload.why && <div className="t2-taskcard-tldr">{card.payload.why}</div>}
        <div className="t2-taskcard-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => { void decide(card, 'open').then((ok) => { if (ok) openSettingsTab('channels') }) }}>{t('museCard.connect')}</button>
          <button type="button" disabled={busy} onClick={() => void decide(card, 'dismiss')}>{t('museCard.noThanks')}</button>
        </div>
      </div></div>
    )
  }
  return null
}

/** 收件箱清单:每条一个按钮,「领取」走现成的领取接口,都处理完这张卡自己收起。Muse 不替你领。 */
function InboxListCard({ card, sessionId }: { card: MuseCardInfo; sessionId?: string }) {
  const { t } = useI18n()
  const { busy, decide } = useDecide(sessionId)
  const items: Array<{ id: string; title: string; note?: string; claimable?: boolean; expires?: string; handled?: boolean }> = card.payload.items || []
  const claim = async (id: string): Promise<void> => {
    if (!sessionId) return
    const app = useApp.getState()
    try {
      const r = await claimOnEngine(targetForSession(sessionId), id, currentClientId())
      app.toast(app.tr(r.alreadyClaimed ? 'inbox.claim.already' : 'inbox.claim.ok'))
      await decide(card, 'item', { messageId: id })
      void useInbox.getState().refreshList()
    } catch (e: any) {
      app.toast(e?.code === 'claim_requirements_unmet' ? app.tr('inbox.claim.unmet') : e?.message || app.tr('inbox.claim.fail'), true)
    }
  }
  const open = (id: string): void => {
    void decide(card, 'item', { messageId: id })
    setActiveSpace('inbox')
    useInbox.getState().select(id)
    useWorkspace.getState().openView('inbox-reader', {}, 'main')
  }
  return (
    <div className="t2-tasks"><div className="t2-taskcard" data-muse-card="inbox-list">
      <div className="t2-taskcard-head"><Inbox size={14} /><b>{t('museCard.list', { n: items.length })}</b></div>
      {!!card.payload.lead && <div className="t2-taskcard-tldr">{card.payload.lead}</div>}
      {items.map((i) => (
        <div key={i.id} className="t2-musecard-row" data-inbox-item={i.id}>
          <div><b>{i.title}</b>{(i.note || i.expires) && <span>{[i.note, i.expires && t('museCard.expires', { date: i.expires })].filter(Boolean).join(' · ')}</span>}</div>
          {i.handled ? <CircleCheck size={14} /> : <div className="t2-taskcard-actions">{i.claimable
            ? <button type="button" className="primary" disabled={busy} onClick={() => void claim(i.id)}><Gift size={13} />{t('museCard.claim')}</button>
            : !window.tangu?.mobile && <button type="button" disabled={busy} onClick={() => open(i.id)}>{t('museCard.openMail')}</button>}</div>}
        </div>
      ))}
      <div className="t2-taskcard-actions"><button type="button" disabled={busy} onClick={() => void decide(card, 'ack')}>{t('museCard.gotIt')}</button></div>
    </div></div>
  )
}

type Tr = (k: string, v?: Record<string, unknown>) => string
type SettingChange = { field: string; from: unknown; to: unknown }

/** 设置项的值怎么念(卡上和回执共用)。 */
function settingValue(field: string, v: any, t: Tr): string {
  if (field === 'heartbeatMinutes') return !v ? t('museCard.val.scheduleOnly') : v % 60 ? t('museCard.val.minutes', { n: v }) : t('museCard.val.hours', { n: v / 60 })
  if (field === 'activeHours') return v ? t('museCard.val.hourRange', { start: v.start, end: v.end }) : t('museCard.val.allDay')
  if (field === 'notify') return t(v === 'digest' ? 'museCard.val.digest' : 'museCard.val.immediate')
  return v ? t('museCard.val.perDay', { n: v }) : t('museCard.val.noLimit')
}

/** 第一次见面的三问:可跳过、都不必答全。能对应到设置的引擎改设置,其余记进 Muse 的记忆。 */
function IntroCard({ card, sessionId }: { card: MuseCardInfo; sessionId?: string }) {
  const { t } = useI18n()
  const { busy, decide } = useDecide(sessionId)
  const [when, setWhen] = useState('')
  const [pace, setPace] = useState('')
  const [focus, setFocus] = useState<string[]>([])
  const row = (q: string, ids: string[], on: (id: string) => boolean, tap: (id: string) => void) => (
    <div className="t2-musecard-q">
      <span>{t(`museCard.q.${q}`)}</span>
      <div className="t2-taskcard-actions">{ids.map((id) => <button key={id} type="button" aria-pressed={on(id)} className={on(id) ? 'primary' : undefined} onClick={() => tap(id)}>{t(`museCard.${q}.${id}`)}</button>)}</div>
    </div>
  )
  return (
    <div className="t2-tasks"><div className="t2-taskcard" data-muse-card="intro">
      <div className="t2-taskcard-head"><Sparkles size={14} /><b>{t('museCard.intro')}</b></div>
      <div className="t2-taskcard-tldr">{t('museCard.introBody')}</div>
      {row('when', ['anytime', 'daytime', 'open'], (id) => when === id, (id) => setWhen(when === id ? '' : id))}
      {row('pace', ['as-needed', 'daily', 'free'], (id) => pace === id, (id) => setPace(pace === id ? '' : id))}
      {row('focus', ['schedule', 'study', 'projects', 'inbox'], (id) => focus.includes(id), (id) => setFocus(focus.includes(id) ? focus.filter((f) => f !== id) : [...focus, id]))}
      <div className="t2-taskcard-actions">
        <button type="button" className="primary" disabled={busy || !(when || pace || focus.length)} onClick={() => void decide(card, 'answer', { answers: { when, pace, focus } })}>{t('museCard.done')}</button>
        <button type="button" disabled={busy} onClick={() => void decide(card, 'skip')}>{t('museCard.skip')}</button>
      </div>
    </div></div>
  )
}

/** 第 14 天的小结:每条能改能删,记忆跟着动;「都对」收起。 */
function SummaryCard({ card, sessionId }: { card: MuseCardInfo; sessionId?: string }) {
  const { t } = useI18n()
  const { busy, decide, send } = useDecide(sessionId)
  const items: string[] = card.payload.items || []
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null)
  // 改写是往 Muse 记忆写用户的原话,引擎拒远端:手机上这张卡能删、能确认,改回电脑上改
  const editable = !!sessionId && sameRef(targetForSession(sessionId).ref, HOME_REF)
  const save = async (): Promise<void> => {
    if (!editing) return
    const text = editing.text.trim()
    const { index } = editing
    if (!text || text === items[index] || await send((target) => editMuseSummary(target, card.id, { index, expected: items[index], text }))) setEditing(null)
  }
  return (
    <div className="t2-tasks"><div className="t2-taskcard" data-muse-card="summary">
      <div className="t2-taskcard-head"><Sparkles size={14} /><b>{t('museCard.summary')}</b></div>
      {!!card.payload.lead && <div className="t2-taskcard-tldr">{card.payload.lead}</div>}
      {items.map((text, index) => (
        <div key={`${index}:${text}`} className="t2-musecard-row">
          {editing?.index === index
            ? <input autoFocus aria-label={t('museCard.edit')} value={editing.text} onChange={(e) => setEditing({ index, text: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save(); if (e.key === 'Escape') setEditing(null) }} />
            : <div><span className="t2-musecard-text">{text}</span></div>}
          <div className="t2-taskcard-actions">{editing?.index === index
            ? <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{t('museCard.save')}</button>
            : <>
                {editable && <button type="button" disabled={busy} onClick={() => setEditing({ index, text })}>{t('museCard.edit')}</button>}
                <button type="button" disabled={busy} onClick={() => void decide(card, 'remove', { index, expected: text })}>{t('museCard.remove')}</button>
              </>}</div>
        </div>
      ))}
      <div className="t2-taskcard-actions"><button type="button" className="primary" disabled={busy} onClick={() => void decide(card, 'ok')}>{t('museCard.allGood')}</button></div>
    </div></div>
  )
}

const cardTitle = (card: MuseCardInfo, t: Tr): string => {
  if (card.kind === 'feature') return t('museCard.feature')
  if (card.kind === 'inbox-ask') return t('museCard.ask')
  if (card.kind === 'inbox-list') return t('museCard.list', { n: (card.payload.items || []).length })
  if (card.kind === 'channel') return t('museCard.channel')
  if (card.kind === 'settings') return t('muse.settings')
  if (card.kind === 'intro') return t('museCard.intro')
  if (card.kind === 'summary') return t('museCard.summary')
  if (card.kind === 'rule') return t('museCard.rule')
  return card.payload.title || ''
}

/** 处理完留在流里的那一行。 */
function receipt(card: MuseCardInfo, t: Tr): { ok: boolean; text: string } {
  if (card.kind === 'settings') {
    if (card.status === 'dismissed') return { ok: false, text: t('museCard.settingsKept') }
    const list = ((card.payload.changes || []) as SettingChange[]).map((c) => settingValue(c.field, c.to, t)).join(t('common.listSep'))
    return { ok: true, text: t('museCard.settingsDone', { list }) }
  }
  if (card.kind === 'intro') return { ok: card.result === 'answer', text: t(card.result === 'answer' ? 'museCard.introDone' : 'museCard.introSkipped') }
  if (card.kind === 'rule') return card.status === 'dismissed' ? { ok: false, text: t('museCard.ruleDeclined') } : { ok: true, text: t(card.result === 'editing' ? 'museCard.ruleEditing' : 'museCard.ruleDone') }
  if (card.kind === 'summary') return { ok: true, text: t('museCard.summaryDone') }
  if (card.status === 'dismissed') return { ok: false, text: t('museCard.dismissed') }
  if (card.kind === 'inbox-ask') return { ok: card.result === 'yes', text: t(card.result === 'yes' ? 'museCard.askYes' : card.result === 'ignore' ? 'museCard.askIgnore' : 'museCard.askLater') }
  if (card.kind === 'inbox-list') return { ok: true, text: t('museCard.listDone') }
  if (card.kind === 'channel') return { ok: true, text: t('museCard.channelOpened') }
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

const VOTES_KEY = 'forsion_muse_feedback'
type Vote = 'up' | 'down'
function readVotes(): Record<string, Vote> {
  try { return JSON.parse(localStorage.getItem(VOTES_KEY) || '{}') || {} } catch { return {} }
}
function saveVote(id: string, v: Vote): void {
  try { localStorage.setItem(VOTES_KEY, JSON.stringify(Object.fromEntries([...Object.entries(readVotes()).slice(-199), [id, v]]))) } catch { /* 记不住只是按钮会再出现 */ }
}

/** 反馈按钮开到什么时候。开始之后这个数不变,读到一次就留着;没读到(还没跑过周期)下一条再问。 */
let feedbackUntil: number | null = null
const readFeedbackUntil = async (sessionId: string): Promise<number> => {
  feedbackUntil ??= (await getMuseStatus(targetForSession(sessionId)).catch(() => null))?.feedbackUntil ?? null
  return feedbackUntil ?? 0
}

/** 磨合期两周,主动消息下面一行轻按钮。点了进 Muse 的 LOG([feedback]),周期里 read_log 读得到。 */
export function MuseFeedbackRow({ messageId, sessionId }: { messageId: string; sessionId: string }) {
  const { t } = useI18n()
  const [until, setUntil] = useState(feedbackUntil ?? 0)
  const [vote, setVote] = useState<Vote | undefined>(() => readVotes()[messageId])
  useEffect(() => {
    let alive = true
    void readFeedbackUntil(sessionId).then((u) => { if (alive) setUntil(u) })
    return () => { alive = false }
  }, [sessionId])
  if (Date.now() >= until) return null
  const send = (v: Vote): void => {
    setVote(v)
    saveVote(messageId, v)
    museMessageFeedback(targetForSession(sessionId), messageId, v).catch((e) => {
      setVote(undefined)
      useApp.getState().toast(t('museCard.failed', { e: e?.message || String(e) }), true)
    })
  }
  return (
    <div className="t2-musefb" data-muse-feedback={vote || 'open'}>
      {vote
        ? <span>{t(vote === 'up' ? 'museCard.noted' : 'museCard.notedLess')}</span>
        : <>
            <button type="button" onClick={() => send('up')}>{t('museCard.helpful')}</button>
            <button type="button" onClick={() => send('down')}>{t('museCard.lessOfThis')}</button>
          </>}
    </div>
  )
}
