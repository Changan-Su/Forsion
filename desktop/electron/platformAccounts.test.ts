import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  answer: 0,
  asked: 0,
  userData: '',
  jar: [] as Array<{ name: string; value: string; domain: string; path: string; expirationDate?: number }>,
  nav: { code: 0, data: { isLogin: true, uname: 'reader' } } as unknown,
}))

vi.mock('electron', () => {
  const cookies = {
    get: async (f: { url?: string; domain?: string; name?: string }) => h.jar.filter((c) => (!f.name || c.name === f.name)),
    set: async (d: { name: string; value: string; domain?: string; path?: string; expirationDate?: number }) => {
      h.jar = h.jar.filter((c) => c.name !== d.name)
      h.jar.push({ name: d.name, value: d.value, domain: d.domain || '.bilibili.com', path: d.path || '/', expirationDate: d.expirationDate })
    },
    remove: async (_url: string, name: string) => { h.jar = h.jar.filter((c) => c.name !== name) },
    on() {}, removeListener() {},
  }
  const sess = { cookies, fetch: async () => ({ ok: true, json: async () => h.nav }) }
  return {
    app: { getPath: () => h.userData },
    BrowserWindow: { fromWebContents: () => null },
    dialog: { showMessageBox: async () => { h.asked++; return { response: h.answer } } },
    ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(ch, fn) },
    session: { fromPartition: () => sess },
  }
})

import { parsePastedCookie, registerPlatformAccountsIpc } from './platformAccounts'

const call = (ch: string, ...args: unknown[]): Promise<unknown> => Promise.resolve(h.handlers.get(`platformAccounts:${ch}`)!({ sender: {} }, ...args))

beforeEach(() => {
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'pa-'))
  h.jar = []
  h.asked = 0
  h.answer = 0
  h.nav = { code: 0, data: { isLogin: true, uname: 'reader' } }
  h.handlers.clear()
  vi.resetModules()
})

async function fresh(): Promise<void> {
  const m = await import('./platformAccounts')
  m.registerPlatformAccountsIpc()
}

describe('parsePastedCookie', () => {
  it('needs the sign-in cookie and drops junk', () => {
    expect(parsePastedCookie('Cookie: SESSDATA=abc%2C1; bili_jct=x; bad name=1', 'bilibili')).toEqual([{ name: 'SESSDATA', value: 'abc%2C1' }, { name: 'bili_jct', value: 'x' }])
    expect(parsePastedCookie('buvid3=1', 'bilibili')).toBeNull()
    expect(parsePastedCookie('', 'bilibili')).toBeNull()
  })
})

describe('platform account IPC', () => {
  it('reports none, then connected with the account name after a paste', async () => {
    await fresh()
    expect(await call('status', 'bilibili')).toEqual({ platform: 'bilibili', state: 'none' })
    expect(await call('paste', 'bilibili', 'bluebird', 'nothing=here')).toEqual({ platform: 'bilibili', state: 'invalid' })
    const st = await call('paste', 'bilibili', 'bluebird', 'SESSDATA=s1; bili_jct=j1') as { state: string; name?: string }
    expect(st.state).toBe('connected')
    expect(st.name).toBe('reader')
  })

  it('the plugin that connected reads the cookie without a prompt; another plugin is asked', async () => {
    await fresh()
    await call('paste', 'bilibili', 'bluebird', 'SESSDATA=s1; bili_jct=j1')
    expect(await call('cookie', 'bilibili', 'bluebird', 'Bluebird')).toBe('SESSDATA=s1; bili_jct=j1')
    expect(h.asked).toBe(0)
    h.answer = 1 // 不允许
    expect(await call('cookie', 'bilibili', 'other', 'Other')).toBeNull()
    expect(h.asked).toBe(1)
    h.answer = 0 // 允许,并记住
    expect(await call('cookie', 'bilibili', 'other', 'Other')).toBe('SESSDATA=s1; bili_jct=j1')
    expect(await call('cookie', 'bilibili', 'other', 'Other')).toBe('SESSDATA=s1; bili_jct=j1')
    expect(h.asked).toBe(2)
  })

  it('grants survive a restart and disconnect withdraws them', async () => {
    await fresh()
    await call('paste', 'bilibili', 'bluebird', 'SESSDATA=s1')
    vi.resetModules(); h.handlers.clear(); await fresh()
    expect(await call('cookie', 'bilibili', 'bluebird', 'Bluebird')).toBe('SESSDATA=s1')
    expect(h.asked).toBe(0)
    expect(await call('disconnect', 'bilibili')).toEqual({ platform: 'bilibili', state: 'none' })
    expect(await call('cookie', 'bilibili', 'bluebird', 'Bluebird')).toBeNull()
    await call('paste', 'bilibili', 'other', 'SESSDATA=s2')
    h.answer = 1
    expect(await call('cookie', 'bilibili', 'bluebird', 'Bluebird')).toBeNull() // 断开时撤过,要重新问
    expect(h.asked).toBe(1)
  })

  it('a sign-in the platform no longer accepts reads as expired', async () => {
    await fresh()
    await call('paste', 'bilibili', 'bluebird', 'SESSDATA=s1')
    h.nav = { code: -101, data: { isLogin: false } }
    expect(await call('status', 'bilibili')).toEqual({ platform: 'bilibili', state: 'expired' })
  })

  it('rejects unknown platforms and bad plugin ids', async () => {
    await fresh()
    await expect(call('status', 'example')).rejects.toThrow()
    await expect(call('cookie', 'bilibili', '../x', 'X')).rejects.toThrow()
  })
})

void registerPlatformAccountsIpc
