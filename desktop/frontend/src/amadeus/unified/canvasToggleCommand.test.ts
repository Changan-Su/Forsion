import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CANVAS_COMMANDS, claimCanvasToggle, releaseCanvasToggle } from './canvasToggleCommand'
import { setLocaleGlobal as setLocale } from '../../i18n'

// 评审 V-20:文档 / 画布切换除了顶栏胶囊,还得有一条命令(命令面板 / 快捷键表可见)。
describe('canvas toggle command', () => {
  const cmd = CANVAS_COMMANDS[0]
  afterEach(() => { setLocale('zh') })

  it('has a lazily translated title (switching language changes it)', () => {
    expect(typeof cmd.title).toBe('function')
    const zh = (cmd.title as () => string)()
    setLocale('en')
    const en = (cmd.title as () => string)()
    expect(zh).toBe('切换文档 / 画布')
    expect(en).toBe('Toggle document / canvas')
  })

  it('runs the most recently claimed note, and releasing someone else does not clear it', () => {
    const a = vi.fn()
    const b = vi.fn()
    claimCanvasToggle(a)
    claimCanvasToggle(b)
    void cmd.run()
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
    releaseCanvasToggle(a)
    void cmd.run()
    expect(b).toHaveBeenCalledTimes(2)
    releaseCanvasToggle(b)
    void cmd.run()
    expect(b).toHaveBeenCalledTimes(2)
  })

  // 装配链:命令进了 Amadeus 的引擎命令集(amadeusCommands 的 CMDS)—— 摘掉这一行,命令面板里就没有它了。
  it('is wired into the Amadeus command set', () => {
    const src = readFileSync(join(__dirname, '../../amadeusCommands.ts'), 'utf8')
    expect(src).toMatch(/^\s*\.\.\.CANVAS_COMMANDS,$/m)
  })
})
