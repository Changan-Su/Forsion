/**
 * Dev-only visual harness:设置 → 远程会话(P1 · K4)—— 真 RemoteSessionsSettings + 生产 CSS;window.tangu.remoteSessions 是桩,
 * 不连主进程。?dark / ?lang=en / ?skin=<cream|coral|teal|lavender|zhi> /
 * ?state=on(缺省:开、有信任设备与待确认项)| off | nohost(父开关关)| insecure(设备凭据未加密)| fullauto(审批档已是全自动)| empty(无设备)
 *   | strict(「本账号的浏览器与网页版」已撤销 = D8 严格档)| signedout(本机没登录)
 * / ?width=<px>(窄栏)。截图:scripts/remote-sessions-settings.check.cjs(DESIGN §8:观感改动交付前看真截图)。
 */
import { createRoot } from 'react-dom/client'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import { applyTheme } from './theme/loader'
import { RemoteSessionsSettings } from './components/RemoteSessionsSettings'
import type { CapMode, RemoteSessionsApi, RemoteSessionsView } from '../../shared/remoteSessions'

const params = new URLSearchParams(location.search)
const dark = params.has('dark')
setLocaleGlobal(params.get('lang') === 'en' ? 'en' : 'zh')
const skin = params.get('skin') || 'cream'
applyTheme('lovable', skin, skin, dark ? 'dark' : 'light')
const state = params.get('state') || 'on'
const now = Date.now()

let view: RemoteSessionsView = {
  hostEnabled: state !== 'nohost',
  enabled: state !== 'off' && state !== 'nohost',
  permitted: state === 'nohost' ? null : state !== 'insecure', // 父开关关着时主进程不问 K5(null = 未知)
  maxApprovalMode: state === 'fullauto' ? 'full-auto' : 'auto-edit',
  trusted: state === 'empty' || state === 'signedout' ? [] : [
    ...(state === 'strict' ? [] : [{ principal: 'account' as const, confirmedAt: now - 3 * 86_400_000, preconfirmed: true }]),
    { principal: 'unit', unitId: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f', name: '小米 14 Ultra · 口袋里的那台（名字很长很长的一台手机）', kind: 'phone', platform: 'android', registeredAt: '2026-09-20T08:00:00.000Z', confirmedAt: now - 40 * 60_000 },
    { principal: 'unit', unitId: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e61', name: 'Studio iMac', kind: 'desktop', platform: 'darwin', registeredAt: '2026-08-02T08:00:00.000Z', confirmedAt: now - 5 * 86_400_000 },
  ],
  pending: state === 'on' ? [{ principal: 'unit', unitId: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e62', name: 'Pixel 9', kind: 'phone', since: now - 20_000 }] : [],
  accountEntry: state === 'signedout' ? null : state === 'strict' ? 'strict' : state === 'empty' ? 'none' : 'trusted',
}
const listeners = new Set<(v: RemoteSessionsView) => void>()
const push = (): RemoteSessionsView => { for (const cb of listeners) cb(view); return view }
const remoteSessions: RemoteSessionsApi = {
  get: async () => view,
  setEnabled: async (on) => { view = { ...view, enabled: on }; return push() },
  setMaxApprovalMode: async (m: CapMode) => { view = { ...view, maxApprovalMode: m }; return push() },
  revoke: async (p) => {
    view = { ...view, trusted: view.trusted.filter((r) => (r.principal === 'account' ? p !== 'account' : r.unitId !== p)), ...(p === 'account' ? { accountEntry: 'strict' as const } : {}) }
    return push()
  },
  allowAccount: async () => {
    view = { ...view, accountEntry: 'trusted', trusted: [{ principal: 'account', confirmedAt: Date.now(), preconfirmed: false }, ...view.trusted.filter((r) => r.principal !== 'account')] }
    return push()
  },
  onChanged: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
}
window.tangu = {
  platform: 'darwin',
  remoteSessions,
  secretStorageStatus: async () => (state === 'insecure'
    ? { level: 'plaintext', backend: 'basic_text', locked: [], restartRequired: false, lastError: null }
    : { level: 'os', backend: 'keychain', locked: [], restartRequired: false, lastError: null }),
} as unknown as NonNullable<Window['tangu']>
;(window as unknown as { __rs: { view: () => RemoteSessionsView } }).__rs = { view: () => view }

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
