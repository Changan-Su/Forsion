/**
 * 连接态提示(P1-K6 S2 §3.8「连接态文案」):手机上对话所在的那台电脑离线 / 引擎没起 / 拒了凭据 / 调用方身份取不到 /
 * 拒绝远程会话 / 限流 / 被移除时,在输入框顶上说清楚是哪一种、会不会自己恢复。
 * S4 起对着的是**这个输入框的会话所在的那台**(有会话 = 它的绑定;空白新对话 = 焦点,新会话建在那)—— 焦点换走了,
 * 留在另一台上的会话照样提示它自己那台的状态。
 *
 * 视觉语汇完全派生额度提示条(.t2-quota-advisory,Chatbox 向上延伸的一段):同一只 Chatbox 的材质与外轮廓,状态色只落在
 * 14px 图标上。两条同时存在时只放这一条(fallback = 额度提示):连不上那台电脑时额度无关紧要,而两段负外边距叠放会错位。
 * 对着本端 → 原样渲染 fallback,零改变。
 */
import type { ReactNode } from 'react'
import { CircleOff, KeyRound, Loader2, PowerOff, RotateCcw, ShieldAlert, Timer, WifiOff } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { composerReady, useApp } from '../stores/appStore'
import { nameOfRef, retryFocusTarget, sameRef, targetForRef, targetKeyOf, useComposerRef, useEngineFocus } from '../services/engine/targets'
import { probeTarget, useTargetHealth, type TargetHealthState } from '../services/engine/health'
import { remoteRefusalMessage } from '../services/localOnly'
import '../services/engine/messages'

registerMessages({
  'engine.target.retry': { zh: '重试', en: 'Retry' },
})

const ICONS: Partial<Record<TargetHealthState | 'connecting' | 'failed', typeof WifiOff>> = {
  offline: WifiOff,
  'engine-unavailable': PowerOff,
  'engine-auth': KeyRound,
  'caller-unavailable': ShieldAlert,
  refused: ShieldAlert,
  'rate-limited': Timer,
  gone: CircleOff,
  connecting: Loader2,
  failed: WifiOff,
}

const MESSAGE_KEYS: Partial<Record<TargetHealthState, string>> = {
  offline: 'engine.target.offline',
  'engine-unavailable': 'engine.target.engineUnavailable',
  'engine-auth': 'engine.target.engineAuth',
  'caller-unavailable': 'engine.target.callerUnavailable',
  refused: 'engine.target.refused',
  'rate-limited': 'engine.target.rateLimited',
  gone: 'engine.target.gone',
}

/** 「重试」= retryFocusTarget(没连上 → 重连;已连上但健康不好 → 探一次)。可恢复态本来就会自己好,按钮只是「现在就试」;
 *  身份取不到(K8 换票抖一下)/ 引擎拒了凭据 / 拒绝**不自动重试**(R-32),按钮是它们唯一的就地出口 —— 原先只能切走再切回
 *  或重载 app。设备被移除才是真没救(connect 见 gone 会自己切回本端),不给。 */
const RETRYABLE = new Set<string>(['offline', 'engine-unavailable', 'rate-limited', 'failed', 'caller-unavailable', 'engine-auth', 'refused'])

/** 输入框能不能发(S4:按这个输入框的会话所在的那台;空白新对话 = 焦点)。连接态 / 健康 / 绑定 / 焦点变了会重渲染。 */
export function useComposerReady(sessionId?: string | null): boolean {
  const ref = useComposerRef(sessionId)
  const connState = useApp((s) => s.connState)
  useTargetHealth((s) => (ref.kind === 'unit' ? s.byKey[targetKeyOf(ref)] : undefined))
  return composerReady({ connState }, sessionId)
}

/** 对着「我的电脑」且还没连上时,输入框的禁用占位换成「等待那台连上」(缺省那句「先在设置里连接后端」
 *  说的是本端的外部连接,放在这里是误导)。对着本端 / 已连上 → undefined(调用方用它自己的占位)。 */
export function useTargetComposerPlaceholder(sessionId?: string | null): string | undefined {
  const { t } = useI18n()
  const ref = useComposerRef(sessionId)
  const ready = useComposerReady(sessionId)
  useEngineFocus((s) => s.name)
  if (ref.kind !== 'unit' || ready) return undefined
  return t('engine.target.composerWaiting', { name: nameOfRef(ref) || t('engine.target.defaultName') })
}

export function TargetHealthNotice({ fallback, sessionId }: { fallback?: ReactNode; sessionId?: string | null }) {
  const { t } = useI18n()
  const ref = useComposerRef(sessionId)
  const focus = useEngineFocus((s) => s.ref)
  useEngineFocus((s) => s.name)
  const onFocus = sameRef(ref, focus) // 焦点那台还有 connect 的连接态(连接中 / 连不上);别的那台只看健康格
  const name = nameOfRef(ref)
  const key = ref.kind === 'unit' ? targetKeyOf(ref) : null
  const health = useTargetHealth((s) => (key ? s.byKey[key] : undefined))
  const connState = useApp((s) => s.connState)
  const connMessage = useApp((s) => s.connMessage)
  if (!key) return <>{fallback}</>

  const label = name || t('engine.target.defaultName')
  let state: TargetHealthState | 'connecting' | 'failed' | null = null
  let text = ''
  if (health && MESSAGE_KEYS[health.state]) {
    state = health.state
    const code = 'code' in health ? health.code : undefined
    // P1-KF:拒绝细节(REMOTE_CALLER_UNCONFIRMED 的 reason / state)一并交给本地化 —— 只凭码会一律说「正在等待确认」
    const refusal = 'refusal' in health ? health.refusal : undefined
    text = remoteRefusalMessage(code, refusal) || t(MESSAGE_KEYS[health.state]!, { name: label })
  } else if (onFocus && connState === 'idle') {
    state = 'connecting'
    text = t('engine.target.connecting', { name: label })
  } else if (onFocus && connState === 'err') {
    state = 'failed'
    text = connMessage || t('engine.target.offline', { name: label })
  }
  if (!state) return <>{fallback}</>

  const Icon = ICONS[state] ?? WifiOff
  // 焦点那台:重连 / 探一次(retryFocusTarget);别的那台(会话留在它上面):探一次,转好了轮询与 SSE 自己续上
  const retry = (): void => {
    if (onFocus) { void retryFocusTarget().catch(() => {}); return }
    const target = targetForRef(ref)
    if (target) void probeTarget(target).catch(() => {})
  }
  return (
    <div className="t2-quota-advisory t2-target-health" data-target-health={state} role="status" aria-live="polite">
      <span className="t2-quota-advisory-copy">
        <Icon size={14} aria-hidden="true" className={state === 'connecting' ? 'spin' : undefined} />
        <span>{text}</span>
      </span>
      {RETRYABLE.has(state) && (
        <span className="t2-quota-advisory-actions">
          <button className="t2-quota-action reset" onClick={retry}>
            <RotateCcw size={12} aria-hidden="true" /> {t('engine.target.retry')}
          </button>
        </span>
      )}
    </div>
  )
}
