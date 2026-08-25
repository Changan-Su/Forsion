/**
 * Dev-only 移动设置视觉台架:
 *   PORT=5284 npm run dev → /settings-harness.html (加 ?dark 看暗色)
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
import { resolveInitialLang, resolveInitialSkin } from '@/theme/registry'
import type { TanguDesktopConfig } from '@/types'

const dark = new URLSearchParams(location.search).has('dark')
const initialMode = dark ? 'dark' : 'light'
const initialLang = resolveInitialLang()
const initialSkin = resolveInitialSkin()

// SettingsModal 的 mobile 判据与生产 mobileShim 同面;其余桥刻意缺席,验证能力门控不会列出空白页。
;(window as unknown as { tangu: Record<string, unknown> }).tangu = {
  mobile: true,
  cloudWeb: true,
  appVersion: async () => 'harness',
}
applyTheme(initialLang, initialSkin, initialMode)
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
        applyTheme(nextLang, nextSkin, effective)
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
