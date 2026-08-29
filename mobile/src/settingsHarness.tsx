/**
 * Dev-only 移动设置视觉台架:
 *   PORT=5284 npm run dev → /settings-harness.html (加 ?dark 看暗色，?desktop 看桌面设置侧栏)
 *
 * 裸挂生产 SettingsModal + 生产主题/CSS,绕过移动端登录与后端启动,供两层 IA 截图和触控回归。
 * Vite 的 build 入口只有 index.html,本文件不进 APK 产物。
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/base.css'
import { SettingsModal } from '@/components/SettingsModal'
import { LocaleProvider } from '@/i18n'
import '@/i18n.generated'
import { applyTheme } from '@/theme/loader'
import { resolveInitialLang, resolveInitialSkin, resolveInitialBg } from '@/theme/registry'
import type { TanguDesktopConfig } from '@/types'

const dark = new URLSearchParams(location.search).has('dark')
const desktop = new URLSearchParams(location.search).has('desktop')
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
}
applyTheme(initialLang, initialSkin, initialBg, initialMode)
document.documentElement.dataset.flat = '1'

function SettingsHarness() {
  const [cfg, setCfg] = useState<TanguDesktopConfig>({ backendUrl: `${location.origin}/api`, token: 'harness', modelId: '' })
  const [lang, setLang] = useState(initialLang)
  const [skin, setSkin] = useState(initialSkin)
  const [mode, setMode] = useState<'light' | 'dark'>(initialMode)
  const [glass, setGlass] = useState(true)
  const [flat, setFlat] = useState(true)
  const [seed, setSeed] = useState('#8b7fd6')

  return (
    <SettingsModal
      open
      cfg={cfg}
      themeLang={lang}
      themeSkin={skin}
      themeMode={mode}
      themeModePref={mode}
      glassOn={glass}
      flatOn={flat}
      themeSeed={seed}
      onClose={() => undefined}
      onConfigChange={(patch) => setCfg((value) => ({ ...value, ...patch }))}
      onThemeChange={(nextLang, nextSkin, nextMode) => {
        const effective = nextMode === 'system' ? mode : nextMode
        setLang(nextLang)
        setSkin(nextSkin)
        setMode(effective)
        applyTheme(nextLang, nextSkin, initialBg, effective)
      }}
      onGlassChange={(on) => {
        setGlass(on)
        document.documentElement.dataset.glass = on ? 'on' : 'off'
      }}
      onFlatChange={(on) => {
        setFlat(on)
        document.documentElement.dataset.flat = on ? '1' : '0'
      }}
      onSeedChange={setSeed}
      onReconnect={() => undefined}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <SettingsHarness />
  </LocaleProvider>,
)
