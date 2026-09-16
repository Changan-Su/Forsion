/**
 * 右栏「子聊天」区:显示当前会话里 agent 起的 discussion / subagent 的实时聊天内容,可切换。
 * - subagent:内容随主 run 流累积(App 已归约进 SubChat.segs),直接渲染。
 * - discussion:独立 run,选中时二开 SSE(subscribeRunEvents)归约该讨论 run 的群聊事件 → 多发言人转录。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Users, Bot, Loader2 } from 'lucide-react'
import type { AgentRunEvent, SubChat, SubChatSeg, TanguDesktopConfig } from '../types'
import { subscribeRunEvents } from '../services/agentRunService'
import { Markdown } from './Markdown'
import { useI18n } from '../i18n'

/** 发言人徽章配色:与 App.groupColor 同算法(前端派生,稳定色相;主持人金色)。 */
function color(slug: string): string {
  if (slug === '__host__') return '#b8860b'
  let h = 0
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 62% 45%)`
}

/** 渲染一串子聊天段(发言文本 / 工具 / 投票)。 */
export const SegList: React.FC<{ segs: SubChatSeg[] }> = ({ segs }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    {segs.map((seg, i) => {
      if (seg.t === 'tool') return (
        <div key={i} className="panel-note" style={{ fontSize: 11.5, opacity: seg.error ? 0.95 : 0.7 }}>
          🔧 <b>{seg.name}</b>{seg.preview ? ` — ${seg.preview.slice(0, 200)}` : ''}
        </div>
      )
      if (seg.t === 'vote') return <div key={i} className="panel-note" style={{ fontSize: 11.5 }}>🗳 {seg.text}</div>
      return (
        <div key={i}>
          {seg.speaker && (
            <div className="msg-role-with-avatar" style={{ color: seg.color, fontSize: 12, fontWeight: 600, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className="msg-avatar fallback" style={{ background: seg.color, width: 16, height: 16, fontSize: 10 }}>{seg.speaker.slice(0, 1)}</span>
              <span>{seg.speaker}</span>
            </div>
          )}
          <div className="msg-content" style={{ fontSize: 12.5 }}><Markdown content={seg.text || ''} /></div>
        </div>
      )
    })}
  </div>
)

/** discussion:订阅独立 run 的事件流,归约成多发言人转录(选中时实时;已结束则 SSE 重放全程)。 */
const DiscussionView: React.FC<{ cfg: TanguDesktopConfig; runId: string }> = ({ cfg, runId }) => {
  const { t } = useI18n()
  const [segs, setSegs] = useState<SubChatSeg[]>([])
  const [streaming, setStreaming] = useState(true)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const ac = new AbortController()
    setSegs([]); setStreaming(true)
    let speaker = ''; let col = ''
    const append = (delta: string) => setSegs((s) => {
      const last = s[s.length - 1]
      if (last && last.t === 'text') return [...s.slice(0, -1), { ...last, text: last.text + delta }]
      return [...s, { t: 'text', speaker, color: col, text: delta }]
    })
    void subscribeRunEvents(cfg, runId, (ev: AgentRunEvent) => {
      const p = ev.payload || {}
      switch (ev.type) {
        case 'group_speaker':
          if (p.phase === 'start') { speaker = p.name || p.slug || ''; col = color(String(p.slug || '')); setSegs((s) => [...s, { t: 'text', speaker, color: col, text: '' }]) }
          break
        case 'token': if (p.delta) append(String(p.delta)); break
        case 'tool_call': setSegs((s) => [...s, { t: 'tool', name: String(p.name || '') }]); break
        case 'group_vote': setSegs((s) => [...s, { t: 'vote', text: `${p.endCount}/${p.total} ${t('panel.subchats.voteEnd')}` }]); break
        case 'group_ended': case 'done': case 'error': setStreaming(false); break
      }
    }, ac.signal).catch(() => setStreaming(false))
    return () => ac.abort()
  }, [cfg, runId, t])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [segs])
  return (
    <div>
      {segs.length === 0 && streaming && <div className="panel-note" style={{ fontSize: 11.5 }}><Loader2 size={12} className="spin" /> {t('panel.subchats.connecting')}</div>}
      <SegList segs={segs} />
      {streaming && segs.length > 0 && <div className="panel-note" style={{ fontSize: 11.5, marginTop: 6 }}><Loader2 size={12} className="spin" /> {t('panel.subchats.live')}</div>}
      <div ref={endRef} />
    </div>
  )
}

export const SubChatsTab: React.FC<{ cfg: TanguDesktopConfig; subChats?: SubChat[] }> = ({ cfg, subChats }) => {
  const { t } = useI18n()
  const list = subChats || []
  const [selId, setSelId] = useState<string | null>(null)
  const sel = list.find((s) => s.id === selId) || list[list.length - 1] || null // 默认选最新
  if (!list.length) return <div className="panel-note">{t('panel.subchats.empty')}</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 140, overflowY: 'auto' }}>
        {list.map((s) => (
          <div key={s.id} role="button" tabIndex={0}
            className={`file-row${sel?.id === s.id ? ' selected' : ''}`}
            onClick={() => setSelId(s.id)}>
            {s.kind === 'discussion' ? <Users size={13} /> : <Bot size={13} />}
            <span className="file-name" title={s.title}>{s.title || s.id.slice(0, 8)}</span>
            {s.streaming && <Loader2 size={12} className="spin" style={{ opacity: 0.6 }} />}
          </div>
        ))}
      </div>
      <div style={{ height: 1, background: 'var(--border)' }} />
      {sel && (
        <div style={{ padding: '0 4px' }}>
          {sel.kind === 'discussion' && sel.runId
            ? <DiscussionView cfg={cfg} runId={sel.runId} />
            : (
              <>
                <SegList segs={sel.segs} />
                {sel.segs.length === 0 && <div className="panel-note" style={{ fontSize: 11.5 }}>{t('panel.subchats.starting')}</div>}
                {sel.streaming && sel.segs.length > 0 && <div className="panel-note" style={{ fontSize: 11.5, marginTop: 6 }}><Loader2 size={12} className="spin" /> {t('panel.subchats.live')}</div>}
              </>
            )}
        </div>
      )}
    </div>
  )
}
