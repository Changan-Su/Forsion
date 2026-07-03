/**
 * 命令注册表(≈ Obsidian addCommand)+ 命令面板可见性 + 全局热键分发。zustand store,
 * 命令面板订阅 commands;hotkey 形如 'mod+k'(mod = mac⌘ / 其它 Ctrl)。
 */
import { create } from 'zustand'
import type { Command } from './types'
import { useShortcuts, effectiveHotkey } from './shortcutStore'

interface CommandState {
  commands: Command[]
  paletteOpen: boolean
  addCommand(cmd: Command): void
  removeCommand(id: string): void
  run(id: string): void
  setPaletteOpen(open: boolean): void
}

export const useCommandStore = create<CommandState>((set, get) => ({
  commands: [],
  paletteOpen: false,
  addCommand: (cmd) =>
    set((s) => ({ commands: [...s.commands.filter((c) => c.id !== cmd.id), cmd] })),
  removeCommand: (id) => set((s) => ({ commands: s.commands.filter((c) => c.id !== id) })),
  run: (id) => {
    const cmd = get().commands.find((c) => c.id === id)
    if (cmd) cmd.run()
  },
  setPaletteOpen: (open) => set({ paletteOpen: open }),
}))

/** 命令式快捷别名(非 React 上下文亦可调用)。 */
export const addCommand = (cmd: Command): void => useCommandStore.getState().addCommand(cmd)
export const removeCommand = (id: string): void => useCommandStore.getState().removeCommand(id)
export const openCommandPalette = (): void => useCommandStore.getState().setPaletteOpen(true)

/** shift 按下时 e.key 给的是 '{'/'}'(US 布局),归一为 '['/']' —— 存储格式统一用 bracket,
 *  'mod+shift+[' 才能直配 Ctrl/⌘+{。 */
const KEY_ALIAS: Record<string, string> = { '{': '[', '}': ']' }

/** 把 'mod+shift+k' 规范化为与事件比较的 token。 */
function hotkeyMatches(hotkey: string, e: KeyboardEvent): boolean {
  const parts = hotkey.toLowerCase().split('+').map((p) => p.trim())
  const key = parts[parts.length - 1]
  const wantMod = parts.includes('mod')
  const wantShift = parts.includes('shift')
  const wantAlt = parts.includes('alt')
  const mod = e.metaKey || e.ctrlKey
  if (wantMod !== mod) return false
  if (wantShift !== e.shiftKey) return false
  if (wantAlt !== e.altKey) return false
  const k = e.key.toLowerCase()
  return (KEY_ALIAS[k] ?? k) === key
}

/**
 * 安装全局热键监听:Cmd/Ctrl+K 开命令面板,其余按各命令 hotkey 分发。返回卸载函数。
 */
export function installHotkeys(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (useShortcuts.getState().recording) return // 录制快捷键时暂停分发,避免误触发
    const st = useCommandStore.getState()
    // 命令面板:可被设置里改键的伪命令 'command-palette'(默认 mod+k)。
    const paletteKey = effectiveHotkey({ id: 'command-palette', hotkey: 'mod+k' })
    if (paletteKey && hotkeyMatches(paletteKey, e)) {
      e.preventDefault()
      st.setPaletteOpen(!st.paletteOpen)
      return
    }
    for (const cmd of st.commands) {
      const hk = effectiveHotkey(cmd) // 用户覆盖优先;'' = 已解绑
      if (hk && hotkeyMatches(hk, e)) {
        e.preventDefault()
        cmd.run()
        return
      }
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
