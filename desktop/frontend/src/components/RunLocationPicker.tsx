/**
 * 新对话的「在哪运行」药丸(P1-K7a;规格 K7 §3.6,缺省 K7 U1 / U2)。
 *
 * 只在手机上出现(runLocationsAvailable:桌面主窗口、网页版、设备页一律不渲染),且名册里至少有一台电脑(哪怕离线 ——
 * 让用户知道为什么选不了)。只挂在空白新对话上:会话一旦建好,位置就定死了(S9)。
 * 药丸显示新会话会建在哪(= K6 焦点)与那台的状态;点开 = 宿主装的选择器(手机 = K8「在哪运行」弹层,含首次确认流程,
 * 生效走 setDraftLocation(loc, {explicit:true}),R-21)。没有选择器的宿主 → 只读。
 * 视觉语汇整段派生项目药丸(.composer-chip.project-pill,同一门「无轮廓中性 pill」)。
 */
import React from 'react'
import { ChevronDown, Cloud, Laptop, Monitor } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { nameOfRef, useEngineFocus } from '../services/engine/targets'
import { formatRunLocation } from '../services/runLocation'
import { useDeviceMarks } from '../services/deviceMarks'
import type { DeviceStatus } from '../services/deviceStatus'
import { runLocationsAvailable } from '../features/runtime'
import { statusOfUnit, unitById, useDeviceSessions } from '../stores/deviceSessionsStore'
import { useRunLocation } from '../stores/runLocationStore'
import { clampText, useDeviceSessionsLive } from '../views/chat2/DeviceSessionSections'
import './runLocationPicker.css'

registerMessages({
  'runloc.label': { zh: '运行位置', en: 'Run on' },
  'runloc.cloud': { zh: '云端', en: 'Cloud' },
  'runloc.thisDevice': { zh: '这台电脑', en: 'This computer' },
  'runloc.pillTitle': { zh: '新会话在哪运行：{where}', en: 'New sessions run on: {where}' },
})

/** 这一端要不要画「在哪运行」:闸开着且名册里有电脑。ChatView 用它决定新对话那一栏要不要出现(Chat 模式没有项目药丸)。 */
export function useRunPickerVisible(): boolean {
  const units = useDeviceSessions((s) => s.units)
  return runLocationsAvailable() && !!units?.length
}

export function RunLocationPicker(): React.ReactElement | null {
  const { t } = useI18n()
  useDeviceSessionsLive()
  const visible = useRunPickerVisible()
  const focus = useEngineFocus((s) => s.ref)
  useEngineFocus((s) => s.name)
  useDeviceSessions((s) => s.units)
  useDeviceMarks((s) => s.probes)
  useDeviceMarks((s) => s.sticky)
  const chooser = useRunLocation((s) => s.chooser)
  if (!visible) return null

  const unit = focus.kind === 'unit' ? unitById(focus.unitId) : null
  const status: DeviceStatus | null = unit ? statusOfUnit(unit).status : null
  const where = focus.kind === 'unit'
    ? clampText(nameOfRef(focus) || unit?.name, 60) || t('engine.target.defaultName')
    : t('runloc.cloud')
  const Icon = focus.kind === 'home' ? Cloud : unit?.platform === 'win32' || unit?.platform === 'linux' ? Monitor : Laptop
  return (
    <div className="project-selector runloc" data-run-location-picker data-run-location={formatRunLocation(focus) || 'home'} data-device-status={status ?? undefined}>
      <button
        type="button"
        className="composer-chip project-pill runloc-pill"
        title={t('runloc.pillTitle', { where })}
        aria-label={t('runloc.pillTitle', { where })}
        aria-haspopup="dialog"
        disabled={!chooser}
        onClick={() => chooser?.()}
      >
        <Icon size={13} />
        <span className="project-pill-name">{where}</span>
        {status && status !== 'ready' && <span className="runloc-status" data-tone={status === 'checking' ? 'wait' : 'warn'}>{t(`devstatus.${status}`)}</span>}
        {chooser && <ChevronDown size={12} />}
      </button>
    </div>
  )
}
