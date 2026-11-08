/**
 * 平台账号(插件 ctx.app.platformAccounts):让插件在用户同意后,用内置浏览器里某个平台的登录信息去取内容。
 *
 * 第一个用户是青鸟收藏夹:B 站会员 / 高清 / 被风控的视频要登录才取得到,登录信息作为 BLUEBIRD_COOKIE
 * 走引擎的 secret_env 交给获取脚本(模型看不到)。
 *
 * 边界(别放宽):
 *  - 平台是宿主写死的名单(PLATFORMS),插件不能传任意域名。
 *  - 登录信息只在内置浏览器的分区里(BROWSER_PARTITION,Chromium 自己加密落盘),不进智库、不进 Plugins/、不随云同步;
 *    「粘贴 Cookie」也是写进这个分区,不另存一份。
 *  - 读登录信息(cookie)按「插件 × 平台」授权:用户在这个插件里点了连接 / 粘贴 = 同意;别的插件来读,主进程弹框问。
 *    确认框在主进程弹,渲染层代码绕不过去。
 *  - 登录窗口是普通的第三方页面:无 preload、sandbox、contextIsolation,与内置浏览器 webview 同一分区、同一套硬化。
 */
import { app, BrowserWindow, dialog, ipcMain, session, type Session } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { BROWSER_PARTITION } from '../shared/browser'
import { defineMainMessages, mt } from './mainI18n'

export type PlatformId = 'bilibili'

export interface PlatformDef {
  /** 读写 cookie 用的地址 */
  url: string
  /** 清理时按域名枚举 */
  domain: string
  /** 有它 = 登录了 */
  authCookie: string
  loginUrl: string
  /** 查账号名;返回 null = 查不到(网络 / 接口变了),不等于没登录 */
  profile?: (s: SessionLike) => Promise<{ loggedIn: boolean; name?: string } | null>
}

export interface CookieLike { name: string; value: string; domain?: string; path?: string; secure?: boolean; expirationDate?: number }
export interface SessionLike {
  cookies: {
    get(filter: { url?: string; domain?: string; name?: string }): Promise<CookieLike[]>
    set(details: { url: string; name: string; value: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number }): Promise<void>
    remove(url: string, name: string): Promise<void>
  }
  fetch?(url: string, init?: { headers?: Record<string, string> }): Promise<{ ok: boolean; json(): Promise<unknown> }>
}

export const PLATFORMS: Record<PlatformId, PlatformDef> = {
  bilibili: {
    url: 'https://www.bilibili.com',
    domain: 'bilibili.com',
    authCookie: 'SESSDATA',
    loginUrl: 'https://passport.bilibili.com/login',
    profile: async (s) => {
      if (!s.fetch) return null
      try {
        const r = await s.fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { Referer: 'https://www.bilibili.com/' } })
        if (!r.ok) return null
        const j = await r.json() as { code?: number; data?: { isLogin?: boolean; uname?: string } }
        if (j?.code === -101) return { loggedIn: false }
        if (j?.code !== 0 || !j.data) return null
        return { loggedIn: !!j.data.isLogin, name: typeof j.data.uname === 'string' ? j.data.uname.slice(0, 64) : undefined }
      } catch { return null }
    },
  },
}

export const isPlatformId = (v: unknown): v is PlatformId => typeof v === 'string' && Object.prototype.hasOwnProperty.call(PLATFORMS, v)

export type AccountStatus =
  | { platform: PlatformId; state: 'connected'; name?: string; expiresAt?: number }
  | { platform: PlatformId; state: 'expired' }
  | { platform: PlatformId; state: 'none' }

export async function accountStatus(s: SessionLike, id: PlatformId): Promise<AccountStatus> {
  const def = PLATFORMS[id]
  const auth = (await s.cookies.get({ url: def.url, name: def.authCookie })).find((c) => c.value)
  if (!auth) return { platform: id, state: 'none' }
  const expiresAt = auth.expirationDate ? Math.round(auth.expirationDate * 1000) : undefined
  if (expiresAt && expiresAt < Date.now()) return { platform: id, state: 'expired' }
  const prof = await def.profile?.(s) ?? null
  if (prof && !prof.loggedIn) return { platform: id, state: 'expired' }
  return { platform: id, state: 'connected', ...(prof?.name ? { name: prof.name } : {}), ...(expiresAt ? { expiresAt } : {}) }
}

/** 「Cookie 请求头」写法:name=value; name2=value2。没登录 = null。 */
export async function cookieHeader(s: SessionLike, id: PlatformId): Promise<string | null> {
  const def = PLATFORMS[id]
  const all = await s.cookies.get({ url: def.url })
  if (!all.some((c) => c.name === def.authCookie && c.value)) return null
  return all.filter((c) => c.name && /^[\x21-\x7e]*$/.test(c.value)).map((c) => `${c.name}=${c.value}`).join('; ')
}

/** 解析用户粘贴的 Cookie(可带 `Cookie:` 前缀,分号分隔)。没有登录那项 = null。 */
export function parsePastedCookie(text: string, id: PlatformId): Array<{ name: string; value: string }> | null {
  const def = PLATFORMS[id]
  const body = String(text ?? '').trim().replace(/^cookie\s*:\s*/i, '')
  const out: Array<{ name: string; value: string }> = []
  for (const part of body.split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const name = part.slice(0, i).trim(), value = part.slice(i + 1).trim()
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || !/^[\x21-\x7e]*$/.test(value) || value.includes(';')) continue
    out.push({ name, value })
  }
  return out.some((c) => c.name === def.authCookie && c.value) ? out.slice(0, 64) : null
}

export async function setPastedCookie(s: SessionLike, id: PlatformId, text: string): Promise<boolean> {
  const def = PLATFORMS[id]
  const pairs = parsePastedCookie(text, id)
  if (!pairs) return false
  const expirationDate = Math.round(Date.now() / 1000) + 180 * 24 * 3600
  for (const { name, value } of pairs) {
    await s.cookies.set({ url: def.url, name, value, domain: `.${def.domain}`, path: '/', secure: true, httpOnly: name === def.authCookie, expirationDate })
  }
  return true
}

export async function clearPlatform(s: SessionLike, id: PlatformId): Promise<void> {
  const def = PLATFORMS[id]
  for (const c of await s.cookies.get({ domain: def.domain })) {
    const host = String(c.domain || def.domain).replace(/^\./, '')
    await s.cookies.remove(`https://${host}${c.path || '/'}`, c.name).catch(() => {})
  }
}

// ── 授权:插件 × 平台 ──────────────────────────────────────────────────────────────
type Grants = Record<string, true>
const grantKey = (pluginId: string, id: PlatformId): string => `${pluginId}\n${id}`
const grantsFile = (): string => path.join(app.getPath('userData'), 'platform-account-grants.json')
let grantsCache: Grants | null = null
async function readGrants(): Promise<Grants> {
  if (grantsCache) return grantsCache
  try {
    const v = JSON.parse(await fs.readFile(grantsFile(), 'utf8'))
    grantsCache = v && typeof v === 'object' && !Array.isArray(v) ? v as Grants : {}
  } catch (e) {
    // 读不到 = 没授权过(文件不存在);解析坏了也按没授权处理 —— 读失败只会多问一次,不会多放行
    grantsCache = {}
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') console.warn('[platformAccounts] grants unreadable', e)
  }
  return grantsCache
}
async function writeGrants(g: Grants): Promise<void> {
  const tmp = `${grantsFile()}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(tmp, JSON.stringify(g), { mode: 0o600 })
  await fs.rename(tmp, grantsFile())
  grantsCache = g // 落盘成功才算数
}
// 授权的读-改-写整段串行:两个窗口同时连接 / 断开不会互相覆盖
let grantChain: Promise<unknown> = Promise.resolve()
function serialGrants<T>(fn: () => Promise<T>): Promise<T> {
  const next = grantChain.then(fn, fn)
  grantChain = next.catch(() => {})
  return next
}
function grant(pluginId: string, id: PlatformId): Promise<void> {
  return serialGrants(async () => {
    const g = await readGrants()
    if (g[grantKey(pluginId, id)]) return
    await writeGrants({ ...g, [grantKey(pluginId, id)]: true })
  })
}
function revokePlatform(id: PlatformId): Promise<void> {
  return serialGrants(async () => {
    const g = await readGrants()
    await writeGrants(Object.fromEntries(Object.entries(g).filter(([k]) => !k.endsWith(`\n${id}`))) as Grants)
  })
}

defineMainMessages({
  'main.accounts.bilibili': { zh: 'B 站', en: 'Bilibili' },
  'main.accounts.loginTitle': { zh: '连接{platform}', en: 'Connect {platform}' },
  'main.accounts.askTitle': { zh: '允许「{plugin}」使用你的{platform}登录信息？', en: 'Let “{plugin}” use your {platform} sign-in?' },
  'main.accounts.askDetail': {
    zh: '它会用这份登录信息获取需要登录才能看到的内容。登录信息只留在这台电脑上，可以随时在插件里断开。',
    en: 'It uses this sign-in to fetch content that needs an account. The sign-in stays on this computer, and you can disconnect it in the plugin at any time.',
  },
  'main.accounts.allow': { zh: '允许', en: 'Allow' },
  'main.accounts.deny': { zh: '不允许', en: 'Don’t allow' },
})

const platformName = (id: PlatformId): string => mt(`main.accounts.${id}`)
const cleanPluginName = (v: unknown, fallback: string): string => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || fallback

async function askGrant(win: BrowserWindow | null, pluginName: string, id: PlatformId): Promise<boolean> {
  const opts = {
    type: 'question' as const,
    buttons: [mt('main.accounts.allow'), mt('main.accounts.deny')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: mt('main.accounts.askTitle', { plugin: pluginName, platform: platformName(id) }),
    detail: mt('main.accounts.askDetail'),
  }
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  return r.response === 0
}

// ── 登录窗口 ──────────────────────────────────────────────────────────────────────
/** 同一平台同时只开一个登录窗口;initiator = 打开它的插件(只有它在登好后自动得到授权)。 */
const loginWindows = new Map<PlatformId, { initiator: string; done: Promise<boolean> }>()

function openLoginWindow(parent: BrowserWindow | null, s: Session, id: PlatformId, initiator: string): Promise<boolean> {
  const def = PLATFORMS[id]
  const work = new Promise<boolean>((resolve) => {
    const win = new BrowserWindow({
      width: 480, height: 640, ...(parent ? { parent } : {}), show: false, autoHideMenuBar: true,
      title: mt('main.accounts.loginTitle', { platform: platformName(id) }),
      webPreferences: { partition: BROWSER_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, webSecurity: true },
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearInterval(poll)
      clearTimeout(timer)
      s.cookies.removeListener('changed', onChanged)
      if (!win.isDestroyed()) win.close()
      resolve(ok)
    }
    const check = async (): Promise<void> => {
      if (done) return
      const auth = await s.cookies.get({ url: def.url, name: def.authCookie }).catch(() => [])
      if (auth.some((c) => c.value)) finish(true)
    }
    const onChanged = (_e: unknown, c: Electron.Cookie, _cause: string, removed: boolean): void => {
      if (!removed && c.name === def.authCookie && c.value) void check()
    }
    s.cookies.on('changed', onChanged)
    const poll = setInterval(() => { void check() }, 1500)
    const timer = setTimeout(() => finish(false), 10 * 60 * 1000)
    win.on('closed', () => finish(false))
    win.once('ready-to-show', () => win.show())
    void win.loadURL(def.loginUrl).catch(() => { if (!win.isDestroyed()) win.show() })
  }).finally(() => loginWindows.delete(id))
  loginWindows.set(id, { initiator, done: work })
  return work
}

// ── IPC ───────────────────────────────────────────────────────────────────────────
const browserSession = (): Session => session.fromPartition(BROWSER_PARTITION)
const senderWindow = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null => BrowserWindow.fromWebContents(e.sender)
const validPluginId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)

export function registerPlatformAccountsIpc(): void {
  ipcMain.handle('platformAccounts:status', async (_e, id: unknown) => {
    if (!isPlatformId(id)) throw new Error('unknown-platform')
    return accountStatus(browserSession(), id)
  })
  /** 已登录就直接回;没登录打开平台自己的登录页,登好自动关。用户从这个插件发起 = 同意这个插件使用。 */
  ipcMain.handle('platformAccounts:connect', async (e, id: unknown, pluginId: unknown, pluginName: unknown) => {
    if (!isPlatformId(id) || !validPluginId(pluginId)) throw new Error('bad-request')
    const s = browserSession()
    let st = await accountStatus(s, id)
    if (st.state === 'connected') {
      // 已经登录(比如在内置浏览器里登过):插件调一下 connect 不能就此拿到授权 —— 没授权过的照样弹框问
      if (!(await readGrants())[grantKey(pluginId, id)]) {
        if (!(await askGrant(senderWindow(e), cleanPluginName(pluginName, pluginId), id))) return st
        await grant(pluginId, id)
      }
      return st
    }
    if (st.state === 'expired') await clearPlatform(s, id)
    // 用户在弹出的平台登录页里亲手登完 = 同意**打开这个窗口的**插件使用;中途搭车的别的插件照样要问
    const running = loginWindows.get(id)
    const mine = !running || running.initiator === pluginId
    const ok = await (running ? running.done : openLoginWindow(senderWindow(e), s, id, pluginId))
    if (!ok) return accountStatus(s, id)
    st = await accountStatus(s, id)
    if (st.state !== 'connected') return st
    if (mine) await grant(pluginId, id)
    else if (!(await readGrants())[grantKey(pluginId, id)]) {
      if (!(await askGrant(senderWindow(e), cleanPluginName(pluginName, pluginId), id))) return st
      await grant(pluginId, id)
    }
    return st
  })
  ipcMain.handle('platformAccounts:paste', async (_e, id: unknown, pluginId: unknown, text: unknown) => {
    if (!isPlatformId(id) || !validPluginId(pluginId) || typeof text !== 'string' || text.length > 16_384) throw new Error('bad-request')
    const s = browserSession()
    if (!(await setPastedCookie(s, id, text))) return { platform: id, state: 'invalid' as const }
    const st = await accountStatus(s, id)
    if (st.state === 'connected') await grant(pluginId, id)
    return st
  })
  ipcMain.handle('platformAccounts:disconnect', async (_e, id: unknown) => {
    if (!isPlatformId(id)) throw new Error('unknown-platform')
    await clearPlatform(browserSession(), id)
    await revokePlatform(id)
    return { platform: id, state: 'none' as const }
  })
  /** 登录信息本身。没授权过的插件,主进程弹框问;拒绝 = null(和没登录一样,插件照常不带登录信息去取)。 */
  ipcMain.handle('platformAccounts:cookie', async (e, id: unknown, pluginId: unknown, pluginName: unknown) => {
    if (!isPlatformId(id) || !validPluginId(pluginId)) throw new Error('bad-request')
    const s = browserSession()
    const header = await cookieHeader(s, id)
    if (!header) return null
    const g = await readGrants()
    if (!g[grantKey(pluginId, id)]) {
      if (!(await askGrant(senderWindow(e), cleanPluginName(pluginName, pluginId), id))) return null
      await grant(pluginId, id)
    }
    return header
  })
}
