/**
 * 设置 → 后台智能体（Special Agents：Historian / Muse）。默认关闭、开启需选模型。
 * 改动即存（POST /agent/special/config 合并）。仅本地后端可用。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { History, Sparkles, FolderPlus } from 'lucide-react'
import { getSpecialConfig, saveSpecialConfig, listModels } from '../services/backendService'
import type { HistorianConfig, ModelInfo, MuseConfig, SpecialAgentsConfig, TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'

export const SpecialAgentsTab: React.FC<{ cfg: TanguDesktopConfig }> = ({ cfg }) => {
  const { t } = useI18n()
  const [conf, setConf] = useState<SpecialAgentsConfig | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void getSpecialConfig(cfg).then(setConf).catch(() => setConf(null))
    void listModels(cfg).then((r) => setModels(r.models)).catch(() => setModels([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const modelOpts = useMemo(() => models.map((m) => ({ id: m.id, label: m.name || m.id })), [models])

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
      <option value="">{t('settings.special.pickModelFirst')}</option>
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
      <div className="hint" style={{ marginBottom: 10 }}>{t('settings.special.hint')}</div>

      {/* Historian */}
      <div className="field" style={{ borderTop: 'var(--border-width) solid var(--border)', paddingTop: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <History size={14} /> {t('settings.special.historian')}
          <span className="grow" />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 400, fontSize: 13 }}>
            <input type="checkbox" checked={h.enabled} disabled={!h.modelId}
              onChange={(e) => saveHistorian({ enabled: e.target.checked })} />
            {t('settings.special.enable')}
          </label>
        </label>
        <div className="hint" style={{ marginBottom: 8 }}>{t('settings.special.historianDesc')}</div>
        <div className="field"><label>{t('settings.special.model')}</label>{modelSelect(h.modelId, (v) => saveHistorian({ modelId: v }))}</div>
        <div className="field-row">
          {numField(t('settings.special.h.titleRounds'), h.everyTitleRounds, (n) => saveHistorian({ everyTitleRounds: n }), 1, 100)}
          {numField(t('settings.special.h.memoryRounds'), h.everyMemoryRounds, (n) => saveHistorian({ everyMemoryRounds: n }), 1, 100)}
          <div className="field">
            <label>{t('settings.special.h.firstRound')}</label>
            <input type="checkbox" checked={h.firstRoundTrigger} onChange={(e) => saveHistorian({ firstRoundTrigger: e.target.checked })} />
          </div>
        </div>
        <div className="field">
          <label>{t('settings.special.h.prompt')}</label>
          <textarea rows={2} value={h.prompt} onChange={(e) => saveHistorian({ prompt: e.target.value })} />
        </div>
      </div>

      {/* Muse */}
      <div className="field" style={{ borderTop: 'var(--border-width) solid var(--border)', paddingTop: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={14} /> {t('settings.special.muse')}
          <span className="grow" />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 400, fontSize: 13 }}>
            <input type="checkbox" checked={m.enabled} disabled={!m.modelId}
              onChange={(e) => saveMuse({ enabled: e.target.checked })} />
            {t('settings.special.enable')}
          </label>
        </label>
        <div className="hint" style={{ marginBottom: 8 }}>{t('settings.special.museDesc')}</div>
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={!m.activeHours} onChange={(e) => saveMuse({ activeHours: e.target.checked ? null : { start: 9, end: 22 } })} />
              {t('settings.special.m.activeAllDay')}
            </label>
            {m.activeHours && (
              <>
                <input type="number" min={0} max={23} value={m.activeHours.start} style={{ width: 64 }}
                  onChange={(e) => saveMuse({ activeHours: { start: Math.max(0, Math.min(23, Number(e.target.value) || 0)), end: m.activeHours!.end } })} />
                <span>–</span>
                <input type="number" min={0} max={23} value={m.activeHours.end} style={{ width: 64 }}
                  onChange={(e) => saveMuse({ activeHours: { start: m.activeHours!.start, end: Math.max(0, Math.min(23, Number(e.target.value) || 0)) } })} />
              </>
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
        <div className="field">
          <label>{t('settings.special.m.prompt')}</label>
          <textarea rows={2} value={m.prompt} onChange={(e) => saveMuse({ prompt: e.target.value })} />
        </div>
      </div>
      {msg && <div className="hint" style={{ color: 'var(--danger)' }}>{msg}</div>}
    </>
  )
}
