import { useEffect, useRef, useState } from 'react'
import { ChevronRight, History } from 'lucide-react'
import { useApp } from '../../stores/appStore'
import { notifyApp } from '../../stores/notificationStore'
import { takeFreshNominations } from '../../stores/notificationWiring'
import { getSessionHistorian, type SessionHistorianStatus } from '../../services/backendService'
import { registerMessages, useI18n } from '../../i18n'
import { Markdown } from '../../components/Markdown'
import { openAgentProfile } from '../agentProfileNav'

registerMessages({
  'historian.status.ready': { zh: '待命', en: 'Ready' },
  'historian.status.working': { zh: '整理会话中', en: 'Reviewing conversation' },
  'historian.status.empty': { zh: '本会话还没有 Historian 工作记录', en: 'No Historian activity in this conversation yet' },
  'historian.status.unavailable': { zh: '状态暂不可用', en: 'Status unavailable' },
})

/** Only model output and completed actions are shown; maintenance prompts stay in the background. */
function readableRecord(content: string): string {
  try {
    const data = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    return [data.summary, data.title, data.log, ...(Array.isArray(data.memory_candidates) ? data.memory_candidates.map((x: any) => typeof x === 'string' ? x : x.text || x.content || '') : [])]
      .filter((x) => typeof x === 'string' && x.trim()).join('\n\n')
  } catch { return content }
}

/** 自进化自动档提名了工作笔记候选 → 右上角提醒,点「复盘」就地发 /refine。
 *  /refine 只在 run 开头被引擎识别,运行中发会变成 steer 而不生效(Composer2 同判);此时改为打开详情「进化」标签让人看候选。
 *  非 host 会话(云端 / sandbox)没有 manage_harness、plan 模式没有写工具(引擎不注入指令),同样只开详情。 */
function nudgeRefine(sessionId: string, activityId: string): void {
  const st = useApp.getState()
  const slug = st.configBySession[sessionId]?.agentSlug || st.defaultAgentSlug
  const name = st.sessions.find((x) => x.id === sessionId)?.title || slug
  notifyApp({
    event: 'harness.candidates', level: 'info', sticky: true, dedupeKey: `harness.candidates:${activityId}`,
    text: st.tr('ntf.harnessCandidates', { name }),
    action: {
      label: st.tr('ntf.actionRefine'),
      run: () => {
        const now = useApp.getState()
        const c = now.configBySession[sessionId]
        const refinable = c?.execMode === 'host' && !c?.planMode
        if (!refinable || now.runningBySession[sessionId]) openAgentProfile(slug, 'evolution')
        else void now.send('/refine', [], undefined, undefined, undefined, sessionId)
      },
    },
  })
}

export function HistorianStatus({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const connected = useApp((s) => s.connState === 'ok')
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<SessionHistorianStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const seen = useRef<Set<string> | null>(null) // 本会话已见过的活动 id;null = 还没成功轮询过(首轮不提醒)
  useEffect(() => { setOpen(false); setData(null); setFailed(false); seen.current = null }, [sessionId])
  useEffect(() => {
    if (!connected) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const load = async (): Promise<void> => {
      try {
        const result = await getSessionHistorian(cfg, sessionId, open)
        if (!disposed) {
          setData(result); setFailed(false)
          const { fresh, seen: next } = takeFreshNominations(result.activity || [], seen.current)
          seen.current = next
          for (const item of fresh) nudgeRefine(sessionId, item.id)
        }
      } catch { if (!disposed) setFailed(true) }
      if (!disposed) timer = setTimeout(load, 2500)
    }
    void load()
    return () => { disposed = true; clearTimeout(timer) }
  }, [cfg, sessionId, open, connected])
  const status = data?.running ? 'working' : 'idle'
  const records = (data?.records || []).map((r) => ({ ...r, content: readableRecord(r.content) })).filter((r) => r.content)
  return <div className="t2o-team-status" data-historian-status={failed ? 'unavailable' : status}>
    <button type="button" className="t2o-desk-row" aria-expanded={open} onClick={() => setOpen(!open)}>
      <History size={18} className={data?.running ? 'historian-working' : undefined} />
      <span className="t2o-desk-name">Historian</span>
      <span className="t2o-desk-dot" data-status={status} />
      <span className="t2o-desk-activity">{t(failed ? 'historian.status.unavailable' : data?.running ? 'historian.status.working' : 'historian.status.ready')}</span>
      <ChevronRight size={12} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
    </button>
    {open && <div className="t2o-desk-work" data-historian-work>
      {records.map((r) => <Markdown key={r.id} content={r.content} />)}
      {(data?.activity || []).map((item) => <div className="t2o-historian-event" key={item.id}>{item.detail}</div>)}
      {!records.length && !data?.activity.length && <div className="panel-note">{t('historian.status.empty')}</div>}
    </div>}
  </div>
}
