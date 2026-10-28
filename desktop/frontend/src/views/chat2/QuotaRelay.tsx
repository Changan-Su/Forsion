/**
 * 额度用完接力的界面半(方案 docs/ToBeImproved/借鉴magpie方案_2026-10-28/relay.html,A + 「换之前先问我」)。
 * 引擎半在 tangu-agent/src/llm/quotaRelay.ts:换了就发 status model_fallback(和服务端停用模型同一种事件),
 * 「先问我」开着时这一轮以 `[quota_fallback_ask:<模型>]` 结尾的错误停下。
 */
import { useEffect, useState } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { formatDateTime, formatTime } from '../../format/time'
import type { UiMessage } from '../../types'

registerMessages({
  'relay.line.quota': { zh: '{from} 的额度用完了（{time} 重置），这一轮改用 {to}', en: '{from} is out of quota (resets {time}), so this turn used {to}' },
  'relay.line.quotaNoTime': { zh: '{from} 的额度用完了，这一轮改用 {to}', en: '{from} is out of quota, so this turn used {to}' },
  'relay.line.quotaBare': { zh: '额度用完了，这一轮改用 {to}', en: 'Quota ran out, so this turn used {to}' },
  'relay.line.disabled': { zh: '{from} 已停用，这一轮改用 {to}', en: '{from} is disabled, so this turn used {to}' },
  'relay.line.disabledBare': { zh: '原模型已停用，这一轮改用 {to}', en: 'The model was disabled, so this turn used {to}' },
  'relay.settings': { zh: '设置', en: 'Settings' },
  'relay.wait': { zh: '等重置', en: 'Wait for reset' },
  'relay.switch': { zh: '改用 {to}', en: 'Use {to}' },
  'relay.always': { zh: '以后额度用完都改用 {to}', en: 'Always use {to} when quota runs out' },
})

/** 和引擎 llm/retry.ts 的 QUOTA_EXHAUSTED 同一组:订阅额度 / 账单配额用完(几小时才重置,不是限流)。 */
export const QUOTA_RE = /usage limit|usage_limit_reached|usage_not_included|insufficient_quota|quota exceeded|exceeded your current quota|out of budget|billing_hard_limit/i
const ASK_RE = /\s*\[quota_fallback_ask:([^\]\s]+)\]/
export const stripQuotaAsk = (raw: string): string => raw.replace(ASK_RE, '')

/** 重置时刻:今天的只写「19:40」,跨天带日期。 */
const resetText = (ms: number): string => (new Date(ms).toDateString() === new Date().toDateString() ? formatTime(ms) : formatDateTime(ms))
/** 引擎报错尾巴「(resets … at 2026-10-28T11:40:00.000Z)」里的重置时刻。 */
export function quotaResetFromError(raw: string): string {
  const m = /\bat (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(raw)
  const ms = m ? Date.parse(m[1]) : NaN
  return ms > Date.now() ? resetText(ms) : ''
}

function useModelName(): (id?: string) => string {
  const models = useApp((s) => s.modelsResp?.models)
  return (id) => (id ? models?.find((m) => m.id === id)?.name || id.split('/').pop() || id : '')
}

/** 回答者名字后面的实际模型:「Tangu · GPT-6 Luna」。 */
export function FallbackModelName({ fb }: { fb: NonNullable<UiMessage['fallback']> }) {
  const name = useModelName()
  return <span className="t2-name-model"> · {fb.toName || name(fb.to)}</span>
}

/** 回答前面那一行:「X 的额度用完了（19:40 重置），这一轮改用 Y · 设置」。 */
export function FallbackLine({ fb }: { fb: NonNullable<UiMessage['fallback']> }) {
  const { t } = useI18n()
  const name = useModelName()
  const from = name(fb.from), to = fb.toName || name(fb.to)
  const quota = fb.reason === 'quota'
  const key = quota ? (!from ? 'relay.line.quotaBare' : fb.resetsAt ? 'relay.line.quota' : 'relay.line.quotaNoTime') : from ? 'relay.line.disabled' : 'relay.line.disabledBare'
  return (
    <div className="t2-sys t2-fallback-line" data-fallback={fb.reason || 'disabled'}>
      <ArrowRightLeft size={12} />
      <span>{t(key, { from, to, time: fb.resetsAt ? resetText(fb.resetsAt) : '' })}</span>
      {quota && <button type="button" className="t2-failed-btn" onClick={() => useApp.getState().openSettings('model/m-models')}>{t('relay.settings')}</button>}
    </div>
  )
}

/** 额度用完那条错误后面的按钮:先问我 → 「等重置 / 改用 X」;没设后备 → 「以后额度用完都改用 X」(点了才写进设置)。 */
export function QuotaChips({ error, messageId, sessionId, modelId }: { error?: string; messageId: string; sessionId?: string; modelId?: string }) {
  const { t } = useI18n()
  const name = useModelName()
  const cloudDefault = useApp((s) => s.modelsResp?.defaultModelId)
  const [hidden, setHidden] = useState(false)
  const [fallbackSet, setFallbackSet] = useState<boolean | null>(null)
  const quota = !!error && QUOTA_RE.test(error)
  const ask = error ? ASK_RE.exec(error)?.[1] : undefined
  useEffect(() => {
    if (!quota || ask || !window.tangu?.getConfig) return
    let alive = true
    void window.tangu.getConfig().then((c) => { if (alive) setFallbackSet(!!c.quotaFallbackModelId) }).catch(() => {})
    return () => { alive = false }
  }, [quota, ask])
  if (!quota || hidden || !sessionId || !window.tangu?.setConfig) return null
  const retry = (quotaFallback?: boolean) => useApp.getState().regenerate(messageId, sessionId, quotaFallback ? { quotaFallback } : undefined)
  if (ask) return (
    <span className="t2-failed">
      <button type="button" className="t2-failed-btn" onClick={() => setHidden(true)}>{t('relay.wait')}</button>
      <button type="button" className="t2-failed-btn primary" onClick={() => retry(true)}>{t('relay.switch', { to: name(ask) })}</button>
    </span>
  )
  if (fallbackSet !== false || !cloudDefault || cloudDefault === modelId) return null
  // 写进设置后重发:原模型在引擎里记着「用完到几点」,这一轮直接走后备并画「改用了」那一行
  return (
    <button type="button" className="t2-failed-btn primary" onClick={() => void window.tangu!.setConfig({ quotaFallbackModelId: cloudDefault }).then(() => { setHidden(true); retry() })}>
      {t('relay.always', { to: name(cloudDefault) })}
    </button>
  )
}
