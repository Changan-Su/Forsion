/** Isolated account UI fixture: no credentials, files, or network mutations. */
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AccountCard } from './components/AccountCard'
import { PluginSettingsCard } from './views/chat2/PluginSettingsCard'
import { CompactionNotice } from './views/chat2/CompactionNotice'
import { usePluginStore } from './amadeus/plugins/pluginStore'
import { useApp } from './stores/appStore'
import { AccountSwitcher } from './components/AccountSwitcher'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import { applyTheme } from './theme/loader'
import type { AuthAccountInfo } from './types'
import './tangu/store/standalone' // 不走 installEngine:自己装 Tangu 的 store 半身(界面热更新 3c);排在最后,别早于上面那些打桩的 import

setLocaleGlobal('zh')
const withRewards = new URLSearchParams(location.search).has('rewards')
const withBg = new URLSearchParams(location.search).has('bg')
applyTheme('lovable', 'cream', 'paper', 'light')
const accounts: AuthAccountInfo[] = [
  { id: 'alice', cloudUrl: 'https://example.test', username: 'Alice', active: true },
  { id: 'bob', cloudUrl: 'https://example.test', username: 'Bob', active: false },
]
let active = 'alice'
const listeners = new Set<(value: { loggedIn: boolean }) => void>()
function emit() { for (const cb of listeners) cb({ loggedIn: !!active }) }
const bridge: Partial<NonNullable<Window['tangu']>> = {
  authStatus: async () => ({ loggedIn: !!active, cloudUrl: 'https://example.test', tokenSource: active ? 'tangu-login' : null, username: accounts.find((a) => a.id === active)?.username || null }),
  authAccounts: async () => accounts.map((a) => ({ ...a, active: a.id === active })),
  forsionSwitchAccount: async (id) => { active = id; emit(); return { ok: true, cloudUrl: 'https://example.test' } },
  forsionLogin: async () => { throw new Error('Test fixture: open the sign-in page to choose another account') },
  forsionLogout: async () => { const i = accounts.findIndex((a) => a.id === active); if (i >= 0) accounts.splice(i, 1); active = ''; emit(); return { ok: true } },
  onAuthChanged: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  ...(withRewards ? { cloudInvoke: async () => ({ ok: true }), cloudFetch: async ({ path }: { path: string }) => ({ status: 200, json: path === '/credits/balance' ? { balance: active === 'alice' ? 1280 : 0 } : { code: 'DEMO' } }) } : {}),
  accountQuota: async () => ({ status: 200, json: {
    dailyPercent: 10, weeklyPercent: 25, dailyLimit: 100, weeklyLimit: 500, weeklyResetAt: '2026-09-28',
    // ?bg:服务端带回后台额度(Muse / 自动化那一桶),菜单「额度剩余」下多一行「后台智能体」
    ...(withBg ? { background: { modelId: 'm-cheap', sharePercent: 15, dailyLimit: 15, dailyRemaining: 9, weeklyLimit: 75, weeklyRemaining: 60 } } : {}),
  } }),
  // 后台那一行只在有本地引擎(Muse 能跑)的宿主上出现
  ...(withBg ? { backendStatus: (async () => ({ state: 'running' })) as unknown as NonNullable<Window['tangu']>['backendStatus'] } : {}),
}
window.tangu = bridge as NonNullable<Window['tangu']>

if (withRewards) {
  usePluginStore.setState({ activeIds: ['forsion-extend'], settingsViews: ['points', 'backpack'].map(id => ({ pluginId: 'forsion-extend', item: { id, category: 'forsion', mount() {} } })) })
  useApp.setState({ openSettings: (target: string) => { document.documentElement.dataset.settingsTarget = target } } as any)
}
function Harness() {
  const [message, setMessage] = useState('Test accounts only')
  return <div style={{ padding: 32 }}>
    <h2>Account switching regression</h2>
    <div style={{ maxWidth: 650, padding: 24, background: 'var(--bg-card)', borderRadius: 'var(--radius-md)' }}>
      <AccountSwitcher busy={false}
        onSelect={(id) => { void window.tangu!.forsionSwitchAccount!(id); setMessage(`Switched to ${id}`) }}
        onAdd={() => setMessage('Open sign-in page')} />
    </div>
    {withRewards && <div style={{ maxWidth: 650, marginTop: 24 }}>
      <PluginSettingsCard event={{ name: 'read_plugin_settings', done: true, id: 'probe', arguments: '{}', result: '<ui_data_123abc command="read_plugin_settings">\n' + JSON.stringify({ kind: 'plugin_settings', source: 'ui', plugin: { id: 'latex-suite', name: 'LaTeX Suite', version: '1.1' }, fields: [{ key: 'enabled', description: 'Enable expansions', type: 'boolean', scope: 'device', value: true }, { key: 'token', description: 'API key configured', type: 'secret', scope: 'account', configured: true }] }) + '\n</ui_data_123abc>' } as any} />
      <CompactionNotice sessionId="probe" message={{ content: '', compaction: { operationId: 'op', runId: 'run', status: 'running', reason: 'idle', idleMinutes: 60, skippable: true } } as any} />
    </div>}
    <output role="status">{message}</output>
    <div style={{ position: 'fixed', bottom: 32, left: 32, width: 260 }}>
      <AccountCard onToast={setMessage} onAuthChange={() => setMessage(active ? `Active: ${active}` : 'Signed out')} />
    </div>
  </div>
}
createRoot(document.getElementById('root')!).render(<LocaleProvider><Harness /></LocaleProvider>)
