import { useEffect, useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { registerMessages, useI18n } from '../../i18n'
import { useApp, type TeamWorkMember } from '../../stores/appStore'
import { useChildChat } from '../../stores/childChatStore'

registerMessages({
  'teamdesk.title': { zh: '团队工作台', en: 'Team Desk' },
  'teamdesk.summary': { zh: '{n} 人 · {k} 工作中', en: '{n} members · {k} working' },
  'teamdesk.status.idle': { zh: '空闲', en: 'Idle' },
  'teamdesk.status.working': { zh: '工作中', en: 'Working' },
  'teamdesk.status.waiting': { zh: '等待审批', en: 'Waiting for approval' },
  'teamdesk.status.done': { zh: '已完成', en: 'Done' },
  'teamdesk.status.failed': { zh: '失败', en: 'Failed' },
  'teamdesk.thinking': { zh: '思考中', en: 'Thinking' },
  'teamdesk.noWork': { zh: '还没有工作记录', en: 'No work yet' },
  'teamdesk.task': { zh: '任务:{task}', en: 'Task: {task}' },
  'teamdesk.live': { zh: '直播中', en: 'Live' },
  'teamdesk.connecting': { zh: '连接中', en: 'Connecting' },
  'teamdesk.expand': { zh: '展开团队工作台', en: 'Expand Team Desk' },
  'teamdesk.collapse': { zh: '收起', en: 'Collapse' },
})

/** 团队会话的成员表:配置里的成员序为准,工作状态从 teamWorkBySession 合并(没起过的成员 = 空闲)。 */
function useTeamMembers(sessionId: string): TeamWorkMember[] {
  const s = useApp(useShallow((st) => ({
    cfg: st.configBySession[sessionId], work: st.teamWorkBySession[sessionId], agentDefs: st.agentDefs, running: st.runningBySession[sessionId], childRuns: st.runningBySession,
  })))
  return useMemo(() => {
    const slugs: string[] = Array.isArray(s.cfg?.groupAgents) ? s.cfg!.groupAgents!.map(String) : []
    return slugs.map((slug) => {
      const w = s.work?.[slug]
      const name = s.agentDefs.find((a) => a.slug === slug)?.name || w?.name || slug
      // A user can continue a member independently after the parent team has finished.
      const childRunning = w?.sessionId && s.childRuns[w.sessionId]
      const status = childRunning ? (w?.status === 'waiting' ? 'waiting' : 'working') : w ? (!s.running && (w.status === 'working' || w.status === 'waiting') ? 'idle' : w.status) : 'idle'
      return { ...(w || { since: 0 }), slug, name, status } as TeamWorkMember
    })
  }, [s.cfg, s.work, s.agentDefs, s.running, s.childRuns])
}

function Avatar({ slug, name, status }: { slug: string; name: string; status: TeamWorkMember['status'] }) {
  const url = useApp((st) => st.agentAvatars[slug])
  const cls = `t2o-bar-avatar${status === 'working' ? ' is-working' : status === 'waiting' ? ' is-waiting' : ''}`
  return url
    ? <img src={url} width={18} height={18} alt="" className={cls} />
    : <span className={`${cls} t2o-bar-avatar-text`}>{[...name][0] || '?'}</span>
}

function activityLine(m: TeamWorkMember, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (m.status === 'working') return m.activity || (m.task ? m.task : t('teamdesk.thinking'))
  if (m.status === 'waiting') return t('teamdesk.status.waiting')
  if (m.status === 'failed') return t('teamdesk.status.failed')
  if (m.status === 'done') return m.task || t('teamdesk.status.done')
  return t('teamdesk.status.idle')
}

/** Team activity belongs to Pin Summary; each member opens its own live work record. */
export function TeamStatus({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const members = useTeamMembers(sessionId)
  const hydrate = useApp((s) => s.hydrateTeamWork)
  const picked = useChildChat((s) => s.selected[sessionId]?.id)
  useEffect(() => { void hydrate(sessionId) }, [sessionId, hydrate])
  return (
    <div className="t2o-team-status" data-team-desk="status">
      {members.map((m) => (
        <div key={m.slug}>
          <button type="button" className="t2o-desk-row" data-slug={m.slug} data-status={m.status}
            aria-pressed={picked === m.slug} onClick={() => useChildChat.getState().open(sessionId, { id: m.slug, title: m.name, slug: m.slug, sessionId: m.sessionId, runId: m.runId, task: m.task })}>
            <Avatar slug={m.slug} name={m.name} status={m.status} />
            <span className="t2o-desk-name">{m.name}</span>
            <span className="t2o-desk-dot" data-status={m.status} title={t(`teamdesk.status.${m.status}`)} />
            <span className="t2o-desk-activity">{activityLine(m, t)}</span>
            <ChevronRight size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
