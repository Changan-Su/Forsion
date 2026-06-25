/**
 * 设置 →「Agent CLIs」:查看检测到的第三方 agent 引擎(Claude Code / Codex …)+ 设每引擎默认模型。
 * 检测(available)来自后端快速检查(配置目录/env/PATH);默认模型从该引擎能力探测(spawn)拉模型列表后下拉选,
 * 经 PUT /agent/engines/:id 持久化到 ~/.tangu/engine-prefs.json。未检测到的引擎只显示安装提示。
 */
import React, { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { listEngines, getEngineCapabilities, setEngineDefaultModel } from '../services/backendService'
import { EngineIcon } from './EngineIcon'
import type { TanguDesktopConfig } from '../types'

type EngineRow = { id: string; name: string; available?: boolean; defaultModel?: string }
type Caps = { models: Array<{ id: string; name: string; description?: string }> }

export const AgentClisTab: React.FC<{ cfg: TanguDesktopConfig }> = ({ cfg }) => {
  const { t } = useI18n()
  const [engines, setEngines] = useState<EngineRow[] | null>(null)
  const [caps, setCaps] = useState<Record<string, Caps | 'loading'>>({})

  useEffect(() => {
    let alive = true
    void listEngines(cfg)
      .then((list) => {
        if (!alive) return
        setEngines(list)
        // 为已检测到的引擎拉模型(填默认模型下拉),逐个 loading(首次 spawn 略慢,后端缓存)。
        for (const e of list.filter((x) => x.available)) {
          setCaps((p) => ({ ...p, [e.id]: 'loading' }))
          void getEngineCapabilities(cfg, e.id).then((c) => {
            if (alive) setCaps((p) => ({ ...p, [e.id]: { models: c.models } }))
          })
        }
      })
      .catch(() => {
        if (alive) setEngines([])
      })
    return () => {
      alive = false
    }
  }, [cfg])

  const onPickModel = (id: string, modelId: string): void => {
    setEngines((list) => (list || []).map((e) => (e.id === id ? { ...e, defaultModel: modelId || undefined } : e)))
    void setEngineDefaultModel(cfg, id, modelId).catch(() => {})
  }

  return (
    <div className="field">
      <div className="settings-section-title">{t('settings.agentClis.title')}</div>
      <div className="hint" style={{ marginBottom: 12 }}>{t('settings.agentClis.hint')}</div>
      {engines === null && <div className="hint">{t('common.loading')}</div>}
      {engines?.length === 0 && <div className="hint">{t('settings.agentClis.empty')}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(engines || []).map((e) => {
          const c = caps[e.id]
          const models = c && c !== 'loading' ? c.models : []
          return (
            <div
              key={e.id}
              style={{ border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-md)', padding: 12 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ display: 'inline-flex', color: 'var(--text-muted)' }}>
                  <EngineIcon engineId={e.id} size={16} />
                </span>
                <b style={{ flex: 1 }}>{e.name}</b>
                {e.available ? (
                  <span className="conn-pill ok">
                    <span className="dot" />
                    {t('settings.agentClis.detected')}
                  </span>
                ) : (
                  <span className="hint">{t('settings.agentClis.notDetected')}</span>
                )}
              </div>
              {e.available ? (
                <div className="field" style={{ margin: '10px 0 0' }}>
                  <label>{t('settings.agentClis.defaultModel')}</label>
                  {c === 'loading' ? (
                    <div className="hint">{t('settings.agentClis.loadingModels')}</div>
                  ) : (
                    <select value={e.defaultModel || ''} onChange={(ev) => onPickModel(e.id, ev.target.value)}>
                      <option value="">{t('settings.agentClis.modelDefault')}</option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ) : (
                <div className="hint" style={{ marginTop: 8 }}>{t('settings.agentClis.notDetectedHint')}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
