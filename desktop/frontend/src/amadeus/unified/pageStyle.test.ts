/** 页面排版选项(评审 C-21)的入口集合与壳属性:桌面 ⋯ 菜单与移动端 sheet 都只画 pageStyleEntries 这一份。 */
import { describe, expect, it, vi } from 'vitest'
import { pageStyleAttrs, pageStyleEntries } from './pageStyle'
import { DEFAULT_PAGE_STYLE } from './viewMemory'

describe('page style entries', () => {
  it('offers font (default / serif / mono), full width and small text with live state', () => {
    const set = vi.fn()
    const entries = pageStyleEntries({ wide: true, small: false, font: 'serif' }, set, (k) => k)
    expect(entries.map((e) => e.id)).toEqual(['font', 'wide', 'small'])
    const font = entries[0]
    if (font.kind !== 'choice') throw new Error('font must be a choice')
    expect(font.options.map((o) => [o.id, o.label, o.on])).toEqual([
      ['default', 'amxpage.font.default', false],
      ['serif', 'amxpage.font.serif', true],
      ['mono', 'amxpage.font.mono', false],
    ])
    font.options[2].run()
    expect(set).toHaveBeenLastCalledWith({ font: 'mono' })
    const [, wide, small] = entries
    expect(wide).toMatchObject({ kind: 'toggle', label: 'amxpage.wide', on: true })
    expect(small).toMatchObject({ kind: 'toggle', label: 'amxpage.small', on: false })
    wide.kind === 'toggle' && wide.run()
    expect(set).toHaveBeenLastCalledWith({ wide: false })
    small.kind === 'toggle' && small.run()
    expect(set).toHaveBeenLastCalledWith({ small: true })
  })

  it('puts no attribute on the shell at defaults', () => {
    expect(pageStyleAttrs(DEFAULT_PAGE_STYLE)).toEqual({})
    expect(pageStyleAttrs({ wide: true, small: true, font: 'mono' })).toEqual({ 'data-page-wide': '', 'data-page-small': '', 'data-page-font': 'mono' })
  })
})
