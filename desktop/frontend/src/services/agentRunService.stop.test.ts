import { afterEach, describe, expect, it, vi } from 'vitest'
import { abortRun, abortRunAndWait, expediteSteer, listActiveRuns } from './agentRunService'

const cfg = { backendUrl: 'https://example.test', token: 'test' } as any
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('stop transport must not report false success', () => {
  it('flushes queued steering through the existing route without aborting or resending content', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetcher)
    expect(await expediteSteer(cfg, 'r')).toEqual({ ok: true })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][0]).toBe('https://example.test/agent/runs/r/steer')
    expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body)).toEqual({ flush: true })
  })
  it('does not abort or restart when a legacy engine rejects flush', async () => {
    const fetcher = vi.fn(async () => new Response('message is required', { status: 400 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(expediteSteer(cfg, 'r')).rejects.toThrow('message is required')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('bounds a hung steering request without discarding the queued input', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))))
    const flushing = expect(expediteSteer(cfg, 'r')).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(5100)
    await flushing
  })
  it('surfaces an HTTP failure from the abort endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('stop unavailable', { status: 503 })))
    await expect(abortRun(cfg, 'r')).rejects.toThrow('stop unavailable')
  })

  it('surfaces network failures instead of pretending the run stopped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    await expect(abortRun(cfg, 'r')).rejects.toThrow('offline')
  })

  it('does not treat a failed status lookup as an empty active set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    await expect(listActiveRuns(cfg, 's')).rejects.toThrow()
  })

  it('waits for cleanup settlement, not just the aborted database status', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, settled: false, status: 'aborted' }))
      .mockResolvedValueOnce(Response.json({ success: true, settled: true, status: 'aborted' }))
    vi.stubGlobal('fetch', fetcher)
    let finished = false
    const stopping = abortRunAndWait(cfg, 'r', 's').then((value) => { finished = true; return value })
    await vi.advanceTimersByTimeAsync(100)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(await stopping).toBe('aborted')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not infer termination from an empty legacy status response', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/abort') ? { success: true } : { runs: [] })))
    const stopping = expect(abortRunAndWait(cfg, 'r', 's')).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(11_000)
    await stopping
  })

  it('accepts an explicit terminal status from a legacy engine', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/abort') ? { success: true } : { runs: [{ id: 'r', status: 'aborted' }] })))
    expect(await abortRunAndWait(cfg, 'r', 's')).toBe('aborted')
  })

  it('bounds a hung abort request and leaves retry possible', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })))
    const stopping = expect(abortRunAndWait(cfg, 'r', 's')).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(5100)
    await stopping
  })
})
