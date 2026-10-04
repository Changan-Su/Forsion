import { describe, it, expect, vi } from 'vitest'
import { createRestartGuard, readRestartActivity } from './restartGuard'

describe('restart protection', () => {
  it('restarts immediately when there is no work and preserves the install path', async () => {
    const confirm = vi.fn(), restart = vi.fn()
    const request = createRestartGuard({ inspect: async () => ({ tasks: 0, processes: 0 }), confirm, restart })
    expect(await request(true)).toEqual({ ok: true })
    expect(confirm).not.toHaveBeenCalled(); expect(restart).toHaveBeenCalledWith(true)
  })
  it.each([{ tasks: 1, processes: 0 }, { tasks: 0, processes: 1 }])('leaves work untouched when Restart later is chosen: %j', async (activity) => {
    const restart = vi.fn(), confirm = vi.fn(async (_options: unknown) => false)
    expect(await createRestartGuard({ inspect: async () => activity, confirm, restart })()).toEqual({ ok: false })
    expect(restart).not.toHaveBeenCalled()
    expect(confirm.mock.calls[0][0]).toMatchObject({ defaultId: 0, cancelId: 0 })
  })
  it('coalesces concurrent requests and only exits after explicit confirmation', async () => {
    let answer!: (yes: boolean) => void
    const restart = vi.fn(), confirm = vi.fn(() => new Promise<boolean>((r) => { answer = r }))
    const request = createRestartGuard({ inspect: async () => ({ tasks: 3, processes: 1 }), confirm, restart })
    const first = request(); const second = request()
    expect(first).toBe(second)
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(restart).not.toHaveBeenCalled()
    answer(true)
    expect(await first).toEqual({ ok: true }); expect(restart).toHaveBeenCalledTimes(1)
  })
  it('does not interpret an unreachable engine as no work; cancellation allows a later retry', async () => {
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true), restart = vi.fn()
    const request = createRestartGuard({ inspect: async () => { throw new Error('offline') }, confirm, restart })
    expect(await request()).toEqual({ ok: false }); expect(restart).not.toHaveBeenCalled()
    expect(await request()).toEqual({ ok: true })
    expect(confirm.mock.calls[0][0].message).toMatch(/状态|status/)
  })
  it('validates the engine-wide response and uses the local bearer token', async () => {
    const fetcher = vi.fn(async (_url: unknown, _options?: unknown) => new Response(JSON.stringify({ tasks: 4, processes: 2 })))
    expect(await readRestartActivity('http://127.0.0.1:3333/', 'local-token', fetcher)).toEqual({ tasks: 4, processes: 2 })
    expect(fetcher.mock.calls[0]).toMatchObject(['http://127.0.0.1:3333/agent/remote/restart-status', { headers: { Authorization: 'Bearer local-token' } }])
    await expect(readRestartActivity('http://x', '', async () => new Response('{}'))).rejects.toThrow('Invalid')
    await expect(readRestartActivity('http://x', '', async () => new Response('', { status: 503 }))).rejects.toThrow('503')
  })
})
