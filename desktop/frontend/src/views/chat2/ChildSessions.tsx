/**
 * 对话里的子会话(方案「子会话与任务卡」2026-10-17,第一轮 B):
 *  - ChildSessionsBlock:开出子会话的那条回答下面一块,每个子会话一行(标题 · 状态 · 最后一句),点开走右侧子会话面板,⌘ 开新标签;
 *    在等你的那行给「去回复」「让 Tangu 回答」。数据全从会话列表来(引擎列表接口带 busy / awaiting_user),不另起轮询。
 *  - ChildUpdateLine:引擎落库的 <child_sessions_update> 用户行(子会话结果送回主会话)对人画成一行系统行,不摆成用户气泡。
 */
import React, { useEffect, useState } from 'react'
import { ChevronRight, CornerDownRight, CornerUpLeft, MessageSquare, Sparkles } from 'lucide-react'
import type { SessionRecord, ToolEvent } from '../../types'
import { useApp } from '../../stores/appStore'
import { useSessionAttention } from '../../stores/attentionStore'
import { useChildChat } from '../../stores/childChatStore'
import { listMessages } from '../../services/backendService'
import { targetForSession } from '../../services/engine/targets'
import { openSession } from '../../sessionNav'
import { registerMessages, useI18n } from '../../i18n'
import { displaySessionTitle } from '../../sessionTitle'
import { StatusMark } from './AttentionDot'
import { rowStatus, type RowStatus } from './sessionTree'

registerMessages({
  'childs.head': { zh: '子会话', en: 'Child sessions' },
  'childs.allBack': { zh: '都回来了', en: 'All back' },
  'childs.waitingN': { zh: '{n} 个在等你', en: '{n} waiting for you' },
  'childs.pending': { zh: '都回来后我接着做', en: 'I’ll continue when they’re back' },
  'childs.st.run': { zh: '在跑', en: 'Running' },
  'childs.st.wait': { zh: '等你回复', en: 'Waiting for you' },
  'childs.st.done': { zh: '做完了', en: 'Finished' },
  'childs.reply': { zh: '去回复', en: 'Reply' },
  'childs.letAnswer': { zh: '让 Tangu 回答', en: 'Let Tangu answer' },
  'childs.letAnswerMsg': { zh: '子会话「{title}」在等回答，你替我回答它吧。', en: 'The child session "{title}" is waiting for an answer. Please answer it for me.' },
  'childs.update': { zh: '子会话回来了', en: 'Child sessions are back' },
  'childs.upd.finished': { zh: '{title} 做完了', en: '{title} finished' },
  'childs.upd.waiting_for_user': { zh: '{title} 在等回答', en: '{title} is waiting for an answer' },
  'childs.upd.failed': { zh: '{title} 出错了', en: '{title} failed' },
  'childs.upd.stopped': { zh: '{title} 被停下了', en: '{title} was stopped' },
  'childs.from': { zh: '来自', en: 'From' },
  'childs.fromBrief': { zh: '第一条是它写的简报，做完会把结果送回去', en: 'The first message is its brief; results go back there when done' },
})

export const CHILD_UPDATE_OPEN = '<child_sessions_update>'
const ID_RE = /\(id ([0-9a-f-]{36})\)/i

/** 这条回答里 start_session 成功开出的子会话 id(工具结果里的 `(id …)`)。 */
export function childIdsOf(events: ToolEvent[] | undefined): string[] {
  const out: string[] = []
  for (const e of events || []) {
    if (e.name !== 'start_session' || !e.done || e.isError) continue
    const m = ID_RE.exec(e.result || '')
    if (m && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

const unescape = (s: string): string => s.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
/** <child_sessions_update> 里每个 <child id title status>(引擎 services/childSessions.ts 写的)。 */
export function parseChildUpdate(content: string): Array<{ id: string; title: string; status: string }> {
  return [...content.matchAll(/<child id="([^"]*)" title="([^"]*)" status="([a-z_]+)">/g)].map((m) => ({ id: unescape(m[1]), title: unescape(m[2]), status: m[3] }))
}

/** 最后一句话的摘要(去掉 markdown 记号,一行)。 */
function plain(md: string): string {
  return md.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 160)
}

function useLastReply(id: string, status: RowStatus, known: boolean): string {
  const [text, setText] = useState('')
  useEffect(() => {
    if (!known || status === 'run') return
    let off = false
    void listMessages(targetForSession(id), id, 6).then((rows) => {
      const last = [...rows].reverse().find((r: any) => r.role === 'model' && r.content)
      if (!off) setText(last ? plain(String(last.content)) : '')
    }).catch(() => {})
    return () => { off = true }
  }, [id, status, known])
  return text
}

function ChildRow({ parentId, s, status, onSuggest }: { parentId: string; s: SessionRecord; status: RowStatus; onSuggest?: (text: string) => void }) {
  const { t } = useI18n()
  const sub = useLastReply(s.id, status, true)
  const title = displaySessionTitle(s.title, t)
  const open = (e: React.MouseEvent): void => {
    if (e.metaKey || e.ctrlKey) { openSession(s.id, { newTab: true }); return }
    useChildChat.getState().open(parentId, { id: s.id, sessionId: s.id, title })
  }
  const label = status === 'run' ? 'childs.st.run' : status === 'wait' ? 'childs.st.wait' : 'childs.st.done'
  return (
    <div className="t2-child-row" role="button" tabIndex={0} data-child-session={s.id} data-status={status || 'seen'} onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter') useChildChat.getState().open(parentId, { id: s.id, sessionId: s.id, title }) }}>
      <span className="t2-child-lead"><MessageSquare size={15} /></span>
      <span className="t2-child-title">{title}</span>
      <span className={`t2-child-state${status === 'wait' ? ' wait' : ''}`}>{t(label)}<StatusMark status={status} /></span>
      <span className="t2-child-chev"><ChevronRight size={13} /></span>
      {sub && status !== 'run' && <span className="t2-child-sub">{sub}</span>}
      {status === 'wait' && (
        <div className="t2-taskcard-actions t2-child-actions">
          <button type="button" className="primary" onClick={(e) => { e.stopPropagation(); open(e) }}><CornerDownRight size={12} /> {t('childs.reply')}</button>
          {onSuggest && <button type="button" onClick={(e) => { e.stopPropagation(); onSuggest(t('childs.letAnswerMsg', { title })) }}><Sparkles size={12} /> {t('childs.letAnswer')}</button>}
        </div>
      )}
    </div>
  )
}

export function ChildSessionsBlock({ parentId, ids, onSuggest }: { parentId: string; ids: string[]; onSuggest?: (text: string) => void }) {
  const { t } = useI18n()
  const sessions = useApp((s) => s.sessions)
  const running = useApp((s) => s.runningBySession)
  const unread = useApp((s) => s.unread)
  const attention = useSessionAttention()
  const kids = ids.map((id) => sessions.find((x) => x.id === id)).filter((x): x is SessionRecord => !!x)
  if (!kids.length) return null // 子会话都归档 / 删掉了:块也不留
  const st = kids.map((k) => rowStatus(k, !!attention.get(k.id), !!running[k.id], unread.has(k.id)))
  const waiting = st.filter((x) => x === 'wait').length
  const allBack = st.every((x) => x !== 'run' && x !== 'wait')
  return (
    <div className="t2-childs" data-child-sessions={kids.length}>
      <div className="t2-childs-head">
        <b>{t('childs.head')}</b><span>{kids.length}</span><span className="grow" />
        <span>{allBack ? t('childs.allBack') : waiting ? t('childs.waitingN', { n: waiting }) : t('childs.pending')}</span>
      </div>
      {kids.map((k, i) => <ChildRow key={k.id} parentId={parentId} s={k} status={st[i]} onSuggest={onSuggest} />)}
    </div>
  )
}

export function ChildUpdateLine({ content }: { content: string }) {
  const { t } = useI18n()
  const rows = parseChildUpdate(content)
  return (
    <div className="t2-sys t2-child-update" data-child-update={rows.length}>
      <CornerDownRight size={12} />
      <span>{t('childs.update')}</span>
      {rows.map((r) => <span key={r.id} className="t2-child-update-item" data-status={r.status}>{t(`childs.upd.${r.status in UPD ? r.status : 'finished'}`, { title: r.title })}</span>)}
    </div>
  )
}
const UPD = { finished: 1, waiting_for_user: 1, failed: 1, stopped: 1 }

/** 子会话顶上一行:来自哪个主会话(点了回去)。第一条用户消息是主会话写的简报,不是用户本人打的字。 */
export function ChildFromLine({ session }: { session?: SessionRecord | null }) {
  const { t } = useI18n()
  const parent = useApp((s) => (session?.parent_session_id ? s.sessions.find((x) => x.id === session.parent_session_id) : undefined))
  // 私聊 @项目派遣出的会话也指回私聊,但它在别的项目里、也不回报 —— 只认同一个项目里的主会话(start_session 开的)
  if (!parent || !session || (parent.project_path || '') !== (session.project_path || '') || !!parent.projectless !== !!session.projectless) return null
  return (
    <div className="t2-sys t2-child-from">
      <CornerUpLeft size={12} /><span>{t('childs.from')}</span>
      <a role="button" tabIndex={0} onClick={() => openSession(parent.id)} onKeyDown={(e) => { if (e.key === 'Enter') openSession(parent.id) }}>{displaySessionTitle(parent.title, t)}</a>
      <span>· {t('childs.fromBrief')}</span>
    </div>
  )
}
