/**
 * ④ 认识你的 Agents 团队(11-06 第四轮 A4,方案 docs/ToBeImproved/首启引导第四轮方案_2026-11-06/):
 * 两张等宽的卡,左卜算子、右电脑历史;团队名单收成底下一行,只介绍。
 * - 名字按界面语言只显示一个(agentName:中文界面「卜算子」,英文界面「Muse」)。
 * - 卜算子:开关、一句话说清它做什么、用哪个模型、两问(什么时候能找你 / 最想盯什么 + 自己写一条,60 字)。
 *   主动程度不问(按缺省「普通」,不发 proactivity),卡底写一句去哪改。
 *   模型行只改显示、不替用户写 modelId:不选时显示引擎实际会用的那个(本机后台任务那一格 → 云端后台模型 → 默认模型,要在可用列表里),
 *   一个都没有才黄底「选择模型 / 先不醒」;登录了缺省「跟随云端」走独立额度,改选 Forsion 的模型算主额度、直连的算接的那家。
 * - 团队名单:头像字 + 名字,默认 / 后台 / 已停用的标签,没有开关(停用开关在 Agents 页)。「在 Agents 里管理」引导结束后去 Agents。
 * - 电脑历史:新装机预先打开,带着开着的开关点「开始使用」才算数(跳过引导不开,主页之后再问一次);老用户显示现在的值。
 *   「开了之后,比如」三行是固定的示意文案,不读真记录。完整说明在「详情」里。点「开始使用」后 macOS 请用户给助手开辅助功能。
 * 这一屏的选择都在「开始使用」时一起写(commitRef),只发和读到的不一样的;写失败留在这一屏报错。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Cpu, Globe, History, Monitor, PenLine, Sparkles } from 'lucide-react'
import { useI18n } from '../../i18n'
import { agentName } from '../../agentName'
import { agentDescription } from '../builtinAgentDescriptions'
import { getAgentsMeta, getSpecialConfig, listAgents, listModels, saveMuseIntro, saveSpecialConfig } from '../../services/backendService'
import type { EngineTarget } from '../../services/engine/targets'
import type { ModelsResponse, NormalAgentDef, SpecialAgentsConfig } from '../../types'
import { SettingsSwitch } from '../SettingsPrimitives'
import { ComputerHistoryDialog } from '../ComputerHistoryDialog'
import { useComputerHistory } from '../useComputerHistory'
import { historyUntouched } from '../computerHistoryAskMark'
import { hasDesktopPermissions } from '../DesktopPermissions'
import { INTRO_FOCUS, INTRO_WHEN, FOCUS_TEXT_MAX } from '../onboardingFlow'
import { useApp } from '../../stores/appStore'
import '../computerHistoryMessages'

const MUSE_FALLBACK = { name: 'Muse', nameZh: '卜算子', nameEn: 'Muse', slug: 'muse' }
type When = typeof INTRO_WHEN[number]
/** 读回现在的设置对应哪一档;对不上(自己设过别的时段)就一个都不选中 —— 没动它就不写,免得有损映射把原值盖掉。 */
const whenOf = (h?: { start: number; end: number } | null): When | null => (!h ? 'anytime' : h.start === 9 && h.end === 21 ? 'daytime' : null)

export function TeamScreen({ resolveTarget, commitRef, signedIn, fresh, onOpenAgents, onBusyChange }: {
  resolveTarget: () => Promise<EngineTarget>
  commitRef: React.MutableRefObject<(() => Promise<void>) | null>
  signedIn: boolean
  /** 新装机:电脑历史预先打开。老用户显示现在的值(分不出「从没开过」和「关过」之前一律不替他预开)。 */
  fresh: boolean
  /** 「在 Agents 里管理」:引导盖在最上面,点了只记下,引导关掉之后再去。 */
  onOpenAgents: (queued: boolean) => void
  onBusyChange: (busy: boolean) => void
}): React.ReactNode {
  const { t, locale } = useI18n()
  const [config, setConfig] = useState<SpecialAgentsConfig | null>(null)
  const [loadError, setLoadError] = useState('')
  const [agents, setAgents] = useState<NormalAgentDef[]>([])
  const [defaultSlug, setDefaultSlug] = useState('xyra')
  const [models, setModels] = useState<ModelsResponse | null>(null)
  /** 本机「设置 › 模型 › 后台任务」那一格(config.json models.background):引擎先认它,再认云端(resolveBackgroundModelId)。 */
  const [localBg, setLocalBg] = useState('')
  // 草稿
  const [museOn, setMuseOn] = useState(true)
  const [modelId, setModelId] = useState('')
  const [when, setWhen] = useState<When | null>('anytime')
  const [focus, setFocus] = useState<string[]>([])
  const [focusText, setFocusText] = useState('')
  const [agentsQueued, setAgentsQueued] = useState(false)
  const history = useComputerHistory()
  const chState = history.view?.state
  const chShown = !!history.api && !history.unsupported
  const [chDraft, setChDraft] = useState<boolean | null>(null)
  /** 草稿是替他预先打开的(新装机、从没动过):卡上才说「默认开启」。动过的新装机也是关着的,不能这么说。 */
  const [chPreOn, setChPreOn] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const avatars = useApp((s) => s.agentAvatars)
  /** 盘上现在是什么:读到时记下,每写成一笔就跟着更新。只发和它不一样的(仓规「默认值不覆盖用户设过的值」);
   *  部分写失败后重试时也按它算,用户中途改回原值的那一项照样写得回去(Codex 评审 P2)。 */
  const base = useRef<{ museEnabled: boolean; modelId: string; when: When | null; introDone: boolean; introMemo: string } | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const target = await resolveTarget()
        const [cfg, list, meta, mdl, host] = await Promise.all([getSpecialConfig(target), listAgents(target), getAgentsMeta(target), listModels(target).catch(() => null),
          window.tangu?.getConfig?.().catch(() => null)])
        if (!live) return
        // 远程来源只回摘要(这一屏只在本机完整引导里有,走到这里算读不全);桩 / 老引擎回不全也一样:读失败 ≠ 缺省,不写
        if (cfg.remote || !cfg.config?.muse) throw new Error('special config incomplete')
        const c = cfg.config
        setConfig(c); setMuseOn(c.muse.enabled !== false); setModelId(c.muse.modelId || '')
        const w = whenOf(c.muse.activeHours)
        setWhen(w)
        base.current = { museEnabled: c.muse.enabled !== false, modelId: c.muse.modelId || '', when: w, introDone: false, introMemo: JSON.stringify({ focus: [], text: '' }) }
        setAgents(list); setDefaultSlug(meta.defaultSlug || 'xyra'); setModels(mdl); setLocalBg(String((host as { backgroundModelId?: string } | null)?.backgroundModelId || ''))
      } catch (e) { if (live) setLoadError(String((e as Error)?.message || e)) }
    })()
    return () => { live = false }
  }, [resolveTarget])
  // 电脑历史的草稿:读到状态那一刻定一次。开着的显示开;新装机、而且看得出从没动过 → 预先打开;其余显示关。
  // 引导完成记号证明不了「从没动过」:登录过的老用户从没见过引导,也可能在设置里关过它(Codex 评审 P1)。
  useEffect(() => {
    if (!chState || chDraft !== null) return
    const preOn = !chState.enabled && fresh && historyUntouched(chState)
    setChPreOn(preOn)
    setChDraft(chState.enabled || preOn)
  }, [chState, chDraft, fresh])

  const muse = agents.find((a) => a.slug === 'muse') || MUSE_FALLBACK
  const museName = agentName(muse, locale)
  const roster = agents.filter((a) => a.slug !== 'muse' && a.createdBy !== 'system')
  const llms = (models?.models || []).filter((m) => !m.modelType || m.modelType === 'llm')
  const modelOf = (id: string) => llms.find((m) => m.id === id)

  const state = useRef({ museOn, modelId, when, focus, focusText, chDraft })
  state.current = { museOn, modelId, when, focus, focusText, chDraft }
  const historyRef = useRef(history)
  historyRef.current = history
  useEffect(() => {
    commitRef.current = async () => {
      const s = state.current, b = base.current
      if (!b) return // 没读到现状就不写:读失败 ≠ 缺省
      onBusyChange(true)
      const errors: string[] = []
      const tryIt = async (fn: () => Promise<unknown>, onOk: () => void): Promise<void> => {
        try { await fn(); onOk() } catch (e) { errors.push(String((e as Error)?.message || e)) }
      }
      try {
        const target = await resolveTarget()
        const musePatch: Record<string, unknown> = {}
        if (s.museOn !== b.museEnabled) musePatch.enabled = s.museOn
        if (s.modelId !== b.modelId) musePatch.modelId = s.modelId
        if (Object.keys(musePatch).length) {
          await tryIt(() => saveSpecialConfig(target, { muse: musePatch }), () => { b.museEnabled = s.museOn; b.modelId = s.modelId })
        }
        // 只带改过的;一个都没改也发一次(空的):记下「第一次见面已经答过」,私聊里不再弹那张卡,别的什么都不动。
        // 关注那两项写的是记忆:写成过一次的同一份不再重发(重试不重复记)。主动程度不问,不发。
        if (s.museOn) {
          const text = s.focusText.trim()
          const memo = JSON.stringify({ focus: s.focus, text })
          const newMemo = memo !== b.introMemo
          const body = {
            ...(s.when && s.when !== b.when ? { when: s.when } : {}),
            ...(newMemo && s.focus.length ? { focus: s.focus } : {}),
            ...(newMemo && text ? { focusText: text } : {}),
          }
          if (!b.introDone || Object.keys(body).length) {
            await tryIt(() => saveMuseIntro(target, body), () => {
              if (s.when) b.when = s.when
              b.introMemo = memo; b.introDone = true
            })
          }
        }
        const h = historyRef.current
        if (h.api && h.view && s.chDraft !== null && s.chDraft !== h.view.state.enabled) {
          const ok = await h.act('enable', (api) => api.setEnabled(s.chDraft!))
          if (!ok) errors.push('computer history')
          // 开了、在 macOS:请用户给助手开辅助功能(同设置页「去授权」那一下)
          else if (s.chDraft && h.view.state.platform === 'darwin' && hasDesktopPermissions()) {
            void window.tangu?.desktopPermissionRequest?.('computerAccessibility', { locale, mode: document.documentElement.classList.contains('dark') ? 'dark' : 'light' } as never).catch(() => {})
          }
        }
        if (errors.length) throw new Error(errors.join(' · '))
        void useApp.getState().refreshAgents?.()
      } finally { onBusyChange(false) }
    }
    return () => { commitRef.current = null }
  }, [commitRef, resolveTarget, onBusyChange, locale])

  if (loadError) return <div className="ob3-col narrow"><div className="ob3-head"><h1 tabIndex={-1} data-ob-title="">{t('ob3.team.title')}</h1></div>
    <div className="ob3-error" role="alert">{t('ob3.muse.loadFailed', { muse: museName, error: loadError })}</div></div>

  // 模型行:不选 = 引擎按「本机后台任务那一格 → 云端后台模型 → 默认模型」往下找(resolveBackgroundModelId),只认这台现在真能用的。
  // 本机那一格设过就先用它(登录了也是,这时不走独立额度);没设过、登录了 = 跟随云端;没登录 = 云端后台 / 默认模型。
  const localPick = localBg && modelOf(localBg) ? localBg : ''
  const fallback = localPick || (signedIn ? '' : [models?.backgroundModelId, models?.defaultModelId].find((id): id is string => !!id && !!modelOf(id)) || '')
  const needModel = !signedIn && !modelId && !fallback
  const picked = modelId ? modelOf(modelId) : undefined
  const mainQuota = (m?: { source?: string }): boolean => signedIn && m?.source === 'forsion'
  const modelHint = needModel ? (llms.length ? 'ob3.muse.modelNeed' : 'ob3.muse.modelNone')
    : !modelId ? (localPick ? (mainQuota(modelOf(localPick)) ? 'ob3.muse.modelLocalMain' : 'ob3.muse.modelLocal') : signedIn ? 'ob3.muse.modelCloud' : 'ob3.muse.modelDefault')
    : mainQuota(picked) ? 'ob3.muse.modelMain' : 'ob3.muse.modelBilled'
  const pills = <T extends string>(label: string, values: readonly T[], keyOf: (v: T) => string, on: (v: T) => boolean, pick: (v: T) => void, extra?: React.ReactNode): React.ReactNode =>
    <div className="ob3-q"><span>{label}</span><div className="ob3-actions" role="group" aria-label={label}>
      {values.map((v) => <button key={v} type="button" className="ob3-pill" aria-pressed={on(v)} disabled={!museOn} onClick={() => pick(v)}>{t(keyOf(v))}</button>)}{extra}</div></div>
  const initial = (name: string): string => Array.from(name)[0]?.toUpperCase() || '?'

  return <div className="ob3-col team">
    <div className="ob3-head"><h1 tabIndex={-1} data-ob-title="">{t('ob3.team.title')}</h1><p>{t('ob3.team.desc', { muse: museName })}</p></div>
    <div className={`ob3-team${chShown ? '' : ' solo'}`}>
      <section className="ob3-card ob3-muse" data-ob-muse="">
        <div className="ob3-muse-h"><span className="ob3-ava"><Sparkles size={18} aria-hidden="true" /></span>
          <div><strong>{museName} · {t('ob3.muse.kind')}</strong><small>{t('ob3.muse.lead')}</small></div>
          <SettingsSwitch checked={museOn} disabled={!config} onChange={setMuseOn} label={museName} /></div>
        <div className={`ob3-model${needModel ? ' need' : ''}`} data-ob-muse-model="">
          <Cpu size={16} aria-hidden="true" />
          <div><strong>{t('ob3.muse.model', { muse: museName })}</strong><small>{t(modelHint)}</small></div>
          <select value={modelId} disabled={!museOn || !config} aria-label={t('ob3.muse.model', { muse: museName })} onChange={(e) => setModelId(e.target.value)}>
            {localPick ? <option value="">{t('ob3.muse.modelLocalOption', { model: modelOf(localPick)?.name || localPick })}</option>
              : signedIn ? <option value="">{t('ob3.muse.modelCloudOption')}</option>
              : fallback ? <option value="">{t('ob3.muse.modelDefaultOption', { model: modelOf(fallback)?.name || fallback })}</option>
              : <option value="" disabled>{t('ob3.muse.modelPick')}</option>}
            {modelId && !picked && <option value={modelId}>{modelId}</option>}
            {llms.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
          </select>
        </div>
        <div className="ob3-sep" />
        {pills(t('ob3.q.when'), INTRO_WHEN, (v) => `ob3.when.${v}`, (v) => v === when, setWhen)}
        {pills(t('ob3.q.focus'), INTRO_FOCUS, (v) => `ob3.focus.${v}`, (v) => focus.includes(v), (v) => setFocus((f) => (f.includes(v) ? f.filter((x) => x !== v) : [...f, v])),
          <label className="ob3-own"><PenLine size={12} aria-hidden="true" /><input value={focusText} maxLength={FOCUS_TEXT_MAX} disabled={!museOn} placeholder={t('ob3.q.focusOwn')} aria-label={t('ob3.q.focusOwn')} onChange={(e) => setFocusText(e.target.value)} /></label>)}
        <span className="ob3-note ob3-muse-foot">{t('ob3.muse.proNote')}</span>
      </section>
      {chShown && <section className="ob3-card ob3-ch" data-ob-history="" data-ch-draft={chDraft ? 'on' : 'off'}>
        <div className="ob3-muse-h"><span className="ob3-ava plain"><History size={18} aria-hidden="true" /></span>
          <div><strong>{t('ob3.ch.title')}</strong><small>{t(chPreOn ? 'ob3.ch.lead' : 'ob3.ch.leadOff', { muse: museName })}
            <button type="button" className="ob3-link" style={{ marginLeft: 4 }} onClick={() => setAboutOpen(true)}>{t('ob3.ch.details')}<ChevronRight size={12} aria-hidden="true" /></button></small></div>
          <SettingsSwitch checked={!!chDraft} disabled={!history.view || chDraft === null} label={t('ob3.ch.title')} onChange={setChDraft} /></div>
        <div className="ob3-eg" data-ob-ch-example="">
          <span className="ob3-eg-k">{t('ob3.ch.egTitle')}</span>
          <div className="ob3-eg-r"><Monitor size={13} aria-hidden="true" /><time>15:10</time><span>{t('ob3.ch.eg1')}</span></div>
          <div className="ob3-eg-r"><Globe size={13} aria-hidden="true" /><time>15:42</time><span>{t('ob3.ch.eg2')}</span></div>
          <div className="ob3-eg-r muse"><Sparkles size={13} aria-hidden="true" /><time>21:00</time><span>{t('ob3.ch.eg3', { muse: museName })}</span></div>
        </div>
        <dl><div><dt>{t('computerHistory.about.recordedLabel')}</dt><dd>{t('ob3.ch.recordedShort')}</dd></div>
          <div><dt>{t('computerHistory.about.neverLabel')}</dt><dd>{t('computerHistory.about.never')}</dd></div></dl>
        {chDraft && !chState?.enabled && chState?.platform === 'darwin' && <div className="ob3-status"><i className="warn" /><span>{t('ob3.ch.permNext')}</span></div>}
        <ComputerHistoryDialog history={history} consent={false} open={aboutOpen} onClose={() => setAboutOpen(false)} />
      </section>}
    </div>
    <section className="ob3-card ob3-strip" data-ob-roster="">
      <span className="ob3-strip-k">{t('ob3.roster.title')}</span>
      {roster.map((a) => {
        const name = agentName(a, locale)
        return <span key={a.slug} className="ob3-member" data-agent={a.slug} title={agentDescription(a, t) || undefined}>
          <span className="ob3-av">{avatars[a.slug] ? <img src={avatars[a.slug]} alt="" width={24} height={24} /> : initial(name)}</span>{name}
          {a.slug === defaultSlug && <em className="ob3-tag">{t('ob3.roster.default')}</em>}
          {a.disabled && <em className="ob3-tag">{t('ob3.roster.off')}</em>}
        </span>
      })}
      <span className="ob3-member" data-agent="historian" title={t('ob3.historian.desc')}>
        <span className="ob3-av">{initial(t('ob3.historian.name'))}</span>{t('ob3.historian.name')}<em className="ob3-tag">{t('ob3.roster.background')}</em>
        {config?.historian?.enabled === false && <em className="ob3-tag">{t('ob3.roster.off')}</em>}
      </span>
      <button type="button" className="ob3-link ob3-manage" data-ob-manage="" aria-pressed={agentsQueued}
        onClick={() => { const next = !agentsQueued; setAgentsQueued(next); onOpenAgents(next) }}>
        {t(agentsQueued ? 'ob3.roster.manageQueued' : 'ob3.roster.manage')}{agentsQueued ? <Check size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
      </button>
    </section>
  </div>
}
