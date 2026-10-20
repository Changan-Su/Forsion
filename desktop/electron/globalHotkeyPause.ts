/**
 * 设置 → 快捷键录制 / 按键查找期间挂起主进程的全局快捷键。macOS 上已注册的 globalShortcut 先于窗口拿到按键:
 * 不挂起的话,在录制框里按 ⌘⇧M 会直接弹 Mini 窗口、按急停键会直接急停,设置页什么也收不到。
 *
 * 每个全局键的主人登记 pause / resume(Mini、急停;应用引用的普通组合键只在 Forsion 不在前台时注册,用不着),
 * 自带兜底计时的主人另给 renew(续期时一并续上)。
 * 挂起按「租约」记:每个发起方(窗口的 webContents id)一份,各带兜底计时器 —— 渲染层崩了 / 忘了恢复,到点自己释放;
 * 重复 set(holder, true) 续期(设置页每按一下键续一次)。所有租约都释放了才恢复,一扇窗口收尾不会顶掉另一扇的挂起。
 * 登记晚于挂起的主人登记即挂起。
 */
export interface PausableHotkey { pause(): void; resume(): void; renew?(): void }

export interface GlobalHotkeyPause {
  /** 登记一个全局键的主人;返回注销函数。 */
  add(owner: PausableHotkey): () => void
  set(holder: number, on: boolean): void
  isPaused(): boolean
}

export function createGlobalHotkeyPause(d: {
  timeoutMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (t: unknown) => void
  log?: (msg: string) => void
} = {}): GlobalHotkeyPause {
  const setT = d.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearT = d.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const owners = new Set<PausableHotkey>()
  const leases = new Map<number, unknown>() // holder → 兜底计时器
  const each = (fn: (o: PausableHotkey) => void): void => { for (const o of owners) { try { fn(o) } catch { /* 一个主人出错不拖累别的 */ } } }
  const api: GlobalHotkeyPause = {
    add(owner) {
      owners.add(owner)
      if (leases.size) { try { owner.pause() } catch { /* 同上 */ } }
      return () => { owners.delete(owner) }
    },
    set(holder, on) {
      const old = leases.get(holder)
      if (old !== undefined) clearT(old)
      if (on) {
        const wasPaused = leases.size > 0
        leases.set(holder, setT(() => { d.log?.(`[hotkey-pause] holder ${holder} did not resume within timeout; releasing`); api.set(holder, false) }, d.timeoutMs ?? 60_000))
        each((o) => { if (!wasPaused) o.pause(); else o.renew?.() })
        return
      }
      if (!leases.delete(holder) || leases.size) return
      each((o) => o.resume())
    },
    isPaused: () => leases.size > 0,
  }
  return api
}
