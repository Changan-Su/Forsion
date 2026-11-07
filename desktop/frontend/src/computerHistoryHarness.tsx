/**
 * Dev-only visual harness:电脑历史 —— 真组件 + 生产 CSS;window.tangu.computerHistory 与权限快照都是桩,不连主进程、不碰 helper。
 * 缺省 = 设置 → 电脑历史(真 ComputerHistorySettings)。?dark / ?lang=en / ?status=<ComputerHistoryStatus> / ?empty(无最近 App 与会话)
 * / ?skin=<cream|coral|teal|lavender|zhi>(主题色与背景色同取这一套;缺省 cream)/ ?platform=win32(Windows 版:无权限卡、Windows 文案)。
 * / ?ask(主页输入框下面那一行:真 ComputerHistoryAsk,本机记号预置成 pending;「开启…」弹共用的 ComputerHistoryDialog 同意说明。
 *   它只在电脑历史关着、从没动过时出现 → 配 ?status=off;?touched = 动过(dataGen 1,那一行不出);?failEnable = 「开启记录」写失败)。
 * / ?dialog(首启引导团队屏「详情」那一下:同一个 ComputerHistoryDialog 只看说明,一进来就开着;关掉后 [data-open-details] 再打开)。
 * 桩把 desktopPermissionRequest 的调用记在 window.__permissionRequests(主页那一行开成后,macOS 接着请辅助功能)。
 * 截图:浏览器打开 /computer-history-harness.html,或用 Playwright 按上面的参数逐张拍(DESIGN §8:观感改动交付前看真截图)。
 * 检查:设置页 npm run check:computerhistory;主页那一行 + 共用弹窗 npm run check:onboardinghistory。
 */
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import { applyTheme } from './theme/loader'
import { ComputerHistorySettings } from './components/ComputerHistorySettings'
import { ComputerHistoryAsk } from './components/ComputerHistoryAsk'
import { ComputerHistoryDialog } from './components/ComputerHistoryDialog'
import { CH_ASK_KEY } from './components/computerHistoryAskMark'
import { useComputerHistory } from './components/useComputerHistory'
import type {
  ComputerHistoryApi, ComputerHistoryExclude, ComputerHistorySession, ComputerHistoryStatus, ComputerHistoryView,
} from '../../shared/computerHistory'
import type { DesktopPermissionsSnapshot } from './types'

const params = new URLSearchParams(location.search)
const dark = params.has('dark')
setLocaleGlobal(params.get('lang') === 'en' ? 'en' : 'zh')
const skin = params.get('skin') || 'cream'
applyTheme('lovable', skin, skin, dark ? 'dark' : 'light')

const MIN = 60_000
const now = Date.now()
const status = (params.get('status') || 'recording') as ComputerHistoryStatus
const empty = params.has('empty')
const platform = params.get('platform') === 'win32' ? 'win32' : 'darwin'
let exclude: ComputerHistoryExclude = { apps: empty ? [] : ['com.apple.Health', 'com.moneymoney-app.retail'], domains: empty ? [] : ['bank.example.com'] }
let enabled = status !== 'off'
let pausedUntil: number | null = status === 'paused' ? now + 45 * MIN : null
let current: ComputerHistoryStatus = status

const touched = params.has('touched')
const failEnable = params.has('failEnable')

let rev = 0
const view = (): ComputerHistoryView => ({
  state: { v: 1, enabled, pausedUntil, status: current, since: now - 95 * MIN, updatedAt: now, platform, dataGen: touched ? 1 : 0, userTurnedOff: false },
  exclude: { apps: [...exclude.apps], domains: [...exclude.domains] },
  root: '/Users/me/.forsion-dev/computer-history',
  keepDays: 7,
  rev: ++rev, // 设置页只收更新的版本:每次快照都要比上一份大
})
// 时间都落在「今天」:晚于本地零点(harness 在凌晨跑也不至于全被过滤掉)。
const dayStart = new Date(now).setHours(0, 0, 0, 0)
const at = (minsAgo: number): number => Math.max(dayStart + MIN, now - minsAgo * MIN)
const sessions: ComputerHistorySession[] = empty ? [] : [
  { start: at(12), end: at(1), app: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode', title: 'ComputerHistorySettings.tsx — computer-history — a very long workspace name that should be truncated', typed: ['x'] },
  { start: at(25), end: at(12), app: 'Google Chrome', bundleId: 'com.google.Chrome', title: 'Accessibility Programming Guide for OS X: Accessibility Notifications', url: 'https://developer.apple.com/library/archive/documentation/Accessibility', typed: [] },
  { start: at(40), end: at(25), app: '备忘录', bundleId: 'com.apple.Notes', title: '周末采购清单', typed: ['牛奶'] },
  { start: at(55), end: at(40), app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', title: 'design-review (Channel) - Forsion - 2 new items', typed: [] },
  { start: at(80), end: at(55), app: 'Safari', bundleId: 'com.apple.Safari', title: 'Docs', url: 'https://docs.example.com/guide/getting-started', typed: [] },
  { start: at(120), end: at(80), app: 'Microsoft Word', bundleId: 'com.microsoft.Word', title: 'Q3 季度复盘（草稿）.docx', typed: [] },
  // 同一段里穿插的短停留:时间线按停留时长排,短的排后面
  { start: at(9), end: at(7), app: '微信', bundleId: 'com.tencent.xinWeChat', title: '微信', typed: [] },
  { start: at(33), end: at(30), app: 'Finder', bundleId: 'com.apple.finder', title: 'Downloads', typed: [] },
  { start: at(95), end: at(93), app: '1Password', bundleId: 'com.1password.1password', typed: [] }, // 排除的 App:只有图标
  // 昨天(按天回看):下午一段文档 + 浏览器
  { start: dayStart - 9 * 60 * MIN, end: dayStart - 8.5 * 60 * MIN, app: 'Microsoft Word', bundleId: 'com.microsoft.Word', title: '周报 09-27.docx', typed: [] },
  { start: dayStart - 8.5 * 60 * MIN, end: dayStart - 8.3 * 60 * MIN, app: 'Google Chrome', bundleId: 'com.google.Chrome', title: 'Forsion Admin', url: 'https://admin.forsion.net/users', typed: [] },
]
const recentApps = empty ? [] : [
  { name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode' },
  { name: 'Google Chrome', bundleId: 'com.google.Chrome' },
  { name: '备忘录', bundleId: 'com.apple.Notes' },
  { name: 'Health', bundleId: 'com.apple.Health' },
]

const fakeIcon = (color: string): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="7" fill="${color}"/></svg>`)}`
const FAKE_ICONS: Record<string, string> = { 'com.microsoft.VSCode': fakeIcon('#2f80ed'), 'com.google.Chrome': fakeIcon('#e8453c') }

const harnessWindow = window as unknown as { __chGets?: number; __chSetEnabled?: number; __permissionRequests?: string[] }
const listeners = new Set<(v: ComputerHistoryView) => void>()
const push = (): ComputerHistoryView => { const v = view(); for (const cb of listeners) cb(v); return v }
const computerHistory: ComputerHistoryApi = {
  // 读了几次:台架等「读回来了、那一行仍没出」时靠它,不靠干等
  get: async () => { harnessWindow.__chGets = (harnessWindow.__chGets || 0) + 1; return view() },
  setEnabled: async (on) => {
    harnessWindow.__chSetEnabled = (harnessWindow.__chSetEnabled || 0) + 1 // 只看说明不该写:台架核它为 0
    if (on && failEnable) throw new Error('simulated write failure')
    enabled = on; pausedUntil = null; current = on ? (status === 'off' ? 'recording' : status) : 'off'; return push() },
  pause: async (until) => { pausedUntil = until === 'tomorrow' ? new Date(now).setHours(24, 0, 0, 0) : Date.now() + until; current = 'paused'; return push() },
  resume: async () => { pausedUntil = null; current = 'recording'; return push() },
  clear: async () => view(),
  setExclude: async (next) => { exclude = next; return push() },
  recent: async (hours, end = Date.now()) => sessions.filter((s) => s.end >= end - hours * 60 * MIN && s.start < end),
  recentApps: async () => recentApps,
  days: async () => [...new Set(sessions.map((s) => { const d = new Date(s.start); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }))].sort().reverse(),
  // 台架拿不到真图标:两枚色块代表「取到了」,其余走首字母兜底
  appIcons: async (ids) => Object.fromEntries(ids.map((id) => [id, FAKE_ICONS[id] ?? null])),
  reveal: async () => {},
  onChanged: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
}
const snapshot: DesktopPermissionsSnapshot = {
  platform, appName: 'Forsion', computerUseAvailable: true,
  helperInstalled: status !== 'helper_missing', helperRunning: status !== 'helper_missing',
  ...(status === 'helper_missing' ? { helperError: 'not-installed' as const } : status === 'helper_outdated' ? { helperError: 'outdated' as const } : {}),
  permissions: {
    // 助手没装时读不到授权状态(真机同样显示「状态未知」)
    computerAccessibility: status === 'no_permission' ? 'denied' : status === 'helper_missing' ? 'unknown' : 'granted', computerScreen: 'unverified',
    microphone: 'granted', camera: 'granted', screen: 'granted',
  },
}
const permissionRequests: string[] = []
harnessWindow.__permissionRequests = permissionRequests
window.tangu = {
  platform,
  computerHistory,
  desktopPermissionsStatus: async () => snapshot,
  desktopPermissionRequest: async (id: string) => { permissionRequests.push(id); return snapshot },
  desktopPermissionsCloseGuide: async () => {},
} as unknown as NonNullable<Window['tangu']>

/** 首启引导团队屏「详情」那一下:只看说明(consent={false}),一进来就开着。 */
function DetailsDialog() {
  const history = useComputerHistory()
  const [open, setOpen] = useState(true)
  return <>
    <button type="button" className="btn ghost" data-open-details="" onClick={() => setOpen(true)}>Details</button>
    <ComputerHistoryDialog history={history} consent={false} open={open} onClose={() => setOpen(false)} />
  </>
}

const mode = params.has('ask') ? 'ask' : params.has('dialog') ? 'dialog' : 'settings'
// 主页那一行只给「跳过了带团队屏的引导」的人:每次进来都把本机记号摆回 pending(上一轮点过 ✕ / 开过也重来)
if (mode === 'ask') localStorage.setItem(CH_ASK_KEY, 'pending')

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    {mode === 'settings'
      ? <section className="settings-main" style={{ maxWidth: 820, margin: '0 auto' }}>
          <div className="settings-body">
            <div className="settings-sub settings-sub--computer-history">
              <ComputerHistorySettings mode={dark ? 'dark' : 'light'} anchor="computer-history" />
            </div>
          </div>
        </section>
      // 主页中间那一栏固定 840 宽,那一行在输入框下面、占满一栏
      : <main data-harness={mode} style={{ width: 'min(840px, calc(100% - 32px))', margin: '160px auto 0' }}>
          {mode === 'ask' ? <ComputerHistoryAsk /> : <DetailsDialog />}
        </main>}
  </LocaleProvider>,
)
