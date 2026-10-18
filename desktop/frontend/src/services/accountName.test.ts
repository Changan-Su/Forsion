import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchAccountName } from './accountName'

afterEach(() => { vi.unstubAllGlobals() })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('登录名(主页问候 / ctx.app.watchAccountName 共用)', () => {
  it('桌面:有昵称用昵称,没有用用户名;换账号再回调一次,名字没变不重复回调', async () => {
    let info = { loggedIn: true, nickname: '小苏', username: 'su' }
    let changed: () => void = () => {}
    vi.stubGlobal('window', { tangu: { authStatus: async () => info, onAuthChanged: (cb: () => void) => { changed = cb; return () => {} } } })
    const seen: string[] = []
    watchAccountName((n) => seen.push(n))
    await flush()
    changed(); await flush()
    info = { loggedIn: false, nickname: '', username: '' }
    changed(); await flush()
    expect(seen).toEqual(['小苏', ''])
  })

  it('网页版 Unit:只有 window.tangu.account → 用 username;退订后不再回调', async () => {
    let fire: () => void = () => {}
    vi.stubGlobal('window', { tangu: { account: { status: async () => ({ loggedIn: true, username: 'su' }), subscribe: (cb: () => void) => { fire = cb; return () => {} } } } })
    const cb = vi.fn()
    const off = watchAccountName(cb)
    await flush()
    off(); fire(); await flush()
    expect(cb.mock.calls).toEqual([['su']])
  })
})
