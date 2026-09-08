/** Isolated account UI fixture: no credentials, files, or network mutations. */
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AccountCard } from './components/AccountCard'
import { AccountSwitcher } from './components/AccountSwitcher'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import { applyTheme } from './theme/loader'
import type { AuthAccountInfo } from './types'

setLocaleGlobal('zh')
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
  accountQuota: async () => ({ status: 200, json: { dailyPercent: 10, weeklyPercent: 25, dailyLimit: 100, weeklyLimit: 500 } }),
}
window.tangu = bridge as NonNullable<Window['tangu']>

function Harness() {
  const [message, setMessage] = useState('Test accounts only')
  return <div style={{ padding: 32 }}>
    <h2>Account switching regression</h2>
    <div style={{ maxWidth: 650, padding: 24, background: 'var(--bg-card)', borderRadius: 'var(--radius-md)' }}>
      <AccountSwitcher busy={false}
        onSelect={(id) => { void window.tangu!.forsionSwitchAccount!(id); setMessage(`Switched to ${id}`) }}
        onAdd={() => setMessage('Open sign-in page')} />
    </div>
    <output role="status">{message}</output>
    <div style={{ position: 'fixed', bottom: 32, left: 32, width: 260 }}>
      <AccountCard onToast={setMessage} onAuthChange={() => setMessage(active ? `Active: ${active}` : 'Signed out')} />
    </div>
  </div>
}
createRoot(document.getElementById('root')!).render(<LocaleProvider><Harness /></LocaleProvider>)
