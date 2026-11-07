/**
 * ④ 认识你的 Agents 团队(11-05 定稿):左边卜算子(主动式 Agent),右边团队里其余几位 + 电脑历史,两栏等高。
 * - 名字按界面语言只显示一个(agentName:中文界面「卜算子」,英文界面「Muse」)。
 * - 卜算子:开关、四条说明、用哪个模型(登录了缺省「跟随云端」= modelId 留空走服务器下发的后台模型;没登录必须自己选,不选它不醒)、
 *   三问:什么时候能找你 / 主动程度(非常 1h · 普通 2h · 一般 3h,界面不显示时间)/ 盯什么(+ 自己写一条,60 字)。
 * - 团队名单:内置与自建的普通 Agent 各一个开关(关 = 停用,侧栏 / @ / 选择器里收起,≠ 删除);默认 Agent 锁定为开;史官走后台开关。
 * - 电脑历史:新装机预先打开,带着开着的开关点「开始使用」才算数(跳过引导不开);老用户显示现在的值。卡片两行就是同意摘要,
 *   完整说明在「详情」里。点「开始使用」后 macOS 请用户给 tangu-computer-use 助手开辅助功能。
 * 这一屏的选择都在「开始使用」时一起写(commitRef),写失败留在这一屏报错。
 */
import React, { useEffect, useRef, useState } from 'react'
import { ChevronRight, Clock, Cpu, History, ListChecks, Lock, PenLine, Plus, ShieldCheck, Sparkles, X, Zap } from 'lucide-react'
import { useI18n } from '../../i18n'
import { agentName } from '../../agentName'
import { agentDescription } from '../builtinAgentDescriptions'
import { getAgentsMeta, getSpecialConfig, listAgents, listModels, museSettingTelemetry, saveAgentDef, saveMuseIntro, saveSpecialConfig } from '../../services/backendService'
import type { EngineTarget } from '../../services/engine/targets'
import type { ModelsResponse, NormalAgentDef, SpecialAgentsConfig } from '../../types'
import { SettingsSwitch } from '../SettingsPrimitives'
import { ComputerHistoryAbout } from '../ComputerHistoryAbout'
import { useComputerHistory } from '../useComputerHistory'
import { hasDesktopPermissions } from '../DesktopPermissions'
import { INTRO_FOCUS, INTRO_WHEN, PROACTIVITY, FOCUS_TEXT_MAX, type Proactivity } from '../onboardingFlow'
import { useApp } from '../../stores/appStore'
import '../computerHistoryMessages'
import { noteOnboarding } from './onboardingTelemetry'

const MUSE_FALLBACK = { name: 'Muse', nameZh: '卜算子', nameEn: 'Muse', slug: 'muse' }
type When = typeof INTRO_WHEN[number]
/** 读回现在的设置对应哪一档;对不上任何一档(自己设过别的间隔 / 时段)就一个都不选中 —— 没动它就不写,免得有损映射把原值盖掉。 */
const proactivityOf = (minutes?: number): Proactivity | null => (Object.entries({ high: 60, normal: 120, low: 180 }).find(([, m]) => m === (minutes ?? 120))?.[0] as Proactivity) ?? null
const whenOf = (h?: { start: number; end: number } | null): When | null => (!h ? 'anytime' : h.start === 9 && h.end === 21 ? 'daytime' : null)

export function TeamScreen({ resolveTarget, commitRef, signedIn, fresh, onAddAgent, onBusyChange }: {
  resolveTarget: () => Promise<EngineTarget>
  commitRef: React.MutableRefObject<(() => Promise<void>) | null>
  signedIn: boolean
  /** 新装机:电脑历史预先打开。老用户显示现在的值(分不出「从没开过」和「关过」之前一律不替他预开)。 */
  fresh: boolean
  onAddAgent: (queued: boolean) => void
  onBusyChange: (busy: boolean) => void
}): React.ReactNode {
  const { t, locale } = useI18n()
  const [config, setConfig] = useState<SpecialAgentsConfig | null>(null)
  const [loadError, setLoadError] = useState('')
  const [agents, setAgents] = useState<NormalAgentDef[]>([])
  const [defaultSlug, setDefaultSlug] = useState('xyra')
  const [models, setModels] = useState<ModelsResponse | null>(null)
  // 草稿
  const [museOn, setMuseOn] = useState(true)
  const [modelId, setModelId] = useState('')
  const [when, setWhen] = useState<When | null>('anytime')
  const [pro, setPro] = useState<Proactivity | null>('normal')
  const [focus, setFocus] = useState<string[]>([])
  const [focusText, setFocusText] = useState('')
  const [historianOn, setHistorianOn] = useState(true)
  const [agentOn, setAgentOn] = useState<Record<string, boolean>>({})
  const [addQueued, setAddQueued] = useState(false)
  const history = useComputerHistory()
  const chState = history.view?.state
  const chShown = !!history.api && !history.unsupported
  const [chDraft, setChDraft] = useState<boolean | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const avatars = useApp((s) => s.agentAvatars)
  /** 盘上现在是什么:读到时记下,每写成一笔就跟着更新。只发和它不一样的(仓规「默认值不覆盖用户设过的值」);
   *  部分写失败后重试时也按它算,用户中途改回原值的那一项照样写得回去(Codex 评审 P2)。 */
  const base = useRef<{ museEnabled: boolean; modelId: string; historian: boolean; when: When | null; pro: Proactivity | null
    disabled: Record<string, boolean>; introDone: boolean; introMemo: string } | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const target = await resolveTarget()
        const [cfg, list, meta, mdl] = await Promise.all([getSpecialConfig(target), listAgents(target), getAgentsMeta(target), listModels(target).catch(() => null)])
        if (!live) return
        // 远程来源只回摘要(这一屏只在本机完整引导里有,走到这里算读不全);桩 / 老引擎回不全也一样:读失败 ≠ 缺省,不写
        if (cfg.remote || !cfg.config?.muse || !cfg.config?.historian) throw new Error('special config incomplete')
        const c = cfg.config
        setConfig(c); setMuseOn(c.muse.enabled !== false); setModelId(c.muse.modelId || ''); setHistorianOn(c.historian.enabled !== false)
        const w = whenOf(c.muse.activeHours), p = proactivityOf(c.muse.heartbeatMinutes)
        setWhen(w); setPro(p)
        base.current = { museEnabled: c.muse.enabled !== false, modelId: c.muse.modelId || '', historian: c.historian.enabled !== false, when: w, pro: p,
          disabled: Object.fromEntries(list.map((a) => [a.slug, !!a.disabled])), introDone: false, introMemo: JSON.stringify({ focus: [], text: '' }) }
        setAgents(list); setDefaultSlug(meta.defaultSlug || 'xyra'); setModels(mdl)
        setAgentOn(Object.fromEntries(list.map((a) => [a.slug, !a.disabled])))
      } catch (e) { if (live) setLoadError(String((e as Error)?.message || e)) }
    })()
    return () => { live = false }
  }, [resolveTarget])
  // 电脑历史的草稿:读到状态那一刻定一次。开着的显示开;新装机、而且看得出从没动过 → 预先打开;其余显示关。
  // 「从没动过」= 没有关过的记号(userTurnedOff,随电脑历史加密那件加)且 dataGen 为 0(关闭 / 清除 / 改排除表都会让它 +1,跨重启持久)。
  // 引导完成记号证明不了这件事:登录过的老用户从没见过引导,也可能在设置里关过它(Codex 评审 P1)。
  useEffect(() => {
    if (!chState || chDraft !== null) return
    const turnedOff = (chState as { userTurnedOff?: boolean }).userTurnedOff === true
    const untouched = !turnedOff && !((chState.dataGen ?? 0) > 0)
    setChDraft(chState.enabled || (fresh && untouched))
  }, [chState, chDraft, fresh])
  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (aboutOpen && !d.open) d.showModal()
    else if (!aboutOpen && d.open) d.close()
  }, [aboutOpen])

  const muse = agents.find((a) => a.slug === 'muse') || MUSE_FALLBACK
  const museName = agentName(muse, locale)
  const roster = agents.filter((a) => a.slug !== 'muse' && a.createdBy !== 'system')
  const llms = (models?.models || []).filter((m) => !m.modelType || m.modelType === 'llm')
  const locked = (slug: string): boolean => slug === defaultSlug || slug === 'xyra'

  const state = useRef({ museOn, modelId, when, pro, focus, focusText, historianOn, agentOn, agents, chDraft })
  state.current = { museOn, modelId, when, pro, focus, focusText, historianOn, agentOn, agents, chDraft }
  const historyRef = useRef(history)
  historyRef.current = history
  useEffect(() => {
    commitRef.current = async () => {
      const s = state.current, b = base.current
      if (!b) return // 没读到现状就不写:读失败 ≠ 缺省
      noteOnboarding({ museOn: s.museOn, ...(s.chDraft !== null ? { computerHistoryOn: s.chDraft } : {}) }) // 匿名遥测:这一屏的两个开关
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
        const hist = s.historianOn !== b.historian
        if (Object.keys(musePatch).length || hist) {
          await tryIt(() => saveSpecialConfig(target, { ...(Object.keys(musePatch).length ? { muse: musePatch } : {}), ...(hist ? { historian: { enabled: s.historianOn } } : {}) }),
            () => { if ('enabled' in musePatch) museSettingTelemetry({ enabled: s.museOn }); b.museEnabled = s.museOn; b.modelId = s.modelId; b.historian = s.historianOn })
        }
        // 只带改过的;一个都没改也发一次(空的):记下「第一次见面已经答过」,私聊里不再弹那张卡,别的什么都不动。
        // 关注那两项写的是记忆:写成过一次的同一份不再重发(重试不重复记)。
        if (s.museOn) {
          const text = s.focusText.trim()
          const memo = JSON.stringify({ focus: s.focus, text })
          const newMemo = memo !== b.introMemo
          const body = {
            ...(s.when && s.when !== b.when ? { when: s.when } : {}),
            ...(s.pro && s.pro !== b.pro ? { proactivity: s.pro } : {}),
            ...(newMemo && s.focus.length ? { focus: s.focus } : {}),
            ...(newMemo && text ? { focusText: text } : {}),
          }
          if (!b.introDone || Object.keys(body).length) {
            await tryIt(() => saveMuseIntro(target, body), () => {
              if (s.when) b.when = s.when
              if (s.pro) b.pro = s.pro
              b.introMemo = memo; b.introDone = true
            })
          }
        }
        for (const a of s.agents) {
          const on = s.agentOn[a.slug]
          if (on === undefined || on === !b.disabled[a.slug]) continue
          await tryIt(() => saveAgentDef(target, { disabled: !on }, a.slug), () => { b.disabled[a.slug] = !on })
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
  const needModel = !signedIn
  const fact = (Icon: typeof Clock, title: string, hint: string): React.ReactNode => <div className="ob3-fact"><Icon size={15} aria-hidden="true" /><div><b>{t(title)}</b><span>{t(hint)}</span></div></div>
  const pills = <T extends string>(label: string, values: readonly T[], keyOf: (v: T) => string, on: (v: T) => boolean, pick: (v: T) => void, extra?: React.ReactNode): React.ReactNode =>
    <div className="ob3-q"><span>{label}</span><div className="ob3-actions" role="group" aria-label={label}>
      {values.map((v) => <button key={v} type="button" className="ob3-pill" aria-pressed={on(v)} disabled={!museOn} onClick={() => pick(v)}>{t(keyOf(v))}</button>)}{extra}</div></div>

  return <div className="ob3-col team">
    <div className="ob3-head"><h1 tabIndex={-1} data-ob-title="">{t('ob3.team.title')}</h1><p>{t('ob3.team.desc', { muse: museName })}</p></div>
    <div className="ob3-team">
      <section className="ob3-card ob3-muse" data-ob-muse="">
        <div className="ob3-muse-h"><span className="ob3-ava"><Sparkles size={18} aria-hidden="true" /></span>
          <div><strong>{museName} · {t('ob3.muse.kind')}</strong><small>{t('ob3.muse.lead')}</small></div>
          <SettingsSwitch checked={museOn} disabled={!config} onChange={setMuseOn} label={museName} /></div>
        <div className="ob3-facts">
          {fact(Clock, 'ob3.muse.wake', 'ob3.muse.wakeHint')}{fact(ListChecks, 'ob3.muse.tidy', 'ob3.muse.tidyHint')}
          {fact(ShieldCheck, 'ob3.muse.ask', 'ob3.muse.askHint')}{signedIn ? fact(Zap, 'ob3.muse.quota', 'ob3.muse.quotaHint') : fact(Zap, 'ob3.muse.ownModel', 'ob3.muse.ownModelHint')}
        </div>
        <div className={`ob3-model${needModel && !modelId ? ' need' : ''}`} data-ob-muse-model="">
          <Cpu size={16} aria-hidden="true" />
          <div><strong>{t('ob3.muse.model', { muse: museName })}</strong><small>{t(signedIn ? 'ob3.muse.modelCloud' : llms.length ? 'ob3.muse.modelNeed' : 'ob3.muse.modelNone')}</small></div>
          <select value={modelId} disabled={!museOn || !config} aria-label={t('ob3.muse.model', { muse: museName })} onChange={(e) => setModelId(e.target.value)}>
            {signedIn ? <option value="">{t('ob3.muse.modelCloudOption')}</option> : <option value="" disabled>{t('ob3.muse.modelPick')}</option>}
            {llms.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
          </select>
        </div>
        <div className="ob3-sep" />
        {pills(t('ob3.q.when'), INTRO_WHEN, (v) => `ob3.when.${v}`, (v) => v === when, setWhen)}
        {pills(t('ob3.q.proactivity'), PROACTIVITY, (v) => `ob3.pro.${v}`, (v) => v === pro, setPro)}
        {pills(t('ob3.q.focus'), INTRO_FOCUS, (v) => `ob3.focus.${v}`, (v) => focus.includes(v), (v) => setFocus((f) => (f.includes(v) ? f.filter((x) => x !== v) : [...f, v])),
          <label className="ob3-own"><PenLine size={12} aria-hidden="true" /><input value={focusText} maxLength={FOCUS_TEXT_MAX} disabled={!museOn} placeholder={t('ob3.q.focusOwn')} aria-label={t('ob3.q.focusOwn')} onChange={(e) => setFocusText(e.target.value)} /></label>)}
      </section>
      <div className="r">
        <section className="ob3-card ob3-roster" data-ob-roster="">
          <h3><span>{t('ob3.roster.title')}</span><span>{t('ob3.roster.hint')}</span></h3>
          {roster.map((a) => {
            const name = agentName(a, locale)
            const lock = locked(a.slug)
            return <div key={a.slug} className="ob3-mem" data-agent={a.slug}>
              <span className="ob3-av">{avatars[a.slug] ? <img src={avatars[a.slug]} alt="" width={28} height={28} /> : name.slice(0, 1).toUpperCase()}</span>
              <div><strong>{name}{a.slug === defaultSlug && <em className="ob3-tag">{t('ob3.roster.default')}</em>}</strong><small>{agentDescription(a, t) || a.slug}</small></div>
              {lock && <span className="lk"><Lock size={11} aria-hidden="true" />{t('ob3.roster.locked')}</span>}
              <SettingsSwitch checked={lock || agentOn[a.slug] !== false} disabled={lock} label={name} onChange={(on) => setAgentOn((m) => ({ ...m, [a.slug]: on }))} />
            </div>
          })}
          <div className="ob3-mem" data-agent="historian">
            <span className="ob3-av">{t('ob3.historian.name').slice(0, 1)}</span>
            <div><strong>{t('ob3.historian.name')}<em className="ob3-tag">{t('ob3.roster.background')}</em></strong><small>{t('ob3.historian.desc')}</small></div>
            <SettingsSwitch checked={historianOn} disabled={!config} label={t('ob3.historian.name')} onChange={setHistorianOn} />
          </div>
          <button type="button" className="ob3-add" aria-pressed={addQueued} onClick={() => { const next = !addQueued; setAddQueued(next); onAddAgent(next) }}>
            <span className="ob3-av"><Plus size={14} aria-hidden="true" /></span><strong style={{ fontWeight: 500 }}>{t('ob3.roster.add')}</strong><small>{t(addQueued ? 'ob3.roster.addQueued' : 'ob3.roster.addHint')}</small>
          </button>
        </section>
        {chShown && <section className="ob3-card ob3-ch" data-ob-history="" data-ch-draft={chDraft ? 'on' : 'off'}>
          <div className="ob3-muse-h"><span className="ob3-ava plain"><History size={18} aria-hidden="true" /></span>
            <div><strong>{t('ob3.ch.title')}</strong><small>{t(fresh ? 'ob3.ch.lead' : 'ob3.ch.leadOff', { muse: museName })}
              <button type="button" className="ob3-link" style={{ marginLeft: 4 }} onClick={() => setAboutOpen(true)}>{t('ob3.ch.details')}<ChevronRight size={12} aria-hidden="true" /></button></small></div>
            <SettingsSwitch checked={!!chDraft} disabled={!history.view || chDraft === null} label={t('ob3.ch.title')} onChange={setChDraft} /></div>
          <dl><div><dt>{t('computerHistory.about.recordedLabel')}</dt><dd>{t('ob3.ch.recordedShort')}</dd></div>
            <div><dt>{t('computerHistory.about.neverLabel')}</dt><dd>{t('computerHistory.about.never')}</dd></div></dl>
          {chDraft && !chState?.enabled && chState?.platform === 'darwin' && <div className="ob3-status"><i className="warn" /><span>{t('ob3.ch.permNext')}</span></div>}
          {history.view && <dialog ref={dialogRef} className="ob-history-dialog" aria-label={t('computerHistory.about.title')} onCancel={() => setAboutOpen(false)}
            onClick={(e) => { if (e.target === e.currentTarget) setAboutOpen(false) }}>
            <div className="ob-changelog-head"><h2>{t('computerHistory.about.title')}</h2>
              <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={() => setAboutOpen(false)}><X size={18} /></button></div>
            <div className="ob-history-dialog-body"><p className="ob-history-consent">{t('computerHistory.enableConfirm.body', { days: history.view.keepDays })}</p><ComputerHistoryAbout view={history.view} /></div>
          </dialog>}
        </section>}
      </div>
    </div>
  </div>
}
