/** 最后一条助手气泡下的一行 run 统计:「17m 33s · 输出 2.0k tokens · 思考 12s」。运行中逐秒走,结束后冻结。
 *  只写输出:引擎的 total 把每次调用的整段上下文都算一遍(大半是缓存),读着像这句回答很贵;输入 / 其中缓存放悬停里。 */
import { useEffect, useState } from 'react'
import { registerMessages, useI18n } from '../../i18n'
import type { RunStats } from '../../stores/runStats'
import { fmtTokens } from './Composer2'
import { fmtElapsed } from '../../../../../tangu-agent/src/contracts/sessionStatus'
export { fmtElapsed } from '../../../../../tangu-agent/src/contracts/sessionStatus'

registerMessages({
  'chat.runStats.output': { zh: '输出 {n} tokens', en: '{n} output tokens' },
  // 悬停拆分:输入按每次模型调用累计(每次都含整段上下文),所以远大于输出
  'chat.runStats.breakdown': { zh: '输入 {input} · 输出 {output}（按每次模型调用累计）', en: 'Input {input} · output {output} (summed over every model call)' },
  'chat.runStats.breakdownCached': { zh: '输入 {input}（其中缓存 {cached}）· 输出 {output}（按每次模型调用累计）', en: 'Input {input} ({cached} cached) · output {output} (summed over every model call)' },
  'chat.runStats.thinking': { zh: '思考中 {t}', en: 'Thinking {t}' },
  'chat.runStats.thought': { zh: '思考 {t}', en: 'Thought for {t}' },
})


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
  const output = stats.output || 0
  if (output > 0) parts.push(t('chat.runStats.output', { n: fmtTokens(output) }))
  if (stats.thinkTracked && think >= 1000) parts.push(t(stats.thinkSince != null ? 'chat.runStats.thinking' : 'chat.runStats.thought', { t: fmtElapsed(think) }))
  const cached = stats.cached || 0
  const title = output > 0 || (stats.input || 0) > 0
    ? t(cached > 0 ? 'chat.runStats.breakdownCached' : 'chat.runStats.breakdown', { input: fmtTokens(stats.input || 0), cached: fmtTokens(cached), output: fmtTokens(output) })
    : undefined
  return <div className="t2-dim t2-runstats" data-run-stats={live ? 'live' : 'done'} title={title}>{parts.join(' · ')}</div>
}
