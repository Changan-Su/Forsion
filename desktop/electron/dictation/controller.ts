/**
 * 全局听写的状态机(主进程;零 electron 依赖,OS 那几下全部注入,vitest 直测)。契约见 shared/dictation.ts。
 *
 * 一次听写:用户按快捷键 → 记下这一刻的目标(哪个应用 / 哪扇窗口;Forsion 自己的窗口记 webContents)→ 胶囊出现、开始录 →
 * 再按一次(或点胶囊上的停)→ 胶囊交回文字 → 写进目标。写不进去就停在 failed,胶囊上留「复制」。
 *
 * 纪律:
 *  1. 写字只由这里发起,且只在一次由快捷键开出来的会话里;文字只认胶囊交回来的、只认同一个会话号(过期的一律丢)。
 *  2. 目标在**按键那一刻**记,不在写的时候现找:写之前由驱动核一遍「还是它在前台」,不是就不写(target-changed)。
 *  3. 服务开关是租约:官方插件在主窗里挂着才开;插件停用 / 主窗关掉 / 重载,租约随 webContents 一起没了,快捷键跟着撤。
 *  4. Esc 只在有胶囊的时候注册成全局键(取消 / 收起),回到 idle 立刻撤 —— 平时绝不吞别的应用的 Esc。
 */
import { DICTATION_MAX_MS, type DictationCapsuleAction, type DictationFailure, type DictationPhase, type DictationState } from '../../shared/dictation'

export type DictationTarget =
  | { kind: 'self'; webContentsId: number }
  | { kind: 'external'; pid: number; window?: number; app?: string }

export type InsertResult = { ok: true; restored?: boolean } | { ok: false; failure: DictationFailure }

export interface DictationDeps {
  platform: string
  /** 按键那一刻的目标;null = 这个平台读不到(当 unsupported)。 */
  captureTarget(): Promise<DictationTarget | null>
  insert(target: DictationTarget, text: string): Promise<InsertResult>
  copy(text: string): Promise<void> | void
  /** macOS:Forsion 有没有辅助功能授权;别的平台回 true。 */
  accessibility(): boolean
  requestAccessibility(): void
  /** hotkey(设置写法)→ 注册成全局键;回 false = 写法不认 / 被别的应用占了。 */
  register(hotkey: string, cb: () => void): boolean
  unregister(hotkey: string): void
  registerEscape(cb: () => void): boolean
  unregisterEscape(): void
  capsule: {
    /** 服务开了:把胶囊窗口预先建好藏着(按键即出,不等加载)。 */
    prepare(): void
    show(): void
    hide(): void
    send(state: DictationState): void
    dispose(): void
  }
  /** 状态广播给各窗口(官方插件的设置页)。 */
  emit(state: DictationState): void
  locale(): 'zh' | 'en'
  newId(): string
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
  log?(msg: string): void
}

export interface DictationController {
  state(): DictationState
  /** 租约:owner = 挂着的那个 webContents id。 */
  attach(owner: number): void
  detach(owner: number): void
  setHotkey(hotkey: string): DictationState
  /** 全局快捷键按下。 */
  toggle(): void
  cancel(): void
  capsuleResult(sessionId: string, text: string): void
  capsuleError(sessionId: string, message: string): void
  capsuleAction(sessionId: string, action: DictationCapsuleAction): void
  /** 设置页录快捷键期间(globalHotkeyPause)。 */
  pause(): void
  resume(): void
}

/** 停了以后等胶囊交文字的上限:流式有自己的 6.5 秒,整段转写(本地模型 / 不支持流式的模型)可能更久。 */
const FINISH_TIMEOUT_MS = 60_000
const DONE_HIDE_MS = 900
const EMPTY_HIDE_MS = 2_500
const CAPTURE_HIDE_MS = 6_000
/** 没写进去的那段文字在胶囊上留多久(复制的机会);之后收起,文字丢弃。 */
const FAILED_HIDE_MS = 30_000

export function createDictationController(d: DictationDeps, opts: { hotkey: string }): DictationController {
  const leases = new Set<number>()
  let hotkey = opts.hotkey
  let registered = false
  let paused = false
  let escape = false
  let phase: DictationPhase = 'idle'
  let sessionId: string | null = null
  let target: Promise<DictationTarget | null> | null = null
  let text: string | undefined
  let failure: DictationFailure | undefined
  let message: string | undefined
  let copied = false
  let timer: unknown = null
  let maxTimer: unknown = null

  const enabled = (): boolean => leases.size > 0
  const snapshot = (): DictationState => ({
    enabled: enabled(), hotkey, registered, phase, sessionId,
    ...(text !== undefined ? { text } : {}),
    ...(failure ? { failure } : {}),
    ...(message ? { message } : {}),
    ...(copied ? { copied } : {}),
    accessibility: d.accessibility(),
    platform: d.platform,
    locale: d.locale(),
  })
  const publish = (): void => {
    const s = snapshot()
    d.capsule.send(s)
    d.emit(s)
  }
  const clear = (t: unknown): void => { if (t != null) d.clearTimeout(t) }
  const later = (ms: number, fn: () => void): void => { clear(timer); timer = d.setTimeout(() => { timer = null; fn() }, ms) }

  const syncEscape = (): void => {
    const want = phase !== 'idle' && enabled() && !paused
    if (want === escape) return
    if (want) escape = d.registerEscape(() => controller.cancel())
    else { d.unregisterEscape(); escape = false }
  }
  const syncHotkey = (): void => {
    const want = enabled() && !paused
    if (registered && !want) { d.unregister(hotkey); registered = false }
    else if (!registered && want) registered = d.register(hotkey, () => controller.toggle())
  }

  const toIdle = (): void => {
    clear(timer); timer = null
    clear(maxTimer); maxTimer = null
    phase = 'idle'
    sessionId = null
    target = null
    text = undefined
    failure = undefined
    message = undefined
    copied = false
    syncEscape()
    d.capsule.hide()
    publish()
  }
  const fail = (why: DictationFailure, keep?: string, msg?: string): void => {
    clear(maxTimer); maxTimer = null
    phase = 'failed'
    failure = why
    text = keep && keep.trim() ? keep : undefined
    message = msg
    syncEscape()
    publish()
    const id = sessionId
    later(text ? FAILED_HIDE_MS : why === 'empty' ? EMPTY_HIDE_MS : CAPTURE_HIDE_MS, () => { if (sessionId === id) toIdle() })
  }

  const start = (): void => {
    clear(timer); timer = null
    sessionId = d.newId()
    text = undefined
    failure = undefined
    message = undefined
    copied = false
    // 先记目标,再出胶囊:胶囊不抢焦点,但记目标这一下不能晚于任何可能的焦点变化。
    target = d.captureTarget().catch((e) => { d.log?.(`[dictation] capture target failed: ${e}`); return null })
    phase = 'listening'
    syncEscape()
    d.capsule.show()
    publish()
    const id = sessionId
    clear(maxTimer)
    maxTimer = d.setTimeout(() => { maxTimer = null; if (sessionId === id && phase === 'listening') stop() }, DICTATION_MAX_MS)
  }
  const stop = (): void => {
    clear(maxTimer); maxTimer = null
    phase = 'finishing'
    publish()
    const id = sessionId
    later(FINISH_TIMEOUT_MS, () => { if (sessionId === id && phase === 'finishing') fail('empty') })
  }

  const insert = async (id: string, said: string): Promise<void> => {
    clear(timer); timer = null
    clear(maxTimer); maxTimer = null
    phase = 'inserting'
    text = said
    publish()
    const t = await target
    if (sessionId !== id) return
    if (!t) { fail(d.platform === 'darwin' || d.platform === 'win32' ? 'target-changed' : 'unsupported', said); return }
    if (t.kind === 'external' && !d.accessibility()) { fail('no-permission', said); return }
    let r: InsertResult
    try { r = await d.insert(t, said) } catch (e) { d.log?.(`[dictation] insert threw: ${e}`); r = { ok: false, failure: 'paste-failed' } }
    if (sessionId !== id) return
    if (!r.ok) { fail(r.failure, said); return }
    phase = 'done'
    syncEscape()
    publish()
    later(DONE_HIDE_MS, () => { if (sessionId === id) toIdle() })
  }

  const controller: DictationController = {
    state: snapshot,
    attach(owner) {
      const was = enabled()
      leases.add(owner)
      if (was) return
      syncHotkey()
      d.capsule.prepare()
      publish()
    },
    detach(owner) {
      if (!leases.delete(owner) || enabled()) return
      if (phase !== 'idle') toIdle()
      syncHotkey()
      d.capsule.dispose()
      publish()
    },
    setHotkey(next) {
      if (next === hotkey) return snapshot()
      if (registered) { d.unregister(hotkey); registered = false }
      hotkey = next
      syncHotkey()
      publish()
      return snapshot()
    },
    toggle() {
      if (!enabled()) return
      if (phase === 'listening') stop()
      else if (phase === 'idle' || phase === 'done' || phase === 'failed') start()
      // finishing / inserting:这一下不算(别把正在写的那次打断)
    },
    cancel() {
      if (phase === 'inserting') return // 已经在写了:取消不了,也不该假装取消了
      if (phase !== 'idle') toIdle()
    },
    capsuleResult(id, said) {
      if (id !== sessionId || (phase !== 'listening' && phase !== 'finishing')) return
      const t = typeof said === 'string' ? said.trim() : ''
      if (!t) { fail('empty'); return }
      void insert(id, t)
    },
    capsuleError(id, msg) {
      if (id !== sessionId || (phase !== 'listening' && phase !== 'finishing')) return
      fail('capture', undefined, String(msg || '').slice(0, 300))
    },
    capsuleAction(id, action) {
      if (id !== sessionId) return
      if (action === 'stop') { if (phase === 'listening') stop() }
      else if (action === 'cancel' || action === 'dismiss') controller.cancel()
      else if (action === 'allow') d.requestAccessibility()
      else if (action === 'copy' && phase === 'failed' && text) {
        const keep = text
        void Promise.resolve(d.copy(keep)).then(() => {
          if (sessionId !== id || phase !== 'failed') return
          phase = 'done'
          copied = true
          failure = undefined
          syncEscape()
          publish()
          later(DONE_HIDE_MS * 2, () => { if (sessionId === id) toIdle() })
        }, (e) => d.log?.(`[dictation] copy failed: ${e}`))
      }
    },
    pause() {
      if (paused) return
      paused = true
      syncHotkey()
      syncEscape()
    },
    resume() {
      if (!paused) return
      paused = false
      syncHotkey()
      syncEscape()
      publish()
    },
  }
  return controller
}
