/**
 * 首启引导向导:① 连接(Forsion 账号登录 / 自定义 provider)→ ② 默认模型 → ③ 环境检测(缺失项
 * 给平台安装命令,用户确认后内置日志面板执行——绝不静默自动装)→ ④ 完成(指路导入/设置)。
 * 触发条件见 App.tsx(managed 从未配置:无 cloudUrl/token/provider);「跳过」永久记 localStorage。
 */
import React, { useEffect, useState } from 'react'
import {
  ArrowRight, ArrowLeft, Bot, Check, Cloud, History, KeyRound, Loader2, LogIn, ExternalLink,
  MonitorCog, Plus, SkipForward, Sparkles, Palette, FolderOpen, Sun, Moon, X, FileText, RefreshCw,
} from 'lucide-react'
import { listModels, testProviderConnection, listAgents, saveAgentDef, getSpecialConfig, saveSpecialConfig } from '../services/backendService'
import { EnvProbeSection } from './EnvProbeSection'
import type { MirrorTestResult, ModelsResponse, NormalAgentDef, SpecialAgentsConfig, TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'
import { PRODUCT, PRODUCT_DISPLAY_NAME } from '../product'
import { listLanguages, listSkins, skinSwatch, forcedSchemeForLanguage } from '../theme/registry'
import { ThemeCard } from './ThemeCard'
import { ThemePreview } from './ThemePreview'
import { BrandLogo } from './BrandLogo'
import { LocaleToggle } from './LocaleToggle'
import { AsrModelChoice } from './AsrModelChoice'
import { listFonts } from '../fontPresets'
import { AuxModelChoice } from './AuxModelChoice'
import { Markdown } from './Markdown'
import { CHANGELOG } from '../changelog'
import { track } from '../achievements/store'
import { applyUiFonts, readFont, writeFont } from '../uiFont'

/** 系统语言/时区疑似中国大陆 → 引导/设置里推荐开镜像(仅推荐,不代选)。 */
export const likelyMainlandChina = (): boolean => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    return navigator.language.toLowerCase() === 'zh-cn' || /^Asia\/(Shanghai|Chongqing|Harbin|Urumqi)$/.test(tz)
  } catch {
    return false
  }
}

export const ONBOARDING_DISMISS_KEY = 'forsion_tangu_onboarding_done'
/** 上次完成引导时的应用版本号;与当前版本不同 → 版本更新后再进一次引导(展示 What's New)。 */
export const ONBOARDING_VERSION_KEY = 'forsion_tangu_onboarding_version'

type Step = 'welcome' | 'connect' | 'theme' | 'model' | 'speech' | 'agents' | 'workspace' | 'env' | 'done'
const STEP_ORDER: Step[] = PRODUCT.agentBackend
  ? ['welcome', 'connect', 'theme', 'model', 'speech', 'agents', 'workspace', 'env', 'done']
  : ['welcome', 'theme', 'done'] // 无 agent 后端的单品变体:只留通用步(connect/model/agents/workspace/env 均属 agent)

/** 订阅 provider 的友好名(id 见 src/llm/providerOAuth.ts OAUTH_PROVIDERS);未知 id 回退原值。 */
// Claude 不在此列:订阅登录已删,走「运行引擎」直接跑本机 Claude Code(见 tangu-agent/src/engines/)。
export const SUB_PROVIDER_LABELS: Record<string, string> = { codex: 'Codex', xai: 'xAI · Grok' }

export const OnboardingWizard: React.FC<{
  /** 当前主题/明暗(与 App 同步;主题步骤即时应用 + 持久化)。 */
  themeLang: string
  themeSkin: string
  themeMode: 'light' | 'dark'
  /** 用户明暗偏好(可 system);换语言/配色时透传它,不能传落地 mode 否则会把 system 抹成明/暗(codex High-2)。 */
  themeModePref: 'light' | 'dark' | 'system'
  themeSeed: string
  onThemeChange: (lang: string, skin: string, pref: 'light' | 'dark' | 'system') => void
  onSeedChange: (hex: string) => void
  /** 向导内动作改变了主配置(登录成功/保存 provider)→ App 重连。 */
  onReconnect: () => void
  onFinish: () => void
}> = ({ themeLang, themeSkin, themeMode, themeModePref, themeSeed, onThemeChange, onSeedChange, onReconnect, onFinish }) => {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>('welcome')
  const stepIdx = STEP_ORDER.indexOf(step)

  // 界面字体(存的是预设 id;与设置→外观同一份 localStorage,写完立刻注入生效)
  const [uiFont, setUiFont] = useState(() => readFont('ui'))

  // ── ⓪ 欢迎(开机式动画 + What's New 抽屉)──
  const [appVer, setAppVer] = useState('')
  const [showChangelog, setShowChangelog] = useState(false)
  useEffect(() => { void window.tangu?.appVersion?.().then((v) => setAppVer(v || '')).catch(() => {}) }, [])

  // ── ① 连接 ──
  const [connectMode, setConnectMode] = useState<'forsion' | 'sub' | 'byok'>('forsion')
  const [cloudUrl, setCloudUrl] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)
  const [loggedIn, setLoggedIn] = useState(false)
  const [syncEnabled, setSyncEnabled] = useState(false) // 登录后:是否开启云同步(记忆 + 云端 agents 双向同步)
  const [device, setDevice] = useState<{ url: string; userCode: string } | null>(null)
  const [connectMsg, setConnectMsg] = useState('')
  // byok 表单
  const [pid, setPid] = useState('')
  const [purl, setPurl] = useState('')
  const [pkey, setPkey] = useState('')
  const [pmodels, setPmodels] = useState('')
  const [byokSaved, setByokSaved] = useState(false)
  const [byokTesting, setByokTesting] = useState(false)
  // 订阅登录(Claude/Codex/xAI 官方 OAuth,跑各自订阅额度;仅桌面端,凭证存本机)
  const [providers, setProviders] = useState<Array<{ id: string; loggedIn: boolean }> | null>(null)
  const [providerBusy, setProviderBusy] = useState<string | null>(null)
  const canSubLogin = !!window.tangu?.providerLogin
  const subLoggedIn = !!providers?.some((p) => p.loggedIn)
  const refreshProviders = (): void => {
    void window.tangu?.authProviders?.().then(setProviders).catch(() => setProviders([]))
  }

  useEffect(() => {
    void window.tangu?.authStatus?.().then((a) => {
      setCloudUrl((u) => u || a.cloudUrl || '')
      setLoggedIn(a.loggedIn)
    })
    refreshProviders()
    const off = window.tangu?.onAuthDevice?.((info) => setDevice(info))
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doLogin = async (): Promise<void> => {
    if (!window.tangu?.forsionLogin) return
    setLoggingIn(true)
    setConnectMsg('')
    setDevice(null)
    try {
      await window.tangu.setConfig({ mode: 'managed', cloudUrl })
      await window.tangu.forsionLogin(cloudUrl)
      track('account.login')
      setLoggedIn(true)
      setConnectMsg(t('onboarding.connect.loginOk'))
      onReconnect()
    } catch (e: any) {
      setConnectMsg(String(e?.message || e).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally {
      setLoggingIn(false)
      setDevice(null)
    }
  }

  const saveByok = async (): Promise<void> => {
    if (!window.tangu?.saveProvider) return
    setByokTesting(true)
    setConnectMsg('')
    try {
      const modelIds = pmodels.split(',').map((s) => s.trim()).filter(Boolean)
      await window.tangu.setConfig({ mode: 'managed' })
      await window.tangu.saveProvider({
        providerId: pid.trim(),
        baseUrl: purl.trim().replace(/\/+$/, ''),
        apiKey: pkey || undefined,
        modelIds: modelIds.length ? modelIds : undefined,
      })
      setByokSaved(true)
      setConnectMsg(t('onboarding.connect.providerSaved'))
      onReconnect()
    } catch (e: any) {
      setConnectMsg(t('onboarding.connect.saveFail', { e: e?.message || e }))
    } finally {
      setByokTesting(false)
    }
  }

  const doProviderLogin = async (id: string): Promise<void> => {
    if (!window.tangu?.providerLogin) return
    setProviderBusy(id)
    setConnectMsg('')
    try {
      await window.tangu.setConfig({ mode: 'managed' })
      await window.tangu.providerLogin(id)
      refreshProviders()
      setConnectMsg(t('onboarding.connect.subLoginOk'))
      onReconnect()
    } catch (e: any) {
      setConnectMsg(String(e?.message || e).replace(/^Error invoking remote method '[^']+': Error: /, ''))
    } finally {
      setProviderBusy(null)
    }
  }

  // ── ③ 默认模型 ──
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [chosenModel, setChosenModel] = useState('')

  // ── ④ 默认本地工作区目录 + 网络镜像(环境步骤)──
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [mirror, setMirror] = useState<'default' | 'china'>('default')
  const [mirrorTesting, setMirrorTesting] = useState(false)
  const [mirrorTest, setMirrorTest] = useState<MirrorTestResult | null>(null)
  useEffect(() => {
    void window.tangu?.getConfig?.().then((c) => {
      setWorkspaceDir(c.defaultWorkspaceDir || '')
      setSyncEnabled(!!c.forsionSyncEnabled)
      setMirror(c.mirror === 'china' ? 'china' : 'default')
    }).catch(() => {})
  }, [])

  const loadStepModels = (): void => {
    setModelsLoading(true)
    void window.tangu?.getConfig().then((c) =>
      listModels({ backendUrl: c.backendUrl, token: c.token, modelId: '' })
        .then((m) => {
          setModels(m)
          setChosenModel((cur) => cur || m.defaultModelId || m.models[0]?.id || '')
        })
        .catch(() => setModels(null))
        .finally(() => setModelsLoading(false)),
    )
  }

  // ── ④ 智能体(名册速览 + 快速新建 + Historian 后台智能体开关)──
  const [agents, setAgents] = useState<NormalAgentDef[] | null>(null)
  const [agName, setAgName] = useState('')
  const [agPersona, setAgPersona] = useState('')
  const [agBusy, setAgBusy] = useState(false)
  const [agMsg, setAgMsg] = useState('')
  const [special, setSpecial] = useState<SpecialAgentsConfig | null>(null)

  const apiCfg = async (): Promise<TanguDesktopConfig> => {
    const c = await window.tangu!.getConfig()
    return { backendUrl: c.backendUrl, token: c.token, modelId: '' }
  }
  const loadAgentsStep = (): void => {
    void apiCfg().then((cfg) => {
      void listAgents(cfg).then(setAgents)
      // 老/external 后端无 special 路由 → 静默隐藏 Historian 卡片。
      void getSpecialConfig(cfg).then((r) => setSpecial(r.config)).catch(() => setSpecial(null))
    }).catch(() => {})
  }

  const createQuickAgent = async (): Promise<void> => {
    const name = agName.trim()
    if (!name) return
    setAgBusy(true)
    setAgMsg('')
    try {
      const cfg = await apiCfg()
      // systemPrompt 新建必填(后端拒空):不填人格时给一句中性默认(硬编码提示词按项目纪律用英文),
      // 兑现「只需名字即可创建」;之后在「智能体」页随时可改。
      const persona = agPersona.trim() || `You are ${name}, a helpful assistant. Reply in the user's language.`
      await saveAgentDef(cfg, { name, systemPrompt: persona })
      setAgName('')
      setAgPersona('')
      setAgMsg(t('onboarding.agents.created', { name }))
      void listAgents(cfg).then(setAgents)
    } catch (e: any) {
      setAgMsg(t('onboarding.agents.createFail', { e: e?.message || e }))
    } finally {
      setAgBusy(false)
    }
  }

  const saveHistorian = (patch: Partial<SpecialAgentsConfig['historian']>): void => {
    if (!special) return
    const h = { ...special.historian, ...patch }
    // modelId 留空=跟随 admin 的「后台 agent 默认」槽(其次对话默认);不再强制选模型,
    // 也不把引导选的对话模型写死进来(写了就脱离跟随)。
    setSpecial({ ...special, historian: h })
    // 保存失败绝不静默:提示 + 回读服务端真值(否则乐观 UI 显示已开而后端没存上)。
    void apiCfg().then((cfg) =>
      saveSpecialConfig(cfg, { historian: h }).then(setSpecial).catch((e) => {
        setAgMsg(t('onboarding.agents.historianSaveFail', { e: e?.message || e }))
        void getSpecialConfig(cfg).then((r) => setSpecial(r.config)).catch(() => {})
      }),
    ).catch(() => {})
  }

  useEffect(() => {
    if (step === 'model') loadStepModels()
    if (step === 'agents') loadAgentsStep()
    // env 步的检测由 EnvProbeSection 自己 mount 时跑(它只在该步渲染)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // ── ③ 环境检测:整块搬进 EnvProbeSection(设置页共用) ──

  const finish = (): void => {
    try {
      localStorage.setItem(ONBOARDING_DISMISS_KEY, '1')
      // 记下完成时的版本 → 下次同版本不再弹,版本升级后再进一次。
      if (appVer) localStorage.setItem(ONBOARDING_VERSION_KEY, appVer)
      else void window.tangu?.appVersion?.().then((v) => { if (v) try { localStorage.setItem(ONBOARDING_VERSION_KEY, v) } catch { /* ignore */ } })
    } catch { /* ignore */ }
    onFinish()
  }

  const connectReady = loggedIn || byokSaved || subLoggedIn

  // 引导仍保留每个独立配置步骤,但左侧把它们组织成四个用户能理解的阶段。
  // 这是视觉与认知分组,不改现有保存时机、跳过语义或步骤顺序。
  const phaseItems = [
    { id: 'connect', label: t('onboarding.phase.connect'), icon: Cloud, steps: ['connect'] as Step[] },
    { id: 'appearance', label: t('onboarding.phase.appearance'), icon: Palette, steps: ['theme'] as Step[] },
    { id: 'capabilities', label: t('onboarding.phase.capabilities'), icon: Sparkles, steps: ['model', 'speech', 'agents'] as Step[] },
    { id: 'workspace', label: t('onboarding.phase.workspace'), icon: FolderOpen, steps: ['workspace', 'env', 'done'] as Step[] },
  ].filter((phase) => phase.steps.some((s) => STEP_ORDER.includes(s)))
  const activePhaseIdx = Math.max(0, phaseItems.findIndex((phase) => phase.steps.includes(step)))
  const stepMeta: Record<Exclude<Step, 'welcome'>, { title: string; description: string }> = {
    connect: { title: t('onboarding.step.connect.title'), description: t('onboarding.step.connect.description') },
    theme: { title: t('onboarding.step.theme.title'), description: t('onboarding.step.theme.description') },
    model: { title: t('onboarding.step.model.title'), description: t('onboarding.step.model.description') },
    speech: { title: t('onboarding.step.speech.title'), description: t('onboarding.step.speech.description') },
    agents: { title: t('onboarding.step.agents.title'), description: t('onboarding.step.agents.description') },
    workspace: { title: t('onboarding.step.workspace.title'), description: t('onboarding.step.workspace.description') },
    env: { title: t('onboarding.step.env.title'), description: t('onboarding.step.env.description') },
    done: { title: t('onboarding.step.done.title'), description: t('onboarding.step.done.description') },
  }

  const rail = (showProgress: boolean): React.ReactNode => (
    <aside className="ob-rail">
      <div className="ob-brand">
        <BrandLogo size={42} />
        <div>
          <div className="ob-brand-name">{PRODUCT_DISPLAY_NAME}</div>
          <div className="ob-brand-caption">{t('onboarding.brand.caption')}</div>
        </div>
      </div>

      {showProgress ? (
        <nav className="ob-phases" aria-label={t('onboarding.progress.label')}>
          <div className="ob-rail-label">{t('onboarding.progress.label')}</div>
          {phaseItems.map((phase, index) => {
            const Icon = phase.icon
            const active = index === activePhaseIdx
            const complete = index < activePhaseIdx || step === 'done'
            return (
              <div key={phase.id} className={`ob-phase${active ? ' active' : ''}${complete ? ' complete' : ''}`}>
                <span className="ob-phase-icon">{complete ? <Check size={14} /> : <Icon size={15} />}</span>
                <span>{phase.label}</span>
              </div>
            )
          })}
        </nav>
      ) : (
        <div className="ob-promise">
          <div className="ob-rail-label">{t('onboarding.welcome.railLabel')}</div>
          <h2>{t('onboarding.welcome.railTitle')}</h2>
          <p>{t('onboarding.welcome.railBody')}</p>
          <div className="ob-promise-list">
            <span><Cloud size={15} />{t('onboarding.welcome.promiseModels')}</span>
            <span><Bot size={15} />{t('onboarding.welcome.promiseAgents')}</span>
            <span><FolderOpen size={15} />{t('onboarding.welcome.promiseLocal')}</span>
          </div>
        </div>
      )}

      <div className="ob-rail-foot">
        <LocaleToggle />
      </div>
    </aside>
  )

  // ── ⓪ 欢迎页:开机式入场动画(标题/版本/按钮错峰淡入)+ 侧边丝滑展开的更新日志(markdown)。 ──
  if (step === 'welcome') {
    return (
      <div className="ob-shell ob-shell--welcome">
        {rail(false)}
        <main className="ob-stage">
          <div className="ob-hero">
            <div className="ob-hero-kicker">{t('onboarding.welcome.kicker')}</div>
            <h1 className="ob-hero-title">{t('onboarding.welcome.title', { name: PRODUCT_DISPLAY_NAME })}</h1>
            <p className="ob-hero-subtitle">{t('onboarding.welcome.subtitle')}</p>
            <div className="ob-hero-actions">
              <button className="btn primary" onClick={() => setStep('connect')}>
                {t('onboarding.welcome.continue')} <ArrowRight size={15} />
              </button>
              <button className={`btn ghost${showChangelog ? ' active' : ''}`} onClick={() => setShowChangelog((v) => !v)}>
                <FileText size={14} /> {t('onboarding.welcome.viewChangelog')}
              </button>
            </div>
            <div className="ob-hero-foot">
              <span>{t('onboarding.welcome.version', { v: appVer || CHANGELOG[0]?.version || '' })}</span>
              <button className="ob-hero-skip" onClick={finish}>{t('onboarding.nav.skip')}</button>
            </div>
          </div>
        </main>

        <div className={`ob-drawer-scrim${showChangelog ? ' open' : ''}`} onClick={() => setShowChangelog(false)} />
        <aside className={`ob-drawer${showChangelog ? ' open' : ''}`} aria-hidden={!showChangelog}>
          <div className="ob-drawer-head">
            <RefreshCw size={14} /> <span className="grow">{t('onboarding.welcome.changelogTitle')}</span>
            <button className="icon-btn" title={t('common.close')} onClick={() => setShowChangelog(false)}><X size={16} /></button>
          </div>
          <div className="ob-drawer-body changelog">
            {CHANGELOG.length === 0 && <div className="hint">{t('onboarding.welcome.noChangelog')}</div>}
            {CHANGELOG.map((c) => (
              <div key={c.version} className="changelog-entry md-body">
                <div className="changelog-ver">{c.version} <span className="changelog-date">{c.date}</span></div>
                <Markdown content={c.lines.map((l) => `- ${l}`).join('\n')} />
              </div>
            ))}
          </div>
        </aside>
      </div>
    )
  }

  return (
    <div className="ob-shell ob-shell--steps">
      {rail(true)}
      <main className="ob-stage">
        <div className="ob-step-wrap">
          {/* key={step} 让每步重新触发一次克制的入场动画。 */}
          <div className="ob-step" key={step}>
            <header className="ob-step-head">
              <div>
                <div className="ob-step-kicker">{phaseItems[activePhaseIdx]?.label}</div>
                <h1>{stepMeta[step].title}</h1>
                <p>{stepMeta[step].description}</p>
              </div>
              <span className="ob-step-count">{stepIdx} / {STEP_ORDER.length - 1}</span>
            </header>
            <div className="ob-step-body">
          {step === 'connect' && (
            <>
              <div className="field">
                <label>{t('onboarding.connect.modeLabel')}</label>
                <div className="seg">
                  <button className={connectMode === 'forsion' ? 'active' : ''} onClick={() => setConnectMode('forsion')}>
                    <Cloud size={12} style={{ verticalAlign: -2, marginRight: 4 }} />{t('onboarding.connect.modeForsion')}
                  </button>
                  {canSubLogin && (
                    <button className={connectMode === 'sub' ? 'active' : ''} onClick={() => setConnectMode('sub')}>
                      <LogIn size={12} style={{ verticalAlign: -2, marginRight: 4 }} />{t('onboarding.connect.modeSub')}
                    </button>
                  )}
                  <button className={connectMode === 'byok' ? 'active' : ''} onClick={() => setConnectMode('byok')}>
                    <KeyRound size={12} style={{ verticalAlign: -2, marginRight: 4 }} />{t('onboarding.connect.modeByok')}
                  </button>
                </div>
              </div>
              {connectMode === 'forsion' ? (
                <>
                  {/* 云端地址只由环境变量 TANGU_CLOUD_URL / 内置默认决定,引导界面不再展示/编辑(与设置一致)。 */}
                  <div className="ob-benefits">
                    <div className="ob-benefits-title"><Cloud size={13} /> {t('onboarding.connect.benefitsTitle')}</div>
                    <ul>
                      <li><strong style={{ color: 'var(--accent-ink)' }}>{t('onboarding.connect.benefitFreeQuota')}</strong></li>
                      <li>{t('onboarding.connect.benefitSync')}</li>
                      <li>{t('onboarding.connect.benefitModels')}</li>
                    </ul>
                  </div>
                  <div className="hint" style={{ marginBottom: 8 }}>{t('onboarding.connect.forsionHint')}</div>
                  <button className="btn primary sm" disabled={loggingIn} onClick={() => void doLogin()}>
                    {loggingIn ? <Loader2 size={12} className="spin" /> : <LogIn size={12} />} {t('onboarding.connect.loginViaBrowser')}
                  </button>
                  {device && (
                    <div className="hint" style={{ marginTop: 6 }}>
                      {t('onboarding.connect.browserNotOpened')}
                      <a href={device.url} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>
                        {device.url} <ExternalLink size={10} style={{ verticalAlign: -1 }} />
                      </a>
                      {device.userCode ? <> · {t('onboarding.connect.verifyCode')} <b>{device.userCode}</b></> : null}
                    </div>
                  )}
                  {loggedIn && (
                    <>
                      <div className="hint" style={{ marginTop: 6 }}>{t('onboarding.connect.loggedIn')}</div>
                      <label className="inline-check" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 }}>
                        <input
                          type="checkbox"
                          checked={syncEnabled}
                          onChange={(e) => { setSyncEnabled(e.target.checked); void window.tangu?.setConfig?.({ forsionSyncEnabled: e.target.checked }) }}
                        />
                        {t('onboarding.connect.cloudSync')}
                      </label>
                      <div className="hint" style={{ marginTop: 4 }}>{t('onboarding.connect.cloudSyncHint')}</div>
                    </>
                  )}
                </>
              ) : connectMode === 'sub' ? (
                <>
                  <div className="hint" style={{ marginBottom: 8 }}>{t('onboarding.connect.subDesc')}</div>
                  {providers?.length ? (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {providers.map((pr) => (
                        <button
                          key={pr.id}
                          className="btn ghost sm"
                          disabled={providerBusy === pr.id}
                          onClick={() => void doProviderLogin(pr.id)}
                        >
                          {providerBusy === pr.id ? <Loader2 size={12} className="spin" /> : <LogIn size={12} />}
                          {SUB_PROVIDER_LABELS[pr.id] || pr.id}
                          {pr.loggedIn ? t('settings.provider.loggedInSuffix') : ''}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="hint">{providers === null ? t('common.loading') : t('onboarding.connect.subUnavailable')}</div>
                  )}
                  <div className="hint" style={{ marginTop: 6 }}>{t('onboarding.connect.subHint')}</div>
                </>
              ) : (
                <>
                  <div className="field-row">
                    <div className="field">
                      <label>{t('onboarding.connect.providerIdLabel')}</label>
                      <input type="text" value={pid} onChange={(e) => setPid(e.target.value.trim())} placeholder={t('onboarding.connect.providerIdPlaceholder')} />
                    </div>
                    <div className="field">
                      <label>{t('onboarding.connect.apiKeyLabel')}</label>
                      <input type="password" value={pkey} onChange={(e) => setPkey(e.target.value)} placeholder="sk-…" />
                    </div>
                  </div>
                  <div className="field">
                    <label>{t('onboarding.connect.baseUrlLabel')}</label>
                    <input type="text" value={purl} onChange={(e) => setPurl(e.target.value.trim())} placeholder="http://localhost:11434/v1" />
                  </div>
                  <div className="field">
                    <label>{t('onboarding.connect.modelWhitelistLabel')}</label>
                    <input type="text" value={pmodels} onChange={(e) => setPmodels(e.target.value)} placeholder="llama3, qwen2.5-coder" />
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button className="btn primary sm" disabled={byokTesting || !pid || !purl} onClick={() => void saveByok()}>
                      {byokTesting ? <Loader2 size={12} className="spin" /> : <Check size={12} />} {t('onboarding.connect.saveAndStart')}
                    </button>
                    <button
                      className="btn ghost sm"
                      disabled={!purl}
                      onClick={() => {
                        void window.tangu?.getConfig().then((c) =>
                          testProviderConnection({ backendUrl: c.backendUrl, token: c.token, modelId: '' }, {
                            baseUrl: purl, apiKey: pkey || undefined,
                            modelId: pmodels.split(',').map((s) => s.trim()).filter(Boolean)[0],
                          }).then((r) => setConnectMsg(`${r.success ? '✓' : '✗'} ${r.message}`))
                            .catch((e) => setConnectMsg(t('onboarding.connect.testFail', { e: e?.message || e }))),
                        )
                      }}
                    >
                      {t('onboarding.connect.testConnection')}
                    </button>
                  </div>
                </>
              )}
              {connectMsg && <div className="hint" style={{ marginTop: 8 }}>{connectMsg}</div>}
            </>
          )}

          {step === 'theme' && (
            <>
              {/* 预览与设置→外观同一块(ThemePreview):首启还没进过应用,不给这块就是闭着眼选皮肤。 */}
              <ThemePreview tabLabel={t('onboarding.phase.appearance')} />
              <div className="field" style={{ marginTop: 14 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Palette size={13} /> {t('settings.theme.langLabel')}
                </label>
                <div className="theme-grid">
                  {listLanguages().map((th) => (
                    <ThemeCard
                      key={th.manifest.id}
                      entry={th}
                      active={th.manifest.id === themeLang}
                      onSelect={() => onThemeChange(th.manifest.id, themeSkin, themeModePref)}
                    />
                  ))}
                </div>
              </div>
              <div className="field">
                {/* 主题色**一根轴**:背景色轴留在设置→外观(Root 传进来的 onThemeChange 会保住当前 bg),
                    别在第一次开机就抛两根轴给用户。⚠️2026-08-29 前这里是旧的耦合逻辑 —— 同一个 id
                    被同时写进两根轴,于是引导选珊瑚连背景都染色,与设置页的模型对不上。 */}
                <label>{t('settings.theme.accentLabel')}</label>
                <div className="skin-row">
                  {listSkins().map((sk) => (
                    <button
                      key={sk.id}
                      type="button"
                      className={`skin-chip${sk.id === themeSkin ? ' active' : ''}`}
                      title={t(`settings.theme.skin.${sk.id}`)}
                      onClick={() => onThemeChange(themeLang, sk.id, themeModePref)}
                    >
                      <i className="skin-dot" style={{ background: sk.id === 'custom' ? themeSeed : skinSwatch(sk, themeMode === 'dark', 'accent') }} />
                      <span>{t(`settings.theme.skin.${sk.id}`)}</span>
                    </button>
                  ))}
                </div>
              </div>
              {themeSkin === 'custom' && (
                <div className="field">
                  <label>{t('onboarding.theme.customSeedLabel')}</label>
                  <input
                    type="color"
                    value={themeSeed}
                    onChange={(e) => onSeedChange(e.target.value)}
                    aria-label={t('onboarding.theme.customSeedLabel')}
                    style={{ width: 48, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                </div>
              )}
              {(() => {
                // 与设置页同款三态 + 锁定(主题 colorScheme 强制时禁用)。透传偏好,绝不把 system 抹成明/暗。
                const forced = forcedSchemeForLanguage(themeLang)
                const active = forced ?? themeModePref
                const opts: Array<{ id: 'light' | 'dark' | 'system'; icon: typeof Sun; label: string }> = [
                  { id: 'light', icon: Sun, label: t('onboarding.theme.light') },
                  { id: 'dark', icon: Moon, label: t('onboarding.theme.dark') },
                  { id: 'system', icon: MonitorCog, label: t('settings.theme.system') },
                ]
                return (
                  <div className="field">
                    <label>{t('onboarding.theme.modeLabel')}</label>
                    <div className="seg">
                      {opts.map(({ id, icon: Ic, label }) => (
                        <button
                          key={id}
                          className={active === id ? 'active' : ''}
                          disabled={!!forced}
                          title={forced ? t('settings.theme.modeLocked') : undefined}
                          onClick={() => onThemeChange(themeLang, themeSkin, id)}
                        >
                          <Ic size={13} style={{ verticalAlign: -2, marginRight: 4 }} />{label}
                        </button>
                      ))}
                    </div>
                    <div className="hint" style={{ marginTop: 6 }}>{forced ? t('settings.theme.modeLockedHint') : t('onboarding.theme.hint')}</div>
                  </div>
                )
              })()}
              <div className="field">
                {/* 只给「界面字体」一档:首启一眼能看出差别的就是它。正文 / 等宽仍留在设置→外观。
                    与上面「配色」同款一排 chip(不是下拉):每颗按自己的字体渲染,即选即预览。 */}
                <label>{t('settings.theme.fontUi')}</label>
                <div className="skin-row">
                  {[{ id: '', label: t('settings.theme.fontFollow'), stack: '' },
                    ...listFonts('ui').map((f) => ({
                      id: f.id,
                      label: f.labelKey ? t(f.labelKey as Parameters<typeof t>[0]) : (f.label ?? f.id),
                      stack: f.stack,
                    }))].map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`skin-chip${f.id === uiFont ? ' active' : ''}`}
                      // paddingLeft:.skin-chip 的左内距是给色点留的,这里没有点。
                      style={{ paddingLeft: 11, fontFamily: f.stack || undefined }}
                      onClick={() => { setUiFont(f.id); writeFont('ui', f.id); applyUiFonts() }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <div className="hint">{t('settings.theme.fontHint')}</div>
              </div>
            </>
          )}

          {step === 'model' && (
            <>
              <div className="field">
                <label>{t('onboarding.model.choiceLabel')}</label>
                {modelsLoading && <div className="hint">{t('onboarding.model.loading')}</div>}
                {!modelsLoading && !models?.models.length && (
                  <div className="hint">
                    {t('onboarding.model.empty')}
                    <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={loadStepModels}>{t('onboarding.model.refresh')}</button>
                  </div>
                )}
                {!!models?.models.length && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {models.models.map((m) => (
                      <button key={`${m.source}-${m.id}`} className="file-row" onClick={() => setChosenModel(m.id)}>
                        <span className="file-name" style={{ color: m.id === chosenModel ? 'var(--accent-ink)' : undefined }}>
                          {m.id === chosenModel ? '● ' : ''}{m.name}
                        </span>
                        <span className="file-size">{m.source === 'direct' ? t('onboarding.model.directSource', { provider: m.provider }) : m.provider}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* 辅助模型(可选):留空即跟随云端默认,不拦引导流程,所以不单开一步。 */}
              <div className="field">
                <label>{t('onboarding.aux.stepLabel')}</label>
                <div className="hint">{t('onboarding.aux.intro')}</div>
              </div>
              <AuxModelChoice models={models} />
            </>
          )}

          {step === 'speech' && (
            <div className="field">
              <label>{t('onboarding.speech.choiceLabel')}</label>
              <div className="hint" style={{ marginBottom: 10 }}>{t('onboarding.speech.intro')}</div>
              <AsrModelChoice models={models} />
            </div>
          )}

          {step === 'agents' && (
            <>
              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Bot size={13} /> {t('onboarding.agents.stepLabel')}
                </label>
                <div className="hint">{t('onboarding.agents.intro')}</div>
              </div>

              {/* 名册速览(头像字母 chip;完整管理在主界面「智能体」页) */}
              <div className="field">
                <label>{t('onboarding.agents.rosterLabel')}</label>
                {agents === null ? (
                  <div className="hint">{t('common.loading')}</div>
                ) : (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {agents.map((a) => (
                      <span
                        key={a.slug}
                        title={a.description || a.slug}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px 3px 4px',
                          border: 'var(--border-width, 1px) solid var(--border)', borderRadius: 999, fontSize: 12,
                        }}
                      >
                        <i style={{
                          fontStyle: 'normal', width: 18, height: 18, borderRadius: '50%', display: 'inline-flex',
                          alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700,
                          color: 'var(--accent-ink)', background: 'color-mix(in srgb, var(--accent-ink) 14%, transparent)',
                        }}>{(a.name || '?').slice(0, 1).toUpperCase()}</i>
                        {a.name}
                        {a.createdBy === 'system' && (
                          <em style={{ fontStyle: 'normal', fontSize: 10, color: 'var(--text-faint)' }}>{t('onboarding.agents.systemBadge')}</em>
                        )}
                      </span>
                    ))}
                    {!agents.length && <div className="hint">{t('onboarding.agents.rosterEmpty')}</div>}
                  </div>
                )}
              </div>

              {/* 快速新建(可选):名字 + 一句话人格 → 立即入名册 */}
              <div className="field">
                <label>{t('onboarding.agents.createLabel')}</label>
                <div className="field-row">
                  <div className="field">
                    <input
                      type="text"
                      value={agName}
                      onChange={(e) => setAgName(e.target.value)}
                      placeholder={t('onboarding.agents.namePlaceholder')}
                    />
                  </div>
                  <div className="field" style={{ flex: 2 }}>
                    <input
                      type="text"
                      value={agPersona}
                      onChange={(e) => setAgPersona(e.target.value)}
                      placeholder={t('onboarding.agents.personaPlaceholder')}
                    />
                  </div>
                  <button className="btn ghost sm" disabled={agBusy || !agName.trim()} onClick={() => void createQuickAgent()}>
                    {agBusy ? <Loader2 size={12} className="spin" /> : <Plus size={12} />} {t('onboarding.agents.createBtn')}
                  </button>
                </div>
                <div className="hint">{t('onboarding.agents.createHint')}</div>
              </div>

              {/* 后台智能体:Historian(老/external 后端不支持则整卡隐藏) */}
              {special && (
                <div className="field">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <History size={13} /> {t('onboarding.agents.historianTitle')}
                  </label>
                  <div className="hint" style={{ marginBottom: 6 }}>{t('onboarding.agents.historianDesc')}</div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div className="seg seg-sm">
                      <button className={!special.historian.enabled ? 'active' : ''} onClick={() => saveHistorian({ enabled: false })}>
                        {t('settings.special.off')}
                      </button>
                      <button className={special.historian.enabled ? 'active' : ''} onClick={() => saveHistorian({ enabled: true })}>
                        {t('settings.special.on')}
                      </button>
                    </div>
                    {special.historian.enabled && (
                      <div className="seg seg-sm">
                        <button
                          className={special.historian.mode !== 'assist' ? 'active' : ''}
                          onClick={() => saveHistorian({ mode: 'independent' })}
                        >
                          {t('settings.special.h.modeIndependent')}
                        </button>
                        <button
                          className={special.historian.mode === 'assist' ? 'active' : ''}
                          onClick={() => saveHistorian({ mode: 'assist' })}
                        >
                          {t('settings.special.h.modeAssist')}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="hint" style={{ marginTop: 6 }}>{t('onboarding.agents.moreHint')}</div>
                </div>
              )}
              {agMsg && <div className="hint" style={{ marginTop: 4 }}>{agMsg}</div>}
            </>
          )}

          {step === 'workspace' && (
            <>
              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <FolderOpen size={13} /> {t('onboarding.workspace.choiceLabel')}
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={workspaceDir}
                    onChange={(e) => setWorkspaceDir(e.target.value)}
                    placeholder={t('onboarding.workspace.placeholder')}
                  />
                  <button
                    className="btn ghost sm"
                    onClick={() => void window.tangu?.pickDirectory?.().then((d) => { if (d) setWorkspaceDir(d) })}
                  >
                    <FolderOpen size={12} /> {t('onboarding.workspace.pick')}
                  </button>
                  {workspaceDir && (
                    <button className="btn ghost sm" onClick={() => setWorkspaceDir('')}>
                      <X size={12} /> {t('onboarding.workspace.clear')}
                    </button>
                  )}
                </div>
                <div className="hint" style={{ marginTop: 6 }}>{t('onboarding.workspace.hint')}</div>
              </div>
            </>
          )}

          {step === 'env' && (
            <>
              {/* 网络环境:开关式换源(仅注入 Forsion 发起的子进程与下载,不改系统配置),即时落配置。 */}
              <div className="field">
                <label>{t('onboarding.env.mirrorLabel')}</label>
                <div className="switch-row">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={mirror === 'china'}
                    className={`switch${mirror === 'china' ? ' on' : ''}`}
                    onClick={() => {
                      const v = mirror === 'china' ? 'default' : 'china'
                      setMirror(v)
                      void window.tangu?.setConfig?.({ mirror: v })
                    }}
                  />
                  <span>{t('settings.mirror.toggle')}</span>
                </div>
                {likelyMainlandChina() && mirror !== 'china' && (
                  <div className="hint" style={{ marginTop: 6, color: 'var(--accent-ink)' }}>{t('settings.mirror.recommend')}</div>
                )}
                <div className="hint" style={{ marginTop: 6 }}>{t('settings.mirror.hint')}</div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                  <button
                    className="btn ghost sm"
                    disabled={mirrorTesting || !window.tangu?.envTestMirror}
                    onClick={() => {
                      if (!window.tangu?.envTestMirror) return
                      setMirrorTesting(true); setMirrorTest(null)
                      void window.tangu.envTestMirror(mirror)
                        .then((r) => setMirrorTest(r))
                        .catch(() => setMirrorTest(null))
                        .finally(() => setMirrorTesting(false))
                    }}
                  >
                    {mirrorTesting ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} {t('settings.mirror.test')}
                  </button>
                  {mirrorTest?.targets.map((tg) => (
                    <span key={tg.name} style={{ fontSize: 12.5, color: tg.ok ? 'var(--text-muted)' : 'var(--danger, #e5484d)' }}>
                      {tg.ok ? '✓' : '✗'} {tg.name} · {tg.ok ? `${tg.latencyMs}ms` : (tg.error || t('settings.mirror.unreachable'))}
                    </span>
                  ))}
                </div>
              </div>
              {/* 交给 Tangu 装 = 开新会话并自动发送 → 得先离开向导才看得见对话。走 finish 而非裸
                  onFinish:env 之后只剩「完成」页,记下已引导免得下次启动又弹一遍。 */}
              <EnvProbeSection onLeave={finish} />
            </>
          )}

          {step === 'done' && (
            <div className="field">
              <label>{t('onboarding.done.label')}</label>
              <div className="panel-note" style={{ lineHeight: 1.8 }}>
                {t('onboarding.done.line1')}<br />
                {t('onboarding.done.line2')}<br />
                {t('onboarding.done.line3')}
              </div>
            </div>
          )}

          <div className="ob-step-actions">
            {stepIdx > 0 && step !== 'done' && (
              <button className="btn ghost sm" onClick={() => setStep(STEP_ORDER[stepIdx - 1])}>
                <ArrowLeft size={12} /> {t('onboarding.nav.prev')}
              </button>
            )}
            <span className="grow" />
            <button className="btn ghost sm" onClick={finish}>
              <SkipForward size={12} /> {t('onboarding.nav.skip')}
            </button>
            {step !== 'done' ? (
              <button
                className="btn primary sm"
                onClick={() => {
                  // 只有用户改选了非云端默认的模型才写 cfg(显式设置=脱离跟随);保持预选默认
                  // 直接下一步 → cfg.modelId 留空,持续跟随 admin 的 app 级默认。
                  if (step === 'model' && chosenModel && chosenModel !== (models?.defaultModelId || '')) {
                    void window.tangu?.setConfig({ modelId: chosenModel })
                  }
                  if (step === 'workspace') {
                    void window.tangu?.setConfig({ defaultWorkspaceDir: workspaceDir.trim() })
                  }
                  setStep(STEP_ORDER[stepIdx + 1])
                }}
              >
                {/* 连接步不再强制:未连接也可「暂时跳过」进下一步(登录/连 provider 之后随时能在设置里补)。 */}
                {step === 'connect' && !connectReady ? t('onboarding.connect.skipForNow') : t('onboarding.nav.next')} <ArrowRight size={12} />
              </button>
            ) : (
              <button className="btn primary sm" onClick={finish}>
                {t('onboarding.nav.start')} <Check size={12} />
              </button>
            )}
          </div>
            </div>
          </div>
        </div>
      </main>
      </div>
  )
}
