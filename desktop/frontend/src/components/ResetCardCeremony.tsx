import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Check, RotateCcw, X } from 'lucide-react'
import { HostLocaleProvider, registerMessages, useI18n } from '../i18n'
import { formatRemaining, remainingPercent as remainingOf, type AccountQuotaView } from '../services/accountQuota'
import './resetCardCeremony.css'

registerMessages({
  'reset.ceremony.eyebrow': { zh: 'FORSION · 额度重置卡', en: 'FORSION · Quota reset card' },
  'reset.ceremony.title': { zh: '额度已焕新', en: 'Quota restored' },
  'reset.ceremony.both': { zh: '今日与本周额度已恢复', en: "Today's and this week's quota has been restored" },
  'reset.ceremony.dailyLabel': { zh: '今日', en: 'Today' },
  'reset.ceremony.weeklyLabel': { zh: '本周', en: 'This week' },
  'reset.ceremony.remaining': { zh: '额度重置卡剩余 {n} 张', en: '{n} quota reset cards remaining' },
  'reset.ceremony.continue': { zh: '继续使用', en: 'Continue' },
  'reset.ceremony.close': { zh: '关闭', en: 'Close' },
})

/** 服务端只收 'both'(周卡 2026-08-05 下线);保留类型名是给调用方一个显式的口径。 */
export type ResetCardScope = 'both'

export interface ResetCardResult {
  scope: ResetCardScope
  before: AccountQuotaView
  after: AccountQuotaView
  remainingCards?: number
}

/** 百分比与全端同一口径(services/accountQuota):以服务端剩余量为准,旧宿主只有「已用百分比」时才回退。 */
const remainingPercent = (quota: AccountQuotaView, period: 'daily' | 'weekly'): number | null =>
  remainingOf(quota[`${period}Limit`], quota[`${period}Remaining`], quota[`${period}Percent`])

export function ResetCardCeremony({ result, onClose, returnFocusSelector }: { result: ResetCardResult; onClose: () => void; returnFocusSelector: string }) {
  const { t } = useI18n()
  const closeRef = useRef<HTMLButtonElement>(null)
  const continueRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const rows = useMemo(() => {
    return (['daily', 'weekly'] as const).map((period) => ({
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
        <p id="reset-ceremony-description">{t('reset.ceremony.both')}</p>
        {rows.length > 0 && <div className="reset-ceremony-quotas">
          {rows.map(({ period, before, after }) => <div className="reset-ceremony-quota" key={period}>
            <div className="reset-ceremony-quota-copy">
              <span>{t(`reset.ceremony.${period}Label`)}</span>
              <span className="reset-ceremony-values"><span>{before == null ? '—' : formatRemaining(before, '—')}</span><span aria-hidden="true">→</span><strong>{formatRemaining(after, '—')}</strong></span>
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

/** 不挂在任何组件树上的一次性弹出:菜单用完卡就关了,插件(ctx.app.showResetCardCeremony)也没有 React 树可挂。 */
export function presentResetCardCeremony(result: ResetCardResult, returnFocusSelector = '.ribbon-account, .account-card'): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  // 关闭钮的点击还在这棵树的事件里:推到下一拍再卸,免得同步卸载正在派发事件的根
  let closed = false
  const close = (): void => { if (!closed) { closed = true; queueMicrotask(() => { root.unmount(); host.remove() }) } }
  root.render(<HostLocaleProvider><ResetCardCeremony result={result} onClose={close} returnFocusSelector={returnFocusSelector} /></HostLocaleProvider>)
}
