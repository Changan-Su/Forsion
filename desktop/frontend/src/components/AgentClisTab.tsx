/**
 * 设置 →「Agent CLIs」:查看检测到的第三方 agent 引擎(Claude Code / Codex …)+ 设每引擎默认模型,
 * 并查看该引擎已装的 skills/MCP、逐个导入成 Tangu 自有资产(二级面板,见 engines/assets.ts)。
 * 检测(available)来自后端快速检查(配置目录/env/PATH);默认模型从该引擎能力探测(spawn)拉模型列表后下拉选,
 * 经 PUT /agent/engines/:id 持久化到 ~/.tangu/engine-prefs.json。未检测到的引擎只显示安装提示。
 */
import React, { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useI18n } from '../i18n'
import {
  listEngines,
  getEngineCapabilities,
  setEngineDefaultModel,
  listEngineAssets,
  importEngineAsset,
  type EngineAssets,
} from '../services/backendService'
import { EngineIcon } from './EngineIcon'
import type { TanguDesktopConfig } from '../types'

type EngineStatus = 'available' | 'needs-signin' | 'not-installed'
type EngineRow = { id: string; name: string; available?: boolean; status?: EngineStatus; defaultModel?: string; setup?: string }
type Caps = { models: Array<{ id: string; name: string; description?: string }> }

export const AgentClisTab: React.FC<{ cfg: TanguDesktopConfig }> = ({ cfg }) => {
  const { t } = useI18n()
  const [engines, setEngines] = useState<EngineRow[] | null>(null)
  const [caps, setCaps] = useState<Record<string, Caps | 'loading'>>({})
  const [assets, setAssets] = useState<Record<string, EngineAssets | 'loading'>>({})
  const [busy, setBusy] = useState('') // `${id}:${kind}:${name}`

  useEffect(() => {
    let alive = true
    void listEngines(cfg)
      .then((list) => {
        if (!alive) return
        setEngines(list)
        // 为已检测到的引擎拉模型 + 已装资产(逐个 loading;首次 spawn 略慢,后端缓存)。
        for (const e of list.filter((x) => x.available)) {
          setCaps((p) => ({ ...p, [e.id]: 'loading' }))
          void getEngineCapabilities(cfg, e.id).then((c) => {
            if (alive) setCaps((p) => ({ ...p, [e.id]: { models: c.models } }))
          })
          setAssets((p) => ({ ...p, [e.id]: 'loading' }))
          void listEngineAssets(cfg, e.id).then((a) => {
            if (alive) setAssets((p) => ({ ...p, [e.id]: a }))
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

  const doImport = (engineId: string, kind: 'skill' | 'mcp', name: string): void => {
    const key = `${engineId}:${kind}:${name}`
    setBusy(key)
    void importEngineAsset(cfg, engineId, kind, name)
      .then(() => {
        setAssets((p) => {
          const a = p[engineId]
          if (!a || a === 'loading') return p
          const mark = <T extends { name: string; imported: boolean }>(arr: T[]): T[] =>
            arr.map((x) => (x.name === name ? { ...x, imported: true } : x))
          return { ...p, [engineId]: kind === 'skill' ? { ...a, skills: mark(a.skills) } : { ...a, mcp: mark(a.mcp) } }
        })
      })
      .catch(() => {})
      .finally(() => setBusy(''))
  }

  const renderAction = (engineId: string, kind: 'skill' | 'mcp', name: string, imported: boolean): React.ReactNode => {
    if (imported) return <span className="hint" style={{ fontSize: 12 }}>{t('settings.agentClis.imported')}</span>
    const key = `${engineId}:${kind}:${name}`
    return (
      <button className="btn ghost sm" disabled={busy === key} onClick={() => doImport(engineId, kind, name)}>
        {busy === key ? <Loader2 size={11} className="spin" /> : t('settings.agentClis.importBtn')}
      </button>
    )
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
          const a = assets[e.id]
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
                {(() => {
                  // 三态:后端给 status 就用它;旧后端只有 available 时降级为二态。
                  const status: EngineStatus = e.status ?? (e.available ? 'available' : 'not-installed')
                  if (status === 'available') {
                    return (
                      <span className="conn-pill ok">
                        <span className="dot" />
                        {t('settings.agentClis.detected')}
                      </span>
                    )
                  }
                  if (status === 'needs-signin') {
                    return (
                      <span className="conn-pill warn">
                        <span className="dot" />
                        {t('settings.agentClis.needsSignin')}
                      </span>
                    )
                  }
                  return <span className="hint">{t('settings.agentClis.notDetected')}</span>
                })()}
              </div>
              {/* 未检测到 → 给出该引擎的一行安装命令(语言中立,直接可复制);已装的不显示。 */}
              {!e.available && !!e.setup && (
                <div className="hint" style={{ marginTop: 8 }}>
                  <code style={{ userSelect: 'text' }}>{e.setup}</code>
                </div>
              )}
              {e.available ? (
                <>
                  <div className="field" style={{ margin: '10px 0 0' }}>
                    <label>{t('settings.agentClis.defaultModel')}</label>
                    {c === 'loading' ? (
                      <div className="hint">{t('settings.agentClis.loadingModels')}</div>
                    ) : (
                      <select value={e.defaultModel || ''} onChange={(ev) => onPickModel(e.id, ev.target.value)}>
                        <option value="">{t('settings.agentClis.modelDefault')}</option>
                        {models.map((m) => (
                          <option key={m.id} value={m.id} title={m.description}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  {a && a !== 'loading' && (a.skills.length > 0 || a.mcp.length > 0) && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: 'var(--border-width) solid var(--border)' }}>
                      <div className="hint" style={{ marginBottom: 8 }}>{t('settings.agentClis.importHint')}</div>
                      {a.skills.length > 0 && (
                        <>
                          <div className="panel-section-title">
                            {t('settings.agentClis.skillsLabel')} · {a.skills.length}
                          </div>
                          {a.skills.map((s) => (
                            <div key={s.name} className="file-row" style={{ cursor: 'default' }}>
                              <span className="file-name">
                                <b>{s.name}</b>
                                {!!s.description && (
                                  <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>
                                    {s.description}
                                  </span>
                                )}
                              </span>
                              {renderAction(e.id, 'skill', s.name, s.imported)}
                            </div>
                          ))}
                        </>
                      )}
                      {a.mcp.length > 0 && (
                        <>
                          <div className="panel-section-title" style={{ marginTop: 8 }}>
                            {t('settings.agentClis.mcpLabel')} · {a.mcp.length}
                          </div>
                          {a.mcp.map((m) => (
                            <div key={m.name} className="file-row" style={{ cursor: 'default' }}>
                              <span className="file-name">
                                <b>{m.name}</b>
                                <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 8 }}>
                                  {m.url || m.command || ''}
                                </span>
                              </span>
                              {renderAction(e.id, 'mcp', m.name, m.imported)}
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </>
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
