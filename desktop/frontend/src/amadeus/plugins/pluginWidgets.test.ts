import { afterEach, describe, expect, it, vi } from 'vitest'
import { invalidatePluginWidget, normalizeWidgetList, providePluginWidget, resetPluginWidgetsForTest, revokePluginWidgets } from './pluginWidgets'

describe('plugin widget rows', () => {
  afterEach(() => resetPluginWidgetsForTest())

  it('normalizes rows: needs a title, keeps known fields, caps at 50', () => {
    const l = normalizeWidgetList({ rows: [
      { id: 'a', title: '读书会', time: '10:00', meta: '还有 1 小时', tone: 'accent', now: true },
      { title: '续费域名', done: false, tone: 'loud', extra: 1 },
      { time: '11:00' },
      'x',
      { id: 7, title: 8, group: '明天' },
    ], footer: '今天 1 / 2 完成', empty: '没有' })
    expect(l.rows).toEqual([
      { id: 'a', title: '读书会', time: '10:00', meta: '还有 1 小时', tone: 'accent', now: true },
      { id: '1', title: '续费域名', done: false },
      { id: '7', title: '8', group: '明天' },
    ])
    expect(l.footer).toBe('今天 1 / 2 完成')
    expect(normalizeWidgetList(Array.from({ length: 80 }, (_, i) => ({ title: `t${i}` }))).rows).toHaveLength(50)
    expect(() => normalizeWidgetList({ items: [] })).toThrow()
  })

  it('a dispose from an older provide does not remove the newer one', () => {
    const a = vi.fn(() => []), b = vi.fn(() => [])
    const offA = providePluginWidget('p', 'w', a)
    providePluginWidget('p', 'w', b)
    offA()
    invalidatePluginWidget('p', 'w') // nothing watching: only drops the cache, never throws
    revokePluginWidgets('p')
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
  })
})
