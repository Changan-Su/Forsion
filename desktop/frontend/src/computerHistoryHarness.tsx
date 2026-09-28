/**
 * Dev-only visual harness:设置 → 电脑历史 —— 真 ComputerHistorySettings + 生产 CSS;window.tangu.computerHistory 与
 * 权限快照都是桩,不连主进程、不碰 helper。?dark / ?lang=en / ?status=<ComputerHistoryStatus> / ?empty(无最近 App 与会话)
 * / ?skin=<cream|coral|teal|lavender|zhi>(主题色与背景色同取这一套;缺省 cream)。
 * 截图:浏览器打开 /computer-history-harness.html,或用 Playwright 按上面的参数逐张拍(DESIGN §8:观感改动交付前看真截图)。
 */
import { createRoot } from 'react-dom/client'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import { applyTheme } from './theme/loader'
import { ComputerHistorySettings } from './components/ComputerHistorySettings'
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
let exclude: ComputerHistoryExclude = { apps: empty ? [] : ['com.apple.Health', 'com.moneymoney-app.retail'], domains: empty ? [] : ['bank.example.com'] }
let enabled = status !== 'off'
let pausedUntil: number | null = status === 'paused' ? now + 45 * MIN : null
let current: ComputerHistoryStatus = status

let rev = 0
const view = (): ComputerHistoryView => ({
  state: { v: 1, enabled, pausedUntil, status: current, since: now - 95 * MIN, updatedAt: now, platform: 'darwin', dataGen: 0 },
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

const listeners = new Set<(v: ComputerHistoryView) => void>()
const push = (): ComputerHistoryView => { const v = view(); for (const cb of listeners) cb(v); return v }
const computerHistory: ComputerHistoryApi = {
  get: async () => view(),
  setEnabled: async (on) => { enabled = on; pausedUntil = null; current = on ? (status === 'off' ? 'recording' : status) : 'off'; return push() },
  pause: async (until) => { pausedUntil = until === 'tomorrow' ? new Date(now).setHours(24, 0, 0, 0) : Date.now() + until; current = 'paused'; return push() },
  resume: async () => { pausedUntil = null; current = 'recording'; return push() },
  clear: async () => view(),
  setExclude: async (next) => { exclude = next; return push() },
  recent: async (hours, end = Date.now()) => sessions.filter((s) => s.end >= end - hours * 60 * MIN && s.start < end),
  recentApps: async () => recentApps,
  // 台架拿不到真图标:两枚色块代表「取到了」,其余走首字母兜底
  appIcons: async (ids) => Object.fromEntries(ids.map((id) => [id, FAKE_ICONS[id] ?? null])),
  reveal: async () => {},
  onChanged: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
}
const snapshot: DesktopPermissionsSnapshot = {
  platform: 'darwin', appName: 'Forsion', computerUseAvailable: true,
  helperInstalled: status !== 'helper_missing', helperRunning: status !== 'helper_missing',
  ...(status === 'helper_missing' ? { helperError: 'not-installed' as const } : {}),
  permissions: {
    // 助手没装时读不到授权状态(真机同样显示「状态未知」)
    computerAccessibility: status === 'no_permission' ? 'denied' : status === 'helper_missing' ? 'unknown' : 'granted', computerScreen: 'unverified',
    microphone: 'granted', camera: 'granted', screen: 'granted',
  },
}
window.tangu = {
  platform: 'darwin',
  computerHistory,
  desktopPermissionsStatus: async () => snapshot,
  desktopPermissionRequest: async () => snapshot,
  desktopPermissionsCloseGuide: async () => {},
} as unknown as NonNullable<Window['tangu']>

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <section className="settings-main" style={{ maxWidth: 820, margin: '0 auto' }}>
      <div className="settings-body">
        <div className="settings-sub settings-sub--computer-history">
          <ComputerHistorySettings mode={dark ? 'dark' : 'light'} anchor="computer-history" />
        </div>
      </div>
    </section>
  </LocaleProvider>,
)
