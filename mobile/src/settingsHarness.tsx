/**
 * Dev-only 移动设置视觉台架:
 *   PORT=5284 npm run dev → /settings-harness.html (加 ?dark 看暗色，?desktop 看桌面设置侧栏，
 *   ?onboarding 看首启引导——台架 window.tangu 无 envCheck，走的正是 web/移动端的收缩步骤序)
 *   ?phone 看「高级 → 测试性功能」里的手机操控设置行(真机才注册;台架给 PhoneControl 挂假 web 实现)
 *   ?tab=notifications 直达某一页(SettingsModal 的 initialTab,手机上也直达二级页)
 *   ?parts 看设置零件(ctx.ui.mountSettingsPage 那套)的演示页:额度条、步进器、输入框 + 按钮、「选了就执行」→ 手机半屏
 *
 * 裸挂生产 SettingsModal + 生产主题/CSS,绕过移动端登录与后端启动,供两层 IA 截图和触控回归。
 * Vite 的 build 入口只有 index.html,本文件不进 APK 产物。
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/base.css'
// 手机上「选了就执行」的网页半屏用 mb-sheet(真机 / 网页手机壳里 SingleColumnHost 总会带上这份样式,台架没有那层壳)
import '@lcl/engine/singleColumn.css'
import { SettingsModal } from '@/components/SettingsModal'
import { OnboardingWizard } from '@/components/OnboardingWizard'
import { LocaleProvider } from '@/i18n'
import '@/i18n.generated'
import { applyTheme } from '@/theme/loader'
import { resolveInitialLang, resolveInitialSkin, resolveInitialBg } from '@/theme/registry'
import type { TanguDesktopConfig } from '@/types'
import { registerPlugin } from '@capacitor/core'
import { registerClientSurface } from '@/services/clientSurfaces'
import { SettingsPage } from '@/components/SettingsPage'
import type { PluginSettingsPageSchema } from '../../desktop/shared/settingsPage'

const dark = new URLSearchParams(location.search).has('dark')
const desktop = new URLSearchParams(location.search).has('desktop')
const onboarding = new URLSearchParams(location.search).has('onboarding')
const phone = new URLSearchParams(location.search).has('phone')
const parts = new URLSearchParams(location.search).has('parts')
const initialTab = new URLSearchParams(location.search).get('tab') ?? undefined
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

  if (parts) {
    return (
      <div className={`settings-page${desktop ? '' : ' settings-page--mobile'}`} style={{ position: 'fixed', inset: 0, display: 'block' }}>
        <div className="settings-body" style={{ height: '100%' }}><PartsDemo /></div>
      </div>
    )
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
      initialTab={initialTab as never}
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

/** ?parts:设置零件演示页(内容照 Extend 0.8.3 的「额度与积分」,数据是演示用的)。回调只改本地状态,看排法与交互用。 */
function PartsDemo() {
  const [fallback, setFallback] = useState(true)
  const [cards, setCards] = useState(1)
  const [log, setLog] = useState('')
  const schema: PluginSettingsPageSchema = {
    groups: [
      { id: 'ai', icon: 'gauge', title: 'AI 额度', desc: '今日和本周各还剩多少；用完后可以用额度重置卡恢复', items: [
        { type: 'meters', id: 'm', meters: [{ label: '今日', value: 0.69, caption: '每天 0:00 重置（北京时间）' }, { label: '本周', value: 0.62, caption: '10月20日 0:00 重置（北京时间）' }] },
        { type: 'button', id: 'reset', title: '额度重置卡', desc: '持有 2 张，用一张把今日和本周的 AI 额度恢复到 100%', buttons: [{ label: '使用一张', confirm: { title: '使用一张额度重置卡？', confirmLabel: '使用', danger: false }, onClick: () => setLog('用了一张重置卡') }] },
        { type: 'stepper', id: 'buy', title: '用积分兑换', desc: '每张 100 积分，一次 1–50 张', value: cards, min: 1, max: 50, onChange: setCards, button: { label: `兑换 · ${cards * 100} 积分`, onClick: (n) => setLog(`兑换 ${n} 张`) } },
      ] },
      { id: 'credits', icon: 'coins', title: '积分', desc: '积分可以兑换额度重置卡', actions: [{ label: '充值积分', kind: 'primary', onClick: () => setLog('充值') }], items: [
        { type: 'value', id: 'balance', title: '余额', value: '1,280' },
      ] },
      { id: 'bg', icon: 'clock', title: '后台额度', desc: 'Muse 与自动化使用，和 AI 额度分开计算', items: [
        { type: 'meters', id: 'm', meters: [{ label: '今日', value: 0.84, caption: '每天 0:00 重置' }, { label: '本周', value: 0.75, caption: '10月20日 0:00 重置' }] },
        { type: 'switch', id: 'fallback', title: '用完后改用 AI 额度继续', desc: '关着时，后台额度用完后 Muse 与自动化会暂停', value: fallback, onChange: setFallback },
        { type: 'choice', id: 'convert', title: '从 AI 额度转入', desc: '按 AI 额度上限的比例转入，本周期内有效', button: '转入…', sheetTitle: '从 AI 额度转入（本周期内有效）',
          options: [{ value: '5', label: '转入 5%', detail: '后台额度 +50,000' }, { value: '10', label: '转入 10%', detail: '后台额度 +100,000' }, { value: '20', label: '转入 20%', detail: '后台额度 +200,000' }], onPick: (v) => setLog(`转入 ${v}%`) },
        { type: 'segmented', id: 'mode', title: '转入方式', value: 'manual', options: [{ value: 'manual', label: '手动' }, { value: 'auto', label: '自动' }], onChange: () => undefined },
      ] },
      { id: 'invite', icon: 'gift', title: '邀请与兑换', desc: '邀请好友注册，或兑换你收到的码', items: [
        { type: 'code', id: 'code', title: '我的邀请码', desc: '已邀请 3 人', value: 'FX7Q2M', copyLabel: '复制' },
        { type: 'input', id: 'redeem', title: '兑换码', desc: '兑换积分、会员或其他奖励', placeholder: '输入兑换码', button: { label: '兑换', onClick: (v) => setLog(`兑换码 ${v}`) } },
      ] },
    ],
  }
  return <><SettingsPage schema={schema} />{log && <p className="hint" data-parts-log>{log}</p>}</>
}

/**
 * ?phone:手机操控的设置行只在真机注册(installPhoneControl 要 Capacitor 原生)。台架抢先给 PhoneControl 挂一个
 * 假 web 实现(Capacitor 同名插件先注册者赢),再按生产的组件与状态源登记 surface —— 开关读的仍是「原生」回报。
 */
async function mountPhoneRow(): Promise<void> {
  let enabled = false
  registerPlugin('PhoneControl', {
    web: {
      status: async () => ({ enabled, capabilities: enabled ? ['phone.intents'] : [], foreground: true, proto: 1 }),
      setEnabled: async (o: { enabled: boolean }) => { enabled = o.enabled; return { enabled } },
      configure: async () => ({}),
      exec: async () => ({ accepted: false }),
    },
  })
  const [{ setPhoneControlEnabled }, { PhoneControlRow }] = await Promise.all([import('./phoneControl'), import('./PhoneControlRow')])
  registerClientSurface('phone', { capabilities: () => [], exec: () => undefined, SettingsRow: PhoneControlRow })
  await setPhoneControlEnabled(false) // 顺带拉一次状态
}

void (phone ? mountPhoneRow() : Promise.resolve()).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider>
      <SettingsHarness />
    </LocaleProvider>,
  )
})
