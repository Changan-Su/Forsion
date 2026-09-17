/** 最后一条助手气泡下的一行 run 统计:「17m 33s · 10.5k tokens · 思考 12s」。运行中逐秒走,结束后冻结。 */
import { useEffect, useState } from 'react'
import { registerMessages, useI18n } from '../../i18n'
import type { RunStats } from '../../stores/runStats'
import { fmtTokens } from './Composer2'

registerMessages({
  'chat.runStats.tokens': { zh: '{n} tokens', en: '{n} tokens' },
  'chat.runStats.thinking': { zh: '思考中 {t}', en: 'Thinking {t}' },
  'chat.runStats.thought': { zh: '思考 {t}', en: 'Thought for {t}' },
})

/** 33s / 17m 33s / 1h 02m */
export const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
}

export function RunStatsLine({ stats }: { stats: RunStats }) {
  const { t } = useI18n()
  const live = stats.finishedAt == null
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])
  const end = stats.finishedAt ?? now
  const think = stats.thinkMs + (stats.thinkSince != null ? Math.max(0, end - stats.thinkSince) : 0)
  const parts = [fmtElapsed(end - stats.startedAt)]
  if (stats.tokens > 0) parts.push(t('chat.runStats.tokens', { n: fmtTokens(stats.tokens) }))
  if (stats.thinkTracked && think >= 1000) parts.push(t(stats.thinkSince != null ? 'chat.runStats.thinking' : 'chat.runStats.thought', { t: fmtElapsed(think) }))
  return <div className="t2-dim t2-runstats" data-run-stats={live ? 'live' : 'done'}>{parts.join(' · ')}</div>
}
