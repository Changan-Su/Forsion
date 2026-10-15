import { describe, expect, it } from 'vitest'
import { cloudSettingsParent, cloudSettingsTabs, cloudTabTitle, cloudViewKey, resolveCloudSettingsKey, cloudAccountSearchKey, type CloudSettingsView } from './settingsCloudNavigation'

const view = (id: string, extra: Partial<CloudSettingsView['item']> = {}, pluginId = 'extend'): CloudSettingsView => ({
  pluginId, item: { id, title: id, mount() {}, ...extra },
})

describe('cloud settings groups', () => {
  const views = [view('account', { aliases: ['profile'], tabTitle: 'Profile' }), view('details', { parent: 'account' }), view('security', { parent: 'account' }), view('quota')]
  it('old profile links open the default account tab; exact old-plugin IDs still win', () => {
    expect(resolveCloudSettingsKey(views, 'fx:extend:profile')).toBe('fx:extend:account')
    expect(resolveCloudSettingsKey([...views, view('profile')], 'fx:extend:profile')).toBe('fx:extend:profile')
    expect(resolveCloudSettingsKey(views, 'fx:other:profile')).toBe('fx:other:profile')
  })
  it('child routes retain their target while the sidebar selects their parent', () => {
    expect(cloudSettingsParent(views, 'fx:extend:security')).toBe('fx:extend:account')
    expect(cloudSettingsTabs(views, 'fx:extend:security').map(cloudViewKey)).toEqual(['fx:extend:account', 'fx:extend:details', 'fx:extend:security'])
    expect(cloudSettingsTabs(views, 'fx:extend:quota')).toEqual([])
    expect(cloudTabTitle(views[0])).toBe('Profile')
  })
  it('missing, cyclic and cross-plugin parents do not hide a page', () => {
    for (const entries of [[view('details', { parent: 'missing' })], [view('a', { parent: 'b' }), view('b', { parent: 'a' })], [view('a', { parent: 'b' }), view('b', {}, 'other')]]) {
      for (const entry of entries) expect(cloudSettingsParent(entries, cloudViewKey(entry))).toBe(cloudViewKey(entry))
    }
  })
  it('labels are resolved at render time after a language change', () => {
    let label = '个人主页'
    const entry = view('account', { tabTitle: () => label })
    expect(cloudTabTitle(entry)).toBe('个人主页')
    label = 'Profile'
    expect(cloudTabTitle(entry)).toBe('Profile')
  })
  it('existing login search reaches details, retaining the older plugin fallback', () => {
    const fallback = 'fx:forsion-extend:account'
    expect(cloudAccountSearchKey([view('account-details', {}, 'forsion-extend')], fallback)).toBe('fx:forsion-extend:account-details')
    expect(cloudAccountSearchKey([view('account', {}, 'forsion-extend')], fallback)).toBe(fallback)
    expect(cloudAccountSearchKey([view('account-details', {}, 'other')], fallback)).toBe(fallback)
  })
})
