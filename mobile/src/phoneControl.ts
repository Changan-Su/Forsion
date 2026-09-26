/**
 * 手机操控(T1 快通道)的 JS 半身:把原生 PhoneControl 插件登记成 client surface `phone`。
 * 契约:Forsion-Genesis/tangu-agent/docs/phone-control.md(§5 surface、§6 原生 API)。
 *
 * JS 在这条链上只是**不受信的搬运工**:exec 原样转交 {runId, ackId, body},claim / 分级 / 执行 / 回执
 * 全在原生;token 与 apiBase 原生自取;开关也在原生 —— 本文件只缓存原生回报的 status(同步的
 * capabilities() 要用),启动与 App 回到前台时刷新。
 * 用户可见文案(开启确认框、R3 确认框、T2 租约浮层与停止药丸)经 configure() 推给原生,切语言重推;
 * 原生代码里没有用户可见字面量(唯一例外:伴随包无障碍服务的 label/description,系统设置页要读,住 res/values*)。
 * T2(`phone.ui`)的能力同样只认原生回报 —— 伴随包装没装、签名、无障碍开没开、proto 对不对都由原生判(契约 §9.1)。
 */
import { useSyncExternalStore } from 'react'
import { App } from '@capacitor/app'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { registerClientSurface } from '@/services/clientSurfaces'
import { registerMessages, subscribeLocale, translate } from '@/i18n'
import { PhoneControlRow } from './PhoneControlRow'

/** 伴随包(com.forsion.tangu.hands)状态,与 §9.6 的 hands_* 结果码一一对应。与 T1 开关无关,如实报告。 */
export type HandsState = 'missing' | 'signature_mismatch' | 'proto_mismatch' | 'disabled' | 'ready'

export interface PhoneControlStatus {
  enabled: boolean
  capabilities: string[]
  foreground: boolean
  proto: number
  /** 不支持 T2 的老原生不带这两个字段 → 设置页不出 T2 小节(不能当成「未安装」)。 */
  hands?: HandsState
  /** Build.VERSION.SDK_INT(33+ 才有「受限设置」那一关)。别从 userAgent 推:UA 精简会把版本号冻住。 */
  sdk?: number
}

interface PhoneControlPlugin {
  status(): Promise<PhoneControlStatus>
  setEnabled(o: { enabled: boolean }): Promise<{ enabled: boolean }>
  configure(o: { strings: Record<string, string> }): Promise<void>
  exec(o: { runId: string; ackId: string; body: string }): Promise<{ accepted: boolean }>
  openAccessibilitySettings(): Promise<void>
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
  // T2 租约浮层(契约 §9.5)。⚠️ leaseBody 必须含 {minutes}:租约时长由原生填(原生是时长的唯一真源),缺占位符原生拒收。
  // 这里是真正的同意时刻,所以边界与落云写在浮层正文里,不只写在设置页。
  // ⚠️ 提交词表是启发式(§9.4「对外不许写成硬边界」):文案只能说「会停下交还」并点明会漏,不能许诺「绝不会发送」。
  // 正文刻意不出现按钮上的字(允许 / 暂不 / 停止):台架按文字找按钮点。
  'phone.native.leaseTitle': { zh: '让 Tangu 查看并操作屏幕？', en: 'Let Tangu see and use the screen?' },
  'phone.native.leaseBody': {
    zh: '接下来 {minutes} 分钟内，Tangu 可以读取屏幕内容，并在其他 App 里点按、输入和滑动。遇到发送、支付、下单时它会停下交给你；这项判断靠按钮文字，纯图标按钮可能漏判，请留意屏幕。微信只读不操作，支付宝、银联与常见银行、证券 App 对 Tangu 不可见。\n\n屏幕上的文字会发送到 Forsion 云端，并保存在对话记录里。屏幕边缘的按钮可以随时结束。',
    en: 'For the next {minutes} minutes, Tangu can read the screen and tap, type and scroll in other apps. It pauses and hands back to you before sending, paying or ordering, but this check relies on button labels and can miss icon-only buttons, so keep an eye on the screen. WeChat is read-only; Alipay, UnionPay and common banking and brokerage apps are hidden from Tangu.\n\nScreen text is sent to Forsion cloud and stored in the conversation. You can end this at any time with the button at the edge of the screen.',
  },
  'phone.native.leaseAllow': { zh: '允许', en: 'Allow' },
  'phone.native.leaseDeny': { zh: '暂不', en: 'Not now' },
  // 租约期间常驻屏幕边缘的药丸:说明 + 停止键(点停止 = 撤租约 + 原生直接 abort 当前 run)。
  'phone.native.pillLabel': { zh: 'Tangu 正在操作', en: 'Tangu is operating' },
  'phone.native.pillStop': { zh: '停止', en: 'Stop' },
})

// 老原生只按自己的键表取值、忽略多余的键,所以多推 T2 的键对 T1 包无害。
const NATIVE_KEYS = [
  'enableTitle', 'enableBody', 'enableConfirm', 'cancel', 'confirmTitle', 'confirmBody', 'confirmAllow', 'confirmDeny',
  'leaseTitle', 'leaseBody', 'leaseAllow', 'leaseDeny', 'pillLabel', 'pillStop',
] as const

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

/** 打开系统无障碍设置页(开伴随包的服务)。回到 Forsion 时 resume 会重读状态,这里不用轮询。 */
export async function openAccessibilitySettings(): Promise<void> {
  try {
    await Native.openAccessibilitySettings()
  } catch (e) {
    console.warn('[phone-control] openAccessibilitySettings failed:', e) // 老原生没有这个方法
  }
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
