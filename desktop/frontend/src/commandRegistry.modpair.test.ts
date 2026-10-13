// @vitest-environment happy-dom
// 「左右修饰键同按」(mod+mod)走的是真事件这一段:捕获阶段记键 → 全局热键分发。纯函数那半在 lcl/engine/shortcutStore.test.ts。
// 放在这边而不是 lcl/engine 下:带 DOM 环境的用例从 desktop 根之外加载不了(同 extendView.test.ts 的摆法)。
import { afterEach, describe, expect, it } from 'vitest'
import { addCommand, installHotkeys, removeCommand, useCommandStore } from '@lcl/engine/commandRegistry'
import { MOD_PAIR, useShortcuts } from '@lcl/engine/shortcutStore'

const key = (type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}): boolean =>
  document.body.dispatchEvent(new KeyboardEvent(type, { code, key: code.startsWith('Meta') ? 'Meta' : code.slice(-1).toLowerCase(), bubbles: true, cancelable: true, ...init }))
const pair = (): void => {
  key('keydown', 'MetaLeft', { metaKey: true })
  key('keydown', 'MetaRight', { metaKey: true })
  key('keyup', 'MetaRight')
  key('keyup', 'MetaLeft')
}

describe('mod+mod 的分发', () => {
  document.documentElement.dataset.platform = 'mac'
  const uninstall = installHotkeys()
  afterEach(() => { removeCommand('t.pair'); useShortcuts.getState().resetAll(); useCommandStore.getState().setPaletteOpen(false) })

  it('绑了 mod+mod 的命令:两个 ⌘ 同按触发一次;⌘K 之类单边组合键不触发它', () => {
    let ran = 0
    addCommand({ id: 't.pair', title: 't', hotkey: MOD_PAIR, run: () => { ran++ } })
    pair()
    expect(ran).toBe(1)
    key('keydown', 'MetaLeft', { metaKey: true })
    key('keydown', 'KeyK', { metaKey: true })
    key('keyup', 'MetaLeft')
    expect(ran).toBe(1)
    expect(useCommandStore.getState().paletteOpen).toBe(true) // ⌘K 照旧开命令面板
  })

  it('命令面板(不在命令表里的伪命令)改成 mod+mod 也能触发', () => {
    useShortcuts.getState().setOverride('command-palette', MOD_PAIR)
    pair()
    expect(useCommandStore.getState().paletteOpen).toBe(true)
  })

  it('收尾', () => { uninstall() })
})
