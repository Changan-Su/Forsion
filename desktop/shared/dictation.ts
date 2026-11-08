/**
 * 全局语音输入(听写)的跨进程契约 —— LCL 表面规范方案 B 第四期(docs/ToBeImproved/LCL表面规范方案_2026-11-07/)。
 *
 * 分工(主进程 electron/dictation/,胶囊渲染 frontend/src/dictation/,官方插件 frontend/src/dictation/voiceInputPlugin.ts):
 *   - 主进程独占:全局快捷键、记下按键那一刻的目标、往别的应用写字(剪贴板 + 粘贴)、胶囊窗口。
 *   - 胶囊(桌面作用域的浮层,不抢焦点)只做录音 + 转写,把这一次听写的文字交回主进程;它拿不到「往任意应用写字」的接口。
 *   - 官方插件只经 window.tangu.dictation 这条窄接口:租约开关 + 换快捷键 + 读状态 + 请辅助功能授权。没有一条能写字。
 *     插件今天在宿主渲染进程里执行、能直调 window.tangu,所以「第三方不给」是准入规矩不是安全边界 —— 安全靠的是:
 *     写字只发生在用户亲手按了快捷键开出来的那一次会话里,写的只是胶囊那个 webContents 交回来的文字。
 */

/** 快捷键写法同设置里的(appRefHotkey.hotkeyToAccelerator):'mod+shift+k'。必须带 ⌘/Ctrl 或 ⌥/Alt。 */
export const DICTATION_DEFAULT_HOTKEY = 'alt+shift+space'
/** 设置页给的几个现成组合(第一个是缺省)。macOS 的 ⌘⌥Space(Finder 搜索)、⌥Space(Alfred / ChatGPT 常用)故意不列。 */
export const DICTATION_HOTKEY_PRESETS = ['alt+shift+space', 'mod+shift+space', 'alt+shift+d'] as const

/** 胶囊上能看到的几种状态。 */
export type DictationPhase =
  | 'idle'
  | 'listening'  // 在录、在转写
  | 'finishing'  // 停了,等最后一句
  | 'inserting'  // 写进目标
  | 'done'       // 写好了(一闪就收)
  | 'failed'     // 没写进去:胶囊留「复制」

/** 没写进去的原因(胶囊据此出文案;不承诺任何应用都能写)。 */
export type DictationFailure =
  | 'target-changed'  // 按键时的那个应用 / 窗口已经不在前台了
  | 'secure-field'    // 焦点在密码框(或系统开着安全输入)
  | 'still-typing'    // 一直在打字(可能正在用输入法组字),没等到停
  | 'no-permission'   // macOS 没给 Forsion 辅助功能授权,发不了 ⌘V
  | 'no-field'        // Forsion 自己的窗口里,焦点不在能打字的地方
  | 'paste-failed'    // 剪贴板 / 按键这一步出错
  | 'empty'           // 没听清
  | 'capture'         // 麦克风 / 转写出错(message 里有原话)
  | 'unsupported'     // 这个平台不支持往别的应用写

export interface DictationState {
  /** 服务开着(官方插件挂着租约、且平台支持)。 */
  enabled: boolean
  /** 生效的快捷键(设置里的写法);registered=false 表示被别的应用占了 / 写法不对。 */
  hotkey: string
  registered: boolean
  phase: DictationPhase
  /** 本次听写的号;胶囊只认同号的指令。 */
  sessionId: string | null
  /** failed 时留给「复制」的文字;done 时是写进去的文字。 */
  text?: string
  failure?: DictationFailure
  /** capture 失败时转写那边的原话(已是界面语言)。 */
  message?: string
  /** done:是点了「复制」收的尾(文字在剪贴板上),不是写进去了。 */
  copied?: boolean
  /** macOS:Forsion 有没有辅助功能授权(往别的应用写字要它);别的平台恒 true。 */
  accessibility: boolean
  platform: string
  /** 胶囊的界面语言(主进程这一刻的界面语言)。 */
  locale: 'zh' | 'en'
}

/** 胶囊 → 主进程(只认胶囊那个 webContents)。 */
export const DICTATION_CAPSULE_CHANNELS = {
  state: 'dictation:capsule:state',      // main → capsule:整份状态
  result: 'dictation:capsule:result',    // 这一次听写的最终文字
  error: 'dictation:capsule:error',      // 录音 / 转写失败的原话
  action: 'dictation:capsule:action',    // 胶囊上的按钮:stop / cancel / copy / dismiss / allow
} as const

export type DictationCapsuleAction = 'stop' | 'cancel' | 'copy' | 'dismiss' | 'allow'

/** 渲染层(官方插件)→ 主进程的窄接口。 */
export const DICTATION_CHANNELS = {
  state: 'dictation:state',
  changed: 'dictation:changed',
  attach: 'dictation:attach',
  setHotkey: 'dictation:setHotkey',
  allow: 'dictation:allowAccessibility',
} as const

/** 一次听写最长多久(到点自动当「停」处理)。 */
export const DICTATION_MAX_MS = 5 * 60_000
