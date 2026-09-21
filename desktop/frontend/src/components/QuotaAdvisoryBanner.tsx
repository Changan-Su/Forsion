import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpRight, RotateCcw, X } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import {
  publishAccountQuota,
  quotaAdvisoryFor,
  subscribeAccountQuota,
  type AccountQuotaView,
} from '../services/accountQuota'

registerMessages({
  'quota.banner.period.daily': { zh: '今日托管 AI 额度', en: "Today's managed AI quota" },
  'quota.banner.period.weekly': { zh: '本周托管 AI 额度', en: 'Weekly managed AI quota' },
  'quota.banner.low': { zh: '{period}剩余 {percent}%', en: '{period} has {percent}% remaining' },
  'quota.banner.near': { zh: '{period}即将用尽,仅剩 {percent}%', en: '{period} is almost used up, with {percent}% remaining' },
  'quota.banner.critical': { zh: '{period}严重不足,仅剩 {percent}%', en: '{period} is critically low, with {percent}% remaining' },
  'quota.banner.exhausted': { zh: '{period}已用尽', en: '{period} is exhausted' },
  'quota.banner.autoDeduct': { zh: '{period}已用尽,正在使用积分自动抵扣', en: '{period} is exhausted; automatic points deduction is active' },
  'quota.banner.upgrade': { zh: '升级会员', en: 'Upgrade membership' },
  'quota.banner.useReset': { zh: '使用重置卡 ({n})', en: 'Use reset card ({n})' },
  'quota.banner.noReset': { zh: '暂无重置卡', en: 'No reset card' },
  'quota.banner.confirmReset': { zh: '再次点击确认', en: 'Click again to confirm' },
  'quota.banner.resetDone': { zh: '已恢复今日与本周额度', en: "Today's and this week's quota has been restored" },
  'quota.banner.resetFail': { zh: '重置额度失败', en: 'Failed to reset quota' },
  'quota.banner.close': { zh: '关闭额度提示', en: 'Dismiss quota notice' },
})

interface Props {
  loggedIn: boolean
  onToast?: (text: string, error?: boolean) => void
}

export function QuotaAdvisoryBanner({ loggedIn, onToast }: Props) {
  const { t } = useI18n()
  const [quota, setQuota] = useState<AccountQuotaView | null>(null)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const quotaRequest = useRef(0)
  const resetRequest = useRef(0)

  const refresh = useCallback(() => {
    if (!loggedIn || !window.tangu?.accountQuota) {
      setQuota(null)
      return
    }
    const id = ++quotaRequest.current
    void window.tangu.accountQuota()
      .then((response) => {
        if (id !== quotaRequest.current) return
        const next = response?.status === 200 && response.json ? response.json as AccountQuotaView : null
        setQuota(next)
        if (next) publishAccountQuota(next)
      })
      .catch(() => { if (id === quotaRequest.current) setQuota(null) })
  }, [loggedIn])

  useEffect(() => {
    if (!loggedIn) {
      ++quotaRequest.current
      ++resetRequest.current
      setQuota(null)
      setResetting(false)
      setConfirmReset(false)
      return
    }
    refresh()
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      ++quotaRequest.current
      ++resetRequest.current
      window.removeEventListener('focus', onFocus)
    }
  }, [loggedIn, refresh])

  useEffect(() => subscribeAccountQuota((next) => {
    if (loggedIn) setQuota(next)
  }), [loggedIn])

  const advisory = useMemo(() => quotaAdvisoryFor(quota), [quota])
  const advisoryKey = advisory ? `${advisory.period}:${advisory.threshold}` : null
  useEffect(() => {
    setConfirmReset(false)
    if (!advisoryKey) setDismissedKey(null)
  }, [advisoryKey])

  if (!loggedIn || !quota || !advisory) return null
  if (dismissedKey === advisoryKey) return null

  const period = t(`quota.banner.period.${advisory.period}`)
  const percent = advisory.remainingPercent > 0 && advisory.remainingPercent < 1
    ? '<1'
    : String(Math.max(0, Math.floor(advisory.remainingPercent)))
  const messageKey = advisory.exhausted
    ? (quota.pointsAutoDeduct ? 'quota.banner.autoDeduct' : 'quota.banner.exhausted')
    : advisory.threshold === 5 ? 'quota.banner.critical'
      : advisory.threshold === 10 ? 'quota.banner.near'
        : 'quota.banner.low'
  const resetCards = Math.max(0, Number(quota.resetCards) || 0)

  const useResetCard = async (): Promise<void> => {
    if (!resetCards || resetting || !window.tangu?.accountUseResetCard) return
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    setResetting(true)
    const id = ++resetRequest.current
    try {
      const response = await window.tangu.accountUseResetCard('both')
      if (id !== resetRequest.current) return
      if (response?.status === 200 && response.json?.success) {
        const next = {
          ...(response.json.quota || {}),
          resetCards: response.json.resetCards,
        } as AccountQuotaView
        setQuota(next)
        publishAccountQuota(next)
        onToast?.(t('quota.banner.resetDone'))
      } else {
        onToast?.(String(response?.json?.detail || t('quota.banner.resetFail')), true)
      }
    } catch (error: any) {
      if (id === resetRequest.current) onToast?.(String(error?.message || error || t('quota.banner.resetFail')), true)
    } finally {
      if (id === resetRequest.current) {
        setResetting(false)
        setConfirmReset(false)
      }
    }
  }

  return (
    <div
      className="t2-quota-advisory"
      data-level={advisory.critical ? 'critical' : advisory.threshold === 10 ? 'near' : 'low'}
      role="status"
      aria-live="polite"
    >
      <span className="t2-quota-advisory-copy">
        <AlertTriangle size={14} aria-hidden="true" />
        <span>{t(messageKey, { period, percent })}</span>
      </span>
      <span className="t2-quota-advisory-actions">
        {!!window.tangu?.openPayCenter && (
          <button className="t2-quota-action upgrade" onClick={() => void window.tangu?.openPayCenter?.()}>
            {t('quota.banner.upgrade')} <ArrowUpRight size={12} aria-hidden="true" />
          </button>
        )}
        {!!window.tangu?.accountUseResetCard && (
          <button
            className="t2-quota-action reset"
            disabled={!resetCards || resetting}
            title={!resetCards ? t('quota.banner.noReset') : undefined}
            onClick={() => void useResetCard()}
          >
            <RotateCcw size={12} className={resetting ? 'spin' : undefined} aria-hidden="true" />
            {confirmReset ? t('quota.banner.confirmReset') : resetCards ? t('quota.banner.useReset', { n: String(resetCards) }) : t('quota.banner.noReset')}
          </button>
        )}
      </span>
      <button className="t2-quota-dismiss" title={t('quota.banner.close')} aria-label={t('quota.banner.close')} onClick={() => setDismissedKey(advisoryKey)}>
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  )
}
