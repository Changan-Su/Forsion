// @vitest-environment happy-dom
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CtxMenu } from './RightPanel'
import type { CloudLibraryRow } from '../types'

const state = vi.hoisted(() => ({
  flush: vi.fn<() => Promise<void>>(),
  toast: vi.fn(),
  vault: { vaultRoot: 'cloud://default/default:Amadeus/Notes/', vaultSide: 'cloud' },
}))
vi.mock('../amadeus/store/pageStore', () => ({
  flushAllScopes: state.flush,
  usePageStore: { getState: () => state.vault },
}))
vi.mock('../amadeus/unified/writeSafety', () => ({ emitAmadeusToast: state.toast }))
vi.mock('./RightPanel', () => ({
  ContextMenu: ({ menu, onClose }: { menu: NonNullable<CtxMenu>; onClose: () => void }) => React.createElement(
    'div', { role: 'menu', className: menu.className },
    menu.items.map((item) => item.kind
      ? React.createElement('div', { key: item.label }, item.label)
      : React.createElement('button', {
        key: item.label, role: 'menuitemradio', 'aria-checked': item.checked, disabled: item.disabled,
        onClick: () => { onClose(); item.run() },
      }, item.icon, item.label, item.detail)),
  ),
}))

import { OnlineVaultSwitcher } from './CloudVaultPanel'

const rows: CloudLibraryRow[] = [
  { id: 'default', vaultId: 'default', kind: 'default', name: 'My Vault', isDefault: true, files: 41 },
  { id: 'default:Amadeus/Notes/', vaultId: 'default', kind: 'legacy', name: 'Notes', isDefault: false, deviceNames: ['Laptop'] },
  { id: 'work', vaultId: 'work', kind: 'own', name: 'Work', isDefault: false, deviceNames: ['Laptop', 'Desktop'] },
]
let root: Root
let host: HTMLDivElement
let media: EventTarget & { matches: boolean }
let listLibraries: ReturnType<typeof vi.fn<() => Promise<CloudLibraryRow[]>>>
const switchLibrary = vi.fn()
const switchVault = vi.fn()
const listVaults = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  media = Object.assign(new EventTarget(), { matches: false })
  vi.stubGlobal('matchMedia', vi.fn((query) => {
    expect(query).toBe('(min-width: 768px)')
    return media
  }))
  state.flush.mockResolvedValue(undefined)
  state.vault.vaultSide = 'cloud'
  state.vault.vaultRoot = 'cloud://default/default:Amadeus/Notes/'
  listLibraries = vi.fn(async () => rows)
  vi.stubGlobal('amadeusCollab', { listLibraries, switchLibrary, switchVault, listVaults })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function mount(mobile = false) {
  function Harness() {
    const [open, setOpen] = useState(false)
    return React.createElement(OnlineVaultSwitcher, {
      collab: window.amadeusCollab!, vaultRoot: state.vault.vaultRoot, mobile, open, onOpenChange: setOpen,
    })
  }
  await act(async () => root.render(React.createElement(Harness)))
}

async function click(element: HTMLElement | null | undefined) {
  expect(element).toBeTruthy()
  await act(async () => element!.click())
}

const open = () => click(host.querySelector('button'))
const sheet = () => document.querySelector<HTMLDivElement>('.cloud-vault-sheet')
const menu = () => document.querySelector<HTMLDivElement>('.ctx-vault-menu')

it('renders the mobile footer from the full library id and opens the cloud-only bottom sheet', async () => {
  media.matches = true // Native mobile keeps the same sheet even in a wide viewport.
  await mount(true)
  expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Notes · 已保存')
  await open()
  expect(menu()).toBeNull()
  expect(sheet()?.getAttribute('aria-label')).toBe('智库')
  expect(sheet()?.querySelector('.us-section-title')?.textContent).toBe('云端')
  expect(sheet()?.querySelector('.us-row[aria-pressed=true]')?.textContent).toBe('NotesLaptop 落盘')
  expect(sheet()?.textContent).toContain('云端笔记41 个文件')
  expect(sheet()?.textContent).toContain('手机上都是在线打开，改动直接存到云端。')
  expect(sheet()?.querySelectorAll('.us-row')).toHaveLength(3)
  await click(sheet()?.querySelector<HTMLButtonElement>('.us-row[aria-pressed=true]'))
  expect(sheet()).toBeNull()
  await open()
  const back = new Event('forsion:mobile-back', { cancelable: true })
  await act(async () => { window.dispatchEvent(back) })
  expect(back.defaultPrevented).toBe(true)
  expect(sheet()).toBeNull()
  expect(switchLibrary).not.toHaveBeenCalled()
})

it('changes from the web phone sheet to the desktop menu at the wide breakpoint', async () => {
  await mount()
  await open()
  expect(sheet()).toBeTruthy()
  await act(async () => { media.matches = true; media.dispatchEvent(new Event('change')) })
  expect(sheet()).toBeNull()
  expect(menu()?.textContent).toContain('网页上都是在线打开；要落盘，在电脑上的 Forsion 里点')
  expect(menu()?.textContent).toContain('在线 · 2 台设备落盘')
  expect(menu()?.querySelector('[aria-checked=true]')?.textContent).toContain('Notes')
  expect(menu()?.querySelectorAll('button')).toHaveLength(3)
  expect(menu()?.textContent).not.toMatch(/这台电脑上|落盘到这台|打开文件夹/)
})

it.each([false, true])('switches by library id only after flushing the old vault (wide web = %s)', async (wide) => {
  media.matches = wide
  state.vault.vaultRoot = 'cloud://default'
  await mount()
  await open()
  await click((wide ? menu() : sheet())?.querySelectorAll<HTMLButtonElement>('.us-row, [role=menuitemradio]')[1])
  expect(state.flush).toHaveBeenCalledWith(true)
  expect(switchLibrary).toHaveBeenCalledExactlyOnceWith('default:Amadeus/Notes/')
  expect(state.flush.mock.invocationCallOrder[0]).toBeLessThan(switchLibrary.mock.invocationCallOrder[0])
  expect(switchVault).not.toHaveBeenCalled()
  expect(document.querySelector('.cloud-vault-sheet, .ctx-vault-menu')).toBeNull()
})

it('leaves the selection unchanged when a pending write cannot be confirmed', async () => {
  await mount()
  await open()
  state.flush.mockRejectedValueOnce(new Error('save failed'))
  await click(sheet()?.querySelector<HTMLButtonElement>('.us-row'))
  expect(switchLibrary).not.toHaveBeenCalled()
  expect(state.toast).toHaveBeenCalledOnce()
})

it('does not fall back or offer a selection on an unreadable library list', async () => {
  listLibraries.mockRejectedValue(new Error('unreadable'))
  await mount()
  await open()
  expect(listVaults).not.toHaveBeenCalled()
  expect(sheet()?.textContent).toContain('云端的库读不出来')
  expect(sheet()?.querySelector('.us-row')).toBeNull()
  expect(host.textContent).not.toContain('已保存')
  expect(switchLibrary).not.toHaveBeenCalled()
})
