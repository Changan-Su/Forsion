import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeftRight, ArrowUpRight, Coins, RotateCcw, Settings2, X } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import {
  backgroundAdvisoryFor,
  formatRemaining,
  mergeQuotaView,
  notePointsConfirmed,
  pickQuotaAdvisory,
  pointsBalanceOf,
  pointsReadToken,
  reconcilePointsRead,
  publishAccountQuota,
  quotaAdvisoryFor,
  subscribeAccountQuota,
  type AccountQuotaView,
} from '../services/accountQuota'
import { pointsAutoDeductAvailable, setPointsAutoDeduct } from '../tangu/pointsAutoDeduct'
import { museAvailable } from '../features/runtime'
import { useApp } from '../stores/appStore'
import { ResetCardCeremony, type ResetCardResult } from './ResetCardCeremony'

/** 横幅上「从 AI 额度转入」一次转限额的这个百分比(本周期有效;「Forsion 云端 → 额度与积分」另有 5 / 10 / 20 可选)。 */
const BANNER_CONVERT_PERCENT = 10

registerMessages({
  // 用词与口径全端统一(2026-09-28 个人中心盘点 C4 / C8):AI 额度 / 后台额度 / 额度重置卡;{percent} 已带 %(<1% 也在内)
  'quota.banner.period.daily': { zh: '今日 AI 额度', en: "Today's AI quota" },
  'quota.banner.period.weekly': { zh: '本周 AI 额度', en: "This week's AI quota" },
  'quota.banner.low': { zh: '{period}剩余 {percent}', en: '{period} has {percent} remaining' },
  'quota.banner.near': { zh: '{period}即将用尽，仅剩 {percent}', en: '{period} is almost used up, with {percent} remaining' },
  'quota.banner.critical': { zh: '{period}严重不足，仅剩 {percent}', en: '{period} is critically low, with {percent} remaining' },
  'quota.banner.exhausted': { zh: '{period}已用尽', en: '{period} is exhausted' },
  'quota.banner.upgrade': { zh: '升级会员', en: 'Upgrade membership' },
  'quota.banner.useReset': { zh: '使用额度重置卡（{n}）', en: 'Use a quota reset card ({n})' },
  'quota.banner.confirmReset': { zh: '再次点击确认', en: 'Click again to confirm' },
  // 额度用完后用积分继续(2026-11-13):只讲开关、余额、一句说明,不显示汇率与点数
  'quota.banner.usePoints': { zh: '用积分继续', en: 'Continue with points' },
  'quota.banner.confirmPoints': { zh: '确认用积分继续', en: 'Confirm: continue with points' },
  'quota.banner.usePointsTip': { zh: '打开后，额度用完时用积分继续；可随时在「额度与积分」里关掉', en: 'When your quota runs out, keep going with points. You can turn this off anytime in Quota & points.' },
  'quota.banner.recharge': { zh: '充值积分', en: 'Buy points' },
  'quota.banner.pointsOn': { zh: '{period}已用完，正在用积分继续', en: '{period} is used up; continuing with points' },
  'quota.banner.pointsOut': { zh: '{period}已用完，积分也用完了', en: '{period} is used up, and so are your points' },
  'quota.banner.pointsBalance': { zh: '积分余额 {n}', en: 'Balance: {n} points' },
  'quota.banner.pointsFail': { zh: '没能打开积分继续', en: "Couldn't turn on continuing with points" },
  'quota.banner.pointsUnknown': { zh: '{period}已用尽，暂时确认不了「用积分继续」开没开', en: "{period} is used up; couldn't confirm whether continuing with points is on" },
  'quota.banner.retry': { zh: '重试', en: 'Retry' },
  'quota.banner.pointsUnavailable': { zh: '积分继续暂时开不了，请稍后再试', en: "Continuing with points isn't available right now. Try again later." },
  'quota.banner.resetFail': { zh: '重置额度失败', en: 'Failed to reset quota' },
  'quota.banner.close': { zh: '关闭额度提示', en: 'Dismiss quota notice' },
  'quota.banner.bg.period.daily': { zh: '今日后台额度', en: "Today's background quota" },
  'quota.banner.bg.period.weekly': { zh: '本周后台额度', en: "This week's background quota" },
  'quota.banner.bg.exhausted': { zh: '{period}已用尽，Muse 与自动化已暂停', en: '{period} is exhausted; Muse and automations are paused' },
  'quota.banner.bg.autoMain': { zh: '{period}已用尽，正在用 AI 额度继续', en: '{period} is exhausted; continuing on your AI quota' },
  'quota.banner.bg.convert': { zh: '从 AI 额度转入 {percent}%', en: 'Move {percent}% from AI quota' },
  'quota.banner.bg.convertDone': { zh: '已从 AI 额度转入 {percent}%，本周期有效', en: 'Moved {percent}% from your AI quota for this period' },
  'quota.banner.bg.convertFail': { zh: '转入失败', en: 'Failed to move quota' },
  'quota.banner.bg.noMain': { zh: 'AI 额度已用完，没有可转入的额度', en: 'Your AI quota is used up; there is nothing to move' },
  'quota.banner.bg.settings': { zh: '后台额度设置', en: 'Background quota settings' },
})

interface Props {
  loggedIn: boolean
  onToast?: (text: string, error?: boolean) => void
}

export function QuotaAdvisoryBanner({ loggedIn, onToast }: Props) {
  const { t, locale } = useI18n()
  const [quota, setQuota] = useState<AccountQuotaView | null>(null)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [ceremony, setCeremony] = useState<ResetCardResult | null>(null)
  const [confirmConvert, setConfirmConvert] = useState(false)
  const [converting, setConverting] = useState(false)
  const [confirmPoints, setConfirmPoints] = useState(false)
  const [enablingPoints, setEnablingPoints] = useState(false)
  /** 写开关后确定不了服务端状态、重读也失败:显示「状态未知 + 重试」,绝不显示成没开 */
  const [pointsUnknown, setPointsUnknown] = useState(false)
  const quotaRequest = useRef(0)
  const resetRequest = useRef(0)

  const refresh = useCallback(() => {
    if (!loggedIn || !window.tangu?.accountQuota) {
      setQuota(null)
      return
    }
    const id = ++quotaRequest.current
    const token = pointsReadToken()
    void window.tangu.accountQuota()
      .then((response) => {
        if (id !== quotaRequest.current) return
        // 发出之后开关被写过:用已确认的值,别让这份旧读取盖掉
        const next = reconcilePointsRead(response?.status === 200 && response.json ? response.json as AccountQuotaView : null, token)
        notePointsConfirmed(next, token)
        if (next && token === pointsReadToken() && typeof next.pointsAutoDeduct === 'boolean') setPointsUnknown(false)
        setQuota(next)
        if (next) publishAccountQuota(next)
      })
      .catch(() => { if (id === quotaRequest.current) setQuota(null) })
  }, [loggedIn])

  /** 写开关结果不确定时重读一次,以服务端为准;读不到就停在「未知」(保留原来那份视图,不清空横幅)。 */
  const rereadPoints = useCallback(async (): Promise<void> => {
    const id = ++quotaRequest.current
    const token = pointsReadToken()
    try {
      const response = await window.tangu?.accountQuota?.()
      if (id !== quotaRequest.current) return
      const next = response?.status === 200 && response.json && typeof response.json.pointsAutoDeduct === 'boolean' ? response.json as AccountQuotaView : null
      if (!next) { setPointsUnknown(true); return }
      notePointsConfirmed(next, token)
      setPointsUnknown(false)
      setQuota(next)
      publishAccountQuota(next)
    } catch {
      if (id === quotaRequest.current) setPointsUnknown(true)
    }
  }, [])

  useEffect(() => {
    if (!loggedIn) {
      ++quotaRequest.current
      ++resetRequest.current
      setQuota(null)
      setResetting(false)
      setConfirmReset(false)
      setConverting(false)
      setConfirmConvert(false)
      setEnablingPoints(false)
      setConfirmPoints(false)
      setPointsUnknown(false)
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
  // 主额度用尽后的三态:没开积分 / 正在用积分 / 积分也用完了。开关状态进 key:关掉过「已用尽」,之后打开了积分照样提示一次
  const balance = pointsBalanceOf(quota)
  const pointsState = !picked || isBg || !picked.advisory.exhausted ? null
    : pointsUnknown ? 'unknown'
    : !quota?.pointsAutoDeduct ? 'off'
      : balance === 0 ? 'out' : 'on'
  const advisoryKey = picked ? `${picked.bucket}:${picked.advisory.period}:${picked.advisory.threshold}${pointsState ? `:${pointsState}` : ''}` : null
  useEffect(() => {
    setConfirmReset(false)
    setConfirmConvert(false)
    setConfirmPoints(false)
    if (!advisoryKey) setDismissedKey(null)
  }, [advisoryKey])

  const ceremonyEl = ceremony && <ResetCardCeremony result={ceremony} onClose={() => setCeremony(null)} returnFocusSelector=".t2c-ta" />
  if (!loggedIn || !quota || !advisory) return ceremonyEl
  if (dismissedKey === advisoryKey) return ceremonyEl

  const period = t(isBg ? `quota.banner.bg.period.${advisory.period}` : `quota.banner.period.${advisory.period}`)
  const percent = formatRemaining(advisory.remainingPercent, '')
  const messageKey = advisory.exhausted
    ? (isBg
      ? (quota.background?.autoMain ? 'quota.banner.bg.autoMain' : 'quota.banner.bg.exhausted')
      : pointsState === 'on' ? 'quota.banner.pointsOn' : pointsState === 'out' ? 'quota.banner.pointsOut'
        : pointsState === 'unknown' ? 'quota.banner.pointsUnknown' : 'quota.banner.exhausted')
    : advisory.threshold === 5 ? 'quota.banner.critical'
      : advisory.threshold === 10 ? 'quota.banner.near'
        : 'quota.banner.low'
  const resetCards = Math.max(0, Number(quota.resetCards) || 0)
  const balanceText = balance === null ? '' : balance.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')
  const canPay = !!window.tangu?.openPayCenter

  const redeemResetCard = async (): Promise<void> => {
    if (!resetCards || resetting || !window.tangu?.accountUseResetCard) return
    if (!confirmReset) {
      setConfirmReset(true)
      setConfirmPoints(false)
      return
    }
    setResetting(true)
    const id = ++resetRequest.current
    const token = pointsReadToken()
    try {
      const response = await window.tangu.accountUseResetCard('both')
      if (id !== resetRequest.current) return
      if (response?.status === 200 && response.json?.success) {
        const next = reconcilePointsRead(mergeQuotaView(quota, response.json.quota, { resetCards: response.json.resetCards }), token)
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
        const next = mergeQuotaView(quota, response.json.quota)
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

  /** 打开「额度用完后用积分继续」(两击确认,与用卡同一姿势)。成功后横幅自己变成「正在用积分继续」。 */
  const enablePoints = async (): Promise<void> => {
    if (enablingPoints || !pointsAutoDeductAvailable(quota)) return
    if (!confirmPoints) {
      setConfirmPoints(true)
      setConfirmReset(false)
      return
    }
    setEnablingPoints(true)
    const id = ++resetRequest.current
    try {
      const result = await setPointsAutoDeduct(true, quota)
      if (id !== resetRequest.current) return
      if (result.ok) {
        setPointsUnknown(false)
        setQuota(result.quota)
        publishAccountQuota(result.quota)
      } else if (result.reason === 'unknown') {
        // 确定不了:服务端可能已经打开了。保持忙碌态重读一次,以服务端的开关状态为准;重读也失败 → 「未知 + 重试」
        await rereadPoints()
      } else {
        // no-bridge:扩展没有这条通道(宿主比扩展新),按钮随即消失;一下点击别白点,照样说一句
        onToast?.(result.reason === 'failed' ? result.detail || t('quota.banner.pointsFail') : t('quota.banner.pointsUnavailable'), true)
      }
    } catch (error: any) {
      if (id === resetRequest.current) onToast?.(String(error?.message || error || t('quota.banner.pointsFail')), true)
    } finally {
      if (id === resetRequest.current) {
        setEnablingPoints(false)
        setConfirmPoints(false)
      }
    }
  }

  const level = pointsState === 'on' ? 'info' : advisory.critical ? 'critical' : advisory.threshold === 10 ? 'near' : 'low'
  const upgradeButton = canPay && (
    <button className="t2-quota-action upgrade" onClick={() => void window.tangu?.openPayCenter?.()}>
      {t('quota.banner.upgrade')} <ArrowUpRight size={12} aria-hidden="true" />
    </button>
  )
  const rechargeButton = canPay && (
    <button className="t2-quota-action recharge" onClick={() => void window.tangu?.openPayCenter?.()}>
      <Coins size={12} aria-hidden="true" /> {t('quota.banner.recharge')}
    </button>
  )
  // 积分那条路:开关没开 → 有余额给「用积分继续」(要有写通道),余额 0 给「充值积分」;余额读不到 = 不知道,两样都不给
  const pointsButton = pointsState === 'off' && balance !== null && (
    balance > 0
      ? pointsAutoDeductAvailable(quota) && (
        <button className="t2-quota-action points" disabled={enablingPoints} title={t('quota.banner.usePointsTip')} onClick={() => void enablePoints()}>
          <Coins size={12} className={enablingPoints ? 'spin' : undefined} aria-hidden="true" />
          {confirmPoints ? t('quota.banner.confirmPoints') : t('quota.banner.usePoints')}
        </button>
      )
      : pointsAutoDeductAvailable(quota) && rechargeButton
  )

  return <>
    {ceremonyEl}
    <div
      className="t2-quota-advisory"
      data-level={level}
      data-bucket={isBg ? 'background' : 'main'}
      data-points={pointsState || undefined}
      role="status"
      aria-live="polite"
    >
      <span className="t2-quota-advisory-copy">
        {pointsState === 'on' ? <Coins size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
        <span>{t(messageKey, { period, percent })}</span>
        {pointsState === 'on' && balanceText && <span className="t2-quota-advisory-sub">{t('quota.banner.pointsBalance', { n: balanceText })}</span>}
      </span>
      {isBg ? <span className="t2-quota-advisory-actions">
        {!!window.tangu?.accountBgConvert && (
          <button className="t2-quota-action convert" disabled={converting} onClick={() => void convertToBackground()}>
            <ArrowLeftRight size={12} className={converting ? 'spin' : undefined} aria-hidden="true" />
            {confirmConvert ? t('quota.banner.confirmReset') : t('quota.banner.bg.convert', { percent: String(BANNER_CONVERT_PERCENT) })}
          </button>
        )}
        <button className="t2-quota-action settings" onClick={() => useApp.getState().openSettings('forsion/fx:forsion-extend:quota' as Parameters<ReturnType<typeof useApp.getState>['openSettings']>[0])}>
          <Settings2 size={12} aria-hidden="true" /> {t('quota.banner.bg.settings')}
        </button>
      </span> : <span className="t2-quota-advisory-actions">
        {pointsState === 'out' ? rechargeButton : null}
        {upgradeButton}
        {/* 重置卡不能再买 / 兑换(2026-11-13):手里有卡才给这条路,没有卡不再挂一颗灰按钮 */}
        {resetCards > 0 && !!window.tangu?.accountUseResetCard && (
          <button
            className="t2-quota-action reset"
            disabled={resetting}
            onClick={() => void redeemResetCard()}
          >
            <RotateCcw size={12} className={resetting ? 'spin' : undefined} aria-hidden="true" />
            {confirmReset ? t('quota.banner.confirmReset') : t('quota.banner.useReset', { n: String(resetCards) })}
          </button>
        )}
        {pointsButton}
        {pointsState === 'unknown' && (
          <button className="t2-quota-action points" disabled={enablingPoints} onClick={() => {
            setEnablingPoints(true)
            void rereadPoints().finally(() => setEnablingPoints(false))
          }}>
            <RotateCcw size={12} className={enablingPoints ? 'spin' : undefined} aria-hidden="true" /> {t('quota.banner.retry')}
          </button>
        )}
      </span>}
      <button className="t2-quota-dismiss" title={t('quota.banner.close')} aria-label={t('quota.banner.close')} onClick={() => setDismissedKey(advisoryKey)}>
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  </>
}
