// @vitest-environment happy-dom
/** 远程同步设置页的 Google Drive 段(DOM 契约):
 *  ① 没有官方客户端时露出客户端 ID / 密钥两栏,空着点「连接」只提示、不调主进程;
 *  ② 填好后「连接」把 ID 与密钥原样交给主进程,进入等待态(按钮禁用);
 *  ③ 主进程回推授权结果后显示已连接、按钮变「重新连接」;客户端随 token 接回,用户未保存的远端目录不被覆盖;
 *  ④ 有官方客户端时两栏收起,「改用自建 Google 客户端」才放出来;
 *  ⑤ 旧主进程没有 gdriveAuthStart 时不列 Google Drive 选项。 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteSyncSection } from './RemoteSyncSection'
import { LocaleProvider } from '../i18n'
import '../i18n.generated' // 共用词条(等待授权 / 已连接)在这里
import type { RemoteSyncConfig } from '../types'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
// 蓬洲云联动(syncSetup)会牵进插件仓库 / 引擎服务整条链,与这里无关:换成最小替身
vi.mock('../services/syncSetup', () => ({ PENZOR_FOCUS: 'k', PENZOR_SPACE_ID: 'penzor', openPenzorSync: () => {}, penzorSyncReady: () => false }))

type AuthCb = (r: { ok: boolean; error?: string; email?: string; config?: RemoteSyncConfig }) => void
const mounted: Array<() => void> = []
afterEach(() => {
  mounted.splice(0).forEach((fn) => fn())
  delete (window as { remoteSync?: unknown }).remoteSync
})

async function mount(opts: { builtin?: boolean; legacy?: boolean; backend?: RemoteSyncConfig['backend'] } = {}) {
  const started: Array<[string, string]> = []
  let authCb: AuthCb | null = null
  const config: RemoteSyncConfig = { backend: opts.backend ?? 'gdrive', intervalMin: 0, gdrive: { clientId: '' } }
  const api: Record<string, unknown> = {
    get: async () => ({ config, running: false, lastReport: null, progress: null, root: '/v', rootError: null, gdriveBuiltin: !!opts.builtin, backends: [] }),
    set: async (p: RemoteSyncConfig) => p,
    run: async () => ({}),
    check: async () => ({ ok: true }),
    dropboxAuthStart: async () => ({ ok: true }),
    dropboxAuthFinish: async () => ({ ok: true }),
    onDropboxAuth: () => () => {},
    onStatus: () => () => {},
  }
  if (!opts.legacy) {
    api.gdriveAuthStart = async (id: string, secret: string) => { started.push([id, secret]); return { ok: true } }
    api.onGdriveAuth = (cb: AuthCb) => { authCb = cb; return () => {} }
  }
  ;(window as { remoteSync?: unknown }).remoteSync = api
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  await act(async () => { root.render(React.createElement(LocaleProvider, null, React.createElement(RemoteSyncSection))) })
  mounted.push(() => { act(() => root.unmount()); el.remove() })
  const btn = (text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined
  const input = (sel: string) => el.querySelector(sel) as HTMLInputElement | null
  const type = (node: HTMLInputElement, v: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, v)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const click = async (b: HTMLElement) => { await act(async () => { b.click() }) }
  return { el, started, auth: (r: Parameters<AuthCb>[0]) => act(() => authCb!(r)), btn, input, type, click }
}

describe('RemoteSyncSection · Google Drive', () => {
  it('自建客户端:空着只提示;填好后交给主进程并等待;回推后显示已连接且不覆盖未保存的目录', async () => {
    const v = await mount()
    const id = v.input('input[placeholder^="OAuth"]')!
    const secret = v.input('input[type="password"]')!
    const dir = v.input('input[placeholder^="远端文件夹"]')!
    expect(id && secret && dir).toBeTruthy()

    await v.click(v.btn('连接 Google Drive')!)
    expect(v.started).toEqual([])
    expect(v.el.textContent).toContain('先填客户端 ID 和密钥')

    v.type(id, ' my.apps.googleusercontent.com ')
    v.type(secret, 'GOCSPX-x')
    v.type(dir, 'Notes/Vault')
    await v.click(v.btn('连接 Google Drive')!)
    expect(v.started).toEqual([['my.apps.googleusercontent.com', 'GOCSPX-x']])
    expect(v.el.textContent).toContain('等待浏览器完成授权')
    expect(v.btn('连接 Google Drive')!.disabled).toBe(true)

    v.auth({ ok: true, email: 'me@example.com', config: { backend: 'gdrive', intervalMin: 0, gdrive: { clientId: 'x', refreshToken: 'RT', accountId: 'P1', email: 'me@example.com', baseDir: '' } } })
    expect(v.el.textContent).toContain('已连接：me@example.com')
    expect(v.btn('重新连接')).toBeTruthy()
    expect(dir.value).toBe('Notes/Vault')
    // 客户端随 token 一起从主进程接回:等待授权时改过的客户端输入作废(token 只对签发它的客户端有效)
    expect(id.value).toBe('x')
  })

  it('授权失败:回推的错误原样显示,退出等待态', async () => {
    const v = await mount()
    v.type(v.input('input[placeholder^="OAuth"]')!, 'cid')
    v.type(v.input('input[type="password"]')!, 'sec')
    await v.click(v.btn('连接 Google Drive')!)
    v.auth({ ok: false, error: 'auth-timeout' })
    expect(v.el.textContent).toContain('auth-timeout')
    expect(v.btn('连接 Google Drive')!.disabled).toBe(false)
  })

  it('有官方客户端:两栏收起,点连接直接走官方;「改用自建」后才露出', async () => {
    const v = await mount({ builtin: true })
    expect(v.input('input[placeholder^="OAuth"]')).toBeNull()
    await v.click(v.btn('连接 Google Drive')!)
    expect(v.started).toEqual([['', '']])
    await v.click(v.btn('改用自建 Google 客户端')!)
    expect(v.input('input[placeholder^="OAuth"]')).toBeTruthy()
  })

  it('旧主进程(没有 gdriveAuthStart):不列 Google Drive 选项', async () => {
    const v = await mount({ legacy: true, backend: 'off' })
    const opts = [...v.el.querySelectorAll('option')].map((o) => o.value)
    expect(opts).toContain('dropbox')
    expect(opts).not.toContain('gdrive')
  })
})
