import { describe, expect, it } from 'vitest'
import { pluginWidgetDirs, sanitizePluginWidget } from './ipc'

describe('plugin home widgets (manifest)', () => {
  it('keeps relative folders inside the plugin, at most 8, no repeats', () => {
    expect(pluginWidgetDirs(['widgets/today', 'widgets/today/', 'widgets\\todo', '../x', '/abs', 'C:/x', 'a/./b', '.hidden', 'widgets/.x', 3])).toEqual(['widgets/today', 'widgets/todo'])
    expect(pluginWidgetDirs(Array.from({ length: 20 }, (_, i) => `w/${i}`))).toHaveLength(8)
    expect(pluginWidgetDirs('widgets/today')).toEqual([])
  })

  it('accepts a list widget with a title and drops the rest', () => {
    expect(sanitizePluginWidget({ id: 'today', title: ' 今天 ', titleEn: 'Today', layout: 'list', icon: 'date', space: 'calendar' }))
      .toEqual({ id: 'today', title: '今天', titleEn: 'Today', summary: undefined, summaryEn: undefined, layout: 'list', icon: 'date', space: 'calendar' })
    expect(sanitizePluginWidget({ id: 'today', title: '今天' })).toBeNull() // 没写 layout:这一版只认列表型
    expect(sanitizePluginWidget({ id: 'today', title: '今天', layout: 'html' })).toBeNull()
    expect(sanitizePluginWidget({ id: 'Today', title: 'x', layout: 'list' })).toBeNull()
    expect(sanitizePluginWidget({ id: 'today', title: '  ', layout: 'list' })).toBeNull()
    expect(sanitizePluginWidget({ id: 'today', title: 't', layout: 'list', icon: '<svg>', space: '../x' })).toEqual(expect.not.objectContaining({ icon: expect.anything(), space: expect.anything() }))
    expect(sanitizePluginWidget(['x'])).toBeNull()
  })
})
