import { afterEach, expect, it, vi } from 'vitest'
import { loadWorkbook } from './workbookPreview'
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('terminates a parser that never responds at the time budget', async () => {
  vi.useFakeTimers()
  const terminate = vi.fn()
  vi.stubGlobal('Worker', class { terminate = terminate; postMessage() {} })
  const result = loadWorkbook(new Uint8Array([1]))
  const rejected = expect(result).rejects.toThrow('workbook-timeout')
  await vi.advanceTimersByTimeAsync(5000)
  await rejected; expect(terminate).toHaveBeenCalledOnce()
})
it('cancels the worker on preview close without detaching the source bytes', async () => {
  const terminate = vi.fn()
  const bytes = new Uint8Array([1, 2]); let transferred: Uint8Array | undefined
  vi.stubGlobal('Worker', class { terminate = terminate; postMessage(data: Uint8Array) { transferred = data } })
  const controller = new AbortController()
  const promise = loadWorkbook(bytes, controller.signal)
  controller.abort()
  await expect(promise).rejects.toThrow('Aborted')
  expect(transferred).not.toBe(bytes); expect([...bytes]).toEqual([1, 2]); expect(terminate).toHaveBeenCalledOnce()
})
