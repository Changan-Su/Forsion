import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Sprout } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { showDetails } from '../stores/detailsSubject'
import { getAgentHarness, getAgentMemorySnapshot } from '../services/backendService'
import { openingSummary } from '../services/selfUpdates'
import { homeTarget } from '../services/engine/targets'
import './SelfUpdateReceipt' // 复用「记住了 N 件事 / 进化记录更新 N 处」
import './selfUpdates.css'

registerMessages({
  'selfOpening.line': { zh: '上次之后，{name} 在后台{parts}', en: 'Since last time, {name} worked in the background — {parts}' },
  'selfOpening.view': { zh: '查看', en: 'View' },
})

// 「上次看到哪」按 Agent 记在本机(slug → 时刻)。存不下时本次运行里照样记着(seenHere),不会点了「查看」又冒出来。
const SEEN_KEY = 'forsion.selfSeen'
const seenHere: Record<string, number> = {}
const readSeen = (): Record<string, number> => {
  let stored: Record<string, number> = {}
  try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); if (v && typeof v === 'object') stored = v } catch { /* ignore */ }
  return { ...stored, ...seenHere }
}
const markSeen = (slug: string): void => {
  seenHere[slug] = Date.now()
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(readSeen())) } catch { /* ignore */ }
}

/** 开场:开新对话时,输入框上方一行「上次之后它在后台记住了 / 学到了什么」。看过一次就消失(点「查看」、发出第一条消息、切走都算看过)。
 *  第一次遇到一个 Agent 只记下时刻、什么都不显示 —— 否则升级后第一眼就是「进化记录更新 47 处」。 */
export function SessionOpening({ slug }: { slug: string }) {
  const { t } = useI18n()
  const name = useApp((s) => s.agentDefs.find((a) => a.slug === slug)?.name || slug)
  const [sum, setSum] = useState<{ remembered: number; evolved: number } | null>(null)
  const shown = useRef(false)
  useEffect(() => {
    setSum(null); shown.current = false
    if (!slug) return
    const since = readSeen()[slug]
    if (typeof since !== 'number') { markSeen(slug); return }
    let alive = true
    const engine = homeTarget()
    // 两份都读到才算数:只读到一半就显示,「看过」会把另一半没读到的那些一起划过去
    void Promise.all([getAgentMemorySnapshot(engine, slug), getAgentHarness(engine, slug)]).then(([memory, harness]) => {
      const next = openingSummary(since, memory.entries || [], harness.journal || [])
      if (alive && next.remembered + next.evolved > 0) setSum(next)
    }, () => { /* 读不到(云端 / 老引擎 / 断线):不显示,也不动「上次看到哪」 */ })
    return () => { alive = false; if (shown.current) markSeen(slug) }
  }, [slug])
  // 这一行真的上了屏才算「看过」(数据到了、还没来得及画就被卸掉的不算)
  useLayoutEffect(() => { if (sum) shown.current = true }, [sum])
  if (!sum) return null
  const parts = [sum.remembered ? t('selfUpdate.remembered', { n: sum.remembered }) : '', sum.evolved ? t('selfUpdate.evolved', { n: sum.evolved }) : ''].filter(Boolean).join(' · ')
  const view = (): void => { markSeen(slug); shown.current = false; setSum(null); showDetails({ kind: 'agent', slug, evolution: Date.now() }) }
  return <div className="self-opening" data-self-opening={slug}>
    <div className="self-opening-inner">
      <Sprout size={15} className="self-receipt-ic" />
      <span className="self-opening-text">{t('selfOpening.line', { name, parts })}</span>
      <button type="button" className="self-act" onClick={view}>{t('selfOpening.view')}</button>
    </div>
  </div>
}
