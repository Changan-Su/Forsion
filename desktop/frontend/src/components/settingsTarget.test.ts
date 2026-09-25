import { describe, expect, it } from 'vitest'
import { LEGACY_TARGETS, resolveSettingsTarget } from './settingsTarget'

// U-02:登录失效 / 订阅过期 / `/login` 三条入口必须落到按钮所在的子页,不许再被归一到第一项「连接」。
describe('resolveSettingsTarget', () => {
  it.each([
    [undefined, { tab: 'general' }],
    ['', { tab: 'general' }],
    ['forsion', { tab: 'general', sub: 'g-forsion' }], // appStore handleAuthExpired、/login
    ['connection', { tab: 'general', sub: 'g-conn' }],
    ['agent-clis', { tab: 'agents', sub: 'ag-clis' }],
    ['wechat', { tab: 'channels' }],
    ['model/m-providers', { tab: 'model', sub: 'm-providers' }], // ReloginChip(订阅登录按钮在提供方)
    ['general/g-basic', { tab: 'general', sub: 'g-basic' }],
    ['skills', { tab: 'skills' }],
    ['plugin:a/b', { tab: 'plugin:a/b' }], // 插件 id 里的 `/` 不拆
    ['fplugin:x', { tab: 'fplugin:x' }],
    ['model/', { tab: 'model/' }], // 空 sub 不算二级落点(交给 SettingsModal 兜底到第一个可用页)
  ])('%s → %j', (input, expected) => {
    expect(resolveSettingsTarget(input as string | undefined)).toEqual(expected)
  })

  it('别名里的一级页都是真实存在的 StaticTab', () => {
    const known = new Set(['general', 'model', 'agents', 'skills', 'mcp', 'hooks', 'channels', 'browser', 'amadeus-plugins', 'notes', 'sync', 'spaces', 'theme', 'shortcuts', 'notifications', 'statusbar', 'permissions', 'advanced', 'developer', 'about'])
    for (const [alias, [tab]] of Object.entries(LEGACY_TARGETS)) expect(known.has(tab), alias).toBe(true)
  })
})
