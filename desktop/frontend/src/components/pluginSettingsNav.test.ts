// @vitest-environment happy-dom
/**
 * 「插件设置」折叠组(方案 P4)的条目:按名字排、超过 8 个只列 5 个(当前的必在、再按最近打开、再按名字补)+「另外 N 个…」;
 * 两份本机偏好(最近打开 / 见过设置的插件)读不出来时不写回。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  forsionPluginHasSettings, matchPluginSettingsEntry, pluginSettingsNavEntries, readKnownPluginSettings, readRecentPluginSettings,
  sortPluginSettingsEntries, syncKnownPluginSettings, touchRecentPluginSettings, type PluginSettingsEntry,
} from './pluginSettingsNav'

const entry = (name: string, kind: 'engine' | 'forsion' = 'forsion', id = name.toLowerCase()): PluginSettingsEntry => ({
  tab: kind === 'engine' ? `plugin:${id}` : `fplugin:${id}`, kind, id, name, enabled: true, keywords: id,
})
afterEach(() => localStorage.clear())

describe('排序与折叠', () => {
  it('按显示名排,不分大小写;同名 Forsion 在前', () => {
    const sorted = sortPluginSettingsEntries([entry('beta'), entry('Alpha'), entry('alpha', 'engine', 'alpha2'), entry('Gamma')], 'en')
    expect(sorted.map((e) => e.tab)).toEqual(['fplugin:alpha', 'plugin:alpha2', 'fplugin:beta', 'fplugin:gamma'])
  })

  it('不超过 8 个全列,没有「另外 N 个」', () => {
    const list = 'ABCDEFGH'.split('').map((n) => entry(n))
    expect(pluginSettingsNavEntries(list, [])).toEqual({ shown: list, more: 0 })
  })

  it('超过 8 个:当前的必在,再按最近打开,不够按名字补;列出来的仍按名字排', () => {
    const list = 'ABCDEFGHIJ'.split('').map((n) => entry(n))
    const { shown, more } = pluginSettingsNavEntries(list, ['fplugin:h', 'fplugin:gone', 'fplugin:c'], 'fplugin:j')
    expect(shown.map((e) => e.name)).toEqual(['A', 'B', 'C', 'H', 'J'])
    expect(more).toBe(5)
    expect(pluginSettingsNavEntries(list, []).shown.map((e) => e.name)).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('过滤认名字和别名', () => {
    const e = { ...entry('Pomodoro'), keywords: 'pomodoro 番茄钟 timer' }
    expect(matchPluginSettingsEntry(e, 'timer')).toBe(true)
    expect(matchPluginSettingsEntry(e, '番茄')).toBe(true)
    expect(matchPluginSettingsEntry(e, 'clip')).toBe(false)
  })
})

describe('本机偏好', () => {
  it('最近打开:新的在前、去重', () => {
    touchRecentPluginSettings('fplugin:a')
    touchRecentPluginSettings('plugin:b')
    expect(touchRecentPluginSettings('fplugin:a')).toEqual(['fplugin:a', 'plugin:b'])
    expect(readRecentPluginSettings()).toEqual(['fplugin:a', 'plugin:b'])
  })

  it('见过设置的插件:在跑有设置的记上,在跑没设置的摘掉,没在跑的留着;关着时靠它算「有设置」', () => {
    localStorage.setItem('forsion.pluginSettings.known', JSON.stringify(['off-one', 'dropped']))
    const next = syncKnownPluginSettings(['live-one', 'dropped'], new Set(['live-one']))!
    expect([...next].sort()).toEqual(['live-one', 'off-one'])
    expect(forsionPluginHasSettings('off-one', false, new Set(), next)).toBe(true)
    expect(forsionPluginHasSettings('off-one', true, new Set(), next)).toBe(false) // 在跑就只看它现在注册了什么
    expect(forsionPluginHasSettings('x', false, new Set(), null)).toBe(false)
  })

  it('原来那份读不出来 = 不知道:不写回(不拿空表盖掉)', () => {
    localStorage.setItem('forsion.pluginSettings.known', '{broken')
    expect(readKnownPluginSettings()).toBeNull()
    expect(syncKnownPluginSettings(['a'], new Set(['a']))).toBeNull()
    expect(localStorage.getItem('forsion.pluginSettings.known')).toBe('{broken')
  })
})
