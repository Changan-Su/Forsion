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

/** Forsion 网关 /api 基址(native 必须绝对:location.origin=https://localhost)。 */
export function apiBase(): string {
  return String(import.meta.env.VITE_API_URL || (location.origin + '/api')).replace(/\/$/, '')
}

/** 提供 /auth 登录页的 Forsion web origin(缺省=去掉 /api 的 API 基址)。 */
export function forsionWebOrigin(): string {
  const explicit = import.meta.env.VITE_AUTH_ORIGIN
  if (explicit) return String(explicit).replace(/\/$/, '')
  return apiBase().replace(/\/api$/, '')
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
