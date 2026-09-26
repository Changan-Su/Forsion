import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeftRight, ArrowUpRight, RotateCcw, Settings2, X } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import {
  backgroundAdvisoryFor,
  pickQuotaAdvisory,
  publishAccountQuota,
  quotaAdvisoryFor,
  subscribeAccountQuota,
  type AccountQuotaView,
} from '../services/accountQuota'
import { museAvailable } from '../features/runtime'
import { useApp } from '../stores/appStore'
import { ResetCardCeremony, type ResetCardResult } from './ResetCardCeremony'

/** 横幅上「从主额度转入」一次转限额的这个百分比(本周期有效;设置页另有 5 / 10 / 20 可选)。 */
const BANNER_CONVERT_PERCENT = 10

registerMessages({
  'quota.banner.period.daily': { zh: '今日托管 AI 额度', en: "Today's managed AI quota" },
  'quota.banner.period.weekly': { zh: '本周托管 AI 额度', en: 'Weekly managed AI quota' },
  'quota.banner.low': { zh: '{period}剩余 {percent}%', en: '{period} has {percent}% remaining' },
  'quota.banner.near': { zh: '{period}即将用尽，仅剩 {percent}%', en: '{period} is almost used up, with {percent}% remaining' },
  'quota.banner.critical': { zh: '{period}严重不足，仅剩 {percent}%', en: '{period} is critically low, with {percent}% remaining' },
  'quota.banner.exhausted': { zh: '{period}已用尽', en: '{period} is exhausted' },
  'quota.banner.autoDeduct': { zh: '{period}已用尽，正在使用积分自动抵扣', en: '{period} is exhausted; automatic points deduction is active' },
  'quota.banner.upgrade': { zh: '升级会员', en: 'Upgrade membership' },
  'quota.banner.useReset': { zh: '使用重置卡 ({n})', en: 'Use reset card ({n})' },
  'quota.banner.noReset': { zh: '暂无重置卡', en: 'No reset card' },
  'quota.banner.confirmReset': { zh: '再次点击确认', en: 'Click again to confirm' },
  'quota.banner.resetDone': { zh: '已恢复今日与本周额度', en: "Today's and this week's quota has been restored" },
  'quota.banner.resetFail': { zh: '重置额度失败', en: 'Failed to reset quota' },
  'quota.banner.close': { zh: '关闭额度提示', en: 'Dismiss quota notice' },
  'quota.banner.bg.period.daily': { zh: '后台 Agent 今日额度', en: "Background agents' daily quota" },
  'quota.banner.bg.period.weekly': { zh: '后台 Agent 本周额度', en: "Background agents' weekly quota" },
  'quota.banner.bg.exhausted': { zh: '{period}已用尽，Muse 与自动化已暂停', en: '{period} is exhausted; Muse and automations are paused' },
  'quota.banner.bg.autoMain': { zh: '{period}已用尽，正在用主额度继续', en: '{period} is exhausted; continuing on your main quota' },
  'quota.banner.bg.convert': { zh: '从主额度转入 {percent}%', en: 'Move {percent}% from main quota' },
  'quota.banner.bg.convertDone': { zh: '已从主额度转入 {percent}%，本周期有效', en: 'Moved {percent}% from your main quota for this period' },
  'quota.banner.bg.convertFail': { zh: '转入失败', en: 'Failed to move quota' },
  'quota.banner.bg.noMain': { zh: '主额度已用完，没有可转入的额度', en: 'Your main quota is used up; there is nothing to move' },
  'quota.banner.bg.settings': { zh: '后台额度设置', en: 'Background quota settings' },
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
  const [ceremony, setCeremony] = useState<ResetCardResult | null>(null)
  const [confirmConvert, setConfirmConvert] = useState(false)
  const [converting, setConverting] = useState(false)
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
      setConverting(false)
      setConfirmConvert(false)
      setCeremony(null)
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

  // 一个提醒位两个桶:主额度 vs 后台额度(Muse 只在桌面本地引擎跑,别的端不提后台桶)。
  const picked = useMemo(
    () => pickQuotaAdvisory(quotaAdvisoryFor(quota), museAvailable() ? backgroundAdvisoryFor(quota) : null),
    [quota],
  )
  const advisory = picked?.advisory ?? null
  const isBg = picked?.bucket === 'background'
  const advisoryKey = picked ? `${picked.bucket}:${picked.advisory.period}:${picked.advisory.threshold}` : null
  useEffect(() => {
    setConfirmReset(false)
    setConfirmConvert(false)
    if (!advisoryKey) setDismissedKey(null)
  }, [advisoryKey])

  const ceremonyEl = ceremony && <ResetCardCeremony result={ceremony} onClose={() => setCeremony(null)} returnFocusSelector=".t2c-ta" />
  if (!loggedIn || !quota || !advisory) return ceremonyEl
  if (dismissedKey === advisoryKey) return ceremonyEl

  const period = t(isBg ? `quota.banner.bg.period.${advisory.period}` : `quota.banner.period.${advisory.period}`)
  const percent = advisory.remainingPercent > 0 && advisory.remainingPercent < 1
    ? '<1'
    : String(Math.max(0, Math.floor(advisory.remainingPercent)))
  const messageKey = advisory.exhausted
    ? (isBg
      ? (quota.background?.autoMain ? 'quota.banner.bg.autoMain' : 'quota.banner.bg.exhausted')
      : (quota.pointsAutoDeduct ? 'quota.banner.autoDeduct' : 'quota.banner.exhausted'))
    : advisory.threshold === 5 ? 'quota.banner.critical'
      : advisory.threshold === 10 ? 'quota.banner.near'
        : 'quota.banner.low'
  const resetCards = Math.max(0, Number(quota.resetCards) || 0)

  const redeemResetCard = async (): Promise<void> => {
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
        setCeremony({ scope: 'both', before: quota, after: next, remainingCards: response.json.resetCards })
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

  /** 从主额度等额转入后台额度(两击确认,与重置卡同一姿势;转的是限额的百分比,本周期有效)。 */
  const convertToBackground = async (): Promise<void> => {
    if (converting || !window.tangu?.accountBgConvert) return
    if (!confirmConvert) {
      setConfirmConvert(true)
      return
    }
    setConverting(true)
    const id = ++resetRequest.current
    try {
      const response = await window.tangu.accountBgConvert(BANNER_CONVERT_PERCENT)
      if (id !== resetRequest.current) return
      if (response?.status === 200 && response.json?.success) {
        const next = { ...(response.json.quota || {}), resetCards: quota.resetCards } as AccountQuotaView
        setQuota(next)
        publishAccountQuota(next)
        onToast?.(t('quota.banner.bg.convertDone', { percent: String(BANNER_CONVERT_PERCENT) }))
      } else {
        onToast?.(response?.json?.error === 'insufficient_main_quota' ? t('quota.banner.bg.noMain') : String(response?.json?.detail || t('quota.banner.bg.convertFail')), true)
      }
    } catch (error: any) {
      if (id === resetRequest.current) onToast?.(String(error?.message || error || t('quota.banner.bg.convertFail')), true)
    } finally {
      if (id === resetRequest.current) {
        setConverting(false)
        setConfirmConvert(false)
      }
    }
  }

  return <>
    {ceremonyEl}
    <div
      className="t2-quota-advisory"
      data-level={advisory.critical ? 'critical' : advisory.threshold === 10 ? 'near' : 'low'}
      data-bucket={isBg ? 'background' : 'main'}
      role="status"
      aria-live="polite"
    >
      <span className="t2-quota-advisory-copy">
        <AlertTriangle size={14} aria-hidden="true" />
        <span>{t(messageKey, { period, percent })}</span>
      </span>
      {isBg ? <span className="t2-quota-advisory-actions">
        {!!window.tangu?.accountBgConvert && (
          <button className="t2-quota-action convert" disabled={converting} onClick={() => void convertToBackground()}>
            <ArrowLeftRight size={12} className={converting ? 'spin' : undefined} aria-hidden="true" />
            {confirmConvert ? t('quota.banner.confirmReset') : t('quota.banner.bg.convert', { percent: String(BANNER_CONVERT_PERCENT) })}
          </button>
        )}
        <button className="t2-quota-action settings" onClick={() => useApp.getState().openSettings('agents')}>
          <Settings2 size={12} aria-hidden="true" /> {t('quota.banner.bg.settings')}
        </button>
      </span> : <span className="t2-quota-advisory-actions">
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
            onClick={() => void redeemResetCard()}
          >
            <RotateCcw size={12} className={resetting ? 'spin' : undefined} aria-hidden="true" />
            {confirmReset ? t('quota.banner.confirmReset') : resetCards ? t('quota.banner.useReset', { n: String(resetCards) }) : t('quota.banner.noReset')}
          </button>
        )}
      </span>}
      <button className="t2-quota-dismiss" title={t('quota.banner.close')} aria-label={t('quota.banner.close')} onClick={() => setDismissedKey(advisoryKey)}>
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  </>
}
