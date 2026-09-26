/**
 * Dev-only 移动设置视觉台架:
 *   PORT=5284 npm run dev → /settings-harness.html (加 ?dark 看暗色，?desktop 看桌面设置侧栏，
 *   ?onboarding 看首启引导——台架 window.tangu 无 envCheck，走的正是 web/移动端的收缩步骤序)
 *   ?phone 看「高级 → 测试性功能」里的手机操控设置行(真机才注册;台架给 PhoneControl 挂假 web 实现);
 *   ?phone=missing|signature_mismatch|disabled|proto_mismatch|ready 开关预置为开,并按该伴随包状态出 T2 小节(&sdk=31 看无受限设置引导)
 *
 * 裸挂生产 SettingsModal + 生产主题/CSS,绕过移动端登录与后端启动,供两层 IA 截图和触控回归。
 * Vite 的 build 入口只有 index.html,本文件不进 APK 产物。
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/base.css'
import { SettingsModal } from '@/components/SettingsModal'
import { OnboardingWizard } from '@/components/OnboardingWizard'
import { LocaleProvider } from '@/i18n'
import '@/i18n.generated'
import { applyTheme } from '@/theme/loader'
import { resolveInitialLang, resolveInitialSkin, resolveInitialBg } from '@/theme/registry'
import type { TanguDesktopConfig } from '@/types'
import { registerPlugin } from '@capacitor/core'
import { registerClientSurface } from '@/services/clientSurfaces'

const dark = new URLSearchParams(location.search).has('dark')
const desktop = new URLSearchParams(location.search).has('desktop')
const onboarding = new URLSearchParams(location.search).has('onboarding')
const phone = new URLSearchParams(location.search).has('phone')
const phoneHands = new URLSearchParams(location.search).get('phone') || '' // 空 = 老原生(不带 hands 字段)
const phoneSdk = Number(new URLSearchParams(location.search).get('sdk')) || 35
const initialMode = dark ? 'dark' : 'light'
const initialLang = resolveInitialLang()
const initialSkin = resolveInitialSkin()
const initialBg = resolveInitialBg()

// 手机面与生产 mobileShim 同能力；?desktop 只补设置导航所需的最小宿主桥，让常规设置的
// 连接 / Forsion / 收件箱三层真实渲染出来，不启动 Electron 与本地后端。
const desktopConfig = {
  mode: 'external', backendUrl: `${location.origin}/api`, token: 'harness', sandbox: 'none',
  cloudUrl: '', inboxNotifyEnabled: true,
}
const mobileConfig = { mode: 'external', backendUrl: `${location.origin}/api`, token: 'harness', modelId: '', sandbox: 'none' }
;(window as unknown as { tangu: Record<string, unknown> }).tangu = desktop ? {
  mobile: false,
  cloudWeb: false,
  appVersion: async () => 'harness',
  getConfig: async () => desktopConfig,
  setConfig: async (patch: Record<string, unknown>) => Object.assign(desktopConfig, patch),
  backendStatus: async () => ({ state: 'ready', mode: 'external', url: location.origin }),
} : {
  mobile: true,
  cloudWeb: true,
  appVersion: async () => 'harness',
  // 与生产 mobileShim 同面(那边落 localStorage,台架只在会期内并):少了它,共享层里
  // `window.tangu?.setConfig(…)` 那类漏写方法可选链的调用点在台架上照样绿,漏掉真机上的 TypeError。
  getConfig: async () => mobileConfig,
  setConfig: async (patch: Record<string, unknown>) => Object.assign(mobileConfig, patch),
}
applyTheme(initialLang, initialSkin, initialBg, initialMode)

function SettingsHarness() {
  const [cfg, setCfg] = useState<TanguDesktopConfig>({ backendUrl: `${location.origin}/api`, token: 'harness', modelId: '' })
  const [lang, setLang] = useState(initialLang)
  const [skin, setSkin] = useState(initialSkin)
  const [mode, setMode] = useState<'light' | 'dark'>(initialMode)
  const [flat, setFlat] = useState(false)
  const [glass, setGlass] = useState(true)
  const [seed, setSeed] = useState('#8b7fd6')

  const onTheme = (nextLang: string, nextSkin: string, nextMode: 'light' | 'dark' | 'system'): void => {
    const effective = nextMode === 'system' ? mode : nextMode
    setLang(nextLang)
    setSkin(nextSkin)
    setMode(effective)
    applyTheme(nextLang, nextSkin, initialBg, effective)
  }

  if (onboarding) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)' }}>
        <OnboardingWizard
          themeLang={lang}
          themeSkin={skin}
          themeMode={mode}
          themeModePref={mode}
          themeSeed={seed}
          onThemeChange={onTheme}
          onSeedChange={setSeed}
          onReconnect={() => undefined}
          onFinish={() => undefined}
        />
      </div>
    )
  }

  return (
    <SettingsModal
      open
      cfg={cfg}
      themeLang={lang}
      themeSkin={skin}
      themeMode={mode}
      themeModePref={mode}
      flatOn={flat}
      glassOn={glass}
      themeSeed={seed}
      onClose={() => undefined}
      onConfigChange={(patch) => setCfg((value) => ({ ...value, ...patch }))}
      onThemeChange={onTheme}
      onFlatChange={(on) => {
        setFlat(on)
        document.documentElement.dataset.flat = on ? '1' : '0'
      }}
      onGlassChange={(on) => {
        setGlass(on)
        document.documentElement.dataset.glass = on ? 'on' : 'off'
      }}
      onSeedChange={setSeed}
      onReconnect={() => undefined}
    />
  )
}

/**
 * ?phone:手机操控的设置行只在真机注册(installPhoneControl 要 Capacitor 原生)。台架抢先给 PhoneControl 挂一个
 * 假 web 实现(Capacitor 同名插件先注册者赢),再按生产的组件与状态源登记 surface —— 开关读的仍是「原生」回报。
 */
async function mountPhoneRow(): Promise<void> {
  let enabled = !!phoneHands
  const t2 = phoneHands ? { hands: phoneHands, sdk: phoneSdk } : {}
  registerPlugin('PhoneControl', {
    web: {
      status: async () => ({
        enabled,
        capabilities: enabled ? ['phone.intents', ...(phoneHands === 'ready' ? ['phone.ui'] : [])] : [],
        foreground: true,
        proto: 1,
        ...t2,
      }),
      setEnabled: async (o: { enabled: boolean }) => { enabled = o.enabled; return { enabled } },
      configure: async () => ({}),
      exec: async () => ({ accepted: false }),
      openAccessibilitySettings: async () => { console.info('[harness] openAccessibilitySettings') },
    },
  })
  const [{ setPhoneControlEnabled }, { PhoneControlRow }] = await Promise.all([import('./phoneControl'), import('./PhoneControlRow')])
  registerClientSurface('phone', { capabilities: () => [], exec: () => undefined, SettingsRow: PhoneControlRow })
  await setPhoneControlEnabled(enabled) // 顺带拉一次状态
}

void (phone ? mountPhoneRow() : Promise.resolve()).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider>
      <SettingsHarness />
    </LocaleProvider>,
  )
})
