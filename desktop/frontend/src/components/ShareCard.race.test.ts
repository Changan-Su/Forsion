// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShareCard } from './ShareCard'
import { ShareStatus } from './ShareStatus'

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../stores/appStore', () => ({ useApp: { getState: () => ({ toast }) } }))
vi.mock('@amadeus/store/pageStore', () => ({ usePageStore: (pick: (s: unknown) => unknown) => pick({ vaultRoot: '/vault', vaultSide: 'cloud' }) }))
vi.mock('../stores/entrySyncStore', () => ({
  useEntrySync: (pick: (s: unknown) => unknown) => pick({ vaults: [] }),
  cloudPathFor: (_v: unknown, _root: unknown, _side: unknown, path: string) => path,
  isSyncedEntry: () => false,
}))
vi.mock('./CloudSyncDialog', () => ({ openCloudSyncDialog: vi.fn() }))
vi.mock('@lcl/engine', () => ({ OverlayAt: ({ children, className }: { children: React.ReactNode; className: string }) => React.createElement('section', { className }, children) }))
vi.mock('../i18n', () => ({ registerMessages: () => {}, translate: (key: string) => key, useI18n: () => ({ t: (key: string) => key }) }))

type Collab = NonNullable<Window['amadeusCollab']>
const quota = { collab: 10, publish: 10 }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
function shared(path: string): Awaited<ReturnType<Collab['pageShare']>> {
  return { quota, share: { path, id: path, title: path, inviteToken: path, inviteRole: 'viewer', hasPassword: false, expiresAt: null, participants: [] } }
}
function published(path: string): Awaited<ReturnType<Collab['publishes']>> {
  return { quota, shares: [{ path, token: path, mode: 'page', createdAt: '' }] }
}

let host: HTMLDivElement
let root: Root
const reads: Array<{ path: string; result: ReturnType<typeof deferred<Awaited<ReturnType<Collab['pageShare']>> >> }> = []
const lists: Array<ReturnType<typeof deferred<Awaited<ReturnType<Collab['publishes']>> >>> = []
const pageShare = vi.fn<Collab['pageShare']>()
const publishes = vi.fn<Collab['publishes']>()
const createPageShare = vi.fn<Collab['createPageShare']>()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  reads.length = 0; lists.length = 0
  toast.mockReset(); createPageShare.mockReset()
  pageShare.mockReset().mockImplementation((path) => {
    const result = deferred<Awaited<ReturnType<Collab['pageShare']>>>()
    reads.push({ path, result })
    return result.promise
  })
  publishes.mockReset().mockImplementation(() => {
    const result = deferred<Awaited<ReturnType<Collab['publishes']>>>()
    lists.push(result)
    return result.promise
  })
  window.amadeusCollab = { pageShare, publishes, createPageShare, inviteUrl: (token: string) => `/invite/${token}`, publishUrl: (token: string) => `/published/${token}` } as unknown as Collab
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); delete window.amadeusCollab; vi.unstubAllGlobals()
})
async function render(path: string, status = false) {
  await act(async () => root.render(status
    ? React.createElement(ShareStatus, { path, onOpen: () => {} })
    : React.createElement(ShareCard, { path, anchor: { x: 400, y: 100 }, onClose: () => {} })))
}
async function resolveRead(index: number, path: string) {
  await act(async () => { reads[index].result.resolve(shared(path)); lists[index].resolve(published(path)) })
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  expect(button, `Missing ${label}`).toBeTruthy()
  await act(async () => button!.click())
}
const urls = () => [...host.querySelectorAll('input[readonly]')].map((n) => (n as HTMLInputElement).value)

describe('sharing UI keeps asynchronous results with their original note', () => {
  it('late sharing and publishing responses for the old path cannot replace the new path', async () => {
    await render('A.md'); await render('folder/A.md')
    await resolveRead(1, 'folder/A.md'); await resolveRead(0, 'A.md')
    expect(urls()).toEqual(['/invite/folder/A.md'])
    await click('share.tabPublish')
    expect(urls()).toEqual(['/published/folder/A.md'])
  })

  it('moving a loaded note immediately removes the old invitation and publication controls', async () => {
    await render('A.md'); await resolveRead(0, 'A.md')
    await click('share.tabPublish')
    expect(urls()).toEqual(['/published/A.md'])
    await render('folder/A.md')
    expect(urls()).toEqual([])
    expect(host.textContent).not.toContain('share.unpublish')
  })

  it('an operation started before a move cannot refresh the old path after the card changes target', async () => {
    const operation = deferred<Awaited<ReturnType<Collab['createPageShare']>>>()
    createPageShare.mockReturnValue(operation.promise)
    await render('A.md')
    await click('share.enable')
    await render('folder/A.md'); await resolveRead(1, 'folder/A.md')
    await act(async () => operation.resolve(shared('A.md').share!))
    expect(pageShare.mock.calls.map(([path]) => path)).toEqual(['A.md', 'folder/A.md'])
    expect(toast).not.toHaveBeenCalled()
  })

  it('a newer refresh for the same note wins over an earlier read', async () => {
    const operation = deferred<Awaited<ReturnType<Collab['createPageShare']>>>()
    createPageShare.mockReturnValue(operation.promise)
    await render('A.md'); await click('share.enable')
    await act(async () => operation.resolve(shared('A.md').share!))
    await resolveRead(1, 'A.md')
    await act(async () => { reads[0].result.resolve({ share: null, quota }); lists[0].resolve({ shares: [], quota }) })
    expect(urls()).toEqual(['/invite/A.md'])
    await click('share.tabPublish')
    expect(urls()).toEqual(['/published/A.md'])
  })

  it('status badges from the old note disappear while the moved note is still loading', async () => {
    await render('A.md', true); await resolveRead(0, 'A.md')
    expect(host.querySelectorAll('.amx-sharestat-chip').length).toBe(2)
    await render('folder/A.md', true)
    expect(host.querySelectorAll('.amx-sharestat-chip').length).toBe(0)
  })
})
