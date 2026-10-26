/** First-run decisions, one screen at a time. Advanced configuration stays in its owning space. */
import React, { useEffect, useRef, useState } from 'react'
import { MotionConfig, motion } from 'framer-motion'
import {
  ArrowRight, ArrowLeft, Bot, Check, ChevronRight, Cloud, Flag, KeyRound, Loader2, LogIn, ExternalLink,
  MonitorCog, FolderOpen, Sun, Moon, X, FileText, RefreshCw, Palette, ShieldCheck, Sparkles, Wrench, Globe2, Zap, BookOpen, CircleAlert, RotateCcw,
} from 'lucide-react'
import { listModels, testProviderConnection } from '../services/backendService'
import { DesktopPermissions, hasDesktopPermissions } from './DesktopPermissions'
import type { DesktopPermissionId, MirrorTestResult, ModelsResponse } from '../types'
import { useI18n } from '../i18n'
import { PRODUCT, PRODUCT_DISPLAY_NAME } from '../product'
import { listLanguages, listSkins, skinSwatch, backgroundSwatch, forcedSchemeForLanguage } from '../theme/registry'
import { useTheme } from '../stores/themeStore'
import { ThemeCard } from './ThemeCard'
import { onRadioGroupKeyDown, radioTabIndex } from './radioGroupKeys'
import { ThemePreview } from './ThemePreview'
import { BrandLogo } from './BrandLogo'
import { LocaleToggle } from './LocaleToggle'
import { listFonts } from '../fontPresets'
import { APP_VERSION } from '../changelog'
import { ChangelogEntries } from '../views/ChangelogView'
import { track } from '../achievements/store'
import { applyUiFonts, readFont, writeFont } from '../uiFont'
import { OnboardingModelChoice } from './OnboardingModelChoice'
import { OnboardingBackgroundAgents } from './OnboardingBackgroundAgents'
import { OnboardingComputerHistory, OnboardingHistoryStatus } from './OnboardingComputerHistory'
import { computerHistoryApi } from './useComputerHistory'
import { isSupportedPlatform } from './computerHistoryModel'
import { stepOrder, updateOrder, type PermissionTab, type Step } from './onboardingFlow'
import { useApp } from '../stores/appStore'
import { EnvProbeSection } from './EnvProbeSection'
import { ErrorBoundary } from './ErrorBoundary'
import './onboardingMessages'
import './onboarding.css'
import { connectionTarget } from '../services/engine/targets'
import { applySyncChoices, type SyncKind } from '../services/syncSetup'
import { setActiveSpace, useSpaceStore } from '@lcl/engine'

/** 使用指南 Space(Forsion Extend 0.9 起随包):引导最后一步给一个入口。 */
const GUIDE_SPACE_ID = 'forsion-guide'

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
// Read the host connection at step entry, after login/model changes have been saved.
const onboardingTarget = async () => {
  if (!window.tangu?.getConfig) throw new Error('Host unavailable')
  const c = await window.tangu.getConfig()
  return connectionTarget({ backendUrl: c.backendUrl, token: c.token, modelId: '' })
}
const permissionSets: Record<Exclude<PermissionTab, 'history'>, DesktopPermissionId[]> = {
  computer: ['computerAccessibility', 'computerScreen'], media: ['microphone', 'camera', 'screen'],
}
const fullOrder = (): Step[] => stepOrder({
  agentBackend: !!PRODUCT.agentBackend, envCheck: !!window.tangu?.envCheck, config: !!window.tangu?.getConfig, permissions: hasDesktopPermissions(),
})
/** 电脑历史这一页在本机有没有:要有主进程接口,且系统有采集端(macOS / Windows)。同步可判,所以不支持的系统上分页根本不出现。 */
const historyOnThisHost = (): boolean => !!computerHistoryApi() && isSupportedPlatform(window.tangu?.platform)
const storedVersion = (): string | null => {
  try { return localStorage.getItem(ONBOARDING_VERSION_KEY) } catch { return null }
}
export const OnboardingWizard: React.FC<{
  themeLang: string; themeSkin: string; themeMode: 'light' | 'dark'; themeModePref: 'light' | 'dark' | 'system'; themeSeed: string
  onThemeChange: (lang: string, skin: string, pref: 'light' | 'dark' | 'system') => void
  onSeedChange: (hex: string) => void; onReconnect: () => void; onFinish: () => void
}> = ({ themeLang, themeSkin, themeMode, themeModePref, themeSeed, onThemeChange, onSeedChange, onReconnect, onFinish }) => {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>('welcome')
  /** 这一步是往前还是往回走到的(入场动效按方向滑入)。 */
  const [dir, setDir] = useState<'forward' | 'back'>('forward')
  /** 版本更新后弹的短引导:「更新了什么」+ 上次之后新增的步骤,没有完成页。挂载时定死(结束时 store 会把标志清掉,退场动效期间不能变回完整版)。 */
  const [updateMode] = useState(() => !!useApp.getState().onboardingUpdate)
  /** 主进程回了 unsupported:把电脑历史那一页撤掉(连同 Muse 说明里指向它的那句、完成页那一行)。 */
  const [historyGone, setHistoryGone] = useState(false)
  const historyHost = historyOnThisHost() && !historyGone
  const FULL_ORDER = fullOrder()
  // 短引导有哪几步在挂载时定死:走到一半再少一步,当前步会掉出序列(之后只可能是少一页分页,不会少一步)。
  const [updateSteps] = useState(() => updateOrder(fullOrder(), storedVersion(), (s) => s !== 'permissions' || historyOnThisHost()))
  const STEP_ORDER = updateMode ? updateSteps : FULL_ORDER
  const stepIdx = STEP_ORDER.indexOf(step)
  /** 到过的最远一步:左栏上它之前的都能点(往回是回看,往前是回到已经到过的地方)。 */
  const [furthest, setFurthest] = useState<Step>('welcome')
  const reachedIdx = Math.max(stepIdx, STEP_ORDER.indexOf(furthest))
  const lastStep = stepIdx === STEP_ORDER.length - 1
  const isHost = FULL_ORDER.includes('connect')
  const [appearanceTab, setAppearanceTab] = useState<'style' | 'colors' | 'font'>('style')
  const [permissionTab, setPermissionTab] = useState<PermissionTab>(updateMode ? 'history' : 'computer')
  /** null = 还没读到设备权限快照:分页条等读到再画,免得「操作电脑」先画出来又消失。 */
  const [computerAvailable, setComputerAvailable] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [backgroundSaving, setBackgroundSaving] = useState(false)
  const [historySaving, setHistorySaving] = useState(false)
  const [backgroundState, setBackgroundState] = useState<{ historian: boolean; muse: boolean } | null>(null)
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

  // 平台对(macOS / Windows)但主进程说没有采集端:整项不出现。挂载时问一次,不等用户点开那一页才发现。
  useEffect(() => {
    if (!historyOnThisHost()) return
    let live = true
    void computerHistoryApi()?.get().then((view) => {
      if (live && (view.state.status === 'unsupported' || !isSupportedPlatform(view.state.platform))) setHistoryGone(true)
    }).catch(() => { /* 读不到不等于不支持:那一页自己会报读取失败并给重试 */ })
    return () => { live = false }
  }, [])

  // ── 欢迎与更新日志对话框 ──
  const [appVer, setAppVer] = useState('')
  const [showChangelog, setShowChangelog] = useState(false)
  useEffect(() => { void window.tangu?.appVersion?.().then((v) => setAppVer(v || '')).catch(() => {}) }, [])

  // ── ① 连接 ──
  // Forsion 账号登录住在内置包 Forsion Extend 里(桥键 forsionLogin):没装就不列「Forsion 账号」这一项,缺省落到自带密钥
  const canForsion = !!window.tangu?.forsionLogin
  const [connectMode, setConnectMode] = useState<'forsion' | 'sub' | 'byok'>(canForsion ? 'forsion' : 'byok')
  const [cloudUrl, setCloudUrl] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)
  const [loggedIn, setLoggedIn] = useState(false)
  // 登录后「同步到蓬洲云」三个勾(云同步开启方案 2026-10-20):默认都勾上,走完引导时按勾的开;这一步就算点过头,之后不再弹首登卡片
  const [syncPick, setSyncPick] = useState<Record<SyncKind, boolean>>({ notes: true, agents: true, plugins: true })
  // 真看到过那三个勾才算点过头:「跳过引导」在哪一步都能按,没看到就别替用户按默认全开(留给之后的首登卡片问)
  const syncSeen = useRef(false)
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
      const result = await listModels(connectionTarget({ backendUrl: c.backendUrl, token: c.token, modelId: '' }))
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
  // 结束只走一次:退场动效那半秒里引导还挂着,再按一次回车 / 再点一次按钮不能重复收尾。
  const finished = useRef(false)
  const guideReady = useSpaceStore((s) => s.spaces.some((x) => x.id === GUIDE_SPACE_ID))
  const finish = (): void => {
    if (finished.current) return
    finished.current = true
    try {
      localStorage.setItem(ONBOARDING_DISMISS_KEY, '1')
      localStorage.setItem(ONBOARDING_VERSION_KEY, appVer || APP_VERSION)
    } catch { /* Storage may be unavailable in private sessions. */ }
    // 登录了才有那三个勾;后台去开,不挡引导收尾(第二台电脑要用户定的,蓬洲云「同步」页会挂着等)
    if (loggedIn && syncSeen.current && window.remoteSync) void applySyncChoices(syncPick)
    onFinish()
  }
  const go = (next: Step, tab?: PermissionTab): void => {
    const nextIdx = STEP_ORDER.indexOf(next)
    setDir(nextIdx < stepIdx ? 'back' : 'forward')
    if (nextIdx > reachedIdx) setFurthest(next)
    if (tab) setPermissionTab(tab)
    setStep(next)
  }
  /** 往前走到 target:「下一步」,或从左栏直接回到已经到过的后面某一步。途经的每一步(从当前这步起、不含 target)的选择
   *  都在这时保存,和一步一步点「下一步」一样 —— 所以回头改了模型再从左栏跳回最后一页,改动不会丢。 */
  const forward = async (target: Step): Promise<void> => {
    // 已经结束(跳过 / 完成)的退场那半秒里不再推进:否则会把刚跳过的那一步的草稿存下去。
    if (saving || finished.current) return
    const targetIdx = STEP_ORDER.indexOf(target)
    const passes = (s: Step): boolean => { const i = STEP_ORDER.indexOf(s); return i >= stepIdx && i < targetIdx }
    const model = passes('model') && chosenModel !== null
    setSaving(true); setSaveError('')
    try {
      if (model) await window.tangu?.setConfig({ modelId: chosenModel })
      if (passes('workspace') && workspaceDir !== null) await window.tangu?.setConfig({ defaultWorkspaceDir: workspaceDir.trim() })
      if (model) onReconnect()
      go(target)
    } catch (error) {
      setSaveError(t('onboarding.guide.saveFail', { error: error instanceof Error ? error.message : String(error) }))
    } finally { setSaving(false) }
  }
  const advance = (): Promise<void> => forward(STEP_ORDER[stepIdx + 1])
  const connectReady = loggedIn || byokSaved || subLoggedIn
  /** 有开关 / 配置正在落盘:上一步、下一步、跳过、左栏和完成页的回跳都等它存完。 */
  const navLocked = saving || mirrorSaving || backgroundSaving || historySaving
  const primaryDisabled = navLocked || (step === 'model' && modelsLoading)
  const primary = lastStep ? finish : () => void advance()
  // 回车 = 右下角的主按钮。焦点在输入框、按钮、开关这类自己要吃回车的控件上,或有弹窗开着时不接。
  const primaryRef = useRef({ run: primary, disabled: primaryDisabled })
  primaryRef.current = { run: primary, disabled: primaryDisabled }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const target = event.target as Element | null
      if (target?.closest?.('button, a, input, select, textarea, summary, dialog, [role="radio"], [role="switch"], [contenteditable="true"]')) return
      if (finished.current || document.querySelector('dialog[open]') || primaryRef.current.disabled) return
      event.preventDefault()
      primaryRef.current.run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // 「权限与数据」:进这一步时读一次设备权限快照,定下有哪几页(不靠某一页先挂上来才知道)。
  // 这台电脑用不了 Computer Use 时,「操作电脑」和电脑历史都不出现 —— 记录是它的助手做的,给一个开了也录不上的开关没有意义。
  useEffect(() => {
    if (step !== 'permissions' || computerAvailable !== null) return
    let live = true
    const read = window.tangu?.desktopPermissionsStatus?.()
    if (!read) { setComputerAvailable(false); return }
    read.then((snapshot) => { if (live) setComputerAvailable(snapshot.computerUseAvailable && isSupportedPlatform(snapshot.platform)) })
      .catch(() => { if (live) setComputerAvailable(false) })
    return () => { live = false }
  }, [step, computerAvailable])
  const historyTab = historyHost && computerAvailable !== false
  const permissionTabs: PermissionTab[] = [...(computerAvailable ? ['computer' as const] : []), ...(historyTab ? ['history' as const] : []), 'media']
  const shownTab = permissionTabs.includes(permissionTab) ? permissionTab : permissionTabs[0]
  const iconFor = { welcome: FileText, connect: Cloud, model: Bot, background: Sparkles, theme: Palette, workspace: FolderOpen, env: Wrench, permissions: ShieldCheck, done: Flag }
  const railLabel = (s: Step): string => s === 'welcome' ? t('onboarding.update.rail')
    : s === 'permissions' && historyHost ? t('onboarding.guide.permissionsData') : t(`onboarding.guide.${s}`)
  const version = appVer || APP_VERSION
  const title = step === 'welcome' ? (updateMode ? t('onboarding.update.title', { version }) : t('onboarding.guide.intro'))
    : step === 'done' ? t('onboarding.guide.doneTitle')
      : step === 'permissions' ? t(historyHost ? 'onboarding.step.permissions.title' : 'desktopPermissions.title') : t(`onboarding.step.${step}.title`)
  const description = step === 'welcome' ? (updateMode ? t(lastStep ? 'onboarding.update.description' : 'onboarding.update.descriptionNew') : t('onboarding.guide.welcome'))
    : step === 'done' ? t('onboarding.guide.doneBody')
      : step === 'permissions' ? t(historyHost ? 'onboarding.step.permissions.description' : 'desktopPermissions.optional')
        : step === 'theme' ? t('onboarding.guide.appearanceDescription') : t(`onboarding.step.${step}.description`)
  const kicker = updateMode ? t(step === 'welcome' ? 'onboarding.update.kicker' : 'onboarding.update.newKicker')
    : step === 'welcome' ? t('onboarding.guide.essentials') : t('onboarding.guide.stepOf', { n: stepIdx, total: STEP_ORDER.length - 1 })
  /** 完成页的摘要:一行一项,点一下回到那一步去改。读不到的(后台 Agent 没加载出来)不列。 */
  const summary: Array<{ step: Step; tab?: PermissionTab; label: string; value: React.ReactNode }> = step !== 'done' ? [] : [
    ...(isHost ? [{ step: 'model' as const, label: t('onboarding.guide.model'), value: chosenModel ? models?.models.find((m) => m.id === chosenModel)?.name || chosenModel : t('onboarding.guide.followDefault') }] : []),
    { step: 'theme' as const, label: t('onboarding.guide.theme'), value: listLanguages().find((th) => th.manifest.id === themeLang)?.manifest.name || themeLang },
    ...(isHost ? [
      { step: 'workspace' as const, label: t('onboarding.guide.workspace'), value: workspaceDir || t('onboarding.guide.workspaceLater') },
      { step: 'env' as const, label: t('onboarding.guide.sourceTitle'), value: t(mirror === 'china' ? 'onboarding.guide.sourceChina' : 'onboarding.guide.sourceDefault') },
    ] : []),
    ...(backgroundState && STEP_ORDER.includes('background') ? [{ step: 'background' as const, label: t('onboarding.guide.background'),
      value: `Historian ${t(backgroundState.historian ? 'settings.special.on' : 'settings.special.off')} · Muse ${t(backgroundState.muse ? 'settings.special.on' : 'settings.special.off')}` }] : []),
    ...(historyTab && STEP_ORDER.includes('permissions') ? [{ step: 'permissions' as const, tab: 'history' as const, label: t('onboarding.guide.history'), value: <OnboardingHistoryStatus /> }] : []),
  ]

  return <div className="ob-shell ob-flow" data-step={step} data-dir={dir} data-mode={updateMode ? 'update' : 'full'}>
    <aside className="ob-rail">
      <div className="ob-brand"><BrandLogo size={30} /><strong>{PRODUCT_DISPLAY_NAME}</strong></div>
      {/* reducedMotion="user":系统开了「减弱动态效果」时,当前项的底不滑、直接到位。 */}
      <MotionConfig reducedMotion="user">
        <nav className="ob-progress" aria-label={t('onboarding.progress.label')}>
          {/* 完整引导的欢迎页不占一格;更新后的短引导里它就是「更新内容」那一步。 */}
          {STEP_ORDER.filter((s) => updateMode || s !== 'welcome').map((s) => {
            const Icon = iconFor[s]
            const label = railLabel(s)
            const idx = STEP_ORDER.indexOf(s)
            // 打勾 = 走完过的(到过的最远一步之前、且不是眼下这一步);最远那一步本身只是到过,还是它自己的图标。
            const body = <><span className="ob-progress-icon">{idx < reachedIdx && idx !== stepIdx ? <Check size={16} className="ob-draw" /> : <Icon size={16} />}</span><span>{label}</span></>
            // 到过的步骤都可以点:前面的是回看;后面的(回头改了一项之后)直接回去,途经各步的选择由 forward 存下。没到过的不能跳。
            return idx !== stepIdx && idx <= reachedIdx
              ? <button type="button" key={s} className="ob-progress-item done" aria-label={label} disabled={navLocked} onClick={() => { if (idx < stepIdx) go(s); else void forward(s) }}>{body}</button>
              : <div key={s} className={`ob-progress-item${step === s ? ' active' : ''}`} aria-label={label} aria-current={step === s ? 'step' : undefined}>
                  {step === s && <motion.span layoutId="ob-progress-pill" className="ob-progress-pill" transition={{ type: 'spring', stiffness: 380, damping: 32 }} />}{body}
                </div>
          })}
        </nav>
      </MotionConfig>
      <div className="ob-rail-foot"><LocaleToggle /><span>{version}</span></div>
    </aside>
    <main className="ob-stage">
      <header className="ob-step-head">
        <div key={step} className="ob-step-title"><div className="ob-step-kicker">{kicker}</div>
          <h1 ref={titleRef} tabIndex={-1}>{title}</h1><p>{description}</p>
        </div>
        {/* 「跳过引导」只在这里,右下角只留一个主按钮。完成页不给(那里的主按钮就是结束)。 */}
        {step !== 'done' && <button type="button" className="ob-skip" disabled={navLocked} onClick={finish}>{t('onboarding.nav.skip')}</button>}
      </header>
      <div className="ob-content" key={step}>
        {/* 每一步的内容区各自兜底:某一步渲染出错只换掉这一块，左栏、步骤标题和底栏照常(走查续六 6.19) */}
        <ErrorBoundary fallback={(error, retry) => <StepErrorCard step={step} error={error} onRetry={retry}
          onSkip={() => { if (stepIdx + 1 < STEP_ORDER.length) go(STEP_ORDER[stepIdx + 1]); else finish() }} />}>
        {/* 经 StepRender 求值:各步 JSX 里的表达式(例 models?.models…)在边界之内执行，抛错才接得住(Codex 评审 P2) */}
        <StepRender render={() => <>
        {step === 'welcome' && updateMode && <div className="ob-update-notes changelog"><ChangelogEntries /></div>}
        {step === 'welcome' && !updateMode && <div className="ob-welcome-layout">
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
            {([...(canForsion ? ['forsion'] : []), ...(canSubLogin ? ['sub'] : []), 'byok'] as const).map((mode) => {
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
                      <div className="ob-sync-title" ref={() => { syncSeen.current = true }}>{t('onboarding.connect.syncTitle')}</div>
                      {([['notes', t('onboarding.connect.sync.notes')], ['agents', t('onboarding.connect.sync.agents')], ['plugins', t('onboarding.connect.sync.plugins')]] as const)
                        .filter(([k]) => k !== 'notes' || !!window.remoteSync).map(([k, label]) => (
                        <label key={k} className="inline-check ob-sync-row">
                          <input type="checkbox" checked={syncPick[k]} onChange={(e) => setSyncPick({ ...syncPick, [k]: e.target.checked })} />
                          {label}
                        </label>
                      ))}
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
                          testProviderConnection(connectionTarget({ backendUrl: c.backendUrl, token: c.token, modelId: '' }), {
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
            <div className="ob-inline"><button className="btn ghost" onClick={() => go('connect')}>{t('onboarding.guide.connect')}</button>
              <button className="btn ghost" onClick={() => void loadStepModels()}><RefreshCw size={14} />{t('onboarding.model.refresh')}</button></div>
          </div> : !modelsLoading && models && <OnboardingModelChoice models={models} value={chosenModel || ''} onChange={setChosenModel} />}
        </>}
        {step === 'background' && <OnboardingBackgroundAgents resolveTarget={onboardingTarget} onBusyChange={setBackgroundSaving} onState={setBackgroundState}
          historyAhead={historyHost && STEP_ORDER[stepIdx + 1] === 'permissions'} />}
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
                <div className="theme-grid" role="radiogroup" aria-label={t('onboarding.guide.styleLabel')} onKeyDown={onRadioGroupKeyDown}>
                  {listLanguages().map((th, i, all) => (
                    <ThemeCard
                      key={th.manifest.id}
                      entry={th}
                      active={th.manifest.id === themeLang}
                      tabIndex={radioTabIndex(th.manifest.id === themeLang, i, all.some((x) => x.manifest.id === themeLang))}
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
          <div className="ob-env-tools"><EnvProbeSection key={probeKey} locked={mirrorSaving} onLeave={finish} /></div>
        </div>}
        {step === 'permissions' && (computerAvailable === null
          ? <p className="ob-muted" role="status">{t('desktopPermissions.loading')}</p>
          : <div className="ob-permission-layout">
              <div className="seg ob-sections">
                {permissionTabs.map((tab) => <button key={tab} aria-pressed={shownTab === tab} className={shownTab === tab ? 'active' : ''}
                  onClick={() => setPermissionTab(tab)}>{t(`onboarding.guide.${tab}`)}</button>)}
              </div>
              {/* 操作电脑 ↔ 语音与媒体 是同一个权限卡实例换 only:切这两页不卸载,进行中的授权 / 安装不被打断(卸载会关掉系统授权引导)。
                  快照持续回报:进这一步时那一次读失败了,之后卡片重试 / 轮询成功,「操作电脑」和电脑历史还能回来。 */}
              <div className="ob-permission-pane" key={shownTab === 'history' ? 'history' : 'device'}>
                {shownTab === 'history'
                  ? <OnboardingComputerHistory mode={themeMode} onBusyChange={setHistorySaving} onUnsupported={() => setHistoryGone(true)} />
                  : <DesktopPermissions mode={themeMode} only={permissionSets[shownTab]}
                      onSnapshot={(snapshot) => setComputerAvailable(snapshot.computerUseAvailable && isSupportedPlatform(snapshot.platform))} />}
              </div>
            </div>)}
        {step === 'done' && <div className="ob-done-layout">
          <div className="ob-done-summary"><span className="ob-done-mark"><Check size={28} className="ob-draw" /></span>
            <ul className="ob-summary">
              {summary.map((row) => <li key={row.label}>
                <button type="button" disabled={navLocked} onClick={() => go(row.step, row.tab)}>
                  <span>{row.label}</span><b>{row.value}</b><i>{t('onboarding.done.edit')}<ChevronRight size={12} aria-hidden="true" /></i>
                </button>
              </li>)}
            </ul>
          </div><div className="ob-next-steps"><h2>{t('onboarding.guide.more')}</h2>
            {isHost ? <>
              <div><Bot size={18} /><span>{t('onboarding.guide.moreAgents')}<small>{t('onboarding.guide.moreAgentsPath')}</small></span></div>
              <div><Sparkles size={18} /><span>{t('onboarding.guide.moreModels')}<small>{t('onboarding.guide.moreModelsPath')}</small></span></div>
              <div><MonitorCog size={18} /><span>{t('onboarding.guide.moreTools')}<small>{t('onboarding.guide.moreToolsPath')}</small></span></div>
            </> : <p>{t('onboarding.done.cloudLine1')}<br />{t('onboarding.done.cloudLine2')}</p>}
            {/* 使用指南随 Extend 装上(Space id 见 Extend 的 spaces/guide/space.json);没装 / 被关掉就不提 */}
            {guideReady && <div className="ob-next-guide"><BookOpen size={18} /><span>{t('onboarding.guide.moreGuide')}</span>
              <button type="button" className="btn ghost sm" disabled={navLocked} onClick={() => { finish(); setActiveSpace(GUIDE_SPACE_ID) }}>{t('onboarding.guide.openGuide')}</button></div>}
          </div>
        </div>}
        </>} />
        </ErrorBoundary>
      </div>
      <footer className="ob-footer">
        {saveError && <div className="ob-save-error" role="alert">{saveError}</div>}
        <div className="ob-footer-row">
          {stepIdx > 0 ? <button className="btn ghost" disabled={navLocked} onClick={() => go(STEP_ORDER[stepIdx - 1])}><ArrowLeft size={14} />{t('onboarding.nav.prev')}</button>
            // 更新后的短引导第一屏就是更新日志本身,不再给打开它的按钮。
            : !updateMode && <button className="btn ghost" onClick={() => setShowChangelog(true)}><FileText size={14} />{t('onboarding.welcome.viewChangelog')}</button>}
          <span className="ob-footer-hint">{t('onboarding.guide.changeLater')}</span>
          <button className="btn primary" disabled={primaryDisabled} onClick={primary}>
            {t(updateMode ? (lastStep ? (step === 'welcome' ? 'onboarding.update.continue' : 'onboarding.update.finish') : 'onboarding.nav.next')
              : step === 'welcome' ? 'onboarding.welcome.continue' : step === 'done' ? 'onboarding.nav.start' : step === 'connect' && !connectReady ? 'onboarding.connect.skipForNow' : 'onboarding.nav.next')}
            {saving ? <Loader2 size={15} className="spin" /> : <ArrowRight size={15} />}
          </button>
        </div>
      </footer>
    </main>
    <dialog ref={changelogRef} className="ob-changelog" onCancel={() => setShowChangelog(false)} onClick={(event) => { if (event.target === event.currentTarget) setShowChangelog(false) }}>
      <div className="ob-changelog-head"><h2>{t('onboarding.welcome.changelogTitle')}</h2><button className="icon-btn" aria-label={t('common.close')} onClick={() => setShowChangelog(false)}><X size={18} /></button></div>
      <div className="ob-changelog-body changelog">
        <ChangelogEntries />
      </div>
    </dialog>
  </div>
}

/** 在子组件的渲染里执行 render:组件类型稳定(不会每次重挂),抛错落在外层 ErrorBoundary 之内。 */
function StepRender({ render }: { render: () => React.ReactNode }) { return render() }

/** 某一步内容区崩了时的错误卡:「重试」重新挂载这一步;「跳过这一步」= 去下一步、不保存这一步。堆栈收进「错误详情」。 */
function StepErrorCard({ step, error, onRetry, onSkip }: { step: Step; error: Error; onRetry: () => void; onSkip: () => void }) {
  const { t } = useI18n()
  return <div className="ob-step-error" role="alert" data-step-error={step}>
    <strong><CircleAlert size={16} />{t('onboarding.stepError.title')}</strong>
    <p>{t(step === 'background' ? 'onboarding.stepError.background' : 'onboarding.stepError.body')}</p>
    <div className="ob-step-error-actions">
      <button type="button" className="btn sm" onClick={onRetry}><RotateCcw size={13} />{t('onboarding.stepError.retry')}</button>
      <button type="button" className="btn ghost sm" onClick={onSkip}>{t('onboarding.stepError.skip')}</button>
    </div>
    <details><summary>{t('onboarding.stepError.details')}</summary><pre>{`${error.message}\n\n${error.stack || ''}`.trim()}</pre></details>
  </div>
}
