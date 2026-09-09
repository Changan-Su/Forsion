/**
 * P2 邀请接受页(/invite/<token>):需登录(main.tsx 已保证),不加载主应用。
 * 页面级共享:显示页名/邀请人/角色;设了查看密码则先输密码;同意后活动库切到对方库并回应用根。
 */
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getApiBase, getToken } from './webShim'
import { ACTIVE_VAULT_KEY } from './amadeus/cloudBridge'
import { contentStorageKey } from '@lcl/engine/contentStorageScope'
import { registerMessages, translate } from '@/i18n'

registerMessages({
  'invite.title': { zh: '加入共享页面', en: 'Join a shared page' },
  'invite.unavailable': { zh: '邀请不存在、已撤销或已过期', en: 'This invitation is unavailable or has expired' },
  'invite.loadFailed': { zh: '加载失败（{status}）', en: 'Could not load the invitation ({status})' },
  'invite.networkError': { zh: '网络错误', en: 'Connection failed' },
  'invite.passwordError': { zh: '密码不正确', en: 'Incorrect password' },
  'invite.ownPage': { zh: '这是你自己的页面', en: 'You own this page' },
  'invite.acceptFailed': { zh: '接受失败，邀请可能已失效', en: 'Could not accept this invitation; it may have expired' },
  'invite.cannotJoin': { zh: '无法加入', en: 'Unable to join' },
  'invite.loading': { zh: '加载中…', en: 'Loading…' },
  'invite.from': { zh: '{name} 邀请你参与', en: '{name} invited you to join' },
  'invite.invited': { zh: '你被邀请参与', en: 'You have been invited to join' },
  'invite.readOnly': { zh: '只读', en: 'Read only' },
  'invite.editable': { zh: '可编辑', en: 'Can edit' },
  'invite.children': { zh: '含子页面', en: 'Includes subpages' },
  'invite.password': { zh: '查看密码', en: 'Access password' },
  'invite.joining': { zh: '加入中…', en: 'Joining…' },
  'invite.accept': { zh: '同意并加入', en: 'Accept and join' },
})

export interface InvitePageOptions {
  apiBase: string
  getToken(): string
  request(path: string, init?: RequestInit): Promise<Response>
  appBase: string
}

const CSS = `
:root { color-scheme: light dark; }
body { margin: 0; }
.inv { min-height: 100vh; display: grid; place-items: center; background: #faf9f7; color: #2a2a2e; font: 15px/1.7 -apple-system, "PingFang SC", "Segoe UI", Roboto, sans-serif; }
.inv-card { width: min(420px, calc(100vw - 48px)); padding: 32px 32px 28px; border: 1px solid rgba(127,127,127,.2); border-radius: 16px; background: #fff; box-shadow: 0 8px 32px rgba(0,0,0,.06); text-align: center; }
.inv-card h1 { font-size: 19px; margin: 0 0 8px; }
.inv-card p { margin: 6px 0; opacity: .8; font-size: 14px; }
.inv-role { display: inline-block; margin: 6px 0 2px; padding: 2px 12px; border-radius: 999px; background: rgba(76,110,245,.12); color: #4c6ef5; font-size: 12.5px; }
.inv-pw { margin-top: 14px; width: 100%; padding: 9px 12px; border: 1px solid rgba(127,127,127,.3); border-radius: 10px; font: 14px inherit; background: transparent; color: inherit; outline: none; text-align: center; }
.inv-pw:focus { border-color: #4c6ef5; }
.inv-btn { margin-top: 14px; width: 100%; padding: 10px 0; border: 0; border-radius: 10px; background: #4c6ef5; color: #fff; font: 600 14px inherit; cursor: pointer; }
.inv-btn:disabled { opacity: .6; cursor: default; }
.inv-err { color: #c03030; }
@media (prefers-color-scheme: dark) {
  .inv { background: #1d1d21; color: #d7d7dc; }
  .inv-card { background: #26262b; border-color: rgba(127,127,127,.25); box-shadow: none; }
  .inv-role { background: rgba(142,164,248,.16); color: #8ea4f8; }
}
`

function InviteApp({ token, account, activeVaultKey }: { token: string; account: InvitePageOptions; activeVaultKey: string }): React.ReactElement {
  const api = account.apiBase
  const [info, setInfo] = useState<{ title: string; role: string; ownerName: string | null; needPassword: boolean } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void account.request(`${api}/amadeus/invites/${encodeURIComponent(token)}`, {
      headers: { Authorization: `Bearer ${account.getToken()}` },
    }).then(async (r) => {
      if (!r.ok) { setErr(r.status === 404 ? translate('invite.unavailable') : translate('invite.loadFailed', { status: r.status })); return }
      setInfo(await r.json())
    }).catch(() => setErr(translate('invite.networkError')))
  }, [account, api, token])

  const accept = (): void => {
    setBusy(true)
    void account.request(`${api}/amadeus/invites/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(info?.needPassword ? { password: pw } : {}),
    }).then(async (r) => {
      if (!r.ok) {
        const b = await r.json().catch(() => null) as { detail?: string; code?: string } | null
        setErr(translate(b?.code === 'PASSWORD' ? 'invite.passwordError' : b?.detail === 'you own this page' ? 'invite.ownPage' : 'invite.acceptFailed'))
        setBusy(false)
        return
      }
      const { vaultId } = (await r.json()) as { vaultId: string; path: string }
      try { localStorage.setItem(activeVaultKey, vaultId) } catch { /* ignore */ }
      location.replace(account.appBase) // Return to the owning projection with its account-scoped vault selection.
    }).catch(() => { setErr(translate('invite.networkError')); setBusy(false) })
  }

  return (
    <div className="inv">
      <div className="inv-card">
        {err && !info ? (
          <>
            <h1>{translate('invite.cannotJoin')}</h1>
            <p className="inv-err">{err}</p>
          </>
        ) : !info ? (
          <p>{translate('invite.loading')}</p>
        ) : (
          <>
            <h1>{translate('invite.title')}</h1>
            <p>{info.ownerName ? translate('invite.from', { name: info.ownerName }) : translate('invite.invited')}</p>
            <p style={{ fontSize: 17, fontWeight: 600, opacity: 1 }}>「{info.title}」</p>
            <span className="inv-role">{translate(info.role === 'viewer' ? 'invite.readOnly' : 'invite.editable')} · {translate('invite.children')}</span>
            {info.needPassword && (
              <input
                className="inv-pw"
                type="password"
                placeholder={translate('invite.password')}
                value={pw}
                onChange={(e) => { setPw(e.target.value); setErr(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter' && (pw || !info.needPassword)) accept() }}
              />
            )}
            {err && <p className="inv-err">{err}</p>}
            <button className="inv-btn" disabled={busy || (info.needPassword && !pw)} onClick={accept}>
              {translate(busy ? 'invite.joining' : 'invite.accept')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export function mountInvitePage(token: string, options?: InvitePageOptions): void {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  document.title = `${translate('invite.title')} · Forsion`
  const el = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'))
  const account = options ?? { apiBase: getApiBase(), getToken, request: fetch, appBase: '/' }
  createRoot(el).render(<InviteApp token={token} account={account} activeVaultKey={contentStorageKey(ACTIVE_VAULT_KEY)} />)
}
