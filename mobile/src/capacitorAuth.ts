/**
 * Capacitor(Android)原生登录:无 nginx 的同源 /auth 代理,改用系统内浏览器打开 Forsion 登录页,
 * 经自定义 scheme 深链 `tangu://auth-callback?token=…` 回跳 app;token 存 @capacitor/preferences(安全存储)。
 *
 * 依赖 AndroidManifest.xml 里 tangu scheme 的 intent-filter(见 android/app/src/main/AndroidManifest.xml)。
 * 若 Forsion `/auth` 只放行 http(s) 作 redirect 目标,改用 https bounce 中转页 302 到 tangu://,或走 App Links。
 */
import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Preferences } from '@capacitor/preferences'

const TOKEN_KEY = 'forsion_token'

export const isNative = (): boolean => Capacitor.isNativePlatform()

export async function getStoredToken(): Promise<string> {
  try { return (await Preferences.get({ key: TOKEN_KEY })).value || '' } catch { return '' }
}
export async function storeToken(t: string): Promise<void> {
  try { await Preferences.set({ key: TOKEN_KEY, value: t }) } catch { /* ignore */ }
}
export async function clearStoredToken(): Promise<void> {
  try { await Preferences.remove({ key: TOKEN_KEY }) } catch { /* ignore */ }
}

/** 生产网关。native 下 location.origin=https://localhost 永远不可能同源,缺省必须烤死生产地址。 */
const PROD_ORIGIN = 'https://api.forsion.net'

/** Forsion 网关源:VITE_API_ORIGIN 覆盖(dev/自托管);native 缺省=生产,web(dev/preview)缺省=同源走代理。 */
export function apiOrigin(): string {
  const explicit = import.meta.env.VITE_API_ORIGIN
  if (explicit) return String(explicit).replace(/\/$/, '')
  return isNative() ? PROD_ORIGIN : location.origin
}

/** /api 基址。 */
export function apiBase(): string {
  return apiOrigin() + '/api'
}

/** 提供 /auth 登录页的 Forsion web origin(缺省=网关源)。 */
export function forsionWebOrigin(): string {
  const explicit = import.meta.env.VITE_AUTH_ORIGIN
  if (explicit) return String(explicit).replace(/\/$/, '')
  return apiOrigin()
}

/**
 * 滑动续期:拿存着的 token 换一枚新的(有效期重新计满 14 天)。「离上次打开 App 不满 2 周就不必重登」
 * 全靠它——登录页发的是 7d 网页 token,首次启动即被换成 14d 会话 token;此后每次启动再续。
 * 服务端 jti 沿用,单枚吊销 / 退出所有设备语义不变。
 * 失败一律静默(离线 / 老版本 server 没这端点 / 这枚已失效),绝不在这里清凭证——401 兜底在 mobileShim。
 */
/** 端/版本(`mobile/2.7.9`):服务端把每次续期记成一次「上线」,admin 活跃度按这个分端。取不到就不带。 */
async function clientTag(): Promise<string | undefined> {
  try {
    const v = (await App.getInfo()).version
    return v ? `mobile/${v}` : undefined
  } catch { return undefined }
}

export async function refreshStoredToken(): Promise<void> {
  const token = await getStoredToken()
  if (!token) return
  try {
    const tag = await clientTag()
    const r = await fetch(`${apiBase()}/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(tag ? { 'X-Forsion-Client': tag } : {}) },
    })
    if (!r.ok) return
    const j = await r.json().catch(() => null)
    const fresh = typeof j?.token === 'string' ? j.token : ''
    // 竞态防线:换新在途期间深链可能已存进另一枚(换号登录)——绝不拿旧链条换来的盖掉新的。
    if (fresh && fresh !== token && (await getStoredToken()) === token) await storeToken(fresh)
  } catch { /* 离线:下次启动再说 */ }
}

let bound = false
/** 绑定深链处理(全局一次):收到 tangu://auth-callback?token=… → 存 token → 关浏览器 → 回调。 */
export function bindDeepLinkAuth(onToken: (t: string) => void): void {
  if (bound) return
  bound = true
  void App.addListener('appUrlOpen', async ({ url }) => {
    try {
      if (!url || url.indexOf('auth-callback') < 0) return
      const u = new URL(url)
      const tok = u.searchParams.get('token')
      if (tok) {
        await storeToken(tok)
        try { await Browser.close() } catch { /* ignore */ }
        onToken(tok)
      }
    } catch { /* ignore */ }
  })
}

/** 打开系统内浏览器到 Forsion 登录页,redirect 指回自定义 scheme。 */
export async function startNativeLogin(): Promise<void> {
  const redirect = 'tangu://auth-callback'
  const url = `${forsionWebOrigin()}/auth?redirect=${encodeURIComponent(redirect)}&app=tangu-mobile`
  try { await Browser.open({ url }) } catch { /* ignore */ }
}
