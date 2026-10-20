/**
 * Muse 私聊里它自己开口的那几样(2026-10-18,方案 docs/ToBeImproved/Muse私聊与收件箱分工方案_2026-10-17,用户选 B):
 *  - 消息头上一行「主动发来 · 时间」(引擎 chat_messages.origin = proactive*,只有引擎写得出这一列,模型冒充不了);
 *  - 它提的待办(proactive:todo)按收件箱那张 Muse 待办卡画:主按钮「交给 Muse 执行」,按 id 现读真状态;
 *  - 它后台排队的审批(proactive:approval):流里只留一行 —— 待批时指向输入框上方的托盘,批完是回执「你在 10:38 批准了 · …」;
 *    托盘(MuseApprovalTray)列出 Muse 所有待批,卡片复用收件箱的 ApprovalCard(按 id 读 pending_approvals、直接调引擎裁决)。
 */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { BellDot, ChevronDown, CircleCheck, CircleX, ShieldQuestion } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useAttention } from '../../stores/attentionStore'
import { getMuseApproval, listMuseApprovals } from '../../services/backendService'
import { homeTarget } from '../../services/engine/targets'
import { formatMessageTime } from '../../format/time'
import type { PendingApprovalInfo, UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { ApprovalCard } from '../inbox/InboxBody'
import { TaskCards, useMuseTodoStatus, type TaskLanding } from './TaskCards'
import type { TaskCard } from './suggest'

registerMessages({
  'museDm.from': { zh: '主动发来 · {time}', en: 'Reached out · {time}' },
  'museDm.apvPending': { zh: '等你批准 · 在输入框上方', en: 'Waiting for your approval · above the input box' },
  'museDm.apvExecuting': { zh: '已批准，执行中…', en: 'Approved, running…' },
  'museDm.apvApproved': { zh: '你在 {time} 批准了', en: 'You approved at {time}' },
  'museDm.apvApprovedBy': { zh: '{time} 已批准', en: 'Approved at {time}' },
  'museDm.apvRejected': { zh: '你在 {time} 拒绝了', en: 'You rejected at {time}' },
  'museDm.apvWithdrawn': { zh: '{time} 已撤回', en: 'Withdrawn at {time}' },
  'museDm.apvFailed': { zh: '你在 {time} 批准了，但执行失败', en: 'You approved at {time}, but it failed' },
  'museDm.tray': { zh: 'Muse 等你批准 · {n}', en: 'Muse is waiting for your approval · {n}' },
})

/** 托盘里批完 → 流里那几行按 id 重读(同一会话的两处视图不共享组件状态)。 */
const useDecided = create<{ n: number; bump: () => void }>((set) => ({ n: 0, bump: () => set((s) => ({ n: s.n + 1 })) }))

/** SQLite 的 CURRENT_TIMESTAMP 是不带时区的 UTC(`2026-10-18 02:38:00`),直接 new Date 会按本地时间读、差出时区;PG 回的是带时区的 ISO。 */
const dbTime = (v: string): number => Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(' ', 'T')}Z` : v)

export const isProactive = (m: Pick<UiMessage, 'origin'>): boolean => !!m.origin?.startsWith('proactive')

export function ProactiveMark({ at }: { at: number }) {
  const { t, locale } = useI18n()
  return (
    <div className="t2-dm-from" data-proactive="">
      <BellDot size={12} aria-hidden="true" />
      <span>{t('museDm.from', { time: formatMessageTime(at, { locale }) })}</span>
    </div>
  )
}

/** 私聊里 Muse 提的待办:与收件箱同一份状态读取与落点(todo 头只在 origin=proactive:todo 时生效,见 EditorialMessage)。 */
export function MuseTodoCards({ tasks, ownerId, sessionId, createdAt, onTask }: {
  tasks: TaskCard[]; ownerId: string; sessionId?: string; createdAt?: number
  onTask?: (card: TaskCard, landing: TaskLanding) => boolean | void | { childId: string } | Promise<boolean | void | { childId: string }>
}) {
  const todo = useMuseTodoStatus(ownerId, tasks)
  return (
    <TaskCards
      tasks={tasks} ownerId={ownerId} sessionId={sessionId} createdAt={createdAt}
      todoStatus={todo.status} onTodoRetry={todo.retry}
      onTask={async (card, landing) => {
        const r = await onTask?.(card, landing)
        if (card.todo) todo.retry() // 以引擎真状态为准
        return r
      }}
    />
  )
}

/** 流里那一行:待批 → 指路托盘;批完 → 回执。找不到这条(老数据 / 读失败)就不画。 */
export function MuseApprovalLine({ id }: { id: string }) {
  const { t, locale } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const decided = useDecided((s) => s.n)
  const [row, setRow] = useState<PendingApprovalInfo | null>(null)
  useEffect(() => {
    let alive = true
    getMuseApproval(homeTarget(), id).then((r) => { if (alive) setRow(r ?? null) }, () => { if (alive) setRow(null) })
    return () => { alive = false }
  }, [cfg, id, decided])
  // 执行中:3s 重读到终态
  useEffect(() => {
    if (row?.status !== 'executing') return
    const h = setTimeout(() => useDecided.getState().bump(), 3000)
    return () => clearTimeout(h)
  }, [row])
  if (!row) return null
  const time = row.decided_at ? formatMessageTime(dbTime(row.decided_at), { locale }) : ''
  if (row.status === 'pending') {
    return <div className="t2-dim t2-apv-pointer" data-muse-approval="pending"><ShieldQuestion size={12} />{t('museDm.apvPending')}</div>
  }
  if (row.status === 'executing') {
    return <div className="t2-dim t2-dm-receipt" data-muse-approval="executing"><CircleCheck size={12} />{t('museDm.apvExecuting')}</div>
  }
  const ok = row.status === 'approved'
  const key = row.status === 'rejected'
    ? (row.decided_by === 'system' ? 'museDm.apvWithdrawn' : 'museDm.apvRejected')
    : row.status === 'failed' ? 'museDm.apvFailed'
    : row.decided_by === 'user' ? 'museDm.apvApproved' : 'museDm.apvApprovedBy'
  const result = ok && row.result ? row.result.split('\n')[0].slice(0, 120) : ''
  return (
    <div className={`t2-dim t2-dm-receipt${ok ? ' ok' : ''}`} data-muse-approval={row.status}>
      {ok ? <CircleCheck size={12} /> : <CircleX size={12} />}
      <span>{t(key, { time })}{result ? ` · ${result}` : ''}</span>
    </div>
  )
}

/** 输入框上方的托盘:Muse 后台所有待批(不止这条私聊里看得到的那几条)。最早那张展开,其余一行一条,点哪行展开哪行。 */
export function MuseApprovalTray() {
  const { t } = useI18n()
  const cfg = useApp((s) => s.cfg)
  const decided = useDecided((s) => s.n)
  // attention 轮询(20s)报 Muse 私聊在等你 → 托盘跟着重拉;批完的那一下由 bump 触发
  const waitSig = useAttention((s) => Object.values(s.dm).filter((d) => d.awaiting).length)
  const [items, setItems] = useState<PendingApprovalInfo[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => {
    let alive = true
    listMuseApprovals(homeTarget(), 'pending')
      .then((list) => { if (alive) setItems(list.filter((a) => a.agent_slug === 'muse').sort((a, b) => a.created_at.localeCompare(b.created_at))) })
      .catch(() => {})
    return () => { alive = false }
  }, [cfg, decided, waitSig])
  const cur = items.find((a) => a.id === openId) ?? items[0]
  if (!cur) return null
  const settled = (): void => {
    useDecided.getState().bump()
    void useAttention.getState().refresh('home')
  }
  return (
    <div className="t2c-apv" role="region" aria-label={t('approval.tray.label')} data-approval-tray={items.length} data-muse-tray="">
      <button type="button" className="t2c-apv-head" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>
        <ShieldQuestion size={13} className="t2c-apv-ic" />
        <span className="t2c-apv-title">{t('museDm.tray', { n: items.length })}</span>
        <ChevronDown size={13} className={`t2c-apv-chev${collapsed ? ' is-collapsed' : ''}`} />
      </button>
      {!collapsed && items.length > 1 && (
        <div className="t2c-apv-rest">
          {items.filter((a) => a !== cur).map((a) => (
            <button type="button" key={a.id} className="t2c-apv-row" title={a.preview} onClick={() => setOpenId(a.id)}>
              <span className="t2c-apv-row-name">{a.tool}</span>
              <span className="t2c-apv-row-preview">{a.preview}</span>
            </button>
          ))}
        </div>
      )}
      {!collapsed && (
        <div className="t2c-apv-body">
          <ApprovalCard key={cur.id} id={cur.id} onSettled={settled} />
        </div>
      )}
    </div>
  )
}
