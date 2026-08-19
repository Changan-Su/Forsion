/** 复合后缀改名归一化契约:标题入口与树入口共用同一份口径(评审 P2:各写一份=叠床名)。 */
import { describe, it, expect } from 'vitest'
import { normalizePluginRename } from './pluginExt'

const EXT = '.canvas.md'

describe('normalizePluginRename', () => {
  it('裸基名 → 补复合段', () => {
    expect(normalizePluginRename('Foo', EXT)).toBe('Foo.canvas')
  })
  it('手打全后缀 → 只掐 .md,不叠床', () => {
    expect(normalizePluginRename('Foo.canvas.md', EXT)).toBe('Foo.canvas')
  })
  it('已带复合段(含大小写混合)→ 原样', () => {
    expect(normalizePluginRename('Foo.canvas', EXT)).toBe('Foo.canvas')
    expect(normalizePluginRename('Foo.CANVAS', EXT)).toBe('Foo.CANVAS')
  })
  it('手打 .md 尾巴 → 掐掉再补段', () => {
    expect(normalizePluginRename('Bar.md', EXT)).toBe('Bar.canvas')
  })
  it('首尾空白掐掉', () => {
    expect(normalizePluginRename('  Foo  ', EXT)).toBe('Foo.canvas')
  })
})
