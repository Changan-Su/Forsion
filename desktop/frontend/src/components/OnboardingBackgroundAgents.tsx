import React, { useEffect, useRef, useState } from 'react'
import { History, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { useI18n } from '../i18n'
import { getSpecialConfig, saveSpecialConfig } from '../services/backendService'
import type { EngineTarget } from '../services/engine/targets'
import type { SpecialConfigResponse } from '../types'
import { useApp } from '../stores/appStore'
import { SettingsSwitch } from './SettingsPrimitives'

/**
 * Only the enable switches belong in first-run setup; advanced settings keep their own host.
 * @param onState    读到 / 改完开关后回报一次(完成页的摘要用);读不到就不回报。
 * @param historyAhead 下一步有电脑历史:Muse 的说明里加一句指过去(Muse 在这条连接上不可用时不加)。
 */
export function OnboardingBackgroundAgents({ resolveTarget, onBusyChange, onState, historyAhead }: {
  resolveTarget: () => Promise<EngineTarget>
  onBusyChange: (busy: boolean) => void
  onState?: (state: { historian: boolean; muse: boolean }) => void
  historyAhead?: boolean
}) {
  const { t } = useI18n()
  const [response, setResponse] = useState<SpecialConfigResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<'historian' | 'muse' | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const target = useRef<EngineTarget | null>(null)
  const writing = useRef(false)
  const onStateRef = useRef(onState)
  onStateRef.current = onState
  useEffect(() => {
    if (response?.config?.historian && response.config.muse) onStateRef.current?.({ historian: !!response.config.historian.enabled, muse: !!response.config.muse.enabled })
  }, [response])

  const load = async () => {
    const request = ++generation.current
    setLoading(true); setError(''); target.current = null
    try {
      const nextTarget = await resolveTarget()
      const next = await getSpecialConfig(nextTarget)
      if (request !== generation.current) return
      // 桩引擎 / 老引擎可能回不全(走查续六 6.19:读 historian 时是 undefined,整个引导崩成错误页):当读取失败，给重试
      if (!next?.config?.historian || !next.config.muse) throw new Error('special config incomplete')
      target.current = nextTarget
      setResponse(next)
    } catch {
      if (request === generation.current) setError(t('onboarding.background.loadFail'))
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    return () => { generation.current++ }
    // Resolve the latest host connection whenever this step mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveTarget])

  const choose = async (agent: 'historian' | 'muse', enabled: boolean) => {
    if (!target.current || !response || response.remote || (agent === 'muse' && response.cloud) || writing.current || loading) return
    const request = generation.current
    writing.current = true; setSaving(agent); setError(''); onBusyChange(true)
    try {
      // Preserve model, rhythm, permissions, folders and all other existing preferences.
      const config = await saveSpecialConfig(target.current, { [agent]: { enabled } })
      if (request !== generation.current) return
      if (!config?.historian || !config.muse) throw new Error('special config incomplete')
      setResponse({ ...response, config })
      const app = useApp.getState()
      void app.refreshSpecialEnabled(app.cfg)
    } catch (e) {
      if (request === generation.current) setError(t('onboarding.guide.saveFail', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      writing.current = false
      if (request === generation.current) { setSaving(null); onBusyChange(false) }
    }
  }

  return <div className="ob-background-layout" aria-busy={loading || !!saving}>
    <div className="ob-background-agents">
      {(['historian', 'muse'] as const).map((agent) => {
        const Icon = agent === 'historian' ? History : Sparkles
        const name = agent === 'historian' ? 'Historian' : 'Muse'
        const enabled = response?.config?.[agent]?.enabled ?? false
        const unavailable = agent === 'muse' && response?.cloud
        return <section className="ob-background-agent" key={agent} data-agent={agent}>
          <Icon size={22} className="ob-background-icon" />
          <div className="ob-background-copy"><h2>{name}</h2>
            <p>{t(`onboarding.background.${agent}`)}</p>
            {unavailable ? <small>{t('onboarding.background.localOnly')}</small>
              : agent === 'muse' && historyAhead && <small>{t('onboarding.background.museHistory')}</small>}
          </div>
          <div className="ob-background-control">
            <SettingsSwitch label={name} checked={enabled} disabled={loading || !!saving || !response || !!response.remote || !!unavailable || !target.current}
              onChange={(value) => void choose(agent, value)} />
            <span aria-live="polite">{loading || saving === agent ? <Loader2 size={13} className="spin" /> : t(enabled ? 'settings.special.on' : 'settings.special.off')}</span>
          </div>
        </section>
      })}
    </div>
    {error && <div className="ob-background-error" role="alert"><span>{error}</span>
      {!saving && <button className="btn ghost sm" onClick={() => void load()}><RefreshCw size={13} />{t('onboarding.model.refresh')}</button>}
    </div>}
    <p className="ob-muted">{t(response?.remote ? 'onboarding.background.remote' : 'onboarding.background.hint')}</p>
  </div>
}
