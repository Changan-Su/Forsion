import { useEffect, useState } from 'react'
import { getSpecialConfig, saveSpecialConfig } from '../services/backendService'
import { homeTarget } from '../services/engine/targets'
import { useI18n } from '../i18n'
import { SettingsRow, SettingsSwitch } from './SettingsPrimitives'

/** 开发者选项里的「Historian 决策闸(测试)」= 本机引擎的 historian.decisionGate。云端 / 远程设备的引擎不走这条,不显示。 */
export function DecisionGateField() {
  const { t } = useI18n()
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    getSpecialConfig(homeTarget())
      .then((r) => { if (alive && !r.remote && !r.cloud) setOn(!!r.config.historian.decisionGate) })
      .catch(() => { /* 读不到 = 不显示 */ })
    return () => { alive = false }
  }, [])
  if (on === null) return null
  return (
    <div className="field">
      <SettingsRow fit="inline" label={t('settings.developer.decisionGate')} description={t('settings.developer.decisionGateHint')} control={<SettingsSwitch checked={on} label={t('settings.developer.decisionGate')} data-setting="decision-gate" onChange={(next) => {
        setOn(next)
        saveSpecialConfig(homeTarget(), { historian: { decisionGate: next } }).catch(() => setOn(!next))
      }} />} />
    </div>
  )
}

/** 关开发者模式时一并关:开关藏起来以后,还开着的闸就是用户看不见的「原话发云端」。只动本机引擎、只在开着时写。 */
// ponytail: 引擎这会儿读不到就不写(读失败 ≠ 关着);下次进开发者选项还能看见、手动关。
export function disableDecisionGate(): void {
  void getSpecialConfig(homeTarget())
    .then((r) => (!r.remote && !r.cloud && r.config.historian.decisionGate ? saveSpecialConfig(homeTarget(), { historian: { decisionGate: false } }) : undefined))
    .catch(() => { /* 见上 */ })
}
