/**
 * 首次引导「权限与数据」的「帮助改进」分页(匿名遥测告知,契约 docs/ToBeImproved/默认数据采集方案_2026-10-28/contract.md §5)。
 * 开关与「看过告知」都存在 Forsion Extend 那边(cloudInvoke 'telemetry:get' / 'telemetry:set'),宿主这里只画:
 * 一张整宽卡片 = 标题 + 一句说明 + 开关(缺省开)、四类数据各一行、底部「隐私政策 ›」。不列「不会发送」(用户定)。
 * 分页面板挂上那一刻记 noticeSeen —— 没看到这一页(跳过了引导)的人,Extend 一条都不发。
 * 结构沿用电脑历史那一页的 .ob-history-* 卡片,不另写样式。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Bot, Bug, ChevronRight, Gauge, MousePointerClick, ShieldCheck, type LucideIcon } from 'lucide-react'
import { useI18n } from '../i18n'
import { FORSION_PRIVACY_URL } from '../appCompliance'
import { SettingsSwitch } from './SettingsPrimitives'
import './computerHistory.css' // .ch-alert

/** Extend telemetry:get 的视图(只取引导用得到的几项)。 */
export interface TelemetryView { available: true; enabled: boolean; noticeSeen: boolean }

const asView = (v: unknown): TelemetryView | null => {
  const o = v as { available?: unknown; enabled?: unknown; noticeSeen?: unknown } | null
  return o && typeof o === 'object' && o.available === true ? { available: true, enabled: o.enabled !== false, noticeSeen: o.noticeSeen === true } : null
}

/** 同步判断:本机的 Extend 有没有遥测通道(preload 只在 Extend 注册了 telemetry:get 时留 telemetryReport 键)。
 *  升级短引导的步骤在挂载时同步定死,只能靠它;真有没有这一页还要等 readTelemetry 答 available。 */
export const improveOnThisHost = (): boolean => typeof window.tangu?.telemetryReport === 'function' && typeof window.tangu?.cloudInvoke === 'function'

/** 读一次;没有通道 / 拒了 / 没答 available → null(页签不出现)。 */
export async function readTelemetry(): Promise<TelemetryView | null> {
  if (!improveOnThisHost()) return null
  try { return asView(await window.tangu!.cloudInvoke!('telemetry:get')) } catch { return null }
}

const ROWS: Array<[LucideIcon, string, string]> = [
  [Bug, 'onboarding.improve.crash', 'onboarding.improve.crashHint'],
  [Bot, 'onboarding.improve.agent', 'onboarding.improve.agentHint'],
  [Gauge, 'onboarding.improve.perf', 'onboarding.improve.perfHint'],
  [MousePointerClick, 'onboarding.improve.usage', 'onboarding.improve.usageHint'],
]

/**
 * @param view 引导挂载时读到的那一份(读不到这一页根本不出现)。
 * @param onChange Extend 回的新视图(完成页的「帮助改进:开 / 关」读它)。
 * @param onBusyChange 开关正在落盘:引导的上一步 / 下一步 / 跳过等它存完(同电脑历史那一页)。
 */
export function OnboardingImprove({ view, onChange, onBusyChange }: {
  view: TelemetryView
  onChange: (view: TelemetryView) => void
  onBusyChange: (busy: boolean) => void
}): React.ReactNode {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 两次写排成一条队:挂载时那次 noticeSeen 和随后的开关先后到 Extend,回来的视图也按这个顺序落,后发的不会被先发的盖掉。
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const live = useRef(true)
  const set = (patch: { enabled?: boolean; noticeSeen?: true }): Promise<void> => {
    const run = chain.current.then(async () => {
      const next = asView(await window.tangu?.cloudInvoke?.('telemetry:set', patch))
      if (next) onChange(next) // 页签切走了也要回写:完成页的「开 / 关」读的是引导那份
    })
    chain.current = run.catch(() => {})
    return run
  }

  useEffect(() => {
    live.current = true
    // 面板露出来 = 看过告知(只能置真;Extend 第一次置真时才开始算 Agent 运行,不补此前的)
    void set({ noticeSeen: true }).catch(() => { /* 记不上就下次引导再记;不打扰 */ })
    return () => { live.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    onBusyChange(busy)
    return () => { if (busy) onBusyChange(false) }
  }, [busy, onBusyChange])

  const toggle = (enabled: boolean): void => {
    setBusy(true)
    setError(null)
    void set({ enabled })
      .catch((e) => { if (live.current) setError(t('onboarding.guide.saveFail', { error: e instanceof Error ? e.message : String(e) })) })
      .finally(() => { if (live.current) setBusy(false) })
  }
  const openPrivacy = (): void => {
    if (window.tangu?.openExternal) void window.tangu.openExternal(FORSION_PRIVACY_URL)
    else window.open(FORSION_PRIVACY_URL, '_blank', 'noopener')
  }

  return (
    <section className="ob-history-card" data-ob-improve="">
      {error !== null && <div className="ch-alert" role="alert">{error}</div>}
      <div className="ob-history-head">
        <ShieldCheck size={18} aria-hidden="true" />
        <div><strong>{t('onboarding.improve.title')}</strong><p>{t('onboarding.improve.summary')}</p></div>
        <SettingsSwitch checked={view.enabled} disabled={busy} onChange={toggle} label={t('onboarding.improve.title')} />
      </div>
      {ROWS.map(([Icon, title, hint]) => (
        <div className="ob-history-row" key={title}>
          <Icon size={16} aria-hidden="true" style={{ flex: 'none', color: 'var(--text-muted)' }} />
          <div><strong>{t(title)}</strong><small>{t(hint)}</small></div>
        </div>
      ))}
      <button type="button" className="ob-history-more" onClick={openPrivacy}>{t('onboarding.improve.privacy')}<ChevronRight size={13} aria-hidden="true" /></button>
    </section>
  )
}
