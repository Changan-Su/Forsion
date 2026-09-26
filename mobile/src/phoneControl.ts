/**
 * 手机操控(T1 快通道)的 JS 半身:把原生 PhoneControl 插件登记成 client surface `phone`。
 * 契约:Forsion-Genesis/tangu-agent/docs/phone-control.md(§5 surface、§6 原生 API)。
 *
 * JS 在这条链上只是**不受信的搬运工**:exec 原样转交 {runId, ackId, body},claim / 分级 / 执行 / 回执
 * 全在原生;token 与 apiBase 原生自取;开关也在原生 —— 本文件只缓存原生回报的 status(同步的
 * capabilities() 要用),启动与 App 回到前台时刷新。
 * 用户可见文案(开启确认框、R3 确认框)经 configure() 推给原生,切语言重推;原生代码里没有用户可见字面量。
 */
import { useSyncExternalStore } from 'react'
import { App } from '@capacitor/app'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { registerClientSurface } from '@/services/clientSurfaces'
import { registerMessages, subscribeLocale, translate } from '@/i18n'
import { PhoneControlRow } from './PhoneControlRow'

export interface PhoneControlStatus {
  enabled: boolean
  capabilities: string[]
  foreground: boolean
  proto: number
}

interface PhoneControlPlugin {
  status(): Promise<PhoneControlStatus>
  setEnabled(o: { enabled: boolean }): Promise<{ enabled: boolean }>
  configure(o: { strings: Record<string, string> }): Promise<void>
  exec(o: { runId: string; ackId: string; body: string }): Promise<{ accepted: boolean }>
}
const Native = registerPlugin<PhoneControlPlugin>('PhoneControl')

// 键名 = 契约 §6 的 configure.strings 键。⚠️ confirmBody 必须含 {app} 与 {target}:原生拿自己核实的
// 目标 App 名与 scheme://host 填进去,缺占位符的模板原生直接拒收(整份 configure 作废)。
registerMessages({
  // 标题/正文刻意不复用按钮上的动词:按钮文字要唯一(台架 phone-control-emu.cjs 按文字找按钮点)。
  'phone.native.enableTitle': { zh: '让 Tangu 操作这台手机？', en: 'Let Tangu operate this phone?' },
  'phone.native.enableBody': {
    zh: '打开后，在这台手机上发起的对话里，Tangu 可以打开 App 和链接、导航、设闹钟与计时、控制媒体和手电筒，并替你起草短信、邮件、电话和日程——发送、拨打、保存始终由你来按。\n\n指令与草稿内容会经过 Forsion 云端，并保存在对话记录里。随时可在设置里关闭。',
    en: 'When on, in chats started on this phone Tangu can open apps and links, start navigation, set alarms and timers, control media and the flashlight, and draft messages, emails, calls and events. You always press send, call or save yourself.\n\nCommands and draft text pass through Forsion cloud and are stored in the conversation. You can turn this off in Settings at any time.',
  },
  'phone.native.enableConfirm': { zh: '允许', en: 'Allow' },
  'phone.native.cancel': { zh: '取消', en: 'Cancel' },
  'phone.native.confirmTitle': { zh: '打开其他 App？', en: 'Open another app?' },
  'phone.native.confirmBody': { zh: 'Tangu 想打开 {app}（{target}）。', en: 'Tangu wants to open {app} ({target}).' },
  'phone.native.confirmAllow': { zh: '打开', en: 'Open' },
  'phone.native.confirmDeny': { zh: '拒绝', en: 'Deny' },
})

const NATIVE_KEYS = ['enableTitle', 'enableBody', 'enableConfirm', 'cancel', 'confirmTitle', 'confirmBody', 'confirmAllow', 'confirmDeny'] as const

function pushStrings(): void {
  const strings: Record<string, string> = {}
  for (const k of NATIVE_KEYS) strings[k] = translate(`phone.native.${k}`)
  void Native.configure({ strings }).catch((e) => console.warn('[phone-control] configure rejected:', e))
}

// ── 原生状态缓存(设置行与 capabilities() 共用) ──
let status: PhoneControlStatus | null = null
const subs = new Set<() => void>()

async function refreshStatus(): Promise<void> {
  try {
    status = await Native.status()
  } catch {
    status = null // 插件不可用:不声明能力
  }
  for (const f of Array.from(subs)) f()
}

function subscribeStatus(f: () => void): () => void {
  subs.add(f)
  return () => { subs.delete(f) }
}

/** 设置行用:原生回报的状态(null = 还没拿到 / 插件不可用)。 */
export function usePhoneControlStatus(): PhoneControlStatus | null {
  return useSyncExternalStore(subscribeStatus, () => status)
}

/** 开关:开启走原生确认框(用户拒绝 = 仍是关);无论结果如何,界面只认之后重读的原生状态。 */
export async function setPhoneControlEnabled(enabled: boolean): Promise<void> {
  try {
    await Native.setEnabled({ enabled })
  } catch (e) {
    console.warn('[phone-control] setEnabled failed:', e)
  }
  await refreshStatus()
}

let installed = false
export function installPhoneControl(): void {
  if (installed || !Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('PhoneControl')) return
  installed = true
  pushStrings()
  subscribeLocale(pushStrings)
  void refreshStatus()
  void App.addListener('resume', () => { void refreshStatus() })
  registerClientSurface('phone', {
    capabilities: () => (status?.enabled ? [...status.capabilities] : []),
    // 原样转交;原生先 claim 再做事,JS 不回执(契约 §1)。
    exec: ({ runId, ackId, body }) => {
      void Native.exec({ runId, ackId, body }).catch((e) => console.warn('[phone-control] exec failed:', e))
    },
    // 登出:原生每次请求都现读 CapacitorStorage 的 token,token 一清,在途的 commit / result 自然失败(fail closed);
    // 这里只刷新缓存。
    onReset: () => { void refreshStatus() },
    SettingsRow: PhoneControlRow,
  })
}
