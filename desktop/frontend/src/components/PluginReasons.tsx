/**
 * 卸载 / 停用插件时可选的「为什么」(遥测 v3 契约 §19 plugin_lifecycle.reason:unused | broken | slow | mistake,都可跳过)。
 *  - 卸载:确认框里一行理由药丸(单选,再点一下取消),随「卸载」那一下报;
 *  - 停用:开关从开拨到关时不马上关,开关下面浮出理由行(宿主版 ReasonPrompt):选一个 / 「直接停用」才关,取消 / Esc / 点别处 = 不关。
 * 只在用户手拨时问;熔断自动停用、别的窗口同步过来的停用不问、不带理由。理由只进匿名计数,不附原文(没有「附上原文」那个勾)。
 * 没有遥测通道(网页 / 手机、没装载 Extend 的桌面)就不问:问了答案也没处去,开关照旧一拨就关、确认框里不画理由。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { followAnchor } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import { LIFECYCLE_REASONS, type LifecycleReason } from '../../../shared/telemetryKeys'
import { ReasonPrompt } from './FeedbackReasons'
import { SettingsSwitch } from './SettingsPrimitives'
import { sendTelemetry, telemetryOn } from '../telemetrySend'
import { telemetryPluginRef } from '../telemetryPluginId'
import './feedbackReasons.css'

registerMessages({
  'pluginReason.uninstallQuestion': { zh: '为什么卸载？（可不选）', en: 'Why uninstall? (optional)' },
  'pluginReason.disableQuestion': { zh: '为什么停用？', en: 'Why turn it off?' },
  'pluginReason.unused': { zh: '用不上', en: 'Don’t need it' },
  'pluginReason.broken': { zh: '有问题', en: 'Something’s broken' },
  'pluginReason.slow': { zh: '太慢', en: 'Too slow' },
  'pluginReason.mistake': { zh: '装错了', en: 'Installed by mistake' },
  'pluginReason.disableSkip': { zh: '直接停用', en: 'Just turn off' },
})

export type { LifecycleReason }
const options = (t: (k: string) => string) => LIFECYCLE_REASONS.map((id) => ({ id, label: t(`pluginReason.${id}`) }))

/** 卸载确认框里的理由药丸:单选、可不选。 */
export function UninstallReasonChips({ value, onChange }: { value: LifecycleReason | null; onChange: (r: LifecycleReason | null) => void }) {
  const { t } = useI18n()
  if (!telemetryOn()) return null
  return (
    <div className="fr-prompt fr-pick" role="group" aria-label={t('pluginReason.uninstallQuestion')} data-uninstall-reasons>
      <span className="fr-q">{t('pluginReason.uninstallQuestion')}</span>
      <div className="fr-chips">
        {options(t).map((r) => (
          <button key={r.id} type="button" aria-pressed={value === r.id} data-reason={r.id} onClick={() => onChange(value === r.id ? null : r.id)}>{r.label}</button>
        ))}
      </div>
    </div>
  )
}

/**
 * 停用开关的理由门:`ask(onDecide)` 在开关下面浮出理由行;onDecide(reason | null) 只在用户选了理由或点「直接停用」时调,
 * 取消就什么都不做(开关保持开着)。anchorRef 指开关外面那层(定位用)。
 */
export function useDisableReason(anchorRef: RefObject<HTMLElement | null>): { ask: (onDecide: (reason: LifecycleReason | null) => void) => void; node: ReactNode } {
  const [pending, setPending] = useState<((reason: LifecycleReason | null) => void) | null>(null)
  const node = pending && anchorRef.current
    ? <DisableReasonPop anchor={anchorRef.current} onPick={(r) => { const go = pending; setPending(null); go(r) }} onCancel={() => setPending(null)} />
    : null
  return { ask: (fn) => setPending(() => fn), node }
}

function DisableReasonPop({ anchor, onPick, onCancel }: { anchor: HTMLElement; onPick: (r: LifecycleReason | null) => void; onCancel: () => void }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  // 落位交给 followAnchor(缩放、下面放不下翻到上面、窗口变化 / 滚动都跟着开关走),右缘对齐开关
  useLayoutEffect(() => (ref.current ? followAnchor(ref.current, anchor, { alignEnd: true, gap: 6 }) : undefined), [anchor])
  useEffect(() => {
    const away = (e: PointerEvent): void => { if (!(e.target instanceof Node && (ref.current?.contains(e.target) || anchor.contains(e.target)))) onCancel() }
    const gone = (): void => onCancel()
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('blur', gone)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('blur', gone)
    }
  }, [anchor, onCancel])
  return createPortal(
    <div ref={ref} className="fr-pop" data-disable-reasons>
      <ReasonPrompt question={t('pluginReason.disableQuestion')} reasons={options(t)} skipLabel={t('pluginReason.disableSkip')} shareable={false}
        onPick={(r) => onPick(r)} onCancel={onCancel} />
    </div>,
    document.body,
  )
}

/**
 * 带停用理由的开关:从开拨到关先问理由(可跳过),选完才调 onChange(false, reason);拨开照旧直接 onChange(true)。
 * 其余属性原样给 SettingsSwitch(data-* 钩子等)。
 */
export function ReasonSwitch({ checked, onChange, label, disabled, ...rest }: {
  checked: boolean
  onChange: (on: boolean, reason?: LifecycleReason) => void
  label: string
  disabled?: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'onClick' | 'role' | 'type'>) {
  const anchor = useRef<HTMLSpanElement>(null)
  const gate = useDisableReason(anchor)
  return (
    <span ref={anchor} style={{ display: 'inline-flex' }}>
      <SettingsSwitch {...rest} checked={checked} disabled={disabled} label={label}
        onChange={(on) => { if (on) onChange(true); else if (!telemetryOn()) onChange(false); else gate.ask((r) => onChange(false, r ?? undefined)) }} />
      {gate.node}
    </span>
  )
}

/** 引擎插件开关拨成功之后的 plugin_lifecycle(v3 补上的漏报)。官方签名包 / 引擎内置的算内置,其余 local。 */
export function reportEnginePluginToggle(p: { id: string; source?: string; official?: boolean }, on: boolean, reason?: LifecycleReason): void {
  sendTelemetry('plugin_lifecycle', {
    ...telemetryPluginRef({ id: p.id, builtin: p.source === 'builtin' || p.official === true }, 'plugin'),
    action: on ? 'enable' : 'disable',
    ...(!on && reason ? { reason } : {}),
  })
}
