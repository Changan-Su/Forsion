/**
 * 手机的三项能力(提醒我 / 操作这台手机 / 用语音说):引导第 3 屏和 设置 › 设备权限 共用的读 / 问 / 去系统设置。
 *
 * - 通知、麦克风是系统权限,走原生 PhonePermissions(PhonePermissionsPlugin.java);
 * - 「操作这台手机」是 App 自己的开关,走现有 PhoneControl(开启过原生确认框,界面只认之后原生回报的状态)。
 *
 * 读失败 = 不知道(null),不是「关」:调用方不能据此当成没开去写什么。
 * 浏览器里(mobileShim 台架)一项都没有:插件不存在就不列,也不去 registerPlugin。
 */
import { App } from '@capacitor/app'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { readPhoneControlStatus, setPhoneControlEnabled } from '../phoneControl'

export type CapId = 'notify' | 'control' | 'voice'
export type CapState = 'on' | 'off' | 'blocked'

export interface PhoneCap {
  id: CapId
  /** 现读一次;null = 读不到(不知道)。 */
  read(): Promise<CapState | null>
  /** 过系统框 / 原生确认框,回答完之后的状态。桥调用失败时抛错。 */
  ask(): Promise<CapState>
  /** 被系统记成「不再询问」后去系统设置里开。「操作这台手机」没有这一项(它随时能再问)。 */
  openSettings?(): Promise<void>
}

type NativeState = 'granted' | 'prompt' | 'denied'
interface NativeStatus { notifications: NativeState; microphone: NativeState; notificationsEnabled: boolean }
type What = 'notifications' | 'microphone'
interface PhonePermissionsPlugin {
  status(): Promise<NativeStatus>
  ask(o: { what: What }): Promise<NativeStatus>
  openSettings(o: { what: What }): Promise<void>
}

function nativeAvailable(name: string): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable(name)
  } catch {
    return false
  }
}

let native: PhonePermissionsPlugin | null = null
/** 只在确认原生插件存在之后才登记(浏览器里不碰)。 */
function permsPlugin(): PhonePermissionsPlugin {
  if (!native) native = registerPlugin<PhonePermissionsPlugin>('PhonePermissions')
  return native
}

function mapNative(s: NativeState): CapState {
  return s === 'granted' ? 'on' : s === 'denied' ? 'blocked' : 'off'
}

/**
 * 通知:13 起运行时权限在、但用户在系统设置里关了本应用的通知 → 系统框不会再弹,只能去设置里开,所以算 blocked。
 * (13 以下原生已经按总开关报 granted / denied。)
 */
function notifyState(s: NativeStatus): CapState {
  const st = mapNative(s.notifications)
  return st === 'on' && s.notificationsEnabled === false ? 'blocked' : st
}

function systemCap(id: 'notify' | 'voice', what: What, pick: (s: NativeStatus) => CapState): PhoneCap {
  return {
    id,
    async read() {
      try {
        return pick(await permsPlugin().status())
      } catch (e) {
        console.warn(`[phone-caps] ${id} status failed:`, e)
        return null
      }
    },
    async ask() {
      return pick(await permsPlugin().ask({ what }))
    },
    async openSettings() {
      await permsPlugin().openSettings({ what })
    },
  }
}

const controlCap: PhoneCap = {
  id: 'control',
  async read() {
    const s = await readPhoneControlStatus()
    return s ? (s.enabled ? 'on' : 'off') : null
  },
  async ask() {
    // 开启走原生确认框;setPhoneControlEnabled 自己吞错并重读,这里只认重读后的原生状态
    await setPhoneControlEnabled(true)
    const s = await readPhoneControlStatus()
    if (!s) throw new Error('phone control status unavailable')
    return s.enabled ? 'on' : 'off'
  },
}

const notifyCap = systemCap('notify', 'notifications', notifyState)
const voiceCap = systemCap('voice', 'microphone', (s) => mapNative(s.microphone))

let override: PhoneCap[] | null = null
let cached: PhoneCap[] | null = null

/**
 * 这台设备上有的能力,固定顺序 notify → control → voice;浏览器里是空的。
 * 同一批对象反复返回(调用方拿它们当 effect 依赖不会每次都变)。
 */
export function phoneCaps(): PhoneCap[] {
  if (override) return override
  if (!cached) {
    const perms = nativeAvailable('PhonePermissions')
    const control = nativeAvailable('PhoneControl')
    cached = [...(perms ? [notifyCap] : []), ...(control ? [controlCap] : []), ...(perms ? [voiceCap] : [])]
  }
  return cached
}

/** 台架 / 单测换成假的;null = 恢复真的。 */
export function setPhoneCapsForTest(caps: PhoneCap[] | null): void {
  override = caps
}

/** 读全部:每项各读各的,一项读失败不连累别的(那项是 null)。 */
export async function readCaps(caps: PhoneCap[]): Promise<Partial<Record<CapId, CapState | null>>> {
  const out: Partial<Record<CapId, CapState | null>> = {}
  await Promise.all(caps.map(async (c) => {
    try { out[c.id] = await c.read() } catch { out[c.id] = null }
  }))
  return out
}

/** App 回到前台(去系统设置开完回来)时回调;返回撤销函数。浏览器里不挂。 */
export function onAppResume(f: () => void): () => void {
  if (!nativeAvailable('App')) return () => {}
  // 网页版的 @capacitor/app 桩里 remove 是同步的(真包回 Promise):两种都收,只管调
  let handle: { remove(): unknown } | null = null
  let gone = false
  void App.addListener('resume', f).then((h) => {
    if (gone) void h.remove()
    else handle = h
  }).catch(() => { /* 没有 App 插件:不刷新,不出错 */ })
  return () => {
    gone = true
    if (handle) void handle.remove()
  }
}
