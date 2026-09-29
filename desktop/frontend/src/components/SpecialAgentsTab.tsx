import { useEffect, useId, useState, type ReactNode } from 'react'
import { Check, ChevronRight, FolderPlus, History, Loader2, Sparkles } from 'lucide-react'
import { useApp } from '../stores/appStore'
import { getSpecialConfig, saveSpecialConfig, listModels, listAgents } from '../services/backendService'
import type { HistorianConfig, ModelInfo, MuseConfig, NormalAgentDef, SpecialAgentsConfig, SpecialAgentsSummary, TanguDesktopConfig } from '../types'
import { registerMessages, useI18n } from '../i18n'
import { track } from '../achievements/store'
import { CapabilityMenu } from './CapabilityMenu'
import { subscribeAccountQuota, type AccountQuotaView } from '../services/accountQuota'
import './specialAgents.css'
import { homeTarget, connectionKey } from '../services/engine/targets'

registerMessages({
  'specialUi.intro': { zh: '管理在后台整理记忆与推进工作的 Agent。选择一个 Agent 调整它的工作方式。', en: 'Manage the agents that organize memory and work in the background. Choose one to adjust how it works.' },
  'specialUi.historianSummary': { zh: '整理会话与记忆', en: 'Organizes conversations and memory' },
  'specialUi.museSummary': { zh: '按节奏主动工作', en: 'Works proactively on a schedule' },
  'specialUi.saved': { zh: '更改已保存', en: 'Changes saved' },
  'specialUi.draft': { zh: '有未保存的更改', en: 'Unsaved changes' },
  'specialUi.save': { zh: '保存更改', en: 'Save changes' },
  'specialUi.discard': { zh: '放弃修改', en: 'Discard changes' },
  'specialUi.saveHint': { zh: '修改后保存，新的设置才会生效。', en: 'Save your changes to apply the new settings.' },
  'specialUi.retry': { zh: '重新加载', en: 'Try again' },
  'specialUi.loadFailed': { zh: '暂时无法读取后台 Agent 设置。', en: 'Background agent settings could not be loaded.' },
  // P1-K10b:设备页的引擎是那台电脑,GET /agent/special/config 对远程来源只回开关与两个节奏值(提示词、授权文件夹、模型、时段、预算不回)。
  // Muse 的权限档 / 心跳经 muse/status 仍对远端可读(MuseView 与 Muse Space 要用;P1-M1A 起那条也投影、/agent/agents 不再回人格)—— 这句文案只说「这页显示什么」,不宣称别处也藏了
  'specialUi.remoteOnly': { zh: '后台 Agent 只能在运行它们的那台电脑上设置。这里只显示它们是否开启。', en: 'Background agents can only be set up on the computer they run on. This page only shows whether they are on.' },
  'specialUi.advanced': { zh: '高级设置', en: 'Advanced settings' },
  'specialUi.memory': { zh: '记忆与进化', en: 'Memory and growth' },
  'specialUi.resetPrompt': { zh: '恢复默认提示词', en: 'Restore default prompt' },
  'specialUi.addFolder': { zh: '添加文件夹', en: 'Add folder' },
  'specialUi.startHour': { zh: '开始时间（小时）', en: 'Start time (hour)' },
  'specialUi.endHour': { zh: '结束时间（小时）', en: 'End time (hour)' },
  'specialUi.searchModels': { zh: '搜索模型', en: 'Search models' },
  'specialUi.cloudQuota': {
    zh: '在云端运行：每到设定的轮数，用所选模型整理一次标题、日志和长期记忆，按实际用量计入你的 AI 额度；额度用完的那一轮会跳过。',
    en: 'Runs in the cloud: every set number of rounds it updates the title, log and long-term memory with the chosen model, counted against your AI quota at actual usage. Rounds are skipped once your quota runs out.',
  },
  'bgQuota.title': { zh: '后台额度', en: 'Background quota' },
  'bgQuota.lead': {
    zh: 'AI 额度之外额外的一份，只计 Muse 与自动化用云端默认后台模型（{model}）的用量。剩余多少、用完后是否改用 AI 额度继续、从 AI 额度转入，都在「Forsion 云端 → 额度与积分」里。',
    en: 'An extra allowance on top of your AI quota, used only by Muse and automations on the cloud default background model ({model}). What is left, whether to continue on your AI quota when it runs out, and moving quota in are all under Forsion Cloud → Quota & points.',
  },
  'bgQuota.otherModel': {
    zh: 'Muse 当前用的是 {model}，不计入后台额度，会消耗 AI 额度。',
    en: 'Muse is set to {model}, which does not count toward the background quota and uses your AI quota instead.',
  },
  'bgQuota.manage': { zh: '打开额度与积分', en: 'Open Quota & points' },
})

function Toggle({ value, onChange, label, disabled = false }: { value: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" className="special-toggle" role="switch" aria-checked={value} aria-label={label} disabled={disabled} onClick={() => onChange(!value)}><span /></button>
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId()
  return <div className="special-field" role="group" aria-labelledby={id}><span id={id}>{label}</span>{children}{hint && <p>{hint}</p>}</div>
}
function NumberField({ label, value, onChange, min, max, hint }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number; hint?: string }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => { const next = text.trim() && Number.isFinite(Number(text)) ? Math.min(max, Math.max(min, Math.floor(Number(text)))) : value; setText(String(next)); onChange(next) }
  return <Field label={label} hint={hint}><input aria-label={label} type="number" min={min} max={max} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }} /></Field>
}

/**
 * Forsion 后台额度(账号级,服务端真源;不走本页的草稿 / 保存流程,点了就生效)。
 * 只在宿主有额度接口、且服务端配了计入模型(background.modelId)时出现。museModelId = Muse 显式选的模型('' = 跟随云端)。
 */
/** 后台额度:剩余量与操作(用完改用 AI 额度继续 / 从 AI 额度转入)2026-09-28 起都在「Forsion 云端 → 额度与积分」(Extend 画的页),
 *  这里只留说明、Muse 专属的「当前模型不计入后台额度」提示和一个跳转 —— 同一组开关原来在这、网页、提醒条三处各有一份。 */
function BackgroundQuotaSection({ museModelId, modelLabel }: { museModelId: string; modelLabel: (id: string) => string }) {
  const { t } = useI18n()
  const [quota, setQuota] = useState<AccountQuotaView | null>(null)
  useEffect(() => {
    let alive = true
    let pushed = false // 首拉回来之前已经收到过广播(转入 / 切账号后别处刷新)→ 首拉那份是旧快照,丢掉
    const off = subscribeAccountQuota((q) => { if (alive && q) { pushed = true; setQuota(q) } })
    void window.tangu?.accountQuota?.().then((r) => { if (alive && !pushed && r?.status === 200 && r.json) setQuota(r.json) }).catch(() => {})
    return () => { alive = false; off() }
  }, [])
  const bg = quota?.background
  if (!window.tangu?.accountQuota || !bg?.modelId) return null
  return <>
    <div className="special-section-title">{t('bgQuota.title')}</div>
    <div className="special-bgquota">
      <p className="special-bgquota-lead">{t('bgQuota.lead', { model: modelLabel(bg.modelId) })}</p>
      {/* ponytail: 只看 Muse 显式选的模型;「设置 → 模型」里本机改过辅助模型槽(config.json models.background)时 Muse 也会走 AI 额度,
          这里不提醒 —— 要提醒得让 /agent/models 带回本机槽位 */}
      {!!museModelId && museModelId !== bg.modelId && <p className="special-bgquota-warn">{t('bgQuota.otherModel', { model: modelLabel(museModelId) })}</p>}
      {!!window.tangu?.cloudInvoke && (
        <button type="button" className="btn ghost sm" onClick={() => useApp.getState().openSettings('forsion/fx:forsion-extend:quota' as Parameters<ReturnType<typeof useApp.getState>['openSettings']>[0])}>
          {t('bgQuota.manage')} <ChevronRight size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  </>
}

type SpecialDraft = { conf: SpecialAgentsConfig; baseline: SpecialAgentsConfig; prompt: string; folders: string }
const specialDrafts = new Map<string, SpecialDraft>()

/** Explicit, field-level saves keep text editing stable and preserve unrelated backend changes. */
export function SpecialAgentsTab({ cfg, localHost = false }: { cfg: TanguDesktopConfig; localHost?: boolean }) {
  const { t } = useI18n()
  const draftKey = connectionKey(cfg)
  const [conf, setConf] = useState<SpecialAgentsConfig | null>(null)
  const [baseline, setBaseline] = useState<SpecialAgentsConfig | null>(null)
  const [promptDefault, setPromptDefault] = useState('')
  const [prompt, setPrompt] = useState('')
  const [folders, setFolders] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [agents, setAgents] = useState<NormalAgentDef[]>([])
  const [slotDefault, setSlotDefault] = useState('')
  const [active, setActive] = useState<'historian' | 'muse'>('historian')
  // 云端(web/安卓):引擎只有按轮 Historian 的四项(开关 / 模型 / 轮数 / 首轮),Muse、模式、提示词都是本地特性。
  const [cloud, setCloud] = useState(false)
  // 远程来源(设备页)只拿到开关摘要:不渲染编辑器(远端本就写不进去),只读显示开关状态(P1-K10b)
  const [remoteView, setRemoteView] = useState<SpecialAgentsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    getSpecialConfig(homeTarget()).then((r) => { if (!alive) return; if (r.remote) { setRemoteView(r.config); return } setRemoteView(null); setCloud(!!r.cloud); const cached = specialDrafts.get(draftKey); setConf(cached?.conf || r.config); setBaseline(cached?.baseline || r.config); setPromptDefault(r.defaults?.historianPrompt || ''); setPrompt(cached?.prompt ?? (r.config.historian.prompt || r.defaults?.historianPrompt || '')); setFolders(cached?.folders ?? r.config.muse.allowedFolders.join('\n')) }).catch(() => { if (alive) setError(t('specialUi.loadFailed')) }).finally(() => { if (alive) setLoading(false) })
    listModels(homeTarget()).then((r) => { if (alive) { setModels(r.models); setSlotDefault(r.backgroundModelId || r.defaultModelId || '') } }).catch(() => {})
    listAgents(homeTarget()).then((r) => { if (alive) setAgents(r) }).catch(() => {})
    return () => { alive = false }
  }, [cfg, retry]) // Locale changes must not replace unsaved text.
  const changeHistorian = (patch: Partial<HistorianConfig>) => { setConf((c) => c && ({ ...c, historian: { ...c.historian, ...patch } })); setNotice('') }
  const changeMuse = (patch: Partial<MuseConfig>) => { setConf((c) => c && ({ ...c, muse: { ...c.muse, ...patch } })); setNotice('') }
  const dirty = !!conf && !!baseline && (JSON.stringify(conf) !== JSON.stringify(baseline) || prompt !== (baseline.historian.prompt || promptDefault) || folders !== baseline.muse.allowedFolders.join('\n'))
  useEffect(() => {
    if (!conf || !baseline || loading) return
    if (dirty) specialDrafts.set(draftKey, { conf, baseline, prompt, folders })
    else specialDrafts.delete(draftKey)
  }, [conf, baseline, prompt, folders, dirty, draftKey, loading])
  const save = async () => {
    if (!conf || !baseline || busy) return
    setBusy(true); setError(''); setNotice('')
    const next = { historian: { ...conf.historian, prompt: prompt === promptDefault ? '' : prompt }, muse: { ...conf.muse, allowedFolders: [...new Set(folders.split('\n').map((s) => s.trim()).filter(Boolean))] } }
    const diff = <T extends object>(a: T, b: T): Partial<T> => Object.fromEntries(Object.entries(a).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(b[key as keyof T]))) as Partial<T>
    try {
      const saved = await saveSpecialConfig(homeTarget(), { historian: diff(next.historian, baseline.historian), muse: diff(next.muse, baseline.muse) })
      if ((!baseline.historian.enabled && saved.historian.enabled) || (!baseline.muse.enabled && saved.muse.enabled)) track('special.enable')
      setConf(saved); setBaseline(saved); setPrompt(saved.historian.prompt || promptDefault); setFolders(saved.muse.allowedFolders.join('\n')); setNotice(t('specialUi.saved'))
      void useApp.getState().refreshSpecialEnabled(cfg)
    } catch (e: any) { setError(t('settings.special.saveFail', { e: e?.message || e })) } finally { setBusy(false) }
  }
  if (loading) return <div className="special-loading" role="status"><Loader2 size={15} className="spin" />{t('common.loading')}</div>
  if (remoteView) return <div className="special-agents">
    <p className="special-intro">{t('specialUi.remoteOnly')}</p>
    <div className="special-agent-nav">
      {(['historian', 'muse'] as const).map((role) => { const Icon = role === 'historian' ? History : Sparkles; const on = !!remoteView[role]?.enabled; return <div key={role} className="special-agent-status"><Icon size={18} /><span><strong>{t(`settings.special.${role}`)}</strong><small>{t(role === 'historian' ? 'specialUi.historianSummary' : 'specialUi.museSummary')}</small></span><i className={on ? 'on' : ''}>{t(on ? 'settings.special.on' : 'settings.special.off')}</i></div> })}
    </div>
  </div>
  if (!conf || !baseline) return <div className="special-loading" role="alert">{error}<button className="btn" onClick={() => setRetry((n) => n + 1)}>{t('specialUi.retry')}</button></div>
  const h = conf.historian, m = conf.muse
  const hMode = h.mode || 'independent', museMode = m.mode || 'ask'
  const choice = (label: string, value: string, options: { id: string; label: string }[], onChange: (v: string) => void, searchLabel?: string) => <CapabilityMenu label={label} selection searchLabel={searchLabel} items={options.map((o) => ({ ...o, selected: o.id === value, onSelect: () => onChange(o.id) }))}><span>{options.find((o) => o.id === value)?.label || value}</span><ChevronRight size={13} /></CapabilityMenu>
  const model = (value: string, onChange: (v: string) => void) => choice(t('settings.special.model'), value, [
    { id: '', label: slotDefault ? t('settings.special.followCloudDefault', { model: models.find((item) => item.id === slotDefault)?.name || slotDefault }) : t('agentProfile.default') },
    ...models.map((item) => ({ id: item.id, label: item.name || item.id })),
    ...(value && !models.some((item) => item.id === value) ? [{ id: value, label: value }] : []),
  ], onChange, t('specialUi.searchModels'))
  const toggleRow = (label: string, value: boolean, onChange: (v: boolean) => void, hint?: string) => <div className="special-toggle-row"><div><strong>{label}</strong>{hint && <p>{hint}</p>}</div><Toggle label={label} value={value} onChange={onChange} /></div>
  const escalation = agents.filter((a) => a.slug !== 'muse').map((a) => ({ id: a.slug, label: a.name || a.slug }))
  if (m.escalateTo && !escalation.some((a) => a.id === m.escalateTo)) escalation.push({ id: m.escalateTo, label: m.escalateTo })
  return <div className="special-agents">
    {!cloud && <p className="special-intro">{t('specialUi.intro')}</p>}
    {!cloud && <div className="special-agent-nav" role="tablist" aria-label={t('settings.special.hint')}>
      {(['historian', 'muse'] as const).map((role) => { const Icon = role === 'historian' ? History : Sparkles; return <button key={role} id={`special-${role}-tab`} role="tab" aria-selected={active === role} aria-controls={`special-${role}`} tabIndex={active === role ? 0 : -1} onKeyDown={(e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const next = e.key === 'Home' ? 'historian' : e.key === 'End' ? 'muse' : role === 'historian' ? 'muse' : 'historian'; setActive(next); document.getElementById(`special-${next}-tab`)?.focus() } }} onClick={() => setActive(role)}><Icon size={18} /><span><strong>{t(`settings.special.${role}`)}</strong><small>{t(role === 'historian' ? 'specialUi.historianSummary' : 'specialUi.museSummary')}</small></span><i className={conf[role].enabled ? 'on' : ''}>{t(conf[role].enabled ? 'settings.special.on' : 'settings.special.off')}</i></button> })}
    </div>}
    <fieldset className="special-editor" disabled={busy}>
      <section key={active} id={`special-${active}`} role="tabpanel" aria-labelledby={`special-${active}-tab`} className="special-agent-content">
        <header className="special-agent-heading"><div><h3>{t(`settings.special.${active}`)}</h3><p>{t(active === 'historian' ? 'settings.special.historianDesc' : 'settings.special.museDesc')}</p></div><Toggle label={t(`settings.special.${active}`)} value={conf[active].enabled} onChange={(enabled) => active === 'historian' ? changeHistorian({ enabled }) : changeMuse({ enabled })} /></header>
        <Field label={t(hMode === 'fork' && active === 'historian' ? 'settings.special.h.fallbackModel' : 'settings.special.model')}>{model(conf[active].modelId, (modelId) => active === 'historian' ? changeHistorian({ modelId }) : changeMuse({ modelId }))}</Field>
        {active === 'historian' ? <>
          {!cloud && <Field label={t('settings.special.h.mode')} hint={t(hMode === 'assist' ? 'settings.special.h.modeHintAssist' : hMode === 'fork' ? 'settings.special.h.modeHintFork' : 'settings.special.h.modeHintIndependent')}>
            <div className="special-choices">{(['independent', 'assist', 'fork'] as const).map((mode) => <button type="button" key={mode} aria-pressed={hMode === mode} onClick={() => changeHistorian({ mode })}>{t(mode === 'assist' ? 'settings.special.h.modeAssist' : mode === 'fork' ? 'settings.special.h.modeFork' : 'settings.special.h.modeIndependent')}</button>)}</div>
          </Field>}
          <NumberField label={t('settings.special.h.rounds')} value={h.everyRounds} onChange={(everyRounds) => changeHistorian({ everyRounds })} min={1} max={100} />
          {toggleRow(t('settings.special.h.firstRound'), h.firstRoundTrigger, (firstRoundTrigger) => changeHistorian({ firstRoundTrigger }))}
          {cloud && <p className="special-footnote">{t('specialUi.cloudQuota')}</p>}
          {!cloud && <><details className="special-disclosure"><summary>{t('specialUi.memory')}</summary>{toggleRow(t('settings.special.h.harnessCandidates'), h.harnessCandidates, (harnessCandidates) => changeHistorian({ harnessCandidates }), t('settings.special.h.harnessCandidatesHint'))}</details>
          <details className="special-disclosure"><summary>{t('specialUi.advanced')}</summary><Field label={t('settings.special.h.prompt')}><textarea aria-label={t('settings.special.h.prompt')} rows={7} value={prompt} onChange={(e) => { setPrompt(e.target.value); setNotice('') }} /><button type="button" className="special-text-action" onClick={() => setPrompt(promptDefault)}>{t('specialUi.resetPrompt')}</button></Field></details></>}
        </> : <>
          <Field label={t('settings.special.m.mode')} hint={t('settings.special.m.modeDesc')}>{choice(t('settings.special.m.mode'), museMode, [
            { id: 'ask', label: t('settings.special.m.modeAsk') }, { id: 'agent', label: t('settings.special.m.modeAgent') }, { id: 'auto', label: t('settings.special.m.modeAuto') },
          ], (mode) => changeMuse({ mode: mode as MuseConfig['mode'] }))}</Field>
          <Field label={t('settings.special.m.folders')} hint={t(museMode === 'auto' ? 'settings.special.m.foldersHintAuto' : 'settings.special.m.foldersHintAsk')}>
            <textarea aria-label={t('settings.special.m.folders')} rows={3} value={folders} onChange={(e) => { setFolders(e.target.value); setNotice('') }} />
            {localHost && window.tangu?.pickDirectory && <button type="button" className="special-text-action" onClick={() => void window.tangu!.pickDirectory!().then((path) => { if (path) setFolders((text) => text.trim() ? `${text.trim()}\n${path}` : path) })}><FolderPlus size={14} />{t('specialUi.addFolder')}</button>}
          </Field>
          <div className="special-section-title">{t('settings.special.m.secRhythm')}</div>
          <div className="special-field-grid"><NumberField label={t('settings.special.m.heartbeat')} value={m.heartbeatMinutes ?? ((m.heartbeatHours ?? 2) * 60)} min={0} max={10080} onChange={(heartbeatMinutes) => changeMuse({ heartbeatMinutes })} hint={t('settings.special.m.heartbeatHint')} />
            <Field label={t('settings.special.m.activeHours')}>{choice(t('settings.special.m.activeHours'), m.activeHours ? 'custom' : 'all', [{ id: 'all', label: t('settings.special.m.activeAllDay') }, { id: 'custom', label: t('settings.special.custom') }], (id) => changeMuse({ activeHours: id === 'custom' ? { start: 9, end: 22 } : null }))}
              {m.activeHours && <div className="special-hours"><NumberField label={t('specialUi.startHour')} value={m.activeHours.start} min={0} max={23} onChange={(start) => changeMuse({ activeHours: { ...m.activeHours!, start } })} /><NumberField label={t('specialUi.endHour')} value={m.activeHours.end} min={0} max={23} onChange={(end) => changeMuse({ activeHours: { ...m.activeHours!, end } })} /></div>}
            </Field></div>
          <BackgroundQuotaSection museModelId={m.modelId} modelLabel={(id) => models.find((item) => item.id === id)?.name || id} />
          <details className="special-disclosure"><summary>{t('settings.special.m.notify')}</summary><div className="special-field-grid"><Field label={t('settings.special.m.notifyMode')}>{choice(t('settings.special.m.notifyMode'), m.notify || 'immediate', [{ id: 'immediate', label: t('settings.special.m.notifyImmediate') }, { id: 'digest', label: t('settings.special.m.notifyDigest') }], (notify) => changeMuse({ notify: notify as MuseConfig['notify'] }))}</Field><Field label={t('settings.special.m.escalateTo')}>{choice(t('settings.special.m.escalateTo'), m.escalateTo || '', [{ id: '', label: t('settings.special.m.escalateNone') }, ...escalation], (escalateTo) => changeMuse({ escalateTo }))}</Field></div></details>
          <details className="special-disclosure"><summary>{t('settings.special.m.budget')}</summary><div className="special-field-grid">
            <NumberField label={t('settings.special.m.budgetWindow')} value={m.restartWindowHours} min={1} max={24} onChange={(restartWindowHours) => changeMuse({ restartWindowHours })} />
            <NumberField label={t('settings.special.m.maxCycles')} value={m.maxRestartsPerWindow} min={0} max={100} onChange={(maxRestartsPerWindow) => changeMuse({ maxRestartsPerWindow })} />
            <NumberField label={t('settings.special.m.maxTodos')} value={m.maxTodosPerWindow} min={0} max={100} onChange={(maxTodosPerWindow) => changeMuse({ maxTodosPerWindow })} />
            <NumberField label={t('settings.special.m.maxIter')} value={m.maxIterationsPerCycle} min={1} max={500} onChange={(maxIterationsPerCycle) => changeMuse({ maxIterationsPerCycle })} />
          </div></details><p className="special-footnote">{t('settings.special.m.persona')}</p>
        </>}
      </section>
    </fieldset>
    <footer className="special-save"><div role="status">{error ? <p className="special-error" role="alert">{error}</p> : notice ? <span><Check size={14} />{notice}</span> : <span>{t(dirty ? 'specialUi.draft' : 'specialUi.saveHint')}</span>}</div>{dirty && <><button type="button" className="btn" disabled={busy} onClick={() => { setConf(baseline); setPrompt(baseline.historian.prompt || promptDefault); setFolders(baseline.muse.allowedFolders.join('\n')); setError(''); setNotice('') }}>{t('specialUi.discard')}</button><button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}{t('specialUi.save')}</button></>}</footer>
  </div>
}
