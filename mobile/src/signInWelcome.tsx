/**
 * 手机 App 登录前那一屏(手机首次引导做法 A 的第 0 屏):说清这是什么、登录后还要选几样,主按钮去网页登录。
 * 只在原生壳没登录时由 mobileShim 动态 import 挂到 #root;登录回跳后整页 reload,这一屏随之丢掉,不需要自己收。
 *
 * 这时还没有 window.tangu、没有引擎、没有 app store,所以这里只带最少的几样:
 * - 样式:layers.css(层序必须第一份)、base.css(token、.btn)、homepage.css(纸面星轨)、onboarding3.css(引导外壳);
 * - 主题:theme/loader 的 applyTheme + registry 的首屏解析(和 mobileEntry 同一套,只是不落盘、不报宿主);
 * - 语言:@/i18n 的 LocaleProvider(它挂载后的 IP 区域校正要读 window.tangu.getConfig,这时没有 → 基址为空直接返回,不外呼);
 * - 动效偏好:theme/motionTheme(模块加载时按本机「只淡入淡出」设置挂 data-motion-fade,星轨据此停住)。
 * 这些模块加载时都只读 localStorage / document,不碰 window.tangu 以外的宿主,也不 import store。
 *
 * 外壳类名与首启向导一致(.ob-shell.ob-flow.ob3),但 data-step 用 'signin':'welcome' 已经是升级时「已更新到 X」那一屏。
 */
import '@/styles/layers.css' // 层序:必须是第一份 CSS(同 mobileEntry)
import '@/styles/base.css'
import '@/views/homepage.css'
import '@/components/onboarding/onboarding3.css'
import './signInWelcome.css'
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowRight, Loader2 } from 'lucide-react'
import { LocaleProvider, registerMessages, useI18n } from '@/i18n'
import { applyTheme } from '@/theme/loader'
import { resolveInitialBg, resolveInitialEffectiveMode, resolveInitialLang, resolveInitialSkin } from '@/theme/registry'
import { useReducedMotionPref } from '@/theme/motionTheme'
import { HomeWallpaperArt } from '@/views/homepageWallpaperArt'
import { LocaleToggle } from '@/components/LocaleToggle'

registerMessages({
  'phoneguide.welcome.title': { zh: '你好，这里是 Forsion', en: 'Hi, this is Forsion' },
  'phoneguide.welcome.desc': {
    zh: '对话、笔记和 Agent 都在这里。手机和电脑登同一个账号，内容接着用。',
    en: 'Chats, notes and agents, all in one place. Sign in with the same account on your phone and computer and pick up where you left off.',
  },
  'phoneguide.welcome.cardTitle': { zh: '登录后再选几样', en: 'After you sign in' },
  'phoneguide.welcome.cardMeta': { zh: '约 1 分钟', en: 'About 1 minute' },
  'phoneguide.welcome.where': { zh: '选在哪运行', en: 'Choose where it runs' },
  'phoneguide.welcome.whereDesc': { zh: '有电脑等别的地方可选时才问', en: 'Only asked if there’s more than one place' },
  'phoneguide.welcome.look': { zh: '选一个看着舒服的样子', en: 'Pick a look you like' },
  'phoneguide.welcome.lookDesc': { zh: '明暗和颜色', en: 'Light or dark, and colors' },
  'phoneguide.welcome.perms': { zh: '想让它帮你做哪些事', en: 'Choose what it can do for you' },
  'phoneguide.welcome.permsDesc': { zh: '提醒、操作手机、语音，不选也能用', en: 'Reminders, phone control and voice; it works without them too' },
  'phoneguide.welcome.note': { zh: '都能以后在 设置 里改', en: 'You can change all of this later in Settings' },
  'phoneguide.welcome.primary': { zh: '登录并开始', en: 'Sign in and start' },
  // 回头客(走过引导、登录态没了)垫在登录页背后的简版:关掉登录页时看到的是它,不是白屏
  'phoneguide.welcome.signinTitle': { zh: '登录 Forsion，接着用', en: 'Sign in to Forsion to continue' },
  'phoneguide.welcome.signin': { zh: '登录', en: 'Sign in' },
})

/** 按下之后多久把按钮放回来:登录页没打开(Browser.open 的错被吞了)时,这是唯一能再按一次的路。 */
const REARM_MS = 4000

export interface SignInWelcomeProps {
  /** 走过引导的人:不列「登录后再选几样」,只给标题和登录按钮;登录页已经在开,按钮先锁着。 */
  returning: boolean
  onSignIn: () => void | Promise<void>
  /** App 回到前台时回调(原生壳给;没给 = 只靠 visibilitychange 和定时放回)。返回取消订阅。 */
  onResume?: (cb: () => void) => () => void
}

const TODO: Array<[string, string]> = [
  ['phoneguide.welcome.where', 'phoneguide.welcome.whereDesc'],
  ['phoneguide.welcome.look', 'phoneguide.welcome.lookDesc'],
  ['phoneguide.welcome.perms', 'phoneguide.welcome.permsDesc'],
]

export function SignInWelcome({ returning, onSignIn, onResume }: SignInWelcomeProps): React.ReactElement {
  const { t } = useI18n()
  const still = useReducedMotionPref()
  // 登录页打开的那一会儿锁住按钮,防连点开出两个登录页。回头客进来时登录页已经在开,一开始就锁着。
  const [busy, setBusy] = useState(returning)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    if (!busy) return
    const release = (): void => { if (alive.current) setBusy(false) }
    const timer = window.setTimeout(release, REARM_MS)
    const onVis = (): void => { if (document.visibilityState === 'visible') release() }
    document.addEventListener('visibilitychange', onVis)
    const off = onResume?.(release)
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); off?.() }
  }, [busy, onResume])

  const signIn = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try { await onSignIn() } catch (err) { console.error('[tangu-mobile] sign-in open failed:', err) }
  }

  return <div className="ob-shell ob-flow ob3" data-step="signin" data-mode={returning ? 'returning' : 'full'}>
    <div className="ob3-paper" aria-hidden="true"><div className="hp-wallpaper-art"><HomeWallpaperArt preset="orbit" hour={12} minute={0} still={still} /></div></div>
    <header className="ob3-top">
      <span />
      <div className="ob3-top-r"><LocaleToggle compact /></div>
    </header>
    <main className="ob3-main">
      <div className="ob3-col narrow">
        <div className="ob3-head">
          <div className="ob3-brand" aria-hidden="true">Forsion is All You Need</div>
          <h1 tabIndex={-1}>{t(returning ? 'phoneguide.welcome.signinTitle' : 'phoneguide.welcome.title')}</h1>
          {!returning && <p>{t('phoneguide.welcome.desc')}</p>}
        </div>
        {!returning && <>
          <section className="ob3-card ob3-signin-todo">
            <div className="ob3-choice-h"><strong>{t('phoneguide.welcome.cardTitle')}</strong><em>{t('phoneguide.welcome.cardMeta')}</em></div>
            {TODO.map(([title, desc], i) => <div key={title} className="ob3-muse-h">
              <span className="ob3-ava" aria-hidden="true">{i + 1}</span>
              <div><strong>{t(title)}</strong><small>{t(desc)}</small></div>
            </div>)}
          </section>
          <div className="ob3-where">{t('phoneguide.welcome.note')}</div>
        </>}
      </div>
    </main>
    <footer className="ob3-foot">
      {/* 窄屏底栏是 space-between:左边垫一格,主按钮才落在右边(向导那里垫的是隐藏的「上一步」) */}
      <div className="ob3-foot-in narrow">
        <span aria-hidden="true" />
        <span className="ob3-foot-hint" />
        <button type="button" className="btn primary" data-ob-primary="" disabled={busy} aria-busy={busy || undefined} onClick={() => void signIn()}>
          {t(returning ? 'phoneguide.welcome.signin' : 'phoneguide.welcome.primary')}
          {busy ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}
        </button>
      </div>
    </footer>
  </div>
}

export interface MountSignInWelcomeOptions extends SignInWelcomeProps {
  el: HTMLElement
}

/** 套上主题和语言后挂到 el 上。返回卸载函数(正常用不到:登录回跳整页 reload)。 */
export function mountSignInWelcome({ el, ...props }: MountSignInWelcomeOptions): () => void {
  try {
    // 同 mobileEntry 的首屏主题,但 persist:false —— 这里只是照着本机记下的样子画,不往回写(用户没在这屏改过什么)。
    // index.html 的内联脚本已经挂好 data-theme / data-skin / data-bg / data-mode;语言样式表与 skins.css 靠这一步才进来。
    applyTheme(resolveInitialLang(), resolveInitialSkin(), resolveInitialBg(), resolveInitialEffectiveMode(), { persist: false })
  } catch (err) {
    console.error('[tangu-mobile] welcome theme failed, continue:', err)
  }
  const root = createRoot(el)
  root.render(<LocaleProvider><SignInWelcome {...props} /></LocaleProvider>)
  return () => root.unmount()
}
