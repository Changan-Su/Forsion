/**
 * Dev-only visual harness:设置 → 远程会话 → 急停与远程锁定(P1 · K2)—— 真 RemoteSessionsSettings(K4 页)+ 经扩展槽挂进来的
 * 真 RemoteSafetyPanel + 生产 CSS;window.tangu.remoteSessions / remoteSafety 都是桩,不连主进程。
 * ?dark / ?lang=en / ?skin=<cream|coral|teal|lavender|zhi> / ?width=<px>(窄栏) /
 * ?state=idle(缺省:未锁、没有远程任务)| running(三条远程任务,一条等批准)| locked(已锁定 + 写盘失败 + 待补发)| hotkeyfail(热键被占用)
 * 截图:scripts/remote-safety-settings.check.cjs(DESIGN §8:观感改动交付前看真截图)。
 */
import { createRoot } from 'react-dom/client'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import { applyTheme } from './theme/loader'
import { RemoteSessionsSettings } from './components/RemoteSessionsSettings'
import type { RemoteSessionsApi, RemoteSessionsView } from '../../shared/remoteSessions'
import type { RemoteSafetyApi, RemoteSafetyState } from '../../shared/remoteSafety'

const params = new URLSearchParams(location.search)
const dark = params.has('dark')
setLocaleGlobal(params.get('lang') === 'en' ? 'en' : 'zh')
const skin = params.get('skin') || 'cream'
applyTheme('lovable', skin, skin, dark ? 'dark' : 'light')
const state = params.get('state') || 'idle'
const now = Date.now()

const view: RemoteSessionsView = {
  hostEnabled: true, enabled: true, permitted: true, maxApprovalMode: 'auto-edit', pending: [], accountEntry: 'trusted',
  trusted: [
    { principal: 'account', confirmedAt: now - 3 * 86_400_000, preconfirmed: true },
    { principal: 'unit', unitId: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f', name: 'Pixel 9', kind: 'phone', platform: 'android', registeredAt: '2026-09-20T08:00:00.000Z', confirmedAt: now - 40 * 60_000 },
  ],
}
const remoteSessions: RemoteSessionsApi = {
  get: async () => view, setEnabled: async () => view, setMaxApprovalMode: async () => view, revoke: async () => view, allowAccount: async () => view,
  onChanged: () => () => {},
}

let st: RemoteSafetyState = {
  locked: state === 'locked', lockedAt: state === 'locked' ? now - 4 * 60_000 : null, lockSource: state === 'locked' ? 'hotkey' : null,
  lockPersistFailed: state === 'locked', pendingEstop: state === 'locked',
  hotkey: state === 'hotkeyfail' ? { accelerator: 'Control+Alt+Shift+.', registered: false, error: 'in_use' } : { accelerator: 'Control+Alt+Shift+.', registered: true, error: null },
  engine: 'connected',
  remoteRuns: state === 'running' || state === 'locked' ? [
    { runId: 'r1', sessionId: 's1', category: 'remote', label: '小米 14 Ultra · 口袋里的那台（名字很长很长的一台手机）', pendingApprovals: 1, pendingInquiries: 0, startedAt: now - 12 * 60_000 },
    { runId: 'r2', sessionId: 's2', category: 'channel', label: params.get('lang') === 'en' ? 'WeChat' : '微信', pendingApprovals: 0, pendingInquiries: 0, startedAt: now - 3 * 60_000 },
    { runId: 'r3', sessionId: 's3', category: 'unattended', label: 'Muse', pendingApprovals: 0, pendingInquiries: 0, startedAt: now - 40_000 },
  ] : [],
  lastEstop: null,
}
const listeners = new Set<(s: RemoteSafetyState) => void>()
const push = (): RemoteSafetyState => { for (const cb of listeners) cb(st); return st }
const remoteSafety: RemoteSafetyApi = {
  get: async () => st,
  estop: async () => { st = { ...st, locked: true, lockedAt: Date.now(), lockSource: 'settings', remoteRuns: [] }; return push() },
  unlock: async () => { st = { ...st, locked: false, lockedAt: null, lockSource: null, lockPersistFailed: false, pendingEstop: false }; push(); return { ok: true } },
  setHotkey: async (acc) => { st = { ...st, hotkey: acc ? { accelerator: acc, registered: true, error: null } : { accelerator: '', registered: false, error: 'disabled' } }; push(); return st.hotkey },
  onChanged: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
}
window.tangu = {
  platform: 'darwin', remoteSessions, remoteSafety,
  secretStorageStatus: async () => ({ level: 'os', backend: 'keychain', locked: [], restartRequired: false, lastError: null }),
} as unknown as NonNullable<Window['tangu']>

const width = Number(params.get('width')) || 820
createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <section className="settings-main" style={{ maxWidth: width, margin: '0 auto' }}>
      <div className="settings-body">
        <div className="settings-sub settings-sub--remote-sessions">
          <RemoteSessionsSettings />
        </div>
      </div>
    </section>
  </LocaleProvider>,
)
