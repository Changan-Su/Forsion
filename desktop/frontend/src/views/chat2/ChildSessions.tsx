/**
 * 对话里的子会话(方案「子会话与任务卡」2026-10-17,第一轮 B):
 *  - ChildSessionsBlock:开出子会话的那条回答下面一块,每个子会话一行(标题 · 状态 · 最后一句),点开走右侧子会话面板,⌘ 开新标签;
 *    在等你的那行给「去回复」「让 Tangu 回答」。数据全从会话列表来(引擎列表接口带 busy / awaiting_user),不另起轮询。
 *  - ChildUpdateLine:引擎落库的 <child_sessions_update> 用户行(子会话结果送回主会话)对人画成一行系统行,不摆成用户气泡。
 *  - ForkBlock(方案「Chat 画布分支」10-18 第二轮「挂点统一」):一条回答下面一块「从这里分出 N」,分支 / 顺便问 / 子会话一行一个
 *    (行就是上面子会话那一行的样子)。点分支 = 主区就地换成那一支(⌘ 开新标签);点顺便问 / 子会话 = 右边那块子会话面板。
 *  - ChildFromLine:子会话顶上「来自 主会话」;分支顶上「从 X 分出」。
 */
import React, { createContext, useContext, useEffect, useState } from 'react'
import { ChevronRight, CornerDownRight, CornerUpLeft, GitBranch, MessageCircleQuestion, MessageSquare, Sparkles } from 'lucide-react'
import type { SessionRecord, ToolEvent } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { useApp } from '../../stores/appStore'
import { useSessionAttention } from '../../stores/attentionStore'
import { useChildChat } from '../../stores/childChatStore'
import { listMessages, type SavedAside } from '../../services/backendService'
import { targetForSession } from '../../services/engine/targets'
import { openSession } from '../../sessionNav'
import { registerMessages, useI18n } from '../../i18n'
import { displaySessionTitle } from '../../sessionTitle'
import { StatusMark } from './AttentionDot'
import { rowStatus, type RowStatus } from './sessionTree'
import { openBtw, useBtw } from './btwStore'

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
  'fork.head': { zh: '从这里分出', en: 'From here' },
  'fork.branch': { zh: '分支', en: 'Branch' },
  'fork.aside': { zh: '顺便问', en: 'Aside' },
  'fork.branchFrom': { zh: '从', en: 'Branched from' },
  'fork.branchFromTail': { zh: '分出 · 分叉之前的对话和它一样', en: '· the conversation up to the fork is the same' },
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

/** 分支那一行:点 = 主区就地换成那一支(⌘ 新标签)。状态照会话列表(在跑 / 等你);平时写「分支」。 */
function BranchRow({ s, status }: { s: SessionRecord; status: RowStatus }) {
  const { t } = useI18n()
  const sub = useLastReply(s.id, status, true)
  const go = (e: React.MouseEvent | React.KeyboardEvent): void => openSession(s.id, e.metaKey || e.ctrlKey ? { newTab: true } : undefined)
  return (
    <div className="t2-child-row" role="button" tabIndex={0} data-branch-session={s.id} data-status={status || 'seen'} onClick={go} onKeyDown={(e) => { if (e.key === 'Enter') go(e) }}>
      <span className="t2-child-lead"><GitBranch size={15} /></span>
      <span className="t2-child-title">{displaySessionTitle(s.title, t)}</span>
      <span className={`t2-child-state${status === 'wait' ? ' wait' : ''}`}>{t(status === 'run' ? 'childs.st.run' : status === 'wait' ? 'childs.st.wait' : 'fork.branch')}<StatusMark status={status} /></span>
      <span className="t2-child-chev"><ChevronRight size={13} /></span>
      {sub && status !== 'run' && <span className="t2-child-sub">{sub}</span>}
    </div>
  )
}

/** 存下来的顺便问那一行:标题 = 第一问,下一行 = 最后一个回答;点了在右边那块面板里重开。 */
function AsideRow({ sessionId, aside }: { sessionId: string; aside: SavedAside }) {
  const { t } = useI18n()
  const first = aside.turns[0]
  const last = aside.turns[aside.turns.length - 1]
  const title = useApp((s) => s.sessions.find((x) => x.id === sessionId)?.title)
  const open = (): void => openBtw({ sessionId, title, asideId: aside.id, messageId: aside.message_id || undefined })
  return (
    <div className="t2-child-row" role="button" tabIndex={0} data-aside={aside.id} data-status="seen" onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open() }}>
      <span className="t2-child-lead"><MessageCircleQuestion size={15} /></span>
      <span className="t2-child-title">{first?.question || t('btw.title')}</span>
      <span className="t2-child-state">{t('fork.aside')}{aside.turns.length > 1 ? ` · ${aside.turns.length}` : ''}</span>
      <span className="t2-child-chev"><ChevronRight size={13} /></span>
      {last?.answer && <span className="t2-child-sub">{plain(last.answer)}</span>}
    </div>
  )
}

const NO_ASIDES: SavedAside[] = []

/** 一条回答下面「从这里分出 N」:分支(fork_message_id = 这条)、挂在这条上的顺便问、这条开出的子会话。都没有就不画。
 *  ponytail: 分支只认来源会话里的这条消息;在分支里看,分叉前那几条是复制出来的新 id,兄弟分支不挂在它们下面(画布那一步按时间对齐)。 */
/** 「从这里分出」画在哪:对话页 = 消息里、分支也列;画布卡 = 分支已经是卡,不列;卡里还要挪到正文外面(长卡的正文会被折起,块不能跟着被裁),
 *  所以 inline:false = 消息里不画,由 ChatCanvas 画在卡底;阅读栏不折,照常画在消息里、只藏分支。 */
/** host:子会话面板挂在哪个会话下(主区正开着的那一支)。画布里共享的祖先卡属于树根,不传就开在树根下、主区看不见 */
export interface ForkScopeValue { inline: boolean; hideBranches: boolean; host?: string }
export const ForkScope = createContext<ForkScopeValue>({ inline: true, hideBranches: false })

export function ForkBlock({ sessionId, messageId, childIds, onSuggest }: { sessionId: string; messageId: string; childIds: string[]; onSuggest?: (text: string) => void }) {
  const { t } = useI18n()
  const { hideBranches, host } = useContext(ForkScope)
  const sessions = useApp((s) => s.sessions)
  const running = useApp((s) => s.runningBySession)
  const unread = useApp((s) => s.unread)
  const attention = useSessionAttention()
  const saved = useBtw((s) => s.saved[sessionId] || NO_ASIDES)
  useEffect(() => { useBtw.getState().loadSaved(sessionId) }, [sessionId])
  const branches = hideBranches ? [] : sessions.filter((x) => x.fork_message_id === messageId).sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
  const asides = saved.filter((a) => a.message_id === messageId)
  const kids = childIds.map((id) => sessions.find((x) => x.id === id)).filter((x): x is SessionRecord => !!x)
  const n = branches.length + asides.length + kids.length
  if (!n) return null
  const stOf = (k: SessionRecord): RowStatus => rowStatus(k, !!attention.get(k.id), !!running[k.id], unread.has(k.id))
  const st = kids.map(stOf)
  const waiting = st.filter((x) => x === 'wait').length
  const allBack = st.every((x) => x !== 'run' && x !== 'wait')
  return (
    <div className="t2-childs" data-forks={n} data-child-sessions={kids.length || undefined}>
      <div className="t2-childs-head">
        <b>{t('fork.head')}</b><span>{n}</span><span className="grow" />
        {kids.length > 0 && <span>{allBack ? t('childs.allBack') : waiting ? t('childs.waitingN', { n: waiting }) : t('childs.pending')}</span>}
      </div>
      {branches.map((b) => <BranchRow key={b.id} s={b} status={stOf(b)} />)}
      {asides.map((a) => <AsideRow key={a.id} sessionId={sessionId} aside={a} />)}
      {kids.map((k, i) => <ChildRow key={k.id} parentId={host ?? sessionId} s={k} status={st[i]} onSuggest={onSuggest} />)}
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
  const fromId = session?.fork_message_id ? (session.fork_session_id || session.parent_session_id) : session?.parent_session_id
  const parent = useApp((s) => (fromId ? s.sessions.find((x) => x.id === fromId) || s.archivedSessions.find((x) => x.id === fromId) : undefined))
  // 分支:从哪一支分出(点了回去);第一条不是简报,是那一支到分叉点为止的对话
  if (parent && session?.fork_message_id) {
    return (
      <div className="t2-sys t2-child-from" data-branch-from={parent.id}>
        <GitBranch size={12} /><span>{t('fork.branchFrom')}</span>
        <a role="button" tabIndex={0} onClick={() => openSession(parent.id)} onKeyDown={(e) => { if (e.key === 'Enter') openSession(parent.id) }}>{displaySessionTitle(parent.title, t)}</a>
        <span>{t('fork.branchFromTail')}</span>
      </div>
    )
  }
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
