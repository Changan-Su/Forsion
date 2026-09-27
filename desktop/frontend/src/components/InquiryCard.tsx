/**
 * 询问卡(ask_user / exit_plan_mode):问题 + 选项按钮 + 自由输入;answered/expired 显示灰态。
 * 视觉对齐 ApprovalCard(边框卡片,token CSS)。待答时在输入框上方的托盘里;对话流里只留已答 / 过期的记录。
 */
import React, { useState } from 'react'
import { CircleHelp, Send, CheckSquare, Square, Loader2, Check, Pencil, Undo2, ClipboardList } from 'lucide-react'
import type { InquiryRequest, TodoItem } from '../types'
import { Markdown } from './Markdown'
import { useI18n, registerMessages } from '../i18n'

registerMessages({
  'plan.approveGo': { zh: '批准并开始执行', en: 'Approve & start' },
  'plan.approveEditedGo': { zh: '按我改的批准并执行', en: 'Approve my edits & start' },
  'plan.approveManual': { zh: '批准，手动开始', en: 'Approve, start manually' },
  'plan.edit': { zh: '编辑计划', en: 'Edit plan' },
  'plan.sendBack': { zh: '打回', en: 'Request changes' },
  'plan.reject': { zh: '拒绝', en: 'Reject' },
  'plan.feedbackPlaceholder': { zh: '要改哪里？（反馈会发给 Agent 重做计划）', en: 'What should change? (sent to the agent to revise the plan)' },
  'plan.sendFeedback': { zh: '发送反馈', en: 'Send feedback' },
  'plan.doneApproved': { zh: '已批准', en: 'Approved' },
  'plan.doneRevised': { zh: '已批准（按你修订的版本）', en: 'Approved (your revised version)' },
  'plan.doneRejected': { zh: '已打回：{answer}', en: 'Sent back: {answer}' },
  'plan.pointer': { zh: '等你拍板 · 在输入框上方', en: 'Waiting for your decision · above the input box' },
  'plan.decisionTitle': { zh: '计划等你拍板（正文见对话里的计划卡）', en: 'The plan needs your decision (full text in the plan card above)' },
})

export const InquiryCard: React.FC<{
  req: InquiryRequest
  onAnswer: (answer: string) => void
}> = ({ req, onAnswer }) => {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const pending = req.status === 'pending'

  return (
    <div className={`inquiry-card${pending ? '' : ' resolved'}`}>
      <div className="inquiry-q">
        <CircleHelp size={14} />
        {req.question}
      </div>
      {pending ? (
        <>
          {req.options.length > 0 && (
            <div className="inquiry-opts">
              {req.options.map((opt, i) => (
                <button key={i} className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => onAnswer(opt)}>
                  {i + 1}. {opt}
                </button>
              ))}
            </div>
          )}
          <div className="inquiry-input">
            <input
              type="text"
              className="inline-input"
              value={draft}
              placeholder={req.options.length ? t('inquiry.placeholderOrFree') : t('inquiry.placeholderAnswer')}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && draft.trim() && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  onAnswer(draft.trim())
                }
              }}
            />
            <button className="btn primary sm" disabled={!draft.trim()} onClick={() => draft.trim() && onAnswer(draft.trim())}>
              <Send size={12} /> {t('inquiry.answer')}
            </button>
          </div>
        </>
      ) : (
        <div className="inquiry-resolved">
          {req.status === 'answered' ? t('inquiry.answered', { answer: req.answer ?? '' }) : t('inquiry.expired')}
        </div>
      )}
    </div>
  )
}

/**
 * 计划审阅的回传约定 —— **与引擎 tangu-agent/src/tools/builtin/interaction.ts 逐字一致**。
 * 引擎按这些字面量判批准/自动开始(改字面 = 批准会被当成打回),故 planWire.test.ts 钉住两侧不漂移。
 */
export const PLAN_APPROVE_AUTO = '批准,自动开始执行'
export const PLAN_APPROVE_MANUAL = '批准,退出计划模式(手动开始)'
export const PLAN_REJECT = '拒绝,保持计划模式'
/** 「编辑后批准」:批准选项 + 本标记 + 修订后的计划全文(inquiry 通道只有一个字符串)。 */
export const PLAN_REVISION_MARK = '\n<<<REVISED_PLAN>>>\n'

/**
 * 头部是否算「批准」—— **必须与引擎 parsePlanAnswer 同规则**(逐字命中选项,或单词式自由批准)。
 * 用 startsWith 会把「批准前先补上回滚方案」这类反对意见标成「已批准」,而引擎那边已按打回处理
 * —— 界面说一套引擎做一套,正是 P2 要消灭的那类错位。planWire.test.ts 钉住两侧不漂移。
 */
const FREE_APPROVE_RE = /^(批准|同意|approve|approved|ok|yes|y)[!！。.]?$/i
export function isPlanApproveHead(head: string): boolean {
  const h = head.trim()
  return h === PLAN_APPROVE_AUTO || h === PLAN_APPROVE_MANUAL || FREE_APPROVE_RE.test(h)
}

/** 从已兑现的答案里拆出「头部选项 / 修订全文」,免得把整份计划塞进「你回答了…」那行。 */
function splitPlanAnswer(answer: string): { head: string; revised?: string } {
  const i = answer.indexOf(PLAN_REVISION_MARK)
  if (i < 0) return { head: answer.trim() }
  return { head: answer.slice(0, i).trim(), revised: answer.slice(i + PLAN_REVISION_MARK.length).trim() }
}

/**
 * 计划卡(P2):计划模式下 agent 提交的实施计划(plan 事件)。正文是要读的内容,留在对话流里;
 * 拍板(批准 / 手动开始 / 编辑后批准 / 打回 / 拒绝)在输入框上方的托盘里(PlanDecision)。
 * 待决时卡上只留一行指路;已兑现显示裁决,按修订版执行的就展示那一版。
 */
export const PlanCard: React.FC<{ plan: string; req?: InquiryRequest }> = ({ plan, req }) => {
  const { t } = useI18n()
  const answered = req?.status === 'answered' ? splitPlanAnswer(req.answer || '') : null
  // 已按修订版执行 → 卡里展示的就该是那一版(它才是正在执行的东西)。
  const body = answered?.revised || plan
  return (
    <div className="plan-card">
      <div className="tg-card-title">
        📋 {t('inquiry.planProposal')}
        {answered && (
          <span className="plan-verdict">
            {isPlanApproveHead(answered.head)
              ? answered.revised ? t('plan.doneRevised') : t('plan.doneApproved')
              : t('plan.doneRejected', { answer: answered.head.slice(0, 60) })}
          </span>
        )}
        {req?.status === 'expired' && <span className="plan-verdict">{t('inquiry.expired')}</span>}
      </div>
      {/* anchorPrefix 故意不传:计划标题不该混进这条消息的浮动目录。 */}
      <div className="plan-body"><Markdown content={body} /></div>
      {req?.status === 'pending' && (
        <div className="t2-dim t2-apv-pointer" data-plan-pointer={req.inquiryId}>
          <ClipboardList size={12} /> {t('plan.pointer')}
        </div>
      )}
    </div>
  )
}

/**
 * 计划的拍板区(托盘里,见 views/chat2/ApprovalTray):批准(自动 / 手动开始)、编辑后批准、打回(带反馈)、拒绝。
 * 回传的字面量与引擎 parsePlanAnswer 逐字对齐(见上方常量,planWire.test.ts 钉住)。
 */
export const PlanDecision: React.FC<{
  plan: string
  req: InquiryRequest
  /** 返回 false = 没送达(网络/非 2xx)→ 解锁按钮让用户重试。 */
  onAnswer: (answer: string) => void | Promise<boolean | void>
}> = ({ plan, req, onAnswer }) => {
  const { t } = useI18n()
  const [draft, setDraft] = useState(plan)
  const [editing, setEditing] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [showFeedback, setShowFeedback] = useState(false)
  // 本地已发标记:兑现要等 inquiry_result 事件回来才离开托盘,这中间不锁的话会重复提交(第二次 410)。
  const [sent, setSent] = useState(false)
  const pending = req.status === 'pending' && !sent
  const answer = (a: string): void => {
    setSent(true)
    // 没送达就解锁:否则决策按钮永久置灰,这张卡成死路(状态只在 inquiry_result 回来时才变)。
    void Promise.resolve(onAnswer(a)).then((ok) => { if (ok === false) setSent(false) }, () => setSent(false))
  }
  const approve = (auto: boolean): void => {
    if (!pending) return
    const head = auto ? PLAN_APPROVE_AUTO : PLAN_APPROVE_MANUAL
    const revised = editing && draft.trim() && draft !== plan ? draft.trim() : ''
    answer(revised ? `${head}${PLAN_REVISION_MARK}${revised}` : head)
  }
  return (
    <div className="plan-decision" data-plan-decision={req.inquiryId}>
      <div className="plan-decision-title"><ClipboardList size={15} /> {t('plan.decisionTitle')}</div>
      {editing && (
        <textarea
          className="approval-edit plan-edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          autoFocus
        />
      )}
      <div className="approval-actions">
        <button className="btn primary sm" disabled={!pending} onClick={() => approve(true)}>
          <Check size={13} /> {editing && draft !== plan ? t('plan.approveEditedGo') : t('plan.approveGo')}
        </button>
        <button className="btn ghost sm" disabled={!pending} onClick={() => approve(false)}>{t('plan.approveManual')}</button>
        <button className="btn ghost sm" disabled={!pending} onClick={() => { setEditing((v) => !v); setDraft(plan) }}>
          <Pencil size={13} /> {editing ? t('common.cancel') : t('plan.edit')}
        </button>
        <button className="btn ghost sm" disabled={!pending} onClick={() => setShowFeedback((v) => !v)}>
          <Undo2 size={13} /> {t('plan.sendBack')}
        </button>
        <button className="btn danger sm" disabled={!pending} onClick={() => answer(PLAN_REJECT)}>{t('plan.reject')}</button>
      </div>
      {showFeedback && (
        // 打回必须带反馈:光说「需要修改」模型拿不到可操作信息,下一版大概率照旧。
        <div className="inquiry-input">
          <input
            type="text"
            className="inline-input"
            value={feedback}
            placeholder={t('plan.feedbackPlaceholder')}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && feedback.trim() && pending && !e.nativeEvent.isComposing) {
                e.preventDefault()
                answer(feedback.trim())
              }
            }}
          />
          <button className="btn primary sm" disabled={!feedback.trim() || !pending} onClick={() => feedback.trim() && answer(feedback.trim())}>
            <Send size={12} /> {t('plan.sendFeedback')}
          </button>
        </div>
      )}
    </div>
  )
}

/** 任务清单(todo 事件;对齐 Claude TodoWrite 的实时显示)。 */
export const TodoList: React.FC<{ todos: TodoItem[] }> = ({ todos }) => {
  const { t: tr } = useI18n()
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="todo-card">
      <div className="tg-card-title">
        ✓ {tr('inquiry.todoList')} <span className="tg-count">({done}/{todos.length})</span>
      </div>
      <div className="todo-rows">
        {todos.map((t, i) => (
          <div key={i} className={`todo-row ${t.status}`}>
            <span className={`todo-mark ${t.status}`}>
              {t.status === 'completed' ? (
                <CheckSquare size={14} />
              ) : t.status === 'in_progress' ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Square size={14} />
              )}
            </span>
            <span className="todo-text">{t.content}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
