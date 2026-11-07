/**
 * 拒绝 / 遗忘时的「为什么」(帮助改进 P3,方案 docs/ToBeImproved/帮助改进拓展方案_2026-11-06 §9 B)。
 *
 * 点了「不感兴趣 / 不用 / 遗忘」不马上生效:动作行原地换成四个理由 +「直接关掉 / 直接遗忘」+「取消」,
 * 点哪个都只发**一次**引擎调用,理由跟着那一次走(引擎按枚举表认,计进本机遥测账本,走匿名改进数据)。
 * 「附上这条原文」是另一条路:勾了,动作成功之后才随账号经反馈通道(window.tangu.submitFeedback)发这一条;
 * 勾选不记住、每条重新问(一条一同意)。宿主没有反馈通道(网页 / 手机)就不画这个勾。
 *
 * 这份给记忆面板(宿主模块)。Muse 卡片在 Tangu 界面包里,用 views/chat2/FeedbackReasons.tsx 那份:Tangu 会热更新到老宿主上,
 * 不能 require 宿主新加的模块(check:tanguboundary)。改交互时两份一起改,data-reason* 钩子保持一致。
 */
import { useEffect, useRef, useState } from 'react'
import { registerMessages, translate, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import './feedbackReasons.css'

registerMessages({
  'reason.memoryQuestion': { zh: '为什么遗忘这条？', en: 'Why forget this?' },
  'reason.memory.wrong': { zh: '记错了', en: 'It’s wrong' },
  'reason.memory.stale': { zh: '过时了', en: 'Out of date' },
  'reason.memory.unwanted': { zh: '不该记', en: 'Shouldn’t be saved' },
  'reason.memory.duplicate': { zh: '重复了', en: 'Duplicate' },
  'reason.memorySkip': { zh: '直接遗忘', en: 'Just forget' },
  'reason.cancel': { zh: '取消', en: 'Cancel' },
  'reason.share': { zh: '附上这条原文，随账号发给 Forsion', en: 'Also send this text to Forsion with my account' },
  'reason.shared': { zh: '原文已发给 Forsion，可在「反馈」里查看', en: 'Sent to Forsion. You can find it in Feedback.' },
  'reason.shareFailed': { zh: '原文没发出去：{e}', en: 'Couldn’t send the text: {e}' },
  'reason.notSignedIn': { zh: '没登录 Forsion 账号', en: 'not signed in to a Forsion account' },
  'reason.ticketMemory': { zh: '记忆反馈', en: 'Memory feedback' },
  'reason.noReason': { zh: '没选原因', en: 'No reason given' },
})

export interface ReasonOption<R extends string> { id: R; label: string }

/** 宿主有没有随账号的反馈通道(桌面有;网页 / 手机没有)。 */
export const canShareOriginal = (): boolean => typeof window !== 'undefined' && !!window.tangu?.submitFeedback

/** 反馈单正文上限(server /api/feedback 收 10000 字)。 */
const TICKET_LIMIT = 10_000

/**
 * 随账号发一条反馈:头一行是哪类反馈 · 选的理由,第二行机器读的标签,空一行之后是原文。
 * 动作已经生效后才调;发不出去只提示,不回滚动作。
 */
export async function sendOriginal(input: { title: string; reasonLabel: string | null; tag: string; body: string }): Promise<boolean> {
  const submit = typeof window !== 'undefined' ? window.tangu?.submitFeedback : undefined
  if (!submit) return false
  const app = useApp.getState()
  const head = `${input.title} · ${input.reasonLabel ?? translate('reason.noReason')}\n[${input.tag}]\n\n`
  const description = (head + input.body.trim()).slice(0, TICKET_LIMIT)
  try {
    const r = await submit({ description })
    if (r.ok) { app.toast(translate('reason.shared')); return true }
    app.toast(translate('reason.shareFailed', { e: r.error === 'not-logged-in' ? translate('reason.notSignedIn') : r.error || 'unknown error' }), true)
  } catch (e) {
    app.toast(translate('reason.shareFailed', { e: String((e as Error)?.message || e) }), true)
  }
  return false
}

/**
 * 理由行。onPick(null) = 不说原因直接做;onCancel = 回到原来的按钮。Esc 也是取消。
 * 打开时焦点落在第一个理由上(原来那颗按钮已经不在了,不接住焦点就掉回 body)。
 */
export function ReasonPrompt<R extends string>({ question, reasons, skipLabel, busy, shareable, onPick, onCancel }: {
  question: string
  reasons: ReadonlyArray<ReasonOption<R>>
  skipLabel: string
  busy?: boolean
  /** 画不画「附上这条原文」 */
  shareable: boolean
  onPick: (reason: R | null, share: boolean) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [share, setShare] = useState(false)
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => { first.current?.focus({ preventScroll: true }) }, [])
  return (
    <div className="fr-prompt" role="group" aria-label={question} data-reason-prompt
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onCancel() } }}>
      <span className="fr-q">{question}</span>
      <div className="fr-chips">
        {reasons.map((r, i) => (
          <button key={r.id} ref={i === 0 ? first : undefined} type="button" disabled={busy} data-reason={r.id} onClick={() => onPick(r.id, share)}>{r.label}</button>
        ))}
        <button type="button" className="fr-plain" disabled={busy} data-reason="none" onClick={() => onPick(null, share)}>{skipLabel}</button>
        <button type="button" className="fr-plain" disabled={busy} data-reason-cancel onClick={onCancel}>{t('reason.cancel')}</button>
      </div>
      {shareable && (
        <label className="fr-share">
          <input type="checkbox" checked={share} disabled={busy} data-reason-share onChange={(e) => setShare(e.target.checked)} />
          <span>{t('reason.share')}</span>
        </label>
      )}
    </div>
  )
}
