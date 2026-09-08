// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({
  side: 'cloud',
  flush: vi.fn(), db: vi.fn(), draw: vi.fn(), reset: vi.fn(), retire: vi.fn(),
  restore: vi.fn(), initSide: vi.fn(), setState: vi.fn(),
}))
vi.mock('../amadeus/store/pageStore', () => ({
  flushAllScopes: fixture.flush,
  resetAllScopeDocs: fixture.reset,
  usePageStore: { getState: () => ({ vaultSide: fixture.side, restoreVault: fixture.restore, initVaultSide: fixture.initSide }), setState: fixture.setState },
}))
vi.mock('../amadeus/store/dbStore', () => ({ useDbStore: { getState: () => ({ flushAll: fixture.db }) } }))
vi.mock('../amadeus/store/drawingStore', () => ({ useDrawStore: { getState: () => ({ flushAll: fixture.draw }) } }))
vi.mock('../amadeus/unified/lifecycle', () => ({ retireAllUnifiedScopes: fixture.retire }))
import { installAccountTransition } from './accountTransition'

let prepare: () => Promise<void>
let changed: () => void
let dispose: () => void
beforeEach(() => {
  vi.clearAllMocks()
  fixture.side = 'cloud'
  for (const fn of [fixture.flush, fixture.db, fixture.draw, fixture.restore, fixture.initSide]) fn.mockResolvedValue(undefined)
  document.body.innerHTML = '<div id="root"></div>'
  window.amadeus = {} as any
  window.tangu = {
    onAuthWillChange: (cb) => { prepare = cb; return () => {} },
    onAuthChanged: (cb) => { changed = () => cb({ loggedIn: true }); return () => {} },
  } as typeof window.tangu
  dispose = installAccountTransition()
})
afterEach(() => { dispose(); delete window.tangu; Reflect.deleteProperty(window, 'amadeus'); document.body.innerHTML = '' })
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

it('flushes every editor before retiring cloud documents and acknowledging the host', async () => {
  let finish!: () => void
  fixture.flush.mockImplementationOnce(() => new Promise<void>((r) => { finish = r }))
  const pending = prepare()
  await vi.waitFor(() => expect(fixture.flush).toHaveBeenCalledWith(true))
  expect(document.body.inert).toBe(true)
  expect(fixture.retire).not.toHaveBeenCalled()
  finish()
  await pending
  expect(fixture.db).toHaveBeenCalledWith(true)
  expect(fixture.draw).toHaveBeenCalledWith(true)
  expect(fixture.retire).toHaveBeenCalledOnce()
  expect(fixture.reset).toHaveBeenCalledOnce()
  expect(fixture.setState).toHaveBeenCalledWith(expect.objectContaining({ vaultRoot: null, pages: [] }))
  changed()
  await settled()
  expect(fixture.restore).toHaveBeenCalledOnce()
  expect(document.body.inert).toBe(false)
})

it('preserves the public local notebook while flushing pending edits', async () => {
  fixture.side = 'local'
  await prepare()
  changed()
  await settled()
  expect(fixture.flush).toHaveBeenCalledWith(true)
  expect(fixture.reset).not.toHaveBeenCalled()
  expect(fixture.retire).not.toHaveBeenCalled()
  expect(fixture.restore).not.toHaveBeenCalled()
  expect(document.body.inert).toBe(false)
})

it('rejects failed saves and retains the document for recovery', async () => {
  fixture.flush.mockRejectedValueOnce(new Error('Disk full'))
  await expect(prepare()).rejects.toThrow('Disk full')
  expect(fixture.reset).not.toHaveBeenCalled()
  expect(fixture.retire).not.toHaveBeenCalled()
  expect(document.body.inert).toBe(false)
})

it('does not retire documents after the host cancels a slow preparation', async () => {
  let finish!: () => void
  fixture.flush.mockImplementationOnce(() => new Promise<void>((r) => { finish = r }))
  const pending = prepare()
  await vi.waitFor(() => expect(fixture.flush).toHaveBeenCalled())
  changed()
  finish()
  await pending
  expect(fixture.reset).not.toHaveBeenCalled()
  expect(document.body.inert).toBe(false)
})

it('drains a previous vault restore before preparing the next account switch', async () => {
  let finishRestore!: () => void
  fixture.restore.mockImplementationOnce(() => new Promise<void>((r) => { finishRestore = r }))
  await prepare()
  changed()
  await vi.waitFor(() => expect(fixture.restore).toHaveBeenCalledOnce())
  const next = prepare()
  await settled()
  expect(fixture.flush).toHaveBeenCalledTimes(1)
  finishRestore()
  await next
  expect(fixture.flush).toHaveBeenCalledTimes(2)
  expect(fixture.initSide).toHaveBeenCalledOnce()
  expect(fixture.reset).toHaveBeenCalledTimes(2)
  expect(document.body.inert).toBe(true)
})
