/**
 * P2 邀请接受页(/invite/<token>):需登录(main.tsx 已保证),不加载主应用。
 * 第一次打开走邀请卡(设了查看密码先输密码);已加入或所有者不用再同意;同意后到文件页。
 * 复用 Forsion 的 token,index.html 的首帧脚本已把主题、背景、明暗写到根元素上。
 */
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getApiBase, getToken } from './webShim'
import { fileAddress } from './openTarget'
import { registerMessages, translate } from '@/i18n'
import '@/styles/base.css'
import '@/theme/skins.css'

registerMessages({
  'invite.title': { zh: '加入共享页面', en: 'Join a shared page' },
  'invite.unavailable': { zh: '这个邀请已失效', en: 'This invitation is no longer valid' },
  'invite.unavailableHint': { zh: '可能已到期或已停止共享，请联系邀请你的人重新发送。', en: 'It may have expired or sharing may have stopped. Ask the person who invited you to send a new link.' },
  'invite.loadFailed': { zh: '加载失败（{status}）', en: 'Could not load the invitation ({status})' },
  'invite.networkError': { zh: '网络错误', en: 'Connection failed' },
  'invite.passwordError': { zh: '密码不正确', en: 'Incorrect password' },
  'invite.acceptFailed': { zh: '接受失败，邀请可能已失效', en: 'Could not accept this invitation; it may have expired' },
  'invite.loading': { zh: '加载中…', en: 'Loading…' },
  'invite.from': { zh: '{name} 邀请你参与', en: '{name} invited you to join' },
  'invite.invited': { zh: '你被邀请参与', en: 'You have been invited to join' },
  'invite.readOnly': { zh: '只读', en: 'Read only' },
  'invite.editable': { zh: '可编辑', en: 'Can edit' },
  'invite.children': { zh: '含子页面', en: 'Includes subpages' },
  'invite.password': { zh: '查看密码', en: 'Access password' },
  'invite.joining': { zh: '加入中…', en: 'Joining…' },
  'invite.accept': { zh: '同意并加入', en: 'Accept and join' },
  'invite.opening': { zh: '正在打开 {title}', en: 'Opening {title}' },
  'invite.alreadyJoined': { zh: '你已经加入，不用再同意', en: "You've already joined" },
  'invite.ownPage': { zh: '这是你自己的页面', en: 'This is your page' },
  'invite.openWorkspace': { zh: '打开我的工作区', en: 'Open my workspace' },
  'invite.currentAccount': { zh: '当前账号 {name}', en: 'Signed in as {name}' },
  'invite.switchAccount': { zh: '换个账号', en: 'Switch account' },
})

export interface InvitePageOptions {
  apiBase: string
  getToken(): string
  request(path: string, init?: RequestInit): Promise<Response>
  appBase: string
  accountName?: string
  switchAccount?(): void
}

interface InviteInfo {
  title: string; role: string; ownerName: string | null; needPassword: boolean
  joined?: boolean; owner?: boolean; vaultId?: string; path?: string
}

const CSS = `
body { margin: 0; }
.inv { min-height: 100dvh; box-sizing: border-box; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: var(--ui-font-body) / 1.6 var(--font-ui); }
.inv-card { width: min(360px, 100%); box-sizing: border-box; padding: 20px 18px 16px; border-radius: var(--radius-lg); background: var(--bg-card); box-shadow: var(--card-shadow); }
.inv-who { margin: 0; color: var(--text-muted); font-size: var(--ui-font-meta); }
.inv-card h1 { margin: 4px 0 8px; font-size: var(--ui-font-title); font-weight: 600; overflow-wrap: anywhere; }
.inv-pills { display: flex; flex-wrap: wrap; gap: 4px; }
.inv-pill { padding: 2px 9px; border-radius: var(--radius-pill); background: var(--overlay-light); color: var(--text-muted); font-size: var(--ui-font-meta); }
.inv-pw { box-sizing: border-box; width: 100%; margin-top: 12px; padding: 8px 12px; border: 0; border-radius: var(--radius-md); background: var(--overlay-light); color: inherit; font: inherit; outline: none; }
.inv-pw:focus { box-shadow: 0 0 0 1px var(--sel-line) inset; }
.inv-btn { display: block; box-sizing: border-box; width: 100%; margin-top: 12px; padding: 9px 0; border: 0; border-radius: var(--radius-md); background: var(--action-fill); color: var(--on-action); font: 600 var(--ui-font-body) var(--font-ui); text-align: center; text-decoration: none; cursor: pointer; }
.inv-btn:disabled { opacity: .55; cursor: default; }
.inv-btn.is-soft { background: var(--overlay-light); color: var(--text); font-weight: 400; }
.inv-sub { margin: 10px 0 0; text-align: center; color: var(--text-faint); font-size: var(--ui-font-meta); }
.inv-sub button { padding: 0; border: 0; background: none; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; }
.inv-err { margin: 8px 0 0; color: var(--danger); font-size: var(--ui-font-meta); }
.inv-jump { text-align: center; color: var(--text-muted); }
.inv-jump b { display: block; margin-bottom: 4px; color: var(--text); font-size: var(--ui-font-heading); font-weight: 600; }
`

function InviteApp({ token, account }: { token: string; account: InvitePageOptions }): React.ReactElement {
  const api = account.apiBase
  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [gone, setGone] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void account.request(`${api}/amadeus/invites/${encodeURIComponent(token)}`, {
      headers: { Authorization: `Bearer ${account.getToken()}` },
    }).then(async (r) => {
      if (r.status === 404) { setGone(true); return }
      if (!r.ok) { setErr(translate('invite.loadFailed', { status: r.status })); return }
      const next = await r.json() as InviteInfo
      setInfo(next)
      if (next.vaultId && next.path) location.replace(fileAddress(account.appBase, next.vaultId, next.path))
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
        const b = await r.json().catch(() => null) as { code?: string } | null
        setErr(translate(b?.code === 'PASSWORD' ? 'invite.passwordError' : 'invite.acceptFailed'))
        setBusy(false)
        return
      }
      const { vaultId, path } = (await r.json()) as { vaultId: string; path: string }
      location.replace(fileAddress(account.appBase, vaultId, path))
    }).catch(() => { setErr(translate('invite.networkError')); setBusy(false) })
  }

  const workspace = <a className="inv-btn is-soft" href={account.appBase}>{translate('invite.openWorkspace')}</a>
  if (info?.vaultId) {
    return (
      <div className="inv"><div className="inv-jump">
        <b>{translate('invite.opening', { title: info.title })}</b>
        {translate(info.owner ? 'invite.ownPage' : 'invite.alreadyJoined')}
      </div></div>
    )
  }
  return (
    <div className="inv">
      {gone ? (
        <div className="inv-card">
          <h1>{translate('invite.unavailable')}</h1>
          <p className="inv-who">{translate('invite.unavailableHint')}</p>
          {workspace}
        </div>
      ) : !info ? (
        err ? <div className="inv-card"><p className="inv-err">{err}</p>{workspace}</div> : <div className="inv-jump">{translate('invite.loading')}</div>
      ) : (
        <div className="inv-card">
          <p className="inv-who">{info.ownerName ? translate('invite.from', { name: info.ownerName }) : translate('invite.invited')}</p>
          <h1>{info.title}</h1>
          <div className="inv-pills">
            <span className="inv-pill">{translate(info.role === 'viewer' ? 'invite.readOnly' : 'invite.editable')}</span>
            <span className="inv-pill">{translate('invite.children')}</span>
          </div>
          {info.needPassword && (
            <input
              className="inv-pw"
              type="password"
              placeholder={translate('invite.password')}
              value={pw}
              onChange={(e) => { setPw(e.target.value); setErr(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && pw) accept() }}
            />
          )}
          {err && <p className="inv-err">{err}</p>}
          <button className="inv-btn" disabled={busy || (info.needPassword && !pw)} onClick={accept}>
            {translate(busy ? 'invite.joining' : 'invite.accept')}
          </button>
          {account.accountName && (
            <p className="inv-sub">
              {translate('invite.currentAccount', { name: account.accountName })}
              {account.switchAccount && <> · <button onClick={account.switchAccount}>{translate('invite.switchAccount')}</button></>}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function mountInvitePage(token: string, options?: InvitePageOptions): void {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  document.title = `${translate('invite.title')} · Forsion`
  const el = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'))
  const account = options ?? { apiBase: getApiBase(), getToken, request: (path, init) => fetch(path, init), appBase: '/' }
  createRoot(el).render(<InviteApp token={token} account={account} />)
}
