/**
 * 首启引导(11-05 定稿,方案 docs/ToBeImproved/首启引导第三轮方案_2026-11-04/revised.html):
 * 开始 → 外观 → 关于你 → 认识你的 Agents 团队,四屏。网页 / 手机只有外观(账号跟着主机走;human/ 与卜算子设置只接受本机写)。
 * - 每屏自己管草稿;「继续」时调用那一屏挂上来的 commitRef(关于你写 human/MEMORY.md),写失败停在这一屏报错。
 *   开始 / 外观即点即生效;团队那一屏在「开始使用」时一起写。「跳过引导」不写当前这一屏。
 * - 上次看引导记下的版本早于 2.13.8(或没记录)= 完整走一遍,原来走过的叫「欢迎回来」;之后的升级只看「已更新到 X」+ 这一版新增的屏。
 * 台架靠的名字:.ob-shell.ob-flow、data-step、data-mode、.ob-skip(「跳过引导」)。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, CircleAlert, Loader2, RotateCcw } from 'lucide-react'
import { useI18n } from '../i18n'
import { useReducedMotionPref } from '../theme/motionTheme'
import { PRODUCT } from '../product'
import { APP_VERSION } from '../changelog'
import { ChangelogEntries } from '../views/ChangelogView'
import { HomeWallpaperArt } from '../views/homepageWallpaperArt'
import { LocaleToggle } from './LocaleToggle'
import { ErrorBoundary } from './ErrorBoundary'
import { needsFullGuide, stepOrder, updateOrder, type Step } from './onboardingFlow'
import { readTelemetry } from './OnboardingImprove'
import { StartScreen, ImproveRow } from './onboarding/StartScreen'
import { ThemeScreen } from './onboarding/ThemeScreen'
import { YouScreen } from './onboarding/YouScreen'
import { TeamScreen } from './onboarding/TeamScreen'
import { openAgentCreation } from '../views/agentProfileNav'
import { useApp } from '../stores/appStore'
import { connectionTarget } from '../services/engine/targets'
import { applySyncChoices, type SyncKind } from '../services/syncSetup'
import './onboardingMessages'
import './onboarding/messages'
import '../views/homepage.css'
import './onboarding/onboarding3.css'

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

/** 每屏进来时现读主机连接(登录 / 加渠道之后 token 可能刚换过)。 */
const onboardingTarget = async () => {
  if (!window.tangu?.getConfig) throw new Error('Host unavailable')
  const c = await window.tangu.getConfig()
  return connectionTarget({ backendUrl: c.backendUrl, token: c.token, modelId: '' })
}
/** 桌面本机(有本机环境探测 envCheck 的宿主)才有开始 / 关于你 / 团队三屏。网页 / 手机 / Unit 页的垫片也有 getConfig,不能拿它判。 */
const onHost = (): boolean => !!PRODUCT.agentBackend && typeof window.tangu?.envCheck === 'function'
const readKey = (key: string): string | null => {
  try { return localStorage.getItem(key) } catch { return null }
}
const errText = (e: unknown): string => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '')
const FOOT_WIDTH: Partial<Record<Step, string>> = { start: 'mid', theme: 'mid', you: 'narrow', team: 'team' }

export const OnboardingWizard: React.FC<{
  themeLang: string; themeSkin: string; themeMode: 'light' | 'dark'; themeModePref: 'light' | 'dark' | 'system'; themeSeed: string
  onThemeChange: (lang: string, skin: string, pref: 'light' | 'dark' | 'system') => void
  onSeedChange: (hex: string) => void; onReconnect: () => void; onFinish: () => void
}> = ({ themeLang, themeSkin, themeMode, themeModePref, themeSeed, onThemeChange, onSeedChange, onReconnect, onFinish }) => {
  const { t } = useI18n()
  // 挂载时定死:结束时 store 会清掉标志,退场动效那半秒里不能变回完整版;步骤序也不能中途变。
  const [updateMode] = useState(() => !!useApp.getState().onboardingUpdate)
  /** 以前走过 / 跳过过引导(有完成记号):完整引导第一屏叫「欢迎回来」,电脑历史不替他预开。 */
  const [returning] = useState(() => readKey(ONBOARDING_DISMISS_KEY) !== null)
  const [order] = useState<Step[]>(() => {
    const full = stepOrder({ host: onHost() })
    const seen = readKey(ONBOARDING_VERSION_KEY)
    return updateMode && !needsFullGuide(seen) ? updateOrder(full, seen) : full
  })
  /** 升级短引导(第一屏是「已更新到 X」)。早于 2.13.8 的老用户虽然也是升级进来,走的是完整引导。 */
  const brief = order[0] === 'welcome'
  const [step, setStep] = useState<Step>(order[0])
  const [furthest, setFurthest] = useState(0)
  const idx = order.indexOf(step)
  const last = idx === order.length - 1
  const [saving, setSaving] = useState(false)
  const [screenBusy, setScreenBusy] = useState(false)
  const [saveError, setSaveError] = useState('')
  const commitRef = useRef<(() => Promise<void>) | null>(null)
  const mainRef = useRef<HTMLElement>(null)

  const [appVer, setAppVer] = useState('')
  useEffect(() => { void window.tangu?.appVersion?.().then((v) => setAppVer(v || '')).catch(() => {}) }, [])
  const version = appVer || APP_VERSION

  // 登录状态:开始那一屏会实时报上来;没有开始那屏(升级短引导)就自己读一次。团队屏的说明和模型行跟着它。
  const [signedIn, setSignedIn] = useState(false)
  useEffect(() => { void window.tangu?.authStatus?.().then((a) => setSignedIn(!!a?.loggedIn)).catch(() => {}) }, [])
  const [connected, setConnected] = useState(false)
  // 登录后的同步三个勾(10-20):真露出来过才在结束时按勾的开,没看到不替用户开(留给首登卡片问)。
  // Agents 那个勾在旧同步里是账号总闸(= 所有 Agent),11-05 Agent 逐个选定案后缺省不勾(新同步里它不起作用,逐个选在蓬洲云 › 同步)
  const [syncPick, setSyncPick] = useState<Record<SyncKind, boolean>>({ notes: true, agents: false, plugins: true })
  const syncSeen = useRef(false)
  const onSyncSeen = useCallback(() => { syncSeen.current = true }, [])
  const addAgent = useRef(false)
  // 升级短引导:登录了、还没看过「帮助改进」的告知 → 「更新了什么」那屏底下补一行(挂载时读一次定死,看过之后不收起)
  const [improveNotice, setImproveNotice] = useState(false)
  useEffect(() => {
    if (!brief) return
    let live = true
    void readTelemetry().then((v) => { if (live && v && !v.noticeSeen) setImproveNotice(true) })
    return () => { live = false }
  }, [brief])

  // 换屏:清掉上一屏的错误,焦点落在这一屏的标题上(读屏器从标题读起)
  useEffect(() => {
    setSaveError('')
    const id = requestAnimationFrame(() => {
      mainRef.current?.querySelector<HTMLElement>('[data-ob-title]')?.focus({ preventScroll: true })
      mainRef.current?.scrollTo?.({ top: 0 })
    })
    return () => cancelAnimationFrame(id)
  }, [step])

  // 结束只走一次:退场动效那半秒里引导还挂着,再按一次回车 / 再点一次按钮不能重复收尾。
  const finished = useRef(false)
  const close = (): void => {
    if (finished.current) return
    finished.current = true
    try {
      localStorage.setItem(ONBOARDING_DISMISS_KEY, '1')
      localStorage.setItem(ONBOARDING_VERSION_KEY, version)
    } catch { /* 隐私窗口里可能写不了 */ }
    // 后台去开,不挡收尾(第二台电脑要用户定的,蓬洲云「同步」页会挂着等)
    if (signedIn && syncSeen.current && window.remoteSync) void applySyncChoices(syncPick)
    onFinish()
    if (addAgent.current) setTimeout(() => openAgentCreation(), 0)
  }
  /** 写这一屏挂上来的选择;没写上就停在这一屏。 */
  const commit = async (): Promise<boolean> => {
    const run = commitRef.current
    if (!run) return true
    setSaving(true); setSaveError('')
    try { await run(); return true } catch (e) {
      setSaveError(t('ob3.saveFail', { error: errText(e) }))
      return false
    } finally { setSaving(false) }
  }
  const go = (next: number): void => {
    if (next < 0 || next >= order.length) return
    setFurthest((f) => Math.max(f, next))
    setStep(order[next])
  }
  const forward = async (): Promise<void> => {
    if (saving || finished.current) return
    if (!(await commit())) return
    if (last) close(); else go(idx + 1)
  }
  /** 点进度点跳回到过的屏:往前跳时先存当前这一屏,和点「继续」一样。 */
  const jump = async (target: number): Promise<void> => {
    if (saving || finished.current || target === idx || target > furthest) return
    if (target > idx && !(await commit())) return
    go(target)
  }
  const locked = saving || screenBusy

  // 回车 = 右下角的主按钮。焦点在输入框、按钮、开关这类自己要吃回车的控件上,或有弹窗开着时不接。
  const primaryRef = useRef({ run: forward, disabled: locked })
  primaryRef.current = { run: forward, disabled: locked }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const target = event.target as Element | null
      if (target?.closest?.('button, a, input, select, textarea, summary, dialog, [role="radio"], [role="switch"], [contenteditable="true"]')) return
      if (finished.current || document.querySelector('dialog[open]') || primaryRef.current.disabled) return
      event.preventDefault()
      void primaryRef.current.run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onConnected = useCallback((v: boolean) => setConnected(v), [])
  const onSignedIn = useCallback((v: boolean) => setSignedIn(v), [])
  const onBusyChange = useCallback((v: boolean) => setScreenBusy(v), [])
  const onAddAgent = useCallback((v: boolean) => { addAgent.current = v }, [])

  const primaryLabel = last
    ? t(brief ? (order.length === 1 ? 'onboarding.update.continue' : 'onboarding.update.finish') : 'ob3.getStarted')
    : step === 'start' && !connected ? t('ob3.skipConnect') : t('ob3.next')
  const hint = step === 'start' ? t('ob3.changeLater') : step === 'theme' ? t('ob3.theme.fontHint')
    : step === 'you' ? t('ob3.you.skipHint') : step === 'team' ? t('ob3.team.skipHint') : ''
  const reduceMotion = useReducedMotionPref()

  const screen = (): React.ReactNode => {
    switch (step) {
      case 'welcome': return <div className="ob3-col narrow">
        <div className="ob3-head"><div className="ob3-brand" aria-hidden="true">Forsion is All You Need</div>
          <h1 tabIndex={-1} data-ob-title="">{t('onboarding.update.title', { version })}</h1>
          <p>{t(last ? 'onboarding.update.description' : 'onboarding.update.descriptionNew')}</p></div>
        <section className="ob3-card ob3-update changelog"><ChangelogEntries /></section>
        {improveNotice && signedIn && <section className="ob3-card"><ImproveRow signedIn={signedIn} /></section>}
      </div>
      case 'start': return <StartScreen resolveTarget={onboardingTarget} returning={returning} syncPick={syncPick} onSyncPick={setSyncPick} onSyncSeen={onSyncSeen}
        onConnected={onConnected} onSignedIn={onSignedIn} onReconnect={onReconnect} onBusyChange={onBusyChange} />
      case 'theme': return <ThemeScreen themeLang={themeLang} themeSkin={themeSkin} themeMode={themeMode} themeModePref={themeModePref} themeSeed={themeSeed}
        onThemeChange={onThemeChange} onSeedChange={onSeedChange} />
      case 'you': return <YouScreen resolveTarget={onboardingTarget} commitRef={commitRef} />
      case 'team': return <TeamScreen resolveTarget={onboardingTarget} commitRef={commitRef} signedIn={signedIn} fresh={!returning && !brief}
        onAddAgent={onAddAgent} onBusyChange={onBusyChange} />
    }
  }

  return <div className="ob-shell ob-flow ob3" data-step={step} data-mode={brief ? 'update' : 'full'}>
    <div className="ob3-paper" aria-hidden="true"><div className="hp-wallpaper-art"><HomeWallpaperArt preset="orbit" hour={12} minute={0} still={reduceMotion} /></div></div>
    <header className="ob3-top">
      {order.length > 1 ? <nav className="ob3-dots" aria-label={t('ob3.progress', { n: idx + 1, total: order.length })}>
        {order.map((s, i) => <button key={s} type="button" className={i === idx ? 'on' : i <= furthest ? 'done' : ''}
          aria-label={t('ob3.progress', { n: i + 1, total: order.length })} aria-current={i === idx ? 'step' : undefined}
          disabled={locked || i === idx || i > furthest} onClick={() => void jump(i)} />)}
      </nav> : <span />}
      <div className="ob3-top-r"><LocaleToggle compact />
        {order.length > 1 && <button type="button" className="ob-skip" disabled={locked} onClick={close}>{t('onboarding.nav.skip')}</button>}</div>
    </header>
    <main className="ob3-main" ref={mainRef} key={step}>
      {/* 每屏各自兜底:某一屏渲染出错只换掉这一块,顶栏和底栏照常(走查续六 6.19) */}
      <ErrorBoundary fallback={(error, retry) => <StepErrorCard step={step} error={error} onRetry={retry}
        onSkip={() => { commitRef.current = null; if (last) close(); else go(idx + 1) }} />}>
        {screen()}
      </ErrorBoundary>
    </main>
    <footer className="ob3-foot">
      <div className={`ob3-foot-in ${FOOT_WIDTH[step] || 'narrow'}`}>
        <button type="button" className="ob3-back" disabled={idx === 0 || locked} onClick={() => go(idx - 1)}><ArrowLeft size={14} aria-hidden="true" />{t('onboarding.nav.prev')}</button>
        <span className="ob3-foot-hint">{saveError ? <span className="ob3-error" role="alert">{saveError}</span> : hint}</span>
        <button type="button" className="btn primary" data-ob-primary="" disabled={locked} onClick={() => void forward()}>
          {primaryLabel}{saving ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}
        </button>
      </div>
    </footer>
  </div>
}

/** 某一屏崩了时的错误卡:「重试」重新挂载这一屏;「跳过这一步」= 去下一屏、不保存这一屏。堆栈收进「错误详情」。 */
function StepErrorCard({ step, error, onRetry, onSkip }: { step: Step; error: Error; onRetry: () => void; onSkip: () => void }) {
  const { t } = useI18n()
  return <div className="ob-step-error ob3-card" role="alert" data-step-error={step}>
    <strong><CircleAlert size={16} />{t('onboarding.stepError.title')}</strong>
    <p>{t('onboarding.stepError.body')}</p>
    <div className="ob-step-error-actions">
      <button type="button" className="btn sm" onClick={onRetry}><RotateCcw size={13} />{t('onboarding.stepError.retry')}</button>
      <button type="button" className="btn ghost sm" onClick={onSkip}>{t('onboarding.stepError.skip')}</button>
    </div>
    <details><summary>{t('onboarding.stepError.details')}</summary><pre>{`${error.message}\n\n${error.stack || ''}`.trim()}</pre></details>
  </div>
}
