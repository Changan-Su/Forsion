/**
 * 输入框上方的托盘:等你拍板的东西都攒在这里(借 Claude Code / Codex),不再插在聊天流里打断阅读 ——
 * 权限审批、Agent 的提问(ask_user)、计划审阅的拍板区(计划正文仍在流里的计划卡上)。
 * 状态不搬家 —— 它们仍挂在各自的消息上(持久化回放 / 兑现 / turn_boundary 的 keep 都钉在那),
 * 托盘只是「本会话所有 pending」的另一个视图:选中的一项(缺省最早那项)展开,其余缩成一行,点哪行展开哪行。
 * 10-23 起(方案「待确认卡片」B)它是一叠卡:聊天里跟在最新内容后面(画布模式 / 预览仍在输入框上方),只露最上面一张,
 * 后面几张露出卡沿;头行写「还有 审批 1 · 提问 1」,‹ › 换卡。任务卡(```forsion-task)作为第四类垫在最后。
 * 交互卡片(要你点 / 答的)一律进这里,内容卡片(Intelligent UI、白板、清单、插件结果卡)留在产出它的那条消息上;
 * Muse 私聊里它后台排队的审批与它提的待办也在这里(10-23)。
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ArrowDown, ChevronDown, ChevronLeft, ChevronRight, ShieldQuestion } from 'lucide-react'
import type { TodoItem } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { ApprovalCard } from '../../components/ApprovalCard'
import { InquiryCard, PlanDecision } from '../../components/InquiryCard'
import { registerMessages, useI18n } from '../../i18n'
import type { TrayItem } from './approvalQueue'
import type { PendingCreation, PendingHuman, PendingTask } from './pendingTasks'
import { HumanUpdateCard } from '../../components/HumanUpdateCard'
import { CreationCardView } from './CreationCards'
import { useApp } from '../../stores/appStore'
import { TaskCards } from './TaskCards'
import type { MessageHandlers } from './EditorialMessage'
import { ApprovalCard as MuseApprovalCard } from '../inbox/InboxBody'
import { MuseTodoCards, museApprovalSettled, type MuseApprovalItem } from './MuseDm'
import '../../tangu/messages'
import { useEnterMotion } from '../../components/AnimatedUI'

registerMessages({
  'approval.tray.title': { zh: '等你批准 · {n}', en: 'Waiting for your approval · {n}' },
  'approval.tray.titleAny': { zh: '等你处理 · {n}', en: 'Waiting for you · {n}' },
  'approval.tray.label': { zh: '等你处理的事项', en: 'Items waiting for you' },
  'approval.tray.more': { zh: '还有 {list}', en: 'Also {list}' },
  'approval.tray.kApproval': { zh: '审批 {n}', en: 'approvals: {n}' },
  'approval.tray.kInquiry': { zh: '提问 {n}', en: 'questions: {n}' },
  'approval.tray.kPlan': { zh: '计划 {n}', en: 'plans: {n}' },
  'approval.tray.kTask': { zh: '任务卡 {n}', en: 'task cards: {n}' },
  'approval.tray.kHuman': { zh: '协作请求 {n}', en: 'requests: {n}' },
  'approval.tray.kCreation': { zh: '作品卡 {n}', en: 'creation cards: {n}' },
  'approval.tray.prev': { zh: '上一件', en: 'Previous' },
  'approval.tray.next': { zh: '下一件', en: 'Next' },
  'approval.pill': { zh: '{n} 件等你', en: '{n} waiting for you' },
})

/** 卡片堆里的一项:挡着 agent 的(审批 / 提问 / 计划,Muse 的后台审批)在前;不挡的(任务卡、协作请求、作品卡)垫底。 */
export type DeckItem = TrayItem | MuseApprovalItem | PendingTask | PendingHuman | PendingCreation

/** 头行计数:Muse 的后台审批算审批。 */
const countKind = (i: DeckItem): 'approval' | 'inquiry' | 'plan' | 'task' | 'human' | 'creation' => (i.kind === 'muse-approval' ? 'approval' : i.kind)
/** 挡着 agent(或 Muse)往下走的:来了就顶到最上面、收着时展开一次。 */
const blocks = (i: DeckItem): boolean => i.kind !== 'task' && i.kind !== 'human' && i.kind !== 'creation'

const ARM_MS = 350

const sentBySession = new Map<string, Set<string>>()
function sentLocks(sessionId?: string): Set<string> {
  const k = sessionId ?? ''
  let hit = sentBySession.get(k)
  if (!hit) { hit = new Set(); sentBySession.set(k, hit) }
  return hit
}

type Sent = void | boolean | Promise<boolean | void>

export function ApprovalTray({ items, onDecide, onAnswer, onTask, sessionId }: {
  items: DeckItem[]
  /** P1-K6:托盘所属会话(审批卡按会话所在的目标判远端只读,INTEGRATION R-31)。 */
  sessionId?: string
  /** 返回 false = 没送达,托盘解锁这一项让用户重试。 */
  onDecide: (messageId: string, approvalId: string, action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, any>) => Sent
  /** 询问 / 计划的回答;返回 false = 没送达。 */
  onAnswer: (messageId: string, inquiryId: string, answer: string) => Sent
  /** 任务卡的落点(同流里任务卡的 onTask)。 */
  onTask?: MessageHandlers['onTask']
}) {
  const { t } = useI18n()
  const [openId, setOpenId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  // 任务卡不挡 agent:停在任务卡上时来了审批 / 提问 / 计划(排在前面),换到它(任务卡里没有会丢的草稿)
  const picked = items.find((i) => i.id === openId)
  const cfg = useApp((st) => st.cfg)
  const cur = (picked && !(!blocks(picked) && blocks(items[0])) ? picked : undefined) ?? items[0]
  const curId = cur?.id
  // 钉住展开项:缺省那项一显示就钉住 —— 之后插到它前面的新条目(并行团队里排在前面的成员晚来的审批 / 提问)
  // 只垫到后面,不把正在看的这项顶掉(草稿会丢,冷却过后还会点到顶上来的那张)。它离开列表才回落到最早那项。
  useEffect(() => { if (curId && curId !== openId) setOpenId(curId) }, [curId, openId])
  // 换卡冷却:批完一项,下一项原地顶上来 —— 连点两下不能把没看过的下一项也批了 / 答了。
  // 展开项一换(含新出现),按钮先不接收点击,ARM_MS 后才生效。
  // 收着时来了新的审批 / 提问 / 计划:展开一次(来了任务卡不展开)
  const blocking = items.filter(blocks).map((i) => i.id).join(' ')
  const seenBlocking = useRef(new Set<string>())
  useEffect(() => {
    const ids = blocking ? blocking.split(' ') : []
    if (ids.some((id) => !seenBlocking.current.has(id))) setCollapsed(false)
    seenBlocking.current = new Set(ids)
  }, [blocking])
  const [armedId, setArmedId] = useState<string | undefined>(undefined)
  useEffect(() => {
    const timer = setTimeout(() => setArmedId(curId), ARM_MS)
    return () => clearTimeout(timer)
  }, [curId])
  // 已送出、还等回执的项:锁在托盘层(卡片切走再切回、收起再展开都不丢),同一项绝不送第二次 ——
  // 第二次必然 410,从前还会把已送达的回答改判成「已过期」。没送达(返回 false / 抛错)才解锁重试。
  // 锁按会话放在模块里:画布模式切换会把托盘在流尾与输入框上方之间挪(= 重挂),组件里的 ref 会跟着丢(Codex 10-23)
  const sent = sentLocks(sessionId)
  const [, rerender] = useState(0)
  const [motion, touch] = useEnterMotion() // 托盘一出现时整张一起进;之后展开、翻页、答完换上来的那张,卡体单独淡入上来
  // 答完的那张离开、下一张顶上来也算刚发生。layout effect:下一张第一帧就带着入场;别在 submit 里给 ——
  // 那时正在答的那张还在(同一个 key),补上属性会当场重放它的入场(10-25 评审)。
  const prevCur = useRef(curId)
  useLayoutEffect(() => {
    if (prevCur.current && curId && prevCur.current !== curId && !items.some((i) => i.id === prevCur.current)) touch()
    prevCur.current = curId
  }, [curId])
  // 兑现离开托盘的不再占着。放在提交后的 effect 里,不在 render 里改 ref:并发渲染可能丢弃一次 render,
  // 那次若先把锁删了,屏幕上仍在的旧项就又能送一次(Codex 09-27 第三轮)。
  useEffect(() => {
    for (const id of sent) if (!items.some((i) => i.id === id)) sent.delete(id)
  }, [items])
  const submit = (id: string, send: () => Sent): void => {
    // 冷却期内一律不送:CSS 的 pointer-events 只挡鼠标,这里连键盘(回车提交)一起挡,也让冷却可测
    if (armedId !== id || sent.has(id)) return
    sent.add(id)
    rerender((n) => n + 1)
    const unlock = (): void => { sent.delete(id); rerender((n) => n + 1) }
    void Promise.resolve().then(send).then((ok) => { if (ok === false) unlock() }, unlock)
  }
  if (!cur) return null
  const busy = sent.has(cur.id)
  const title = items.every((i) => countKind(i) === 'approval') ? 'approval.tray.title' : 'approval.tray.titleAny'
  const idx = items.indexOf(cur)
  const go = (d: number): void => { touch(); setOpenId(items[(idx + d + items.length) % items.length].id) }
  const rest = items.filter((i) => i !== cur)
  const more = (['approval', 'inquiry', 'plan', 'task', 'human', 'creation'] as const)
    .map((k) => [k, rest.filter((i) => countKind(i) === k).length] as const)
    .filter(([, n]) => n)
    .map(([k, n]) => t(`approval.tray.k${k[0].toUpperCase()}${k.slice(1)}`, { n }))
    .join(' · ')
  return (
    <div className="t2c-apv" role="region" aria-label={t('approval.tray.label')} data-approval-tray={items.length} data-tray-msgs={items.map((i) => i.messageId).join(' ')} data-peek={Math.min(rest.length, 2) || undefined}>
      <div className="t2c-apv-top">
        <button type="button" className="t2c-apv-head" aria-expanded={!collapsed} onClick={() => { touch(); setCollapsed((c) => !c) }}>
          <ShieldQuestion size={13} className="t2c-apv-ic" />
          <span className="t2c-apv-title">{t(title, { n: items.length })}</span>
          {more && <span className="t2c-apv-more">{t('approval.tray.more', { list: more })}</span>}
          <ChevronDown size={13} className={`t2c-apv-chev${collapsed ? ' is-collapsed' : ''}`} />
        </button>
        {!collapsed && items.length > 1 && <>
          <span className="t2c-apv-n">{idx + 1} / {items.length}</span>
          <button type="button" className="t2c-apv-nav" data-dir="prev" title={t('approval.tray.prev')} aria-label={t('approval.tray.prev')} onClick={() => go(-1)}><ChevronLeft size={14} /></button>
          <button type="button" className="t2c-apv-nav" data-dir="next" title={t('approval.tray.next')} aria-label={t('approval.tray.next')} onClick={() => go(1)}><ChevronRight size={14} /></button>
        </>}
      </div>
      {!collapsed && (
        <div
          key={cur.id}
          data-motion={motion}
          className={`t2c-apv-body${armedId === curId ? '' : ' is-arming'}${busy ? ' is-sent' : ''}`}
          data-tray-kind={cur.kind}
          data-tray-msg={cur.messageId}
        >
          {(cur.kind === 'approval' || cur.kind === 'inquiry' || cur.kind === 'plan') && cur.agentName && <div className="t2c-apv-from">{cur.agentName}</div>}
          {cur.kind === 'human' ? (
            // 「知道了」/ 撤销之后它离开卡片堆,流里那行收成「已知道 / 已撤销」
            <HumanUpdateCard key={cur.id} changes={cur.changes} cfg={cfg} sessionId={sessionId || ''} agentName={cur.agentName} inDeck />
          ) : cur.kind === 'creation' ? (
            <div className="t2-tasks"><CreationCardView key={cur.id} card={cur.card} sessionId={sessionId} /></div>
          ) : cur.kind === 'task' ? (
            // 落点与锁都在 TaskCards 里(按会话 + 内容记处理过没);处理完它离开卡片堆,写卡那条回答下面留一行结局。
            // Muse 提的待办按引擎里的真状态给按钮(MuseTodoCards,同流里与收件箱)
            cur.card.todo
              ? <MuseTodoCards key={cur.id} tasks={[cur.card]} ownerId={cur.messageId} sessionId={sessionId} createdAt={cur.createdAt} onTask={onTask} />
              : <TaskCards key={cur.id} tasks={[cur.card]} ownerId={cur.messageId} sessionId={sessionId} createdAt={cur.createdAt} onTask={onTask} />
          ) : cur.kind === 'muse-approval' ? (
            // 按 id 读 pending_approvals、直接调引擎裁决(收件箱那张);批完重拉,它离开卡片堆
            <MuseApprovalCard key={cur.id} id={cur.info.id} onSettled={museApprovalSettled} />
          ) : cur.kind === 'approval' ? (
            <ApprovalCard key={cur.id} req={cur.req} sessionId={sessionId} onDecide={(action, args) => submit(cur.id, () => onDecide(cur.messageId, cur.id, action, args))} />
          ) : cur.kind === 'plan' ? (
            <PlanDecision key={cur.id} plan={cur.plan} req={cur.req} busy={busy} onAnswer={(a) => submit(cur.id, () => onAnswer(cur.messageId, cur.id, a))} />
          ) : (
            <InquiryCard key={cur.id} req={cur.req} onAnswer={(a) => submit(cur.id, () => onAnswer(cur.messageId, cur.id, a))} />
          )}
        </div>
      )}
    </div>
  )
}

/** 卡片堆滚出视野时(往上翻历史)输入框上方一枚药丸:「↓ N 件等你 · 任务清单 x/y」,点了回到对话末尾。
 *  卡片堆跟着内容走,新来一张不把人拽下去(在底部时照旧吸底),所以要这枚药丸告诉你底下有事。
 *  自己盯卡片堆进没进视口(IntersectionObserver),不让整个 ChatView 跟着滚动重渲。 */
export function DeckPill({ rootRef, count, todos, onClick }: { rootRef: RefObject<HTMLElement | null>; count: number; todos?: TodoItem[]; onClick: () => void }) {
  const { t } = useI18n()
  const [away, setAway] = useState(false)
  useEffect(() => {
    const root = rootRef.current
    const deck = root?.querySelector('[data-pending-deck] .t2c-apv')
    if (!root || !deck) return
    // 流的底下那一截压在悬浮的输入区后面:看得见的范围扣掉它
    const cover = parseFloat(getComputedStyle(root).getPropertyValue('--t2-composer-h')) || 96
    const io = new IntersectionObserver(([e]) => setAway(!e.isIntersecting), { root, rootMargin: `0px 0px -${Math.round(cover)}px 0px` })
    io.observe(deck)
    return () => io.disconnect()
  }, [rootRef, count])
  if (!away) return null
  const done = todos?.filter((x) => x.status === 'completed').length ?? 0
  return (
    <div className="t2-deckpill-row">
      <button type="button" className="t2-deckpill" data-deck-pill={count} onClick={onClick}>
        <ArrowDown size={13} />
        <span>{t('approval.pill', { n: count })}</span>
        {!!todos?.length && <><span className="t2-deckpill-sep">·</span><span>{t('inquiry.todoList')} {done}/{todos.length}</span></>}
      </button>
    </div>
  )
}
