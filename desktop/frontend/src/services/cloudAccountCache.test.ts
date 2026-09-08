import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCloudAccountCache, cloudAccountIdentity, syncCloudAccountCache } from './cloudAccountCache'
import { loadLayout, loadNamedLayout, saveLayout, saveNamedLayout } from '@lcl/engine/layoutPersist'
import { contentStorageKey } from '@lcl/engine/contentStorageScope'

const token = (userId: string, jti = '1'): string => `header.${btoa(JSON.stringify({ userId, jti }))}.signature`
let data: Record<string, string>
beforeEach(() => {
  data = {}
  vi.stubGlobal('localStorage', new Proxy({
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value },
    removeItem: (key: string) => { delete data[key] },
  }, { ownKeys: () => Object.keys(data), getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) }))
})
afterEach(() => vi.unstubAllGlobals())

describe('browser cloud cache account boundary', () => {
  it('clears legacy and foreign snapshots while preserving local preferences and local notes', () => {
    data.amadeus_tree_snap = 'old private tree'
    data.forsion_mobile_config = 'local model preferences'
    data['amadeus.mobile.lastPage'] = 'local.md'
    syncCloudAccountCache('https://cloud.test/api', token('a'))
    expect(data.amadeus_tree_snap).toBeUndefined()
    data.amadeus_tree_snap = 'a tree'
    syncCloudAccountCache('https://cloud.test/api', token('a', 'refreshed'))
    expect(data.amadeus_tree_snap).toBe('a tree')
    syncCloudAccountCache('https://cloud.test/api', token('b'))
    expect(data.amadeus_tree_snap).toBeUndefined()
    expect(data.forsion_mobile_config).toBe('local model preferences')
    expect(data['amadeus.mobile.lastPage']).toBe('local.md')
  })

  it('separates equal user IDs on different servers and clears on logout', () => {
    syncCloudAccountCache('https://one.test/api', token('a'))
    data.amadeus_tree_snap = 'one tree'
    syncCloudAccountCache('https://two.test/api', token('a'))
    expect(data.amadeus_tree_snap).toBeUndefined()
    data['amadeus.cloudVaultId'] = 'private-vault'
    clearCloudAccountCache()
    expect(data['amadeus.cloudVaultId']).toBeUndefined()
  })

  it('separates backends below the same host while normalizing trailing slashes', () => {
    syncCloudAccountCache('https://cloud.test/one/api', token('a'))
    data.amadeus_tree_snap = 'Backend one private notes'
    syncCloudAccountCache('https://cloud.test/one/api/', token('a', 'renewed'))
    expect(data.amadeus_tree_snap).toBe('Backend one private notes')
    syncCloudAccountCache('https://cloud.test/two/api', token('a'))
    expect(data.amadeus_tree_snap).toBeUndefined()
    expect(cloudAccountIdentity('https://cloud.test/one/api', token('a'))).not.toBe(cloudAccountIdentity('https://cloud.test/two/api', token('a')))
  })

  it('does not adopt an origin-only legacy owner into a path-specific account', () => {
    const legacyOwner = JSON.stringify(['https://cloud.test', 'a'])
    const legacyLayoutKey = `tangu2_layout_v4:account:${encodeURIComponent(legacyOwner)}`
    data['forsion.cloudCacheAccount'] = legacyOwner
    data.amadeus_tree_snap = 'Unknown backend private notes'
    data[legacyLayoutKey] = 'Unknown backend private tabs'
    syncCloudAccountCache('https://cloud.test/one/api', token('a'))
    expect(data.amadeus_tree_snap).toBeUndefined()
    expect(contentStorageKey('tangu2_layout_v4')).not.toBe(legacyLayoutKey)
    expect(data[contentStorageKey('tangu2_layout_v4')]).toBeUndefined()
    expect(data[legacyLayoutKey]).toBe('Unknown backend private tabs')
  })

  it('keeps account-owned content snapshots for switching back, including detached/mobile variants', () => {
    const keys = ['tangu2_layout_v4', 'tangu2_named_layouts', 'tangu2_layout_detached_notes', 'lcl_sc_layout_v1', 'lcl_sc_named_layouts_v1_mini', 'forsion.deskBySession', 'forsion_tangu_unread_sessions', 'amadeus_tree_snap', 'amadeus.cloudVaultId', 'amadeus_last_page']
    for (const key of keys) data[`${key}:account:owner-a`] = 'Private A layout'
    clearCloudAccountCache()
    for (const key of keys) expect(data[`${key}:account:owner-a`]).toBe('Private A layout')
  })

  it('prevents the next account from restoring private tabs in desktop, named Space, or mobile layouts', () => {
    syncCloudAccountCache('https://cloud.test/api', token('a'))
    const leaf = { id: 'private-note', type: 'amadeus-page', loc: 'main', title: 'Private acquisition plan', params: { notePath: 'Secret.md', sessionId: 'account-a-chat' } }
    const layout = {
      version: 4 as const,
      dockview: { panels: { 'private-note': { title: leaf.title, params: leaf.params } } },
      sidebars: { left: { visible: true, stash: [] }, right: { visible: false, stash: [] } },
    }
    saveLayout(layout)
    saveNamedLayout('space:amadeus', layout)
    data.tangu2_layout_v3 = JSON.stringify(layout.dockview)
    data.tangu2_layout_detached_note = JSON.stringify(layout)
    const mobile = { v: 1, main: [leaf], left: [], right: [], activeMainId: leaf.id, leftActiveId: null, rightActiveId: null }
    for (const suffix of ['', '_mini', '_detached']) {
      data[`lcl_sc_layout_v1${suffix}`] = JSON.stringify(mobile)
      data[`lcl_sc_named_layouts_v1${suffix}`] = JSON.stringify({ 'space:amadeus': mobile })
    }
    const preferences = {
      'lcl.sideWidth2.amadeus': '{"left":320}', 'lcl.uiMode': 'mobile',
      forsion_shortcuts: '{"open":"Ctrl+O"}', forsion_tangu_active_space: 'amadeus',
      forsion_tangu_ribbon_order: '["tangu","amadeus"]',
      forsion_theme_seed: 'blue', tangu_locale: 'en', amadeus_last_page: 'Local note.md',
    }
    Object.assign(data, preferences)
    expect(loadNamedLayout('space:amadeus')).not.toBeNull()

    syncCloudAccountCache('https://cloud.test/api', token('b'))

    expect(loadLayout()).toBeNull()
    expect(loadNamedLayout('space:amadeus')).toBeNull()
    expect(Object.values(data).some((value) => value.includes('Private acquisition plan') || value.includes('account-a-chat'))).toBe(false)
    for (const [key, value] of Object.entries(preferences)) expect(data[key]).toBe(value)
  })
})
