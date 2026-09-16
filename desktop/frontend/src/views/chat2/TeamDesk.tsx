/**
 * Team Desk(方案 §6.4 B;09-16 第四轮拍板 ⑲ 恒开、⑳ 只看最近一次激活):团队会话里替换 Agent Desk 的成员工作台。
 *   卡片态(车道下半,壳复用 .agent-desk-card):每成员一行 = 头像 + 名字 + 状态点 + 一行动态;标题「Team Desk · n 人 · k 工作中」。
 *   展开态(侧板,壳复用 .agent-desk 与 deskBySession 的 mode / fraction):成员条 + 选中成员的工作转录 —— 订阅它子 run 的事件流
 *   (运行中直播;已结束从 seq 0 回放),与右栏子聊天面板的 DiscussionView 同一机制。
 *   审批 / 询问不在这里:成员子 run 的审批已转发到主聊天的占位气泡上(用户拍板:不用点开也能传递),这里只看过程。
 *   数据:teamWorkBySession(team_member / team_activity 事件)+ 挂载时 hydrateTeamWork(/background?kind=teamwork 复原)。
 * 仅桌面(与 Agent Desk 同边界);移动端只有状态条上的头像高亮。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Users, Maximize2, Minimize2, Loader2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { registerMessages, useI18n } from '../../i18n'
import { useApp, type TeamWorkMember } from '../../stores/appStore'
import { subscribeRunEvents } from '../../services/agentRunService'
import { SegList } from '../../components/SubChatsTab'
import { useDeskGrip } from './AgentDesk'
import type { AgentRunEvent, SubChatSeg, TanguDesktopConfig } from '../../types'

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

/** 发言人徽章配色:与 appStore.groupColor 同算法(前端派生,稳定色相)。 */
function colorOf(slug: string): string {
  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 62% 45%)`
}

/** 团队会话的成员表:配置里的成员序为准,工作状态从 teamWorkBySession 合并(没起过的成员 = 空闲)。 */
function useTeamMembers(sessionId: string): TeamWorkMember[] {
  const s = useApp(useShallow((st) => ({
    cfg: st.configBySession[sessionId], work: st.teamWorkBySession[sessionId], agentDefs: st.agentDefs, running: st.runningBySession[sessionId],
  })))
  return useMemo(() => {
    const slugs: string[] = Array.isArray(s.cfg?.groupAgents) ? s.cfg!.groupAgents!.map(String) : []
    return slugs.map((slug) => {
      const w = s.work?.[slug]
      const name = s.agentDefs.find((a) => a.slug === slug)?.name || w?.name || slug
      // 团队 run 没在跑 → 谁都不可能「工作中 / 等审批」(迟到的事件流或复原的旧状态别把人钉在忙碌态)
      const status = w ? (!s.running && (w.status === 'working' || w.status === 'waiting') ? 'idle' : w.status) : 'idle'
      return { ...(w || { since: 0 }), slug, name, status } as TeamWorkMember
    })
  }, [s.cfg, s.work, s.agentDefs, s.running])
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

/** 卡片态:车道下半的常驻预览;点整卡 / 放大钮 → 展开侧板。空会话不占位(与 Agent Desk 卡同规则,免与 Agent 选择器争位)。 */
export function TeamDeskCard({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const members = useTeamMembers(sessionId)
  const mode = useApp((s) => s.deskBySession[sessionId]?.mode)
  const hasMessages = useApp((s) => !!s.messagesBySession[sessionId]?.length)
  const hydrate = useApp((s) => s.hydrateTeamWork)
  useEffect(() => { void hydrate(sessionId) }, [sessionId, hydrate])
  const gone = mode === 'open' || !hasMessages
  const working = members.filter((m) => m.status === 'working' || m.status === 'waiting').length
  const expand = gone ? undefined : () => useApp.getState().patchDesk(sessionId, { mode: 'open' })
  return (
    <div data-desk-session={sessionId} data-team-desk="card" className={`agent-desk-card${expand ? ' act' : ''}${gone ? ' gone' : ''}`} onClick={expand} title={expand ? t('teamdesk.expand') : undefined}>
      <div className="agent-desk-card-head">
        <Users size={12} className="agent-desk-spark" />
        <span className="agent-desk-card-title">{t('teamdesk.title')} · {t('teamdesk.summary', { n: members.length, k: working })}</span>
        {expand && (
          <button className="icon-btn" title={t('teamdesk.expand')} onClick={(e) => { e.stopPropagation(); expand() }}>
            <Maximize2 size={13} />
          </button>
        )}
      </div>
      <div className="agent-desk-card-body">
        <div className="t2o-desk-rows">
          {members.map((m) => (
            <div className="t2o-desk-row" key={m.slug} data-slug={m.slug} data-status={m.status}>
              <Avatar slug={m.slug} name={m.name} status={m.status} />
              <span className="t2o-desk-name">{m.name}</span>
              <span className="t2o-desk-dot" data-status={m.status} title={t(`teamdesk.status.${m.status}`)} />
              <span className="t2o-desk-activity">{activityLine(m, t)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 选中成员的工作转录:订阅它当前 / 最近一次子 run 的事件流(token → 文本;tool_call → 工具行;done / error 收尾)。 */
function MemberWork({ cfg, member }: { cfg: TanguDesktopConfig; member: TeamWorkMember }) {
  const { t } = useI18n()
  const [segs, setSegs] = useState<SubChatSeg[]>([])
  const [streaming, setStreaming] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const runId = member.runId
  useEffect(() => {
    if (!runId) { setSegs([]); setStreaming(false); return }
    const ac = new AbortController()
    setSegs([]); setStreaming(true)
    const col = colorOf(member.slug)
    const append = (delta: string) => setSegs((s) => {
      const last = s[s.length - 1]
      if (last && last.t === 'text') return [...s.slice(0, -1), { ...last, text: last.text + delta }]
      return [...s, { t: 'text', speaker: member.name, color: col, text: delta }]
    })
    void subscribeRunEvents(cfg, runId, (ev: AgentRunEvent) => {
      const p = ev.payload || {}
      switch (ev.type) {
        case 'token': if (p.delta) append(String(p.delta)); break
        case 'tool_call': setSegs((s) => [...s, { t: 'tool', name: String(p.name || ''), preview: typeof p.arguments === 'string' ? p.arguments.slice(0, 200) : '' }]); break
        case 'tool_result': if (p.isError) setSegs((s) => [...s, { t: 'tool', name: String(p.name || ''), preview: String(p.result || '').slice(0, 200), error: true }]); break
        case 'done': case 'error': setStreaming(false); break
      }
    }, ac.signal).catch(() => setStreaming(false))
    return () => ac.abort()
  }, [cfg, runId, member.slug, member.name])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [segs])
  if (!runId) return <div className="t2o-desk-empty">{t('teamdesk.noWork')}</div>
  return (
    <div className="t2o-desk-work" data-team-desk="work">
      {member.task && <div className="t2o-desk-task">{t('teamdesk.task', { task: member.task })}</div>}
      {segs.length === 0 && streaming && <div className="panel-note" style={{ fontSize: 11.5 }}><Loader2 size={12} className="spin" /> {t('teamdesk.connecting')}</div>}
      <SegList segs={segs} />
      {streaming && segs.length > 0 && <div className="panel-note" style={{ fontSize: 11.5, marginTop: 6 }}><Loader2 size={12} className="spin" /> {t('teamdesk.live')}</div>}
      <div ref={endRef} />
    </div>
  )
}

/** 展开态:侧板(与 AgentDesk 同壳:flex-basis 过渡、拖宽、data-desk-session 认领)。 */
export function TeamDesk({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const members = useTeamMembers(sessionId)
  const desk = useApp((s) => s.deskBySession[sessionId])
  const cfg = useApp((s) => s.cfg)
  const rootRef = useRef<HTMLDivElement>(null)
  const onGrip = useDeskGrip(sessionId, rootRef)
  const [picked, setPicked] = useState<string | null>(null)
  // 缺省看正在忙的第一位;都闲着看第一位
  const selected = members.find((m) => m.slug === picked) || members.find((m) => m.status === 'working' || m.status === 'waiting') || members[0]
  const open = desk?.mode === 'open'
  const frac = desk?.fraction ?? 0.46
  const working = members.filter((m) => m.status === 'working' || m.status === 'waiting').length
  return (
    <div ref={rootRef} data-desk-session={sessionId} data-team-desk="panel" className={`agent-desk${open ? ' open' : ''}`} style={{ '--desk-w': `${(frac * 100).toFixed(2)}%` } as React.CSSProperties}>
      {open && (
        <>
          <div className="agent-desk-grip" onPointerDown={onGrip} />
          <div className="agent-desk-inner">
            <div className="agent-desk-head">
              <Users size={13} className="agent-desk-spark" />
              <span className="agent-desk-title">{t('teamdesk.title')}</span>
              <span className="agent-desk-note">{t('teamdesk.summary', { n: members.length, k: working })}</span>
              <button className="icon-btn" title={t('teamdesk.collapse')} onClick={() => useApp.getState().patchDesk(sessionId, { mode: undefined })}>
                <Minimize2 size={14} />
              </button>
            </div>
            <div className="agent-desk-body">
              <div className="t2o-desk-strip" role="tablist">
                {members.map((m) => (
                  <button key={m.slug} type="button" role="tab" className="t2o-desk-tab" aria-selected={selected?.slug === m.slug} data-slug={m.slug} data-status={m.status} onClick={() => setPicked(m.slug)}>
                    <Avatar slug={m.slug} name={m.name} status={m.status} />
                    <span>{m.name}</span>
                    <span className="t2o-desk-dot" data-status={m.status} />
                  </button>
                ))}
              </div>
              {selected ? <MemberWork cfg={cfg} member={selected} /> : <div className="t2o-desk-empty">{t('teamdesk.noWork')}</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
