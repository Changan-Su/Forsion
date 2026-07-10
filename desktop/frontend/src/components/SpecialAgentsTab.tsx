/**
 * 设置 → 后台智能体（Special Agents：Historian / Muse）。默认关闭、开启需选模型。
 * 改动即存（POST /agent/special/config 合并）。仅本地后端可用。
 * UI 对齐 Tangu 设计系统:卡片 + .seg 分段开关 + .field/.field-row;默认提示词预填进可改框。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { History, Sparkles, FolderPlus } from 'lucide-react'
import { getSpecialConfig, saveSpecialConfig, listModels } from '../services/backendService'
import type { HistorianConfig, ModelInfo, MuseConfig, SpecialAgentsConfig, TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'
import { track } from '../achievements/store'

/** 分段开关(对齐 .seg):关 | 开。canOn=false 时禁用「开」。 */
const Seg: React.FC<{ value: boolean; onChange: (b: boolean) => void; onLabel: string; offLabel: string; canOn?: boolean }> =
  ({ value, onChange, onLabel, offLabel, canOn = true }) => (
    <div className="seg seg-sm">
      <button type="button" className={!value ? 'active' : ''} onClick={() => onChange(false)}>{offLabel}</button>
      <button type="button" className={value ? 'active' : ''} disabled={!canOn && !value} onClick={() => (canOn || value) && onChange(true)}>{onLabel}</button>
    </div>
  )

export const SpecialAgentsTab: React.FC<{ cfg: TanguDesktopConfig }> = ({ cfg }) => {
  const { t } = useI18n()
  const [conf, setConf] = useState<SpecialAgentsConfig | null>(null)
  const [defaults, setDefaults] = useState<{ historianPrompt: string }>({ historianPrompt: '' })
  const [models, setModels] = useState<ModelInfo[]>([])
  /** admin 的 app 级后台默认槽(其次对话默认):未显式选模型时跟随,开关不再因空模型而禁用。 */
  const [slotDefault, setSlotDefault] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void getSpecialConfig(cfg).then((r) => { setConf(r.config); if (r.defaults) setDefaults(r.defaults) }).catch(() => setConf(null))
    void listModels(cfg).then((r) => {
      setModels(r.models)
      setSlotDefault(r.backgroundModelId || r.defaultModelId || '')
    }).catch(() => setModels([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const modelOpts = useMemo(() => models.map((m) => ({ id: m.id, label: m.name || m.id })), [models])
  const slotDefaultLabel = useMemo(
    () => (slotDefault ? (models.find((m) => m.id === slotDefault)?.name || slotDefault) : ''),
    [slotDefault, models],
  )

  const saveHistorian = (patch: Partial<HistorianConfig>): void => {
    if (!conf) return
    const next = { ...conf, historian: { ...conf.historian, ...patch } }
    setConf(next)
    void saveSpecialConfig(cfg, { historian: next.historian }).then(setConf).catch((e) => setMsg(t('settings.special.saveFail', { e: e?.message || e })))
  }
  const saveMuse = (patch: Partial<MuseConfig>): void => {
    if (!conf) return
    const next = { ...conf, muse: { ...conf.muse, ...patch } }
    setConf(next)
    void saveSpecialConfig(cfg, { muse: next.muse }).then(setConf).catch((e) => setMsg(t('settings.special.saveFail', { e: e?.message || e })))
  }

  if (!conf) return <div className="hint">{t('common.loading')}</div>
  const h = conf.historian
  const m = conf.muse

  const modelSelect = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">
        {slotDefault ? t('settings.special.followCloudDefault', { model: slotDefaultLabel }) : t('settings.special.pickModelFirst')}
      </option>
      {modelOpts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  )
  const numField = (label: string, value: number, onChange: (n: number) => void, min = 1, max = 999) => (
    <div className="field">
      <label>{label}</label>
      <input type="number" min={min} max={max} value={value} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))} />
    </div>
  )

  return (
    <>
      <div className="hint" style={{ marginBottom: 12 }}>{t('settings.special.hint')}</div>

      {/* Historian */}
      <div className={`agent-card${h.enabled ? '' : ' disabled'}`}>
        <div className="agent-card-head">
          <span className="ac-title"><History size={15} /> {t('settings.special.historian')}</span>
          <span className="grow" />
          <Seg value={h.enabled} canOn={!!h.modelId || !!slotDefault} onChange={(v) => { if (v) track('special.enable'); saveHistorian({ enabled: v }) }}
            onLabel={t('settings.special.on')} offLabel={t('settings.special.off')} />
        </div>
        <p className="ac-desc">{t('settings.special.historianDesc')}{!h.modelId && !slotDefault && ` · ${t('settings.special.pickModelFirst')}`}</p>
        <div className="field"><label>{t('settings.special.model')}</label>{modelSelect(h.modelId, (v) => saveHistorian({ modelId: v }))}</div>
        <div className="field">
          <label>{t('settings.special.h.mode')}</label>
          <div className="seg seg-sm">
            <button type="button" className={h.mode !== 'assist' ? 'active' : ''} onClick={() => saveHistorian({ mode: 'independent' })}>
              {t('settings.special.h.modeIndependent')}
            </button>
            <button type="button" className={h.mode === 'assist' ? 'active' : ''} onClick={() => saveHistorian({ mode: 'assist' })}>
              {t('settings.special.h.modeAssist')}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>{t('settings.special.h.modeHint')}</div>
        </div>
        <div className="field-row">
          {numField(t('settings.special.h.rounds'), h.everyRounds, (n) => saveHistorian({ everyRounds: n }), 1, 100)}
          <div className="field">
            <label>{t('settings.special.h.firstRound')}</label>
            <Seg value={h.firstRoundTrigger} onChange={(v) => saveHistorian({ firstRoundTrigger: v })}
              onLabel={t('settings.special.on')} offLabel={t('settings.special.off')} />
          </div>
        </div>
        <div className="field">
          <label>{t('settings.special.h.prompt')}</label>
          <textarea rows={3} value={h.prompt || defaults.historianPrompt}
            onChange={(e) => saveHistorian({ prompt: e.target.value === defaults.historianPrompt ? '' : e.target.value })} />
        </div>
      </div>

      {/* Muse */}
      <div className={`agent-card${m.enabled ? '' : ' disabled'}`}>
        <div className="agent-card-head">
          <span className="ac-title"><Sparkles size={15} /> {t('settings.special.muse')}</span>
          <span className="grow" />
          <Seg value={m.enabled} canOn={!!m.modelId || !!slotDefault} onChange={(v) => { if (v) track('special.enable'); saveMuse({ enabled: v }) }}
            onLabel={t('settings.special.on')} offLabel={t('settings.special.off')} />
        </div>
        <p className="ac-desc">{t('settings.special.museDesc')}{!m.modelId && !slotDefault && ` · ${t('settings.special.pickModelFirst')}`}</p>
        <div className="field"><label>{t('settings.special.model')}</label>{modelSelect(m.modelId, (v) => saveMuse({ modelId: v }))}</div>
        <div className="field-row">
          {numField(t('settings.special.m.restartWindow'), m.restartWindowHours, (n) => saveMuse({ restartWindowHours: n }), 1, 24)}
          {numField(t('settings.special.m.maxRestarts'), m.maxRestartsPerWindow, (n) => saveMuse({ maxRestartsPerWindow: n }), 0, 100)}
          {numField(t('settings.special.m.maxIter'), m.maxIterationsPerCycle, (n) => saveMuse({ maxIterationsPerCycle: n }), 1, 500)}
        </div>
        <div className="field-row">
          {numField(t('settings.special.m.maxTodos'), m.maxTodosPerWindow, (n) => saveMuse({ maxTodosPerWindow: n }), 0, 100)}
          {numField(t('settings.special.m.poll'), m.supervisorPollMinutes, (n) => saveMuse({ supervisorPollMinutes: n }), 1, 240)}
        </div>
        <div className="field">
          <label>{t('settings.special.m.activeHours')}</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Seg value={!!m.activeHours} onChange={(v) => saveMuse({ activeHours: v ? { start: 9, end: 22 } : null })}
              onLabel={t('settings.special.custom')} offLabel={t('settings.special.m.activeAllDay')} />
            {m.activeHours && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="number" min={0} max={23} value={m.activeHours.start} style={{ width: 60 }}
                  onChange={(e) => saveMuse({ activeHours: { start: Math.max(0, Math.min(23, Number(e.target.value) || 0)), end: m.activeHours!.end } })} />
                <span style={{ color: 'var(--text-muted)' }}>–</span>
                <input type="number" min={0} max={23} value={m.activeHours.end} style={{ width: 60 }}
                  onChange={(e) => saveMuse({ activeHours: { start: m.activeHours!.start, end: Math.max(0, Math.min(23, Number(e.target.value) || 0)) } })} />
              </div>
            )}
          </div>
        </div>
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {t('settings.special.m.folders')}
            {window.tangu?.pickDirectory && (
              <button className="icon-btn" style={{ width: 22, height: 22 }} title="+"
                onClick={() => void window.tangu!.pickDirectory!().then((d) => { if (d) saveMuse({ allowedFolders: [...m.allowedFolders, d] }) })}>
                <FolderPlus size={13} />
              </button>
            )}
          </label>
          <textarea rows={2} value={m.allowedFolders.join('\n')}
            onChange={(e) => saveMuse({ allowedFolders: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} />
        </div>
        {/* 人格/指令已迁入 ~/.tangu/agents/muse/(文件夹系统 agent),在 Agent 名册里像普通 agent 一样编辑。 */}
        <div className="hint" style={{ marginBottom: 0 }}>{t('settings.special.m.promptMoved')}</div>
      </div>
      {msg && <div className="hint" style={{ color: 'var(--danger)' }}>{msg}</div>}
    </>
  )
}
