import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Check, RotateCcw, X } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import type { AccountQuotaView } from '../services/accountQuota'
import './resetCardCeremony.css'

registerMessages({
  'reset.ceremony.eyebrow': { zh: 'FORSION · 额度重置卡', en: 'FORSION · Quota reset card' },
  'reset.ceremony.title': { zh: '额度已焕新', en: 'Quota restored' },
  'reset.ceremony.both': { zh: '今日与本周额度已恢复', en: "Today's and this week's quota has been restored" },
  'reset.ceremony.weekly': { zh: '本周额度已恢复', en: "This week's quota has been restored" },
  'reset.ceremony.dailyLabel': { zh: '今日', en: 'Today' },
  'reset.ceremony.weeklyLabel': { zh: '本周', en: 'This week' },
  'reset.ceremony.remaining': { zh: '重置卡剩余 {n} 张', en: '{n} reset cards remaining' },
  'reset.ceremony.continue': { zh: '继续使用', en: 'Continue' },
  'reset.ceremony.close': { zh: '关闭', en: 'Close' },
})

export type ResetCardScope = 'both' | 'weekly'

export interface ResetCardResult {
  scope: ResetCardScope
  before: AccountQuotaView
  after: AccountQuotaView
  remainingCards?: number
}

/** 百分比以服务端剩余量为准；旧宿主只有「已用百分比」时才回退。 */
function remainingPercent(quota: AccountQuotaView, period: 'daily' | 'weekly'): number | null {
  const limit = Number(quota[`${period}Limit`])
  if (!Number.isFinite(limit) || limit < 0) return null
  if (limit === 0) return 0
  const remainingValue = quota[`${period}Remaining`]
  const remaining = remainingValue == null ? NaN : Number(remainingValue)
  const usedValue = quota[`${period}Percent`]
  const used = usedValue == null ? NaN : Number(usedValue)
  const percent = Number.isFinite(remaining) ? remaining / limit * 100 : 100 - used
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null
}

export function ResetCardCeremony({ result, onClose, returnFocusSelector }: { result: ResetCardResult; onClose: () => void; returnFocusSelector: string }) {
  const { t } = useI18n()
  const closeRef = useRef<HTMLButtonElement>(null)
  const continueRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const rows = useMemo(() => {
    const periods: Array<'daily' | 'weekly'> = result.scope === 'weekly' ? ['weekly'] : ['daily', 'weekly']
    return periods.map((period) => ({
      period,
      before: remainingPercent(result.before, period),
      after: remainingPercent(result.after, period),
    }))
      .filter((row) => row.after !== null)
  }, [result])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return }
      if (event.key !== 'Tab') return
      const first = closeRef.current
      const last = continueRef.current
      if (!first || !last) return
      if (getComputedStyle(last).visibility === 'hidden') {
        event.preventDefault()
        first.focus()
        return
      }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (previousFocus?.isConnected) previousFocus.focus()
      else document.querySelector<HTMLElement>(returnFocusSelector)?.focus()
    }
  }, [returnFocusSelector])

  return createPortal(
    <div className="reset-ceremony-backdrop">
      <section className="reset-ceremony" role="dialog" aria-modal="true" aria-labelledby="reset-ceremony-title" aria-describedby="reset-ceremony-description">
        <button ref={closeRef} className="reset-ceremony-close" aria-label={t('reset.ceremony.close')} onClick={onClose}><X size={16} aria-hidden="true" /></button>
        <div className="reset-ceremony-scene" aria-hidden="true">
          <span className="reset-ceremony-halo" />
          <div className="reset-ceremony-card">
            <div className="reset-ceremony-card-top"><span>FORSION</span><RotateCcw size={19} strokeWidth={1.5} /></div>
            <span className="reset-ceremony-card-mark">F</span>
            <span className="reset-ceremony-card-bottom">QUOTA RESET</span>
            <span className="reset-ceremony-card-sheen" />
          </div>
          <span className="reset-ceremony-seal"><Check size={21} strokeWidth={2.2} /></span>
        </div>
        <div className="reset-ceremony-eyebrow">{t('reset.ceremony.eyebrow')}</div>
        <h2 id="reset-ceremony-title">{t('reset.ceremony.title')}</h2>
        <p id="reset-ceremony-description">{t(result.scope === 'weekly' ? 'reset.ceremony.weekly' : 'reset.ceremony.both')}</p>
        {rows.length > 0 && <div className="reset-ceremony-quotas">
          {rows.map(({ period, before, after }) => <div className="reset-ceremony-quota" key={period}>
            <div className="reset-ceremony-quota-copy">
              <span>{t(`reset.ceremony.${period}Label`)}</span>
              <span className="reset-ceremony-values"><span>{before == null ? '—' : `${Math.round(before)}%`}</span><span aria-hidden="true">→</span><strong>{Math.round(after!)}%</strong></span>
            </div>
            <div className="reset-ceremony-track" aria-hidden="true"><span style={{ '--reset-before': `${before ?? 0}%`, '--reset-after': `${after}%` } as React.CSSProperties} /></div>
          </div>)}
        </div>}
        <div className="reset-ceremony-footer">
          {result.remainingCards != null && <span>{t('reset.ceremony.remaining', { n: String(result.remainingCards) })}</span>}
          <button ref={continueRef} className="reset-ceremony-continue" onClick={onClose}>{t('reset.ceremony.continue')}</button>
        </div>
      </section>
    </div>, document.body,
  )
}
