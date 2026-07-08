/**
 * 首启引导向导:① 连接(Forsion 账号登录 / 自定义 provider)→ ② 默认模型 → ③ 环境检测(缺失项
 * 给平台安装命令,用户确认后内置日志面板执行——绝不静默自动装)→ ④ 完成(指路导入/设置)。
 * 触发条件见 App.tsx(managed 从未配置:无 cloudUrl/token/provider);「跳过」永久记 localStorage。
 */
import React, { useEffect, useRef, useState } from 'react'
import {
  ArrowRight, ArrowLeft, Bot, Check, Cloud, History, KeyRound, Loader2, LogIn, ExternalLink,
  MonitorCheck, Play, Plus, SkipForward, Sparkles, Palette, FolderOpen, Sun, Moon, X, FileText, RefreshCw,
} from 'lucide-react'
import { listModels, testProviderConnection, listAgents, saveAgentDef, getSpecialConfig, saveSpecialConfig } from '../services/backendService'
import type { EnvProbeResult, MirrorTestResult, ModelsResponse, NormalAgentDef, SpecialAgentsConfig, TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'
import { PRODUCT, PRODUCT_DISPLAY_NAME } from '../product'
import { listLanguages, listSkins } from '../theme/registry'
import { applyTheme } from '../theme/loader'
import { ThemeCard } from './ThemeCard'
import { BrandLogo } from './BrandLogo'
import { Markdown } from './Markdown'
import { CHANGELOG } from '../changelog'

export const ONBOARDING_DISMISS_KEY = 'forsion_tangu_onboarding_done'
/** 上次完成引导时的应用版本号;与当前版本不同 → 版本更新后再进一次引导(展示 What's New)。 */
export const ONBOARDING_VERSION_KEY = 'forsion_tangu_onboarding_version'

type Step = 'welcome' | 'connect' | 'theme' | 'model' | 'agents' | 'workspace' | 'env' | 'done'
const STEP_ORDER: Step[] = PRODUCT.agentBackend
  ? ['welcome', 'connect', 'theme', 'model', 'agents', 'workspace', 'env', 'done']
  : ['welcome', 'theme', 'done'] // 无 agent 后端的单品变体:只留通用步(connect/model/agents/workspace/env 均属 agent)

/** 订阅 provider 的友好名(id 见 src/llm/providerOAuth.ts OAUTH_PROVIDERS);未知 id 回退原值。 */
const SUB_PROVIDER_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', xai: 'xAI · Grok' }

export const OnboardingWizard: React.FC<{
  /** 当前主题/明暗(与 App 同步;主题步骤即时应用 + 持久化)。 */
  themeLang: string
  themeSkin: string
  themeMode: 'light' | 'dark'
  themeSeed: string
  onThemeChange: (lang: string, skin: string, mode: 'light' | 'dark') => void
  onSeedChange: (hex: string) => void
  /** 向导内动作改变了主配置(登录成功/保存 provider)→ App 重连。 */
  onReconnect: () => void
  onFinish: () => void
}> = ({ themeLang, themeSkin, themeMode, themeSeed, onThemeChange, onSeedChange, onReconnect, onFinish }) => {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>('welcome')
  const stepIdx = STEP_ORDER.indexOf(step)

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
    // 开启需要模型:沿用上一步选的默认模型(设置里可再改)。
    if (h.enabled && !h.modelId) h.modelId = chosenModel
    if (h.enabled && !h.modelId) {
      setAgMsg(t('onboarding.agents.historianNeedModel'))
      return
    }
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
    if (step === 'env') void doEnvCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // ── ③ 环境检测 ──
  const [probes, setProbes] = useState<EnvProbeResult[] | null>(null)
  const [envChecking, setEnvChecking] = useState(false)
  const [runningInstall, setRunningInstall] = useState<string | null>(null)
  const [installLog, setInstallLog] = useState<string[]>([])
  const logRef = useRef<HTMLPreElement>(null)

  const doEnvCheck = async (): Promise<void> => {
    if (!window.tangu?.envCheck) return
    setEnvChecking(true)
    try {
      setProbes(await window.tangu.envCheck())
    } finally {
      setEnvChecking(false)
    }
  }

  useEffect(() => {
    const off = window.tangu?.onEnvOutput?.((ev) => {
      setInstallLog((prev) => [...prev.slice(-400), ...ev.line.split('\n').filter(Boolean)])
      requestAnimationFrame(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight))
    })
    return () => off?.()
  }, [])

  const needsSudo = (p: EnvProbeResult): boolean => /^sudo\b/.test(p.installCommand || '')

  const runInstall = async (p: EnvProbeResult): Promise<void> => {
    if (!p.installId || !window.tangu?.envRun) return
    // sudo 命令需要 TTY 输密码,GUI 子进程里必然卡死/失败 → 改为复制命令请用户去终端执行。
    if (needsSudo(p)) {
      try { await navigator.clipboard.writeText(p.installCommand || '') } catch { /* ignore */ }
      setInstallLog((prev) => [...prev, t('onboarding.env.copied', { command: p.installCommand })])
      return
    }
    if (!window.confirm(t('onboarding.env.installConfirm', { command: p.installCommand }))) return
    setRunningInstall(p.installId)
    setInstallLog([])
    try {
      await window.tangu.envRun(p.installId)
      await doEnvCheck() // 装完重测
    } finally {
      setRunningInstall(null)
    }
  }

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

  // ── ⓪ 欢迎页:开机式入场动画(标题/版本/按钮错峰淡入)+ 侧边丝滑展开的更新日志(markdown)。 ──
  if (step === 'welcome') {
    return (
      <div className="ob-hero-wrap">
        <div className="ob-hero">
          <div className="ob-hero-mark"><BrandLogo size={56} /></div>
          <h1 className="ob-hero-title">{t('onboarding.welcome.title', { name: PRODUCT_DISPLAY_NAME })}</h1>
          <div className="ob-hero-ver">{t('onboarding.welcome.version', { v: appVer || CHANGELOG[0]?.version || '' })}</div>
          <div className="ob-hero-actions">
            <button className="btn primary" onClick={() => setStep('connect')}>
              {t('onboarding.welcome.continue')} <ArrowRight size={15} />
            </button>
            <button className={`btn ghost${showChangelog ? ' active' : ''}`} onClick={() => setShowChangelog((v) => !v)}>
              <FileText size={14} /> {t('onboarding.welcome.viewChangelog')}
            </button>
          </div>
          <button className="ob-hero-skip" onClick={finish}>{t('onboarding.nav.skip')}</button>
        </div>

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
    <div className="ob-step-wrap">
      {/* 无边设计:与欢迎页一致,无卡片;key={step} 让每步重新触发入场动画 */}
      <div className="ob-step" key={step}>
        <div className="ob-step-head">
          <Sparkles size={14} /> <span className="grow">{t('onboarding.title', { name: PRODUCT_DISPLAY_NAME })}</span>
          <span className="ob-step-count">{stepIdx} / {STEP_ORDER.length - 1}</span>
        </div>
        <div className="ob-step-body">
          {step === 'connect' && (
            <>
              <div className="field">
                <label>{t('onboarding.connect.stepLabel')}</label>
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
                      <li><strong style={{ color: 'var(--accent)' }}>{t('onboarding.connect.benefitFreeQuota')}</strong></li>
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
              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Palette size={13} /> {t('onboarding.theme.stepLabel')}
                </label>
                <div className="theme-grid">
                  {listLanguages().map((th) => (
                    <ThemeCard
                      key={th.manifest.id}
                      entry={th}
                      mode={themeMode}
                      active={th.manifest.id === themeLang}
                      onSelect={() => { applyTheme(th.manifest.id, themeSkin, themeMode, { customColor: themeSeed }); onThemeChange(th.manifest.id, themeSkin, themeMode) }}
                    />
                  ))}
                </div>
              </div>
              <div className="field">
                <label>{t('settings.theme.skinLabel')}</label>
                <div className="skin-row">
                  {listSkins().map((sk) => (
                    <button
                      key={sk.id}
                      type="button"
                      className={`skin-chip${sk.id === themeSkin ? ' active' : ''}`}
                      title={t(`settings.theme.skin.${sk.id}`)}
                      onClick={() => { applyTheme(themeLang, sk.id, themeMode, { customColor: themeSeed }); onThemeChange(themeLang, sk.id, themeMode) }}
                    >
                      <i className="skin-dot" style={{ background: sk.id === 'custom' ? themeSeed : sk.accent }} />
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
                    onChange={(e) => { applyTheme(themeLang, 'custom', themeMode, { customColor: e.target.value }); onSeedChange(e.target.value) }}
                    aria-label={t('onboarding.theme.customSeedLabel')}
                    style={{ width: 48, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                </div>
              )}
              <div className="field">
                <label>{t('onboarding.theme.modeLabel')}</label>
                <div className="seg">
                  <button className={themeMode === 'light' ? 'active' : ''} onClick={() => { applyTheme(themeLang, themeSkin, 'light', { customColor: themeSeed }); onThemeChange(themeLang, themeSkin, 'light') }}>
                    <Sun size={13} style={{ verticalAlign: -2, marginRight: 4 }} />{t('onboarding.theme.light')}
                  </button>
                  <button className={themeMode === 'dark' ? 'active' : ''} onClick={() => { applyTheme(themeLang, themeSkin, 'dark', { customColor: themeSeed }); onThemeChange(themeLang, themeSkin, 'dark') }}>
                    <Moon size={13} style={{ verticalAlign: -2, marginRight: 4 }} />{t('onboarding.theme.dark')}
                  </button>
                </div>
                <div className="hint" style={{ marginTop: 6 }}>{t('onboarding.theme.hint')}</div>
              </div>
            </>
          )}

          {step === 'model' && (
            <>
              <div className="field">
                <label>{t('onboarding.model.stepLabel')}</label>
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
                        <span className="file-name" style={{ color: m.id === chosenModel ? 'var(--accent)' : undefined }}>
                          {m.id === chosenModel ? '● ' : ''}{m.name}
                        </span>
                        <span className="file-size">{m.source === 'direct' ? t('onboarding.model.directSource', { provider: m.provider }) : m.provider}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
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
                          color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
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
                  <FolderOpen size={13} /> {t('onboarding.workspace.stepLabel')}
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
              {/* 网络环境:中国大陆用户一键切镜像源(pip/npm/git + 市场下载),即时落配置。 */}
              <div className="field">
                <label>{t('onboarding.env.mirrorLabel')}</label>
                <select
                  value={mirror}
                  onChange={(e) => {
                    const v = e.target.value === 'china' ? 'china' : 'default'
                    setMirror(v)
                    void window.tangu?.setConfig?.({ mirror: v })
                  }}
                >
                  <option value="default">{t('onboarding.env.mirrorDefault')}</option>
                  <option value="china">{t('onboarding.env.mirrorChina')}</option>
                </select>
                <div className="hint" style={{ marginTop: 6 }}>{t('onboarding.env.mirrorHint')}</div>
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
              <div className="field">
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <MonitorCheck size={13} /> {t('onboarding.env.stepLabel')}
                </label>
                {envChecking && <div className="hint">{t('onboarding.env.checking')}</div>}
                {probes?.map((pr) => (
                  <div key={pr.tool} className="file-row" style={{ cursor: 'default' }}>
                    <span className="file-name">
                      {pr.found ? '✅' : '⚠️'} <b>{pr.tool}</b>
                      <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 12 }}>
                        {pr.found ? pr.version : pr.tool === 'docker' ? t('onboarding.env.missingDocker') : pr.tool === 'npm' ? t('onboarding.env.missingNpm') : t('onboarding.env.missing')}
                      </span>
                    </span>
                    {!pr.found && pr.installId && (
                      <button
                        className="btn ghost sm"
                        disabled={runningInstall !== null}
                        title={pr.installCommand || ''}
                        onClick={() => void runInstall(pr)}
                      >
                        {runningInstall === pr.installId ? <Loader2 size={12} className="spin" /> : <Play size={12} />}{' '}
                        {needsSudo(pr) ? t('onboarding.env.copyCmd') : t('onboarding.env.install')}
                      </button>
                    )}
                  </div>
                ))}
                {installLog.length > 0 && (
                  <pre
                    ref={logRef}
                    style={{
                      marginTop: 8, fontSize: 11, fontFamily: 'var(--font-mono)', maxHeight: 160,
                      overflowY: 'auto', background: 'var(--bg-card)', padding: 8,
                      border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-sm)',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    }}
                  >
                    {installLog.join('\n')}
                  </pre>
                )}
                <div className="hint" style={{ marginTop: 6 }}>
                  {t('onboarding.env.hint')}
                </div>
              </div>
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

          <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
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
                disabled={step === 'connect' && !connectReady}
                onClick={() => {
                  if (step === 'model' && chosenModel) {
                    void window.tangu?.setConfig({ modelId: chosenModel })
                  }
                  if (step === 'workspace') {
                    void window.tangu?.setConfig({ defaultWorkspaceDir: workspaceDir.trim() })
                  }
                  setStep(STEP_ORDER[stepIdx + 1])
                }}
              >
                {t('onboarding.nav.next')} <ArrowRight size={12} />
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
  )
}
