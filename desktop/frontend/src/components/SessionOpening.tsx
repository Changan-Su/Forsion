import { useEffect, useRef, useState } from 'react'
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

// 「上次看到哪」按 Agent 记在本机(slug → 时刻)。存不下就每次都当第一次:不显示,不报错。
const SEEN_KEY = 'forsion.selfSeen'
const readSeen = (): Record<string, number> => { try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} } }
const markSeen = (slug: string): void => { try { localStorage.setItem(SEEN_KEY, JSON.stringify({ ...readSeen(), [slug]: Date.now() })) } catch { /* ignore */ } }

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
    void Promise.all([
      getAgentMemorySnapshot(engine, slug).then((m) => m.entries || [], () => []),
      getAgentHarness(engine, slug).then((h) => h.journal || [], () => []),
    ]).then(([entries, journal]) => {
      const next = openingSummary(since, entries, journal)
      if (alive && next.remembered + next.evolved > 0) { shown.current = true; setSum(next) }
    })
    return () => { alive = false; if (shown.current) markSeen(slug) }
  }, [slug])
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
