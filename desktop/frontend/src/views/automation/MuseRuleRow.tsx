/**
 * 自动化首页「Muse 建议」一节最上面那几行:Muse 在私聊里提了、还没答的规则卡(11-22 方案 A)。
 * 和私聊里那张是同一张卡(引擎 muse_cards)、同一套动作(好 / 先观察 / 改一下 / 不用),在哪答都行,答完两边一起收 ——
 * 两边都以引擎的卡状态为准,答完经 automationStore.bumpCards() 通知私聊那边重读。
 * 宿主代码:私聊的卡片组件在 Tangu 界面包里,宿主不能直接引(check:tanguboundary),这里照它的动作单独画成首页的行。
 */
import { useState } from 'react'
import { AlarmClock } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { decideMuseCard } from '../../services/backendService'
import { homeTarget } from '../../services/engine/targets'
import { ReasonPrompt } from '../../components/FeedbackReasons'
import { useAutomation } from '../../stores/automationStore'
import type { MuseCardInfo, MuseDismissReason } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { MUSE_DISMISS_REASONS } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { canObserve, condText, onlyText } from './lib'
import './messages'

type T = (k: string, v?: Record<string, unknown>) => string

/** 「做」那一句:规则卡只带一步(提醒 / 通知 / 发消息),或者没有动作 = 叫醒 Muse。 */
function ruleDoText(r: any, t: T): string {
  const step = r.actions?.[0]
  if (step?.type === 'remind') return `${t('automation.step.remind')}「${step.title}」`
  if (step?.type === 'notify') return `${t('automation.step.notify')}「${step.title}」`
  if (step?.type === 'send_message') return `${step.agentSlug} → ${t(step.delivery === 'solo' ? 'automation.send.solo' : 'automation.send.inbox')}`
  return t('automation.step.wake')
}

export function MuseRuleRow({ card }: { card: MuseCardInfo }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const r = card.payload?.rule ?? {}
  const only = onlyText(t, r, true)
  /** 成了返回建出来的规则 id(「改一下」要拿它开画布)或 true;没成 false。别处先答了 / 建规则失败也让两边重读,跟引擎走。 */
  const decide = async (action: string, extra?: Record<string, unknown>): Promise<string | boolean> => {
    if (busy) return false
    setBusy(true)
    const st = useAutomation.getState()
    try {
      const res = await decideMuseCard(homeTarget(), card.id, action, extra)
      return res.trigger?.id ?? true
    } catch (e: any) {
      if (e?.code !== 'card_not_pending') useApp.getState().toast(t('automation.rule.failed', { e: e?.message || String(e) }), true)
      return false
    } finally {
      setBusy(false)
      st.bumpCards()
      st.bump()
    }
  }
  return (
    <div className="auto-starter auto-sugg auto-rulecard" data-muse-card="rule" data-card-id={card.id}>
      <AlarmClock size={20} className="auto-sugg-mark" />
      <strong>{r.desc || t('automation.rule.untitled')}<span className="auto-rulecard-tag">{t('automation.rule.waiting')}</span></strong>
      <span className="auto-sugg-flow">{r.cond ? condText(t, r.cond) : '—'} → {ruleDoText(r, t)}{only ? ` · ${only}` : ''}</span>
      <span className="auto-sugg-why">{t('automation.rule.fromChat')}</span>
      {asking
        ? <div className="auto-sugg-reasons">
            <ReasonPrompt<MuseDismissReason> question={t('automation.rule.why')} reasons={MUSE_DISMISS_REASONS.map((id) => ({ id, label: t(`automation.rule.reason.${id}`) }))}
              skipLabel={t('automation.sugg.reason.skip')} busy={busy} shareable={false}
              onPick={(reason) => void decide('dismiss', reason ? { reason } : undefined)} onCancel={() => setAsking(false)} />
          </div>
        : <div className="auto-rulecard-actions">
            <button type="button" className="btn sm" disabled={busy} onClick={() => void decide('accept')}>{t('automation.rule.ok')}</button>
            {!!r.cond && canObserve(r.cond.type) && <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void decide('observe')}>{t('automation.rule.observe')}</button>}
            <button type="button" className="btn ghost sm" disabled={busy}
              onClick={() => { void decide('edit').then((id) => { if (typeof id === 'string') void useAutomation.getState().openRule(id) }) }}>{t('automation.rule.edit')}</button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => setAsking(true)}>{t('automation.rule.no')}</button>
          </div>}
    </div>
  )
}
