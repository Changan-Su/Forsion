/** First-run decisions, one screen at a time. Advanced configuration stays in its owning space. */
import React, { useEffect, useRef, useState } from 'react'
import {
  ArrowRight, ArrowLeft, Bot, Check, Cloud, KeyRound, Loader2, LogIn, ExternalLink,
  MonitorCog, FolderOpen, Sun, Moon, X, FileText, RefreshCw, Palette, ShieldCheck, Sparkles, Wrench, Globe2, Zap,
} from 'lucide-react'
import { listModels, testProviderConnection } from '../services/backendService'
import { DesktopPermissions, hasDesktopPermissions } from './DesktopPermissions'
import type { DesktopPermissionId, MirrorTestResult, ModelsResponse } from '../types'
import { useI18n } from '../i18n'
import { PRODUCT, PRODUCT_DISPLAY_NAME } from '../product'
import { listLanguages, listSkins, skinSwatch, backgroundSwatch, forcedSchemeForLanguage } from '../theme/registry'
import { useTheme } from '../stores/themeStore'
import { ThemeCard } from './ThemeCard'
import { ThemePreview } from './ThemePreview'
import { BrandLogo } from './BrandLogo'
import { LocaleToggle } from './LocaleToggle'
import { listFonts } from '../fontPresets'
import { Markdown } from './Markdown'
import { APP_VERSION, CHANGELOG } from '../changelog'
import { track } from '../achievements/store'
import { applyUiFonts, readFont, writeFont } from '../uiFont'
import { OnboardingModelChoice } from './OnboardingModelChoice'
import { EnvProbeSection } from './EnvProbeSection'
import './onboardingMessages'
import './onboarding.css'

export const likelyMainlandChina = (): boolean => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    // forsion_region = 语言四级链里 IP 探测缓存下的国家码(i18n.tsx):兜住「国内用户跑英文系统 + 非中国时区」。
    return navigator.language.toLowerCase() === 'zh-cn' || /^Asia\/(Shanghai|Chongqing|Harbin|Urumqi)$/.test(tz)
      || localStorage.getItem('forsion_region') === 'CN'
  } catch { return false }
}
export const ONBOARDING_DISMISS_KEY = 'forsion_tangu_onboarding_done'
export const ONBOARDING_VERSION_KEY = 'forsion_tangu_onboarding_version'
export const SUB_PROVIDER_LABELS: Record<string, string> = { codex: 'Codex', xai: 'xAI · Grok' }
type Step = 'welcome' | 'connect' | 'model' | 'theme' | 'workspace' | 'env' | 'permissions' | 'done'
const permissionSets: Record<'computer' | 'media', DesktopPermissionId[]> = {
  computer: ['computerAccessibility', 'computerScreen'], media: ['microphone', 'camera', 'screen'],
}
const stepOrder = (): Step[] => {
  const steps: Step[] = PRODUCT.agentBackend && !!window.tangu?.envCheck
    ? ['welcome', 'connect', 'model', 'theme', 'workspace', 'env', 'done'] : ['welcome', 'theme', 'done']
  if (hasDesktopPermissions()) steps.splice(steps.indexOf('done'), 0, 'permissions')
  return steps
}
export const OnboardingWizard: React.FC<{
  themeLang: string; themeSkin: string; themeMode: 'light' | 'dark'; themeModePref: 'light' | 'dark' | 'system'; themeSeed: string
  onThemeChange: (lang: string, skin: string, pref: 'light' | 'dark' | 'system') => void
  onSeedChange: (hex: string) => void; onReconnect: () => void; onFinish: () => void
}> = ({ themeLang, themeSkin, themeMode, themeModePref, themeSeed, onThemeChange, onSeedChange, onReconnect, onFinish }) => {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>('welcome')
  const STEP_ORDER = stepOrder()
  const stepIdx = STEP_ORDER.indexOf(step)
  const isHost = STEP_ORDER.includes('connect')
  const [appearanceTab, setAppearanceTab] = useState<'style' | 'colors' | 'font'>('style')
  const [permissionTab, setPermissionTab] = useState<'computer' | 'media'>('computer')
  const [computerAvailable, setComputerAvailable] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const titleRef = useRef<HTMLHeadingElement>(null)
  const changelogRef = useRef<HTMLDialogElement>(null)
  // 背景色轴直接读写 themeStore(与设置→外观同一条路径);主题色轴仍走 props 的 onThemeChange。
  const themeBg = useTheme((s) => s.bg)
  const setBg = useTheme((s) => s.setBg)
  const themeBgSeed = useTheme((s) => s.bgSeed)
  const setBgSeedValue = useTheme((s) => s.setBgSeedValue)

  // 界面字体(存的是预设 id;与设置→外观同一份 localStorage,写完立刻注入生效)
  const [uiFont, setUiFont] = useState(() => readFont('ui'))

  // ── 欢迎与更新日志对话框 ──
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
  // 订阅登录(Codex/xAI 官方 OAuth,跑各自订阅额度;仅桌面端,凭证存本机)
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
    }).catch(() => {})
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


  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelError, setModelError] = useState(false)
  const [chosenModel, setChosenModel] = useState<string | null>(null)
  const modelRequest = useRef(0)
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null)
  // ── 本机环境:下载源即选即存(与设置同一个 mirror 键);存完才重挂检测区,安装命令按新源重算 ──
  const [mirror, setMirror] = useState<'default' | 'china'>('default')
  const [mirrorSaving, setMirrorSaving] = useState(false)
  const [probeKey, setProbeKey] = useState(0)
  const [mirrorTesting, setMirrorTesting] = useState(false)
  const [mirrorTest, setMirrorTest] = useState<MirrorTestResult | null>(null)
  const chinaLikely = likelyMainlandChina()
  const chooseMirror = async (next: 'default' | 'china'): Promise<void> => {
    if (next === mirror || mirrorSaving) return
    setMirrorSaving(true); setSaveError(''); setMirrorTest(null)
    try {
      await window.tangu?.setConfig({ mirror: next })
      setMirror(next)
      setProbeKey((k) => k + 1)
    } catch (error) {
      setSaveError(t('onboarding.guide.saveFail', { error: error instanceof Error ? error.message : String(error) }))
    } finally { setMirrorSaving(false) }
  }
  const testMirror = (): void => {
    if (!window.tangu?.envTestMirror) return
    setMirrorTesting(true); setMirrorTest(null)
    void window.tangu.envTestMirror(mirror).then(setMirrorTest).catch(() => setMirrorTest(null)).finally(() => setMirrorTesting(false))
  }
  useEffect(() => {
    void window.tangu?.getConfig?.().then((c) => {
      setWorkspaceDir((draft) => draft ?? c.defaultWorkspaceDir ?? '')
      setMirror(c.mirror === 'china' ? 'china' : 'default')
      setSyncEnabled(!!c.forsionSyncEnabled)
    }).catch(() => {})
    void window.tangu?.listProviders?.().then((items) => setByokSaved(items.length > 0)).catch(() => {})
    return () => { modelRequest.current++ }
  }, [])
  const loadStepModels = async (): Promise<void> => {
    const request = ++modelRequest.current
    setModelsLoading(true); setModelError(false)
    try {
      if (!window.tangu?.getConfig) throw new Error('Host unavailable')
      const c = await window.tangu.getConfig()
      const result = await listModels({ backendUrl: c.backendUrl, token: c.token, modelId: '' })
      if (request !== modelRequest.current) return
      setModels(result)
      setChosenModel((draft) => draft ?? c.modelId ?? '')
    } catch {
      if (request === modelRequest.current) setModelError(true)
    } finally {
      if (request === modelRequest.current) setModelsLoading(false)
    }
  }
  useEffect(() => {
    setSaveError('')
    titleRef.current?.focus({ preventScroll: true })
    if (step === 'model') void loadStepModels()
    // Models are refreshed on entry; an existing draft is preserved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])
  useEffect(() => {
    const dialog = changelogRef.current
    if (showChangelog && dialog && !dialog.open) dialog.showModal()
    else if (!showChangelog && dialog?.open) dialog.close()
  }, [showChangelog])
  const finish = (): void => {
    try {
      localStorage.setItem(ONBOARDING_DISMISS_KEY, '1')
      localStorage.setItem(ONBOARDING_VERSION_KEY, appVer || APP_VERSION)
    } catch { /* Storage may be unavailable in private sessions. */ }
    onFinish()
  }
  const advance = async (): Promise<void> => {
    if (saving) return
    setSaving(true); setSaveError('')
    try {
      if (step === 'model' && chosenModel !== null) await window.tangu?.setConfig({ modelId: chosenModel })
      if (step === 'workspace' && workspaceDir !== null) await window.tangu?.setConfig({ defaultWorkspaceDir: workspaceDir.trim() })
      if (step === 'model' && chosenModel !== null) onReconnect()
      setStep(STEP_ORDER[stepIdx + 1])
    } catch (error) {
      setSaveError(t('onboarding.guide.saveFail', { error: error instanceof Error ? error.message : String(error) }))
    } finally { setSaving(false) }
  }
  const connectReady = loggedIn || byokSaved || subLoggedIn
  const iconFor = { connect: Cloud, model: Bot, theme: Palette, workspace: FolderOpen, env: Wrench, permissions: ShieldCheck, done: Check }
  const title = step === 'welcome' ? t('onboarding.guide.intro') : step === 'done' ? t('onboarding.guide.doneTitle')
    : step === 'permissions' ? t('desktopPermissions.title') : t(`onboarding.step.${step}.title`)
  const description = step === 'welcome' ? t('onboarding.guide.welcome') : step === 'done' ? t('onboarding.guide.doneBody')
    : step === 'permissions' ? t('desktopPermissions.optional') : step === 'theme' ? t('onboarding.guide.appearanceDescription') : t(`onboarding.step.${step}.description`)

  return <div className="ob-shell ob-flow" data-step={step}>
    <aside className="ob-rail">
      <div className="ob-brand"><BrandLogo size={30} /><strong>{PRODUCT_DISPLAY_NAME}</strong></div>
      <nav className="ob-progress" aria-label={t('onboarding.progress.label')}>
        {STEP_ORDER.filter((s): s is Exclude<Step, 'welcome'> => s !== 'welcome').map((s, i) => {
          const Icon = iconFor[s]
          return <div key={s} className={`ob-progress-item${step === s ? ' active' : ''}`} aria-label={t(`onboarding.guide.${s}`)} aria-current={step === s ? 'step' : undefined}>
            <span className="ob-progress-icon">{stepIdx > i + 1 ? <Check size={16} /> : <Icon size={16} />}</span>
            <span>{t(`onboarding.guide.${s}`)}</span>
          </div>
        })}
      </nav>
      <div className="ob-rail-foot"><LocaleToggle /><span>{appVer || APP_VERSION}</span></div>
    </aside>
    <main className="ob-stage">
      <header className="ob-step-head">
        <div><div className="ob-step-kicker">{t('onboarding.guide.essentials')}</div>
          <h1 ref={titleRef} tabIndex={-1}>{title}</h1><p>{description}</p>
        </div>
        {step !== 'welcome' && <span className="ob-step-count">{stepIdx} / {STEP_ORDER.length - 1}</span>}
      </header>
      <div className="ob-content" key={step}>
        {step === 'welcome' && <div className="ob-welcome-layout">
          <div className="ob-welcome-story"><BrandLogo size={64} />
            <h2>{PRODUCT_DISPLAY_NAME}</h2><p>{t('onboarding.welcome.railBody')}</p>
            <div className="ob-welcome-points">
              <span><Bot size={18} />{t('onboarding.welcome.promiseModels')}</span>
              <span><FolderOpen size={18} />{t('onboarding.welcome.promiseLocal')}</span>
            </div>
          </div><ThemePreview tabLabel={t('onboarding.phase.appearance')} />
        </div>}
        {step === 'connect' && <div className="ob-connect-layout">
          <div className="ob-connect-options">
            {(['forsion', ...(canSubLogin ? ['sub'] : []), 'byok'] as const).map((mode) => {
              const Icon = mode === 'forsion' ? Cloud : mode === 'sub' ? LogIn : KeyRound
              return <button key={mode} aria-pressed={connectMode === mode} className={`ob-connect-option${connectMode === mode ? ' selected' : ''}`}
                onClick={() => { setConnectMode(mode as 'forsion' | 'sub' | 'byok'); setConnectMsg('') }}>
                <Icon size={20} /><span><strong>{t(mode === 'forsion' ? 'onboarding.connect.modeForsion' : mode === 'sub' ? 'onboarding.connect.modeSub' : 'onboarding.connect.modeByok')}</strong>
                  <small>{t(mode === 'forsion' ? 'onboarding.guide.forsion' : mode === 'sub' ? 'onboarding.guide.subscription' : 'onboarding.guide.byok')}</small></span>
              </button>
            })}
          </div><div className="ob-connect-detail">
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
                  <button className="btn primary sm" disabled={loggingIn || loggedIn} onClick={() => void doLogin()}>
                    {loggingIn ? <Loader2 size={12} className="spin" /> : <LogIn size={12} />} {t(loggedIn ? 'onboarding.guide.connected' : 'onboarding.connect.loginViaBrowser')}
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
                      <label htmlFor="ob-provider">{t('onboarding.connect.providerIdLabel')}</label>
                      <input id="ob-provider" type="text" value={pid} onChange={(e) => setPid(e.target.value.trim())} placeholder={t('onboarding.connect.providerIdPlaceholder')} />
                    </div>
                    <div className="field">
                      <label htmlFor="ob-api-key">{t('onboarding.connect.apiKeyLabel')}</label>
                      <input id="ob-api-key" type="password" autoComplete="off" value={pkey} onChange={(e) => setPkey(e.target.value)} placeholder="sk-…" />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="ob-base-url">{t('onboarding.connect.baseUrlLabel')}</label>
                    <input id="ob-base-url" type="text" value={purl} onChange={(e) => setPurl(e.target.value.trim())} placeholder="http://localhost:11434/v1" />
                  </div>
                  <div className="field">
                    <label htmlFor="ob-model-ids">{t('onboarding.connect.modelWhitelistLabel')}</label>
                    <input id="ob-model-ids" type="text" value={pmodels} onChange={(e) => setPmodels(e.target.value)} placeholder="llama3, qwen2.5-coder" />
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
              {connectMsg && <div className="ob-feedback" role="status">{connectMsg}</div>}

          </div></div>}
        {step === 'model' && <>
          {modelsLoading && <div className="ob-loading" role="status"><Loader2 size={20} className="spin" />{t('onboarding.model.loading')}</div>}
          {!modelsLoading && (modelError || !models?.models.some((m) => !m.modelType || m.modelType === 'llm')) ? <div className="ob-empty">
            <Bot size={32} /><h2>{t(modelError ? 'onboarding.guide.modelError' : 'onboarding.guide.modelEmpty')}</h2>
            <div className="ob-inline"><button className="btn ghost" onClick={() => setStep('connect')}>{t('onboarding.guide.connect')}</button>
              <button className="btn ghost" onClick={() => void loadStepModels()}><RefreshCw size={14} />{t('onboarding.model.refresh')}</button></div>
          </div> : !modelsLoading && models && <OnboardingModelChoice models={models} value={chosenModel || ''} onChange={setChosenModel} />}
        </>}
        {step === 'theme' && <div className="ob-appearance-layout">
          <div className="ob-appearance-controls">
            <div className="seg ob-sections" aria-label={t('onboarding.guide.theme')}>
              {(['style', 'colors', 'font'] as const).map((tab) => <button key={tab} aria-pressed={appearanceTab === tab}
                className={appearanceTab === tab ? 'active' : ''} onClick={() => setAppearanceTab(tab)}>{t(`onboarding.guide.${tab}`)}</button>)}
            </div>
            <div className="ob-appearance-options">
              {appearanceTab === 'style' && <>              <div className="field" >
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Palette size={13} /> {t('onboarding.guide.styleLabel')}
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
</>}
              {appearanceTab === 'colors' && <>              <div className="field">
                {/* 颜色**两根独立的轴**,与设置→外观逐字同款(2026-08-30 用户拍板:引导里也要都露出来)。
                    主题色只换 accent 家族,背景色只换底/文字/边线族(见 theme/skins.css)。
                    ⚠️ 别退回 2026-08-29 前的耦合写法 —— 那时同一个 id 被同时写进两根轴,引导选珊瑚
                    连背景都染色,与设置页的模型对不上。背景色的**新装机缺省 = 经典**(resolveInitialBg
                    → resolveInitialSkin → DEFAULT_SKIN);老用户重进引导时它等于其原配色,那是刻意的
                    拆轴迁移,别在这里强行改写。 */}
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
              <div className="field">
                <label>{t('settings.theme.bgLabel')}</label>
                <div className="skin-row">
                  {listSkins().map((sk) => (
                    <button
                      key={sk.id}
                      type="button"
                      className={`skin-chip${sk.id === themeBg ? ' active' : ''}`}
                      title={t(`settings.theme.skin.${sk.id}`)}
                      onClick={() => setBg(sk.id)}
                    >
                      <i
                        className="skin-dot skin-dot-background"
                        style={{ background: backgroundSwatch(sk, themeMode === 'dark', sk.id === 'custom' ? (themeBgSeed || themeSeed) : sk.bgSeed) }}
                      />
                      <span>{t(`settings.theme.skin.${sk.id}`)}</span>
                    </button>
                  ))}
                </div>
              </div>
              {themeBg === 'custom' && (
                <div className="field">
                  <label>{t('settings.theme.customBgLabel')}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <input
                      type="color"
                      value={themeBgSeed || '#f8f7f6'}
                      onChange={(e) => setBgSeedValue(e.target.value)}
                      aria-label={t('settings.theme.customBgLabel')}
                      style={{ width: 48, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                    />
                    <span className="hint" style={{ fontFamily: 'var(--font-mono)' }}>{themeBgSeed || t('settings.theme.customBgFollow')}</span>
                    {themeBgSeed && (
                      <button className="btn ghost sm" onClick={() => setBgSeedValue('')}>{t('settings.theme.customBgClear')}</button>
                    )}
                  </div>
                </div>
              )}
</>}
              {appearanceTab === 'font' && <><div className="field"><label htmlFor="ob-font">{t('settings.theme.fontUi')}</label>
  <select id="ob-font" value={uiFont} onChange={(e) => { setUiFont(e.target.value); writeFont('ui', e.target.value); applyUiFonts() }}>
    <option value="">{t('settings.theme.fontFollow')}</option>
    {listFonts('ui').map((f) => <option key={f.id} value={f.id}>{f.labelKey ? t(f.labelKey) : f.label || f.id}</option>)}
  </select><p className="hint">{t('settings.theme.fontHint')}</p>
  <div className="ob-font-sample">Aa / 你好<br /><span>Forsion Genesis</span></div>
</div></>}
            </div>
          </div><div className="ob-preview"><ThemePreview tabLabel={t('onboarding.guide.theme')} />
            <h2>{t('onboarding.guide.preview')}</h2><p>{t('onboarding.guide.previewHint')}</p>
          </div>
        </div>}
        {step === 'workspace' && <div className="ob-workspace-layout">
          <div className="ob-workspace-story"><FolderOpen size={42} /><h2>{t('onboarding.guide.workspaceTitle')}</h2><p>{t('onboarding.guide.workspaceBody')}</p></div>
          <div className="ob-workspace-choice"><label htmlFor="ob-directory">{t('onboarding.workspace.choiceLabel')}</label>
            <input id="ob-directory" value={workspaceDir ?? ''} placeholder={t('onboarding.workspace.placeholder')} onChange={(e) => setWorkspaceDir(e.target.value)} />
            <div className="ob-inline"><button className="btn ghost" onClick={() => {
              void window.tangu?.pickDirectory?.().then((d) => { if (d) setWorkspaceDir(d) }).catch((e) => setSaveError(String(e)))
            }}><FolderOpen size={15} />{t('onboarding.workspace.pick')}</button>
            {workspaceDir && <button className="btn ghost" onClick={() => setWorkspaceDir('')}>{t('onboarding.workspace.clear')}</button>}</div>
            <p className="ob-muted">{t('onboarding.guide.workspaceLater')}</p>
          </div>
        </div>}
        {step === 'env' && <div className="ob-env-layout">
          <div className="ob-env-source">
            <h2>{t('onboarding.guide.sourceTitle')}</h2>
            <div className="ob-env-options" role="radiogroup" aria-label={t('onboarding.guide.sourceTitle')}>
              {(['default', 'china'] as const).map((id) => {
                const Icon = id === 'china' ? Zap : Globe2
                return <button key={id} role="radio" aria-checked={mirror === id} disabled={mirrorSaving}
                  className={`ob-env-option${mirror === id ? ' selected' : ''}`} onClick={() => void chooseMirror(id)}>
                  <Icon size={18} /><span>
                    <strong>{t(id === 'china' ? 'onboarding.guide.sourceChina' : 'onboarding.guide.sourceDefault')}
                      {id === 'china' && chinaLikely && <em>{t('onboarding.guide.recommended')}</em>}</strong>
                    <small>{t(id === 'china' ? 'onboarding.guide.sourceChinaHint' : 'onboarding.guide.sourceDefaultHint')}</small>
                  </span>
                  {mirror === id && (mirrorSaving ? <Loader2 size={15} className="spin ob-env-mark" /> : <Check size={15} className="ob-env-mark" />)}
                </button>
              })}
            </div>
            <div className="ob-env-test">
              <button className="btn ghost sm" disabled={mirrorTesting || mirrorSaving || !window.tangu?.envTestMirror} onClick={testMirror}>
                {mirrorTesting ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} {t('settings.mirror.test')}
              </button>
              {mirrorTest?.targets.map((tg) => (
                <span key={tg.name} className={tg.ok ? 'ok' : 'fail'}>
                  {tg.ok ? <Check size={12} /> : <X size={12} />}{tg.name} · {tg.ok ? `${tg.latencyMs}ms` : (tg.error || t('settings.mirror.unreachable'))}
                </span>
              ))}
            </div>
            <p className="ob-muted">{t('onboarding.guide.sourceScope')}</p>
          </div>
          {/* 交给 Tangu 装 = 开新会话并自动发送 → 得先离开向导才看得见对话,走 finish 记下已引导。
              key=probeKey:换源存盘后重挂,安装命令按新源重算(main.ts runEnvCheck 在检测时读 mirror)。 */}
          <div className="ob-env-tools"><EnvProbeSection key={probeKey} onLeave={finish} /></div>
        </div>}
        {step === 'permissions' && <div className="ob-permission-layout">
          <div className="seg ob-sections">
            {(['computer', 'media'] as const).filter((tab) => tab !== 'computer' || computerAvailable).map((tab) => <button key={tab} aria-pressed={permissionTab === tab} className={permissionTab === tab ? 'active' : ''}
              onClick={() => setPermissionTab(tab)}>{t(`onboarding.guide.${tab}`)}</button>)}
          </div>
          <DesktopPermissions mode={themeMode} only={permissionSets[permissionTab]} onSnapshot={(snapshot) => {
            const available = snapshot.computerUseAvailable && ['darwin', 'win32'].includes(snapshot.platform)
            setComputerAvailable(available)
            if (!available) setPermissionTab('media')
          }} />
        </div>}
        {step === 'done' && <div className="ob-done-layout">
          <div className="ob-done-summary"><span className="ob-done-mark"><Check size={28} /></span>
            <dl>
              {isHost && <><dt>{t('onboarding.guide.model')}</dt><dd>{chosenModel ? models?.models.find((m) => m.id === chosenModel)?.name || chosenModel : t('onboarding.guide.followDefault')}</dd></>}
              <dt>{t('onboarding.guide.theme')}</dt><dd>{listLanguages().find((th) => th.manifest.id === themeLang)?.manifest.name || themeLang}</dd>
              {isHost && <><dt>{t('onboarding.guide.workspace')}</dt><dd>{workspaceDir || t('onboarding.guide.workspaceLater')}</dd></>}
              {isHost && <><dt>{t('onboarding.guide.sourceTitle')}</dt><dd>{t(mirror === 'china' ? 'onboarding.guide.sourceChina' : 'onboarding.guide.sourceDefault')}</dd></>}
            </dl>
          </div><div className="ob-next-steps"><h2>{t('onboarding.guide.more')}</h2>
            {isHost ? <>
              <div><Bot size={18} /><span>{t('onboarding.guide.moreAgents')}<small>{t('onboarding.guide.moreAgentsPath')}</small></span></div>
              <div><Sparkles size={18} /><span>{t('onboarding.guide.moreModels')}<small>{t('onboarding.guide.moreModelsPath')}</small></span></div>
              <div><MonitorCog size={18} /><span>{t('onboarding.guide.moreTools')}<small>{t('onboarding.guide.moreToolsPath')}</small></span></div>
            </> : <p>{t('onboarding.done.cloudLine1')}<br />{t('onboarding.done.cloudLine2')}</p>}
          </div>
        </div>}
      </div>
      <footer className="ob-footer">
        {saveError && <div className="ob-save-error" role="alert">{saveError}</div>}
        <div className="ob-footer-row">
          {stepIdx > 0 ? <button className="btn ghost" disabled={saving} onClick={() => setStep(STEP_ORDER[stepIdx - 1])}><ArrowLeft size={14} />{t('onboarding.nav.prev')}</button>
            : <button className="btn ghost" onClick={() => setShowChangelog(true)}><FileText size={14} />{t('onboarding.welcome.viewChangelog')}</button>}
          <span className="ob-footer-hint">{t('onboarding.guide.changeLater')}</span>
          {step !== 'done' && <button className="btn ghost" disabled={saving} onClick={step === 'permissions' ? () => void advance() : finish}>{t(step === 'permissions' ? 'desktopPermissions.later' : 'onboarding.nav.skip')}</button>}
          <button className="btn primary" disabled={saving || mirrorSaving || (step === 'model' && modelsLoading)} onClick={step === 'done' ? finish : () => void advance()}>
            {t(step === 'welcome' ? 'onboarding.welcome.continue' : step === 'done' ? 'onboarding.nav.start' : step === 'connect' && !connectReady ? 'onboarding.connect.skipForNow' : 'onboarding.nav.next')}
            {saving ? <Loader2 size={15} className="spin" /> : <ArrowRight size={15} />}
          </button>
        </div>
      </footer>
    </main>
    <dialog ref={changelogRef} className="ob-changelog" onCancel={() => setShowChangelog(false)} onClick={(event) => { if (event.target === event.currentTarget) setShowChangelog(false) }}>
      <div className="ob-changelog-head"><h2>{t('onboarding.welcome.changelogTitle')}</h2><button className="icon-btn" aria-label={t('common.close')} onClick={() => setShowChangelog(false)}><X size={18} /></button></div>
      <div className="ob-changelog-body changelog">
        {CHANGELOG.map((c) => <div key={c.version} className="changelog-entry md-body"><div className="changelog-ver">{c.version} <span className="changelog-date">{c.date}</span></div><Markdown content={c.lines.map((l) => `- ${l}`).join('\n')} /></div>)}
      </div>
    </dialog>
  </div>
}
