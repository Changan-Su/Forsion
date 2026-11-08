/**
 * Muse 卡片「不需要」时的理由行(帮助改进 P3,方案 docs/ToBeImproved/帮助改进拓展方案_2026-11-06 §9 B)。
 *
 * 为什么是 Tangu 这边单独一份(宿主 components/FeedbackReasons.tsx 给记忆面板用):Tangu 界面会热更新到老宿主上,
 * 向宿主要的模块只许减(check:tanguboundary / build-tangu-ui 的共享表)。宿主那份是新模块,老宿主没有,Tangu 不能 require 它;
 * 记忆面板是宿主模块,又只能引宿主的。所以两边各一份,键名(museReason.* / reason.*)和类名(t2-reason-* / fr-*)各管各的。
 * 改交互时两份一起改,data-reason* 钩子(台架靠它)保持一致。
 *
 * 点了理由才发**一次**引擎调用,理由跟着那一次走;「附上这条原文」勾了,动作成功之后才随账号经反馈通道发这一条,
 * 勾选不记住、每条重新问。宿主没有反馈通道(网页 / 手机 / 老宿主)就不画这个勾。
 */
import { useEffect, useRef, useState } from 'react'
import { registerMessages, translate, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'

registerMessages({
  'museReason.question': { zh: '为什么不需要？', en: 'Why not?' },
  'museReason.irrelevant': { zh: '不相关', en: 'Not relevant' },
  'museReason.timing': { zh: '时机不对', en: 'Bad timing' },
  'museReason.frequent': { zh: '太频繁', en: 'Too often' },
  'museReason.known': { zh: '我早知道了', en: 'Already knew' },
  'museReason.skip': { zh: '直接关掉', en: 'Just dismiss' },
  'museReason.cancel': { zh: '取消', en: 'Cancel' },
  'museReason.share': { zh: '附上这条原文，随账号发给 Forsion', en: 'Also send this text to Forsion with my account' },
  'museReason.shared': { zh: '原文已发给 Forsion，可在「反馈」里查看', en: 'Sent to Forsion. You can find it in Feedback.' },
  'museReason.shareFailed': { zh: '原文没发出去：{e}', en: 'Couldn’t send the text: {e}' },
  'museReason.notSignedIn': { zh: '没登录 Forsion 账号', en: 'not signed in to a Forsion account' },
  'museReason.ticket': { zh: 'Muse 卡片反馈', en: 'Muse card feedback' },
  'museReason.noReason': { zh: '没选原因', en: 'No reason given' },
})

export interface ReasonOption<R extends string> { id: R; label: string }

/** 宿主有没有随账号的反馈通道(桌面有;网页 / 手机 / 老宿主没有)。 */
export const canShareOriginal = (): boolean => typeof window !== 'undefined' && !!window.tangu?.submitFeedback

/** 反馈单正文上限(server /api/feedback 收 10000 字)。 */
const TICKET_LIMIT = 10_000

/** 随账号发一条:头一行「类别 · 理由」,第二行机读标签,空一行之后是原文。动作已生效后才调;发不出去只提示,不回滚。 */
export async function sendOriginal(input: { reasonLabel: string | null; tag: string; body: string }): Promise<boolean> {
  const submit = typeof window !== 'undefined' ? window.tangu?.submitFeedback : undefined
  if (!submit) return false
  const app = useApp.getState()
  const head = `${translate('museReason.ticket')} · ${input.reasonLabel ?? translate('museReason.noReason')}\n[${input.tag}]\n\n`
  const description = (head + input.body.trim()).slice(0, TICKET_LIMIT)
  try {
    const r = await submit({ description })
    if (r.ok) { app.toast(translate('museReason.shared')); return true }
    app.toast(translate('museReason.shareFailed', { e: r.error === 'not-logged-in' ? translate('museReason.notSignedIn') : r.error || 'unknown error' }), true)
  } catch (e) {
    app.toast(translate('museReason.shareFailed', { e: String((e as Error)?.message || e) }), true)
  }
  return false
}

/** 理由行。onPick(null) = 不说原因直接关;onCancel = 回到原来的按钮。Esc 也是取消。打开时焦点落在第一个理由上。 */
export function ReasonPrompt<R extends string>({ reasons, busy, shareable, onPick, onCancel }: {
  reasons: ReadonlyArray<ReasonOption<R>>
  busy?: boolean
  shareable: boolean
  onPick: (reason: R | null, share: boolean) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [share, setShare] = useState(false)
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => { first.current?.focus({ preventScroll: true }) }, [])
  const question = t('museReason.question')
  return (
    <div className="t2-reason" role="group" aria-label={question} data-reason-prompt
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onCancel() } }}>
      <span className="t2-reason-q">{question}</span>
      <div className="t2-reason-chips">
        {reasons.map((r, i) => (
          <button key={r.id} ref={i === 0 ? first : undefined} type="button" disabled={busy} data-reason={r.id} onClick={() => onPick(r.id, share)}>{r.label}</button>
        ))}
        <button type="button" className="t2-reason-plain" disabled={busy} data-reason="none" onClick={() => onPick(null, share)}>{t('museReason.skip')}</button>
        <button type="button" className="t2-reason-plain" disabled={busy} data-reason-cancel onClick={onCancel}>{t('museReason.cancel')}</button>
      </div>
      {shareable && (
        <label className="t2-reason-share">
          <input type="checkbox" checked={share} disabled={busy} data-reason-share onChange={(e) => setShare(e.target.checked)} />
          <span>{t('museReason.share')}</span>
        </label>
      )}
    </div>
  )
}
