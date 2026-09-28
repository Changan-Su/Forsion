/**
 * 焦点目标的连接态提示(P1-K6 S2 §3.8「连接态文案」):手机把整端切到「我的电脑」后,那台电脑离线 / 引擎没起 /
 * 拒了凭据 / 调用方身份取不到 / 拒绝远程会话 / 限流 / 被移除时,在输入框顶上说清楚是哪一种、会不会自己恢复。
 *
 * 视觉语汇完全派生额度提示条(.t2-quota-advisory,Chatbox 向上延伸的一段):同一只 Chatbox 的材质与外轮廓,状态色只落在
 * 14px 图标上。两条同时存在时只放这一条(fallback = 额度提示):连不上那台电脑时额度无关紧要,而两段负外边距叠放会错位。
 * 焦点在本端 → 原样渲染 fallback,零改变。
 */
import type { ReactNode } from 'react'
import { CircleOff, KeyRound, Loader2, PowerOff, RotateCcw, ShieldAlert, Timer, WifiOff } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { focusTarget, useEngineFocus } from '../services/engine/targets'
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

/** 可恢复的态给「重试」(立即探一次);终局态(设备被移除 / 身份 / 拒绝)重试也没用,不给。 */
const RETRYABLE = new Set<string>(['offline', 'engine-unavailable', 'rate-limited', 'failed'])

/** 焦点在「我的电脑」且还没连上时,输入框的禁用占位换成「等待那台连上」(缺省那句「先在设置里连接后端」
 *  说的是本端的外部连接,放在这里是误导)。焦点在本端 / 已连上 → undefined(调用方用它自己的占位)。 */
export function useTargetComposerPlaceholder(): string | undefined {
  const { t } = useI18n()
  const unit = useEngineFocus((s) => s.ref.kind === 'unit')
  const name = useEngineFocus((s) => s.name)
  const connState = useApp((s) => s.connState)
  if (!unit || connState === 'ok') return undefined
  return t('engine.target.composerWaiting', { name: name || t('engine.target.defaultName') })
}

export function TargetHealthNotice({ fallback }: { fallback?: ReactNode }) {
  const { t } = useI18n()
  const focus = useEngineFocus((s) => s.ref)
  const name = useEngineFocus((s) => s.name)
  const key = focus.kind === 'unit' ? (`unit:${focus.unitId}` as const) : null
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
    text = remoteRefusalMessage(code) || t(MESSAGE_KEYS[health.state]!, { name: label })
  } else if (connState === 'idle') {
    state = 'connecting'
    text = t('engine.target.connecting', { name: label })
  } else if (connState === 'err') {
    state = 'failed'
    text = connMessage || t('engine.target.offline', { name: label })
  }
  if (!state) return <>{fallback}</>

  const Icon = ICONS[state] ?? WifiOff
  const retry = (): void => {
    void probeTarget(focusTarget()).then((h) => {
      const app = useApp.getState()
      if (h.state === 'ready' && app.connState !== 'ok') void app.connect(app.cfg)
    }).catch(() => {})
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
