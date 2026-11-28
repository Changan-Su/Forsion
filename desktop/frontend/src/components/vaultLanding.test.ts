// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { translate } from '../i18n'
import type { BindingView, DownloadError, LibraryInfo, VaultSyncGet } from '../sync/v2/types'
import { DOWNLOAD_BLOCK_GROUP } from '../sync/v2/download'

const fake = vi.hoisted(() => ({
  amadeus: {
    vaultCreate: vi.fn(), vaultDefaultParent: vi.fn(), vaultIsEmptyDir: vi.fn(), vaultRemoveEmptyDir: vi.fn(),
    listVaults: vi.fn(), forgetVault: vi.fn(), moveSyncVaultPin: vi.fn(), vaultSyncActions: vi.fn(),
  },
  get: vi.fn(), resolveName: vi.fn(), downloadCheck: vi.fn(), download: vi.fn(), create: vi.fn(), unbind: vi.fn(), libraries: vi.fn(),
  openSettings: vi.fn(), refresh: vi.fn(), preview: vi.fn(), scroll: vi.fn(), switchVault: vi.fn(), openRoot: '/workspace/Notes',
  account: 'account', mode: 'full', menu: vi.fn(), toast: vi.fn(), penzorOpen: vi.fn(), penzorSource: true, penzorElsewhere: false, openObject: vi.fn(),
}))
vi.mock('@amadeus/api', () => ({ amadeus: fake.amadeus }))
vi.mock('@amadeus/store/pageStore', () => ({ usePageStore: { getState: () => ({ vaultRoot: fake.openRoot, switchLocalVault: fake.switchVault }) } }))
vi.mock('@amadeus/components/DialogOverlay', () => ({ DialogOverlay: 'div' }))
vi.mock('@amadeus/components/Dialogs', () => ({ useEscape: () => {} }))
vi.mock('../sync/VaultSyncPanel', () => ({ bytesText: (n: number) => n + ' B' }))
vi.mock('../sync/vaultSyncStore', () => ({ refreshVaultSync: fake.refresh, ensureVaultSyncSubscribed: () => {}, useVaultSync: () => ({}), feedsOf: () => [], useVaultSyncRaw: Object.assign((sel: (s: { v2: null }) => unknown) => sel({ v2: null }), { getState: () => ({ v2: null }) }) }))
vi.mock('../sync/v2/client', () => ({ vaultSync: fake, deviceName: async () => null }))
vi.mock('../sync/v2/openSyncSettings', () => ({ openSyncSettings: fake.openSettings, downloadPreviewFocus: vi.fn() }))
vi.mock('../sync/v2/mode', () => ({ modeFrom: () => ({ mode: fake.mode }), setSyncMode: () => {}, isFullSync: () => fake.mode === 'full',
  isLegacySync: () => fake.mode === 'legacy', isDesktopExtendOff: () => false, useSyncMode: (sel: (s: { mode: string }) => unknown) => sel({ mode: fake.mode }) }))
vi.mock('../stores/appStore', () => ({ useApp: (sel: (s: unknown) => unknown) => sel({ authInfo: { loggedIn: !!fake.account, accountId: fake.account } }) }))

vi.mock('@lcl/engine', () => ({
  OverlayAt: () => null, openObject: fake.openObject, spaceOpensElsewhere: () => fake.penzorElsewhere,
  useSpaceStore: { getState: () => ({ activeSpaceId: 'forsion-penzor', spaces: [{ id: 'forsion-penzor' }] }) },
}))
vi.mock('@amadeus/plugins/pluginStore', () => {
  const item = { id: 'penzor-places', open: fake.penzorOpen }
  return { usePluginStore: { getState: () => ({
    activeIds: ['forsion-extend'], plugins: [{ id: 'forsion-extend', locked: true }],
    listSources: fake.penzorSource ? [{ pluginId: 'forsion-extend', item }] : [],
  }) } }
})
vi.mock('./SettingsPage', () => ({ SettingsPage: ({ schema }: { schema: import('./SettingsPage').HostSettingsGroup[] | { groups?: import('./SettingsPage').HostSettingsGroup[] } }) =>
  React.createElement('div', null, !Array.isArray(schema) && schema.groups?.find((g) => g.id === 'ssync-cloud')?.items?.map((item) => item.type === 'block' ? React.createElement(React.Fragment, { key: item.id }, item.node) : null),
  ),
}))
vi.mock('../services/syncSetup', () => ({ PENZOR_SPACE_ID: 'forsion-penzor', openPenzorSync: vi.fn(), penzorSyncReady: () => false }))
vi.mock('./SettingsPrimitives', () => ({ SettingsSwitch: () => null }))
vi.mock('./SyncSettingsParts', () => ({ RecordsBlock: () => null, RecoveryList: () => null, SummaryCard: () => null }))
vi.mock('../sync/SyncRecordList', () => ({ SyncRecordsDialogHost: () => null }))
vi.mock('../sync/VaultSyncChip', () => ({ Mark: () => null, VaultSyncChip: () => null }))

vi.mock('./RightPanel', () => ({ ContextMenu: ({ menu }: { menu: unknown }) => { fake.menu(menu); return null } }))
vi.mock('@amadeus/components/askString', () => ({ askString: vi.fn() }))
vi.mock('@amadeus/unified/writeSafety', () => ({ emitAmadeusToast: fake.toast }))

import { registerMessages } from '../i18n'
import { DownloadVaultDialog } from './DownloadVaultDialog'
import { NewVaultDialog } from './NewVaultDialog'
import { StopDownloadCard } from './StopDownloadCard'
import { SyncFocusCapability } from '../sync/v2/SyncFocusCapability'
import { SyncSettings } from './SyncSettings'
import { LocalVaultButton } from '../amadeusVaultMenu'
import type { CtxItem } from './RightPanel'
import { cloudOnlyRows } from '../sync/v2/vaultSurfaces'

registerMessages({
  'amdlg.cancel': { zh: '取消', en: 'Cancel' },
  'vaultMenu.create': { zh: '新建', en: 'Create' },
  'vaultMenu.newTitle': { zh: '新建智库', en: 'New vault' },
})

const cloud: LibraryInfo = {
  id: 'work-library', vaultId: 'work-library', kind: 'own', prefix: 'Amadeus/', name: 'Work', nameKey: 'work', files: 3, bytes: 600, updatedAt: null, devices: [],
}
const workRoot = '/workspace/Vaults/Work'
const binding: BindingView = {
  root: workRoot, name: 'Work', id: 'binding', target: { kind: 'penzor', vaultId: cloud.id, vaultName: 'Work', prefix: 'Amadeus/', placement: 'own' },
  state: 'active', paused: false, enabled: true, role: 'primary', scope: { mode: 'all' },
  status: { phase: 'idle', lastSyncAt: null, pendingChanges: 2, deletesPending: 0, failures: 0, held: 1 },
}
const ok = (value: unknown) => ({ ok: true, value })
const fail = (error: string, detail?: unknown) => ({ ok: false, error, detail })
const get = (bindings: BindingView[] = []): VaultSyncGet => ({
  version: 2, mode: 'full', bindings, localVaults: [], cadence: { kind: 'manual' }, cloudVaults: null,
  serverCaps: { vaults: true, realMove: false }, sealed: { agents: true, plugins: true }, takeover: [], recoveryCount: 0,
})
const dir = (root: string, extra = {}) => ({ root, name: root.split('/').at(-1), display: root, exists: true, pinned: false, current: false, ...extra })
const libraries = (list = [cloud], stale = false) => ok({ list: { libraries: list, generatedAt: '' }, stale, fetchedAt: 1 })
const ready = (state: 'new' | 'empty' | 'nonempty' = 'new') => ok({ ok: true, root: workRoot, name: 'Work', kind: 'own', files: 3, bytes: 600, freeBytes: 2000, state })
const close = vi.fn()
const preview = vi.fn()
const review = vi.fn()
const stopped = vi.fn()
const created = vi.fn()
let root: Root

const mount = async (el: React.ReactNode) => { await act(async () => root.render(el)) }
const text = () => document.querySelector('form[data-vault-landing]')?.textContent ?? ''
const button = (key: string) => [...document.querySelectorAll('form button')].find((b): b is HTMLButtonElement => b.textContent === translate(key))
const click = async (key: string) => { await act(async () => button(key)!.click()) }
const enterName = async (value: string) => {
  const input = document.querySelector('form input[type=text], form input.dialog-input') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const downloadDialog = (name = 'Work') => React.createElement(DownloadVaultDialog, { library: { ...cloud, name }, onClose: close, onPreview: preview })
const stop = (blocked = false) => React.createElement(StopDownloadCard, { binding, blocked, onClose: close, onReview: review, onStopped: stopped })
const newDialog = () => React.createElement(NewVaultDialog, {
  option: { available: true, defaultChecked: true }, onClose: close, onCreated: created,
  onDownload: (library) => root.render(React.createElement(DownloadVaultDialog, { library, onClose: close, onPreview: preview })),
})

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('tangu', { pickDirectory: vi.fn(), openFloatingPanel: vi.fn(), authStatus: async () => ({ loggedIn: !!fake.account, accountId: fake.account }) })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  fake.openRoot = '/workspace/Notes'; fake.account = 'account'; fake.mode = 'full'
  fake.amadeus.vaultDefaultParent.mockResolvedValue('/workspace/Vaults')
  fake.amadeus.vaultCreate.mockResolvedValue({ root: workRoot, created: true })
  fake.amadeus.vaultIsEmptyDir.mockResolvedValue(true)
  fake.amadeus.vaultRemoveEmptyDir.mockResolvedValue(undefined)
  fake.amadeus.vaultSyncActions.mockReturnValue({ download: true, create: true, unbind: true })
  fake.amadeus.listVaults.mockResolvedValue([dir(workRoot)])
  fake.amadeus.forgetVault.mockResolvedValue(true)
  fake.amadeus.moveSyncVaultPin.mockResolvedValue('moved')
  fake.get.mockResolvedValue(ok(get()))
  fake.switchVault.mockResolvedValue(undefined)
  fake.penzorSource = true; fake.penzorElsewhere = false
  fake.openObject.mockResolvedValue({ ok: true })
  fake.resolveName.mockResolvedValue(ok({ candidates: [] }))
  fake.downloadCheck.mockResolvedValue(ready())
  fake.download.mockResolvedValue(ok({ ok: true, bindingId: 'new-binding' }))
  fake.libraries.mockResolvedValue(libraries())
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const downloadErrors: Array<[DownloadError | string, string]> = [
  ...Object.entries(DOWNLOAD_BLOCK_GROUP).filter(([code]) => code !== 'already_local') as Array<[DownloadError, string]>,
  ...['compat_mode', 'channel_missing', 'extend_unavailable', 'stale', 'state_unreadable', 'account_changed'].map((code): [string, string] => [code, 'unavailable']),
]
it.each(downloadErrors)('download guard %s presents its reason and the location or settings action', async (code, group) => {
  fake.downloadCheck.mockResolvedValue(fail(code, { bytes: 600, freeBytes: 1 }))
  await mount(downloadDialog())
  expect(text()).toContain(translate('landing.err.' + code, { name: 'Work' }))
  expect(!!button('landing.change')).toBe(['space', 'nested', 'legacy_sync', 'location'].includes(group))
  expect(button('landing.settings')?.disabled ?? true).toBe(group !== 'legacy_sync')
  expect(button('landing.start')?.disabled ?? true).toBe(true)
  expect(fake.amadeus.vaultCreate).not.toHaveBeenCalled()
})
it('shows the known local root and routes to its sync row without creating a duplicate', async () => {
  fake.downloadCheck.mockResolvedValue(fail('already_local', { root: '/other/Work' }))
  await mount(downloadDialog())
  expect(text()).toContain('/other/Work')
  await click('landing.syncExisting')
  expect(fake.openSettings).toHaveBeenCalledWith({ root: '/other/Work', intent: 'start' })
  expect(fake.amadeus.vaultCreate).not.toHaveBeenCalled()
})
it('hands the nonempty folder to the existing preview and omits unknown free space', async () => {
  fake.downloadCheck.mockResolvedValue(ok({ ...ready('nonempty').value as object, freeBytes: null }))
  const args = { root: workRoot, target: { kind: 'penzor', candidate: { kind: 'own', name: 'Work', vaultId: cloud.id } }, scope: { mode: 'all' } }
  fake.download.mockResolvedValue(ok({ ok: true, next: 'preview', preview: args }))
  await mount(downloadDialog())
  expect(text()).not.toContain('这台还剩')
  await click('landing.compare')
  expect(preview).toHaveBeenCalledWith(args, 'Work')
})
it('blocks invalid host names before checking a download', async () => {
  await mount(downloadDialog('Work:2026'))
  expect(text()).toContain(translate('landing.invalidHostName'))
  expect(button('landing.start')?.disabled).toBe(true)
  expect(fake.downloadCheck).not.toHaveBeenCalled()
})

it('blocks invalid host names before resolving or creating a new vault', async () => {
  await mount(newDialog())
  await enterName('W'.repeat(81))
  expect(text()).toContain(translate('landing.invalidHostName'))
  expect(button('vaultMenu.create')?.disabled).toBe(true)
  await click('vaultMenu.create')
  expect(fake.resolveName).not.toHaveBeenCalled()
  expect(fake.amadeus.vaultCreate).not.toHaveBeenCalled()
})
it('debounces Extend name resolution and resolves again when submitting', async () => {
  vi.useFakeTimers()
  fake.create.mockResolvedValue(ok({ ok: true, bindingId: 'b' }))
  await mount(newDialog())
  await enterName('W')
  await enterName('Work')
  await act(async () => vi.advanceTimersByTimeAsync(299))
  expect(fake.resolveName).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(fake.resolveName.mock.calls).toEqual([['Work']])
  await click('vaultMenu.create')
  expect(fake.resolveName.mock.calls).toEqual([['Work'], ['Work']])
  expect(fake.create).toHaveBeenCalledWith(workRoot)
})
it('uses the server name_exists library id all the way through download', async () => {
  fake.resolveName.mockResolvedValue(fail('channel_missing'))
  fake.create.mockResolvedValue(fail('name_exists', { libraryId: cloud.id }))
  await mount(newDialog())
  await enterName('Work')
  await click('vaultMenu.create')
  expect(fake.amadeus.vaultRemoveEmptyDir).toHaveBeenCalledWith(workRoot)
  await click('landing.downloadExisting')
  expect(fake.downloadCheck).toHaveBeenCalledWith(cloud.id, '/workspace/Vaults')
  await click('landing.start')
  expect(fake.download).toHaveBeenCalledWith(cloud.id, workRoot)
  expect(fake.switchVault).not.toHaveBeenCalled()
})
it.each(['offline', 'server_unsupported'])('opens the local vault when cloud creation returns %s', async (error) => {
  fake.create.mockResolvedValue(fail(error))
  await mount(newDialog())
  await enterName('Work')
  await click('vaultMenu.create')
  expect(fake.switchVault).toHaveBeenCalledWith(workRoot)
  expect(created).toHaveBeenCalledWith(expect.objectContaining({ root: workRoot, upload: 'failed', reason: error }), 'Work')
  expect(fake.amadeus.vaultRemoveEmptyDir).not.toHaveBeenCalled()
})
it('shows the reserved name reason and keeps the dialog open', async () => {
  fake.create.mockResolvedValue(fail('reserved'))
  await mount(newDialog())
  await enterName('Work')
  await click('vaultMenu.create')
  expect(text()).toContain(translate('landing.err.reserved'))
  expect(button('vaultMenu.create')?.disabled).toBe(true)
  expect(close).not.toHaveBeenCalled()
})
it('pending does not remove the local entry or complete stop', async () => {
  fake.get.mockResolvedValue(ok(get([binding])))
  fake.unbind.mockResolvedValue(fail('pending', { pending: 3, held: 1, failures: 0 }))
  await mount(stop())
  await click('landing.syncFirst')
  expect(fake.unbind).toHaveBeenCalledWith(binding.id, true)
  expect(text()).toContain(translate('landing.pending', { n: 3, m: 1 }))
  expect(button('landing.keepSyncing')).toBeDefined()
  expect(fake.amadeus.forgetVault).not.toHaveBeenCalled()
  expect(stopped).not.toHaveBeenCalled()
  await click('landing.seeWhich')
  expect(review).toHaveBeenCalledOnce()
})
it('local_pending shows terminal copy without a file count or retry', async () => {
  fake.get.mockResolvedValue(ok(get([binding])))
  fake.unbind.mockResolvedValue(fail('local_pending', { pending: 17 }))
  await mount(stop())
  await click('landing.syncFirst')
  expect(text()).toContain(translate('landing.localPending', { name: 'Work' }))
  expect(text()).not.toContain('17')
  expect(button('landing.ok')).toBeDefined()
  expect(button('landing.stopNow')).toBeUndefined()
  expect(fake.amadeus.forgetVault).not.toHaveBeenCalled()
})
it.each(['takeover_in_progress', 'move_in_progress', 'binding_not_running', 'binding_not_found', 'unbinding_in_progress'])('shows the stop explanation for %s', async (code) => {
  fake.get.mockResolvedValue(ok(get([binding])))
  fake.unbind.mockResolvedValue(fail(code))
  await mount(stop())
  await click('landing.syncFirst')
  expect(text()).toContain(translate('landing.err.' + code))
  expect(!!button('landing.stopNow')).toBe(code === 'binding_not_running')
  expect(fake.amadeus.forgetVault).not.toHaveBeenCalled()
})
it.each(['local-vault-unavailable', 'legacy-remotesync-not-paused'])('blocks %s before calling unbind', async (code) => {
  fake.get.mockResolvedValue(ok(get([binding])))
  fake.amadeus.listVaults.mockResolvedValue([dir(workRoot, { pinned: true })])
  fake.amadeus.moveSyncVaultPin.mockResolvedValue(code)
  await mount(stop())
  await click('landing.stopNow')
  expect(text()).toContain(translate('landing.err.' + code))
  expect(fake.unbind).not.toHaveBeenCalled()
})
it('moves to another registered local vault, moves the pin, then forgets after unbind', async () => {
  fake.openRoot = workRoot
  const other = '/workspace/Notes'
  fake.amadeus.listVaults.mockResolvedValueOnce([dir(workRoot, { pinned: true, current: true }), dir(other)])
  fake.amadeus.listVaults.mockResolvedValueOnce([dir(workRoot, { pinned: true }), dir(other, { current: true })])
  fake.switchVault.mockImplementation(async () => { fake.openRoot = other })
  fake.get.mockResolvedValueOnce(ok(get([binding]))).mockResolvedValueOnce(ok(get()))
  fake.unbind.mockResolvedValue(ok({ root: workRoot }))
  await mount(stop())
  await click('landing.stopNow')
  expect(fake.switchVault).toHaveBeenCalledWith(other)
  expect(fake.amadeus.moveSyncVaultPin).toHaveBeenCalledWith(workRoot)
  expect(fake.unbind).toHaveBeenCalledWith(binding.id, false)
  expect(fake.amadeus.forgetVault).toHaveBeenCalledWith(workRoot)
  expect(fake.switchVault.mock.invocationCallOrder[0]).toBeLessThan(fake.amadeus.moveSyncVaultPin.mock.invocationCallOrder[0]!)
  expect(fake.amadeus.moveSyncVaultPin.mock.invocationCallOrder[0]).toBeLessThan(fake.unbind.mock.invocationCallOrder[0]!)
  expect(fake.unbind.mock.invocationCallOrder[0]).toBeLessThan(fake.amadeus.forgetVault.mock.invocationCallOrder[0]!)
})
it('asks again when unsynced changes appear after opening the stop card', async () => {
  const clean = { ...binding, status: { ...binding.status, held: 0, pendingChanges: 0 } }
  fake.get.mockResolvedValue(ok(get([binding])))
  await mount(React.createElement(StopDownloadCard, { binding: clean, onClose: close, onReview: review, onStopped: stopped }))
  await click('landing.stopConfirm')
  expect(fake.unbind).not.toHaveBeenCalled()
  expect(button('landing.syncFirst')).toBeDefined()
  expect(button('landing.stopNow')).toBeDefined()
})

it('never offers to stop the active vault without a local fallback', async () => {
  await mount(stop(true))
  expect(text()).toContain(translate('landing.err.local-vault-unavailable'))
  expect(button('landing.stopNow')).toBeUndefined()
  expect(fake.unbind).not.toHaveBeenCalled()
})
it('groups by explicit library id without collapsing legacy siblings or comparing names', () => {
  const legacy = { ...cloud, id: 'default:Amadeus/Work/', vaultId: 'default', prefix: 'Amadeus/Work/', kind: 'legacy' as const }
  const sibling = { ...legacy, id: 'default:Amadeus/Notes/', prefix: 'Amadeus/Notes/', name: 'Notes' }
  const existing = { ...get([{ ...binding, target: { kind: 'penzor' as const, vaultId: 'default', vaultName: null, placement: 'legacy-entry' as const, prefix: legacy.prefix } }]), localVaults: [{ root: '/other/Work', name: 'Work', libraryId: cloud.id }] }
  expect(cloudOnlyRows(existing, [cloud, legacy, sibling]).map((r) => r.id)).toEqual([sibling.id])
  expect(cloudOnlyRows({ ...existing, localVaults: [{ root: '/other/Work', name: 'Work' }] }, [cloud]).map((r) => r.id)).toEqual([cloud.id])
})
it('publishes SyncFocus only while a usable cloud-only row and download bridge exist', async () => {
  const global = globalThis as typeof globalThis & { __forsionSyncFocus?: number }
  fake.get.mockResolvedValue(ok(get([binding])))
  await mount(React.createElement(SyncFocusCapability))
  expect(global.__forsionSyncFocus).toBeUndefined()
  fake.get.mockResolvedValue(ok(get()))
  fake.libraries.mockResolvedValue(libraries([cloud], true))
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(global.__forsionSyncFocus).toBeUndefined()
  fake.libraries.mockResolvedValue(libraries())
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(global.__forsionSyncFocus).toBe(1)
  fake.mode = 'legacy'
  await mount(React.createElement(SyncFocusCapability))
  expect(global.__forsionSyncFocus).toBeUndefined()
})

it('lands on the exact cloud library id and consumes a download focus only once', async () => {
  const other = { ...cloud, id: 'other', vaultId: 'other', name: 'Reading' }
  fake.libraries.mockResolvedValue(libraries([other, cloud]))
  const focus = { libraryId: cloud.id, intent: 'download' as const }
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(fake.scroll)
  try {
    await mount(React.createElement(SyncSettings, { focus, legacy: null }))
    expect(fake.downloadCheck.mock.calls).toEqual([[cloud.id, '/workspace/Vaults']])
    expect(scroll.mock.contexts.some((el) => (el as HTMLElement).dataset.ssyncLibrary === cloud.id)).toBe(true)
    await click('amdlg.cancel')
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(fake.downloadCheck).toHaveBeenCalledOnce()
    expect(document.querySelector('form[data-vault-landing]')).toBeNull()
  } finally { scroll.mockRestore() }
})

it('leaves the settings dialog closed for an absent id', async () => {
  await mount(React.createElement(SyncSettings, { focus: { libraryId: 'missing', intent: 'download' }, legacy: null }))
  expect(document.querySelector('[data-ssync-library="work-library"]')).not.toBeNull()
  expect(document.querySelector('form[data-vault-landing]')).toBeNull()
  expect(fake.downloadCheck).not.toHaveBeenCalled()
})

const opening = { x: 10, y: 20 }
const latestMenu = (): CtxItem[] => fake.menu.mock.lastCall?.[0].items ?? []
const openVaultMenu = async () => {
  await mount(React.createElement(LocalVaultButton, { vaultRoot: '/workspace/Notes' }))
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click())
}
it('splits a proven same-name local row and lets an online-only row open its download from the context menu', async () => {
  const match = { ...cloud, name: 'Reading', id: 'reading-library', vaultId: 'reading-library' }
  const local = '/workspace/Reading'
  fake.amadeus.listVaults.mockResolvedValue([dir('/workspace/Notes'), dir(local)])
  fake.get.mockResolvedValue(ok({ ...get(), localVaults: [{ root: local, name: 'Reading', libraryId: match.id }] }))
  fake.libraries.mockResolvedValue(libraries([cloud, match]))
  await openVaultMenu()
  const reading = latestMenu().find((i) => i.label === 'Reading')!
  expect(reading.detail).toBe(translate('landing.sameName'))
  expect(reading.title).toBe(local)
  reading.run()
  expect(fake.switchVault).toHaveBeenCalledWith(local)
  reading.action?.run()
  expect(fake.openSettings).toHaveBeenCalledWith({ root: local, intent: 'start' })
  const work = latestMenu().find((i) => i.label === 'Work')!
  expect(work.dimmed).toBe(true)
  expect(work.disabled).toBe(false)
  work.run()
  expect(fake.toast).toHaveBeenCalledWith(expect.objectContaining({ text: translate('landing.onlineUnavailable') }))
  await act(async () => work.onSecondary?.(opening))
  expect(latestMenu().map((i) => i.label)).toEqual([translate('landing.download'), translate('landing.viewCloud')])
  await act(async () => latestMenu()[1]!.run())
  expect(fake.openObject).toHaveBeenCalledWith({ type: 'space', id: 'forsion-penzor' }, 'here', expect.anything())
  expect(fake.penzorOpen).toHaveBeenCalledWith({ key: 'lib:' + cloud.id, title: 'Work' }, { newTab: false })
  await act(async () => latestMenu()[0]!.run())
  expect(fake.downloadCheck).toHaveBeenCalledWith(cloud.id, '/workspace/Vaults')
})
it('draws an offline cached menu without active cloud operations, and shows a separate unreadable state', async () => {
  fake.libraries.mockResolvedValue(libraries([cloud], true))
  await openVaultMenu()
  const work = latestMenu().find((i) => i.label === 'Work' && i.checked === undefined)!
  expect(work.disabled).toBe(true)
  expect(work.onSecondary).toBeUndefined()
  expect(latestMenu().some((i) => i.kind === 'note' && i.label === translate('landing.err.offline'))).toBe(true)
  fake.libraries.mockResolvedValue(fail('libraries_cache_unreadable'))
  await openVaultMenu()
  expect(latestMenu().some((i) => i.label === translate('landing.cloudUnreadable'))).toBe(true)
})
it('leaves the cloud group and its write actions out when the installed channel is missing', async () => {
  fake.libraries.mockResolvedValue(fail('channel_missing'))
  await openVaultMenu()
  expect(latestMenu().some((i) => i.kind === 'head')).toBe(false)
})

it.each(['missing source', 'space in another window'])('keeps the cloud-page action disabled with %s', async (cause) => {
  fake.penzorSource = cause !== 'missing source'
  fake.penzorElsewhere = cause === 'space in another window'
  await openVaultMenu()
  await act(async () => latestMenu().find((item) => item.label === 'Work' && item.checked === undefined)?.onSecondary?.(opening))
  expect(latestMenu().find((item) => item.label === translate('landing.viewCloud'))?.disabled).toBe(true)
  expect(fake.penzorOpen).not.toHaveBeenCalled()
})
it('disables download for the default cloud vault while keeping its cloud page available', async () => {
  fake.libraries.mockResolvedValue(libraries([{ ...cloud, kind: 'default', name: 'My Vault' }]))
  await openVaultMenu()
  const defaultRow = latestMenu().find((item) => item.label === translate('amadeus.default.cloudNotes'))!
  await act(async () => defaultRow.onSecondary?.(opening))
  expect(latestMenu()[0]).toMatchObject({ disabled: true, detail: translate('landing.err.default_unsupported') })
  expect(latestMenu()[1]?.disabled).toBe(false)
})

it('adds the stop action for a cloud binding and the upload action for a local-only row', async () => {
  const other = '/workspace/Notes'
  fake.amadeus.listVaults.mockResolvedValue([dir(workRoot), dir(other, { current: true })])
  fake.get.mockResolvedValue(ok(get([binding])))
  await openVaultMenu()
  const rows = latestMenu()
  await act(async () => rows.find((item) => item.label === 'Notes')?.onSecondary?.(opening))
  latestMenu().find((item) => item.label === translate('landing.uploadMenu'))?.run()
  expect(fake.openSettings).toHaveBeenCalledWith({ root: other, intent: 'start' })
  await act(async () => rows.find((item) => item.label === 'Work')?.onSecondary?.(opening))
  await act(async () => latestMenu().find((item) => item.label === translate('landing.stop'))?.run())
  expect(text()).toContain(translate('landing.stopTitle', { name: 'Work' }))
})

it('keeps an upload retry on the local menu row after offline cloud creation', async () => {
  fake.create.mockResolvedValue(fail('offline'))
  await openVaultMenu()
  await act(async () => latestMenu().find((item) => item.label === translate('vaultMenu.new'))?.run())
  await enterName('Work')
  await click('vaultMenu.create')
  expect(fake.toast).toHaveBeenCalledWith(expect.objectContaining({ text: translate('landing.uploadFailed', { name: 'Work', reason: translate('landing.err.offline') }) }))
  await openVaultMenu()
  const work = latestMenu().find((item) => item.label === 'Work' && item.checked !== undefined)!
  expect(work.status).toBe(translate('landing.localOnly'))
  expect(work.action?.label).toBe(translate('landing.uploadMenu'))
})
it('does not compare a folder the user rejected and checks again when the same parent is picked', async () => {
  vi.mocked(window.tangu!.pickDirectory!).mockResolvedValue('/workspace/Vaults')
  fake.downloadCheck.mockResolvedValueOnce(ready('nonempty')).mockResolvedValueOnce(ready('new'))
  await mount(downloadDialog())
  await click('landing.different')
  expect(text()).toContain(translate('landing.renameFirst'))
  expect(button('landing.start')?.disabled).toBe(true)
  await click('landing.change')
  expect(fake.downloadCheck).toHaveBeenCalledTimes(2)
  expect(button('landing.start')?.disabled).toBe(false)
})
