/**
 * 设置 → 后台智能体（Special Agents：Historian / Muse）。默认关闭、开启需选模型。
 * 改动即存（POST /agent/special/config 合并）。仅本地后端可用。
 * UI 对齐 Tangu 设计系统:卡片 + .seg 分段开关 + .field/.field-row;默认提示词预填进可改框。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { History, Sparkles, FolderPlus } from 'lucide-react'
import { getSpecialConfig, saveSpecialConfig, listModels, listAgents } from '../services/backendService'
import type { HistorianConfig, ModelInfo, MuseConfig, NormalAgentDef, SpecialAgentsConfig, TanguDesktopConfig } from '../types'
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
  /** Agent 名册:「难活交给」下拉的选项来源(listAgents 失败=空数组)。 */
  const [agents, setAgents] = useState<NormalAgentDef[]>([])
  /** admin 的 app 级后台默认槽(其次对话默认):未显式选模型时跟随,开关不再因空模型而禁用。 */
  const [slotDefault, setSlotDefault] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void getSpecialConfig(cfg).then((r) => { setConf(r.config); if (r.defaults) setDefaults(r.defaults) }).catch(() => setConf(null))
    void listModels(cfg).then((r) => {
      setModels(r.models)
      setSlotDefault(r.backgroundModelId || r.defaultModelId || '')
    }).catch(() => setModels([]))
    void listAgents(cfg).then(setAgents)
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
  const hMode = h.mode === 'assist' || h.mode === 'fork' ? h.mode : 'independent'
  const museMode = m.mode || 'ask'
  // 名册里没有的 slug(旧版文本框填的)也留作一项,否则下拉会静默显示成「不指定」而配置还在。
  const escalateOpts = agents.filter((a) => a.slug !== 'muse').concat(m.escalateTo && !agents.some((a) => a.slug === m.escalateTo) ? [{ slug: m.escalateTo, name: m.escalateTo } as NormalAgentDef] : [])

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
        {/* fork 模式判官用会话模型,此模型仍被回落判断与记忆整固消费,故不藏只改名 */}
        <div className="field"><label>{hMode === 'fork' ? t('settings.special.h.fallbackModel') : t('settings.special.model')}</label>{modelSelect(h.modelId, (v) => saveHistorian({ modelId: v }))}</div>
        <div className="field">
          <label>{t('settings.special.h.mode')}</label>
          <div className="seg seg-sm">
            <button type="button" className={hMode === 'independent' ? 'active' : ''} onClick={() => saveHistorian({ mode: 'independent' })}>
              {t('settings.special.h.modeIndependent')}
            </button>
            <button type="button" className={hMode === 'assist' ? 'active' : ''} onClick={() => saveHistorian({ mode: 'assist' })}>
              {t('settings.special.h.modeAssist')}
            </button>
            <button type="button" className={hMode === 'fork' ? 'active' : ''} onClick={() => saveHistorian({ mode: 'fork' })}>
              {t('settings.special.h.modeFork')}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            {t(hMode === 'assist' ? 'settings.special.h.modeHintAssist' : hMode === 'fork' ? 'settings.special.h.modeHintFork' : 'settings.special.h.modeHintIndependent')}
          </div>
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
          <label>{t('settings.special.h.harnessCandidates')}</label>
          <Seg value={!!h.harnessCandidates} onChange={(v) => saveHistorian({ harnessCandidates: v })}
            onLabel={t('settings.special.on')} offLabel={t('settings.special.off')} />
          <div className="hint" style={{ marginTop: 4 }}>{t('settings.special.h.harnessCandidatesHint')}</div>
        </div>
        <div className="field">
          <label>{t('settings.special.h.prompt')}</label>
          <textarea rows={3} value={h.prompt || defaults.historianPrompt}
            onChange={(e) => saveHistorian({ prompt: e.target.value === defaults.historianPrompt ? '' : e.target.value })} />
        </div>
      </div>

      {/* Muse(2026-09-10 重排):基本(模型/权限档/额外文件夹)→ 节奏 → 通知 → 预算(折叠)。字段语义见引擎 services/muse.ts 头注释。 */}
      <div className={`agent-card${m.enabled ? '' : ' disabled'}`}>
        <div className="agent-card-head">
          <span className="ac-title"><Sparkles size={15} /> {t('settings.special.muse')}</span>
          <span className="grow" />
          <Seg value={m.enabled} canOn={!!m.modelId || !!slotDefault} onChange={(v) => { if (v) track('special.enable'); saveMuse({ enabled: v }) }}
            onLabel={t('settings.special.on')} offLabel={t('settings.special.off')} />
        </div>
        <p className="ac-desc">{t('settings.special.museDesc')}{!m.modelId && !slotDefault && ` · ${t('settings.special.pickModelFirst')}`}</p>
        <div className="field"><label>{t('settings.special.model')}</label>{modelSelect(m.modelId, (v) => saveMuse({ modelId: v }))}</div>
        {/* 权限档:与普通 agent 的审批档对齐;三档都能在 Library 里自由工作。旧引擎没有这些字段 → 读端按缺省显示。 */}
        <div className="field">
          <label>{t('settings.special.m.mode')}</label>
          <select value={museMode} onChange={(e) => saveMuse({ mode: e.target.value as MuseConfig['mode'] })}>
            <option value="ask">{t('settings.special.m.modeAsk')}</option>
            <option value="agent">{t('settings.special.m.modeAgent')}</option>
            <option value="auto">{t('settings.special.m.modeAuto')}</option>
          </select>
          <div className="hint">{t('settings.special.m.modeDesc')}</div>
        </div>
        {/* allowedFolders 一个字段两种消费:全开档并入可写根(extraRoots);审批/代批档只进提示词「可以去看」。提示随档位切换,别让用户猜。 */}
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
          <div className="hint">{t(museMode === 'auto' ? 'settings.special.m.foldersHintAuto' : 'settings.special.m.foldersHintAsk')}</div>
        </div>

        <div className="ac-sec">{t('settings.special.m.secRhythm')}</div>
        <div className="field-row">
          {/* 分钟(09-11 起);旧引擎只回 heartbeatHours → ×60 显示,保存一律写 heartbeatMinutes。 */}
          <div className="field">
            <label>{t('settings.special.m.heartbeat')}</label>
            <input type="number" min={0} max={10080} value={m.heartbeatMinutes ?? (m.heartbeatHours != null ? Math.round(m.heartbeatHours * 60) : 120)}
              onChange={(e) => saveMuse({ heartbeatMinutes: Math.max(0, Math.min(10080, Math.floor(Number(e.target.value) || 0))) })} />
            <div className="hint">{t('settings.special.m.heartbeatHint')}</div>
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
        </div>

        <div className="ac-sec">{t('settings.special.m.notify')}</div>
        <div className="field-row">
          <div className="field">
            <label>{t('settings.special.m.notifyMode')}</label>
            <select value={m.notify || 'immediate'} onChange={(e) => saveMuse({ notify: e.target.value as MuseConfig['notify'] })}>
              <option value="immediate">{t('settings.special.m.notifyImmediate')}</option>
              <option value="digest">{t('settings.special.m.notifyDigest')}</option>
            </select>
          </div>
          <div className="field">
            <label>{t('settings.special.m.escalateTo')}</label>
            <select value={m.escalateTo || ''} onChange={(e) => saveMuse({ escalateTo: e.target.value })}>
              <option value="">{t('settings.special.m.escalateNone')}</option>
              {escalateOpts.map((a) => <option key={a.slug} value={a.slug}>{a.name || a.slug}</option>)}
            </select>
          </div>
        </div>

        {/* 预算:三个上限共用一个滚动窗口(restartWindowHours;museTodo.ts 的 TODO 配额也读它)。supervisorPollMinutes 是巡检实现细节,不露出。 */}
        <details>
          <summary className="ac-sec">{t('settings.special.m.budget')}</summary>
          <div className="field-row">
            {numField(t('settings.special.m.budgetWindow'), m.restartWindowHours, (n) => saveMuse({ restartWindowHours: n }), 1, 24)}
            {numField(t('settings.special.m.maxCycles'), m.maxRestartsPerWindow, (n) => saveMuse({ maxRestartsPerWindow: n }), 0, 100)}
            {numField(t('settings.special.m.maxTodos'), m.maxTodosPerWindow, (n) => saveMuse({ maxTodosPerWindow: n }), 0, 100)}
          </div>
          {numField(t('settings.special.m.maxIter'), m.maxIterationsPerCycle, (n) => saveMuse({ maxIterationsPerCycle: n }), 1, 500)}
        </details>
        <p className="ac-desc" style={{ margin: '12px 0 0' }}>{t('settings.special.m.persona')}</p>
      </div>
      {msg && <div className="hint" style={{ color: 'var(--danger)' }}>{msg}</div>}
    </>
  )
}
