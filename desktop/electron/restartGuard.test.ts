import { describe, it, expect, vi } from 'vitest'
import { createRestartGuard, readRestartActivity, restartDialog } from './restartGuard'
import { setMainLocale } from './mainI18n'

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

// 中断任务续跑方案 B 第 7 节:开着「重启后自动接着做」、确实有任务在跑时,弹窗改说更新完会接着做,主按钮是「立即更新」。
describe('restart dialog when interrupted tasks resume automatically', () => {
  const ask = async (activity: { tasks: number; processes: number; unknown?: boolean }, install: boolean, autoResume?: () => Promise<boolean>) => {
    const confirm = vi.fn(async (_options: ReturnType<typeof restartDialog>) => true), restart = vi.fn()
    await createRestartGuard({ inspect: async () => activity, confirm, restart, ...(autoResume ? { autoResume } : {}) })(install)
    return confirm.mock.calls[0]?.[0]
  }
  it('update: says the tasks will pick up after the update, primary button is Update now (zh / en)', async () => {
    setMainLocale('zh')
    const zh = await ask({ tasks: 2, processes: 1 }, true, async () => true)
    expect(zh).toMatchObject({ message: '现在更新吗？', buttons: ['稍后', '立即更新'], defaultId: 1, cancelId: 0 })
    expect(zh!.detail).toBe('有 2 个任务在跑。更新完重新打开后，它们会从停下的地方自动接着做。1 个后台进程会被停掉。')
    setMainLocale('en')
    const en = await ask({ tasks: 3, processes: 0 }, true, async () => true)
    expect(en).toMatchObject({ message: 'Update now?', buttons: ['Later', 'Update now'], defaultId: 1, cancelId: 0 })
    expect(en!.detail).toBe('3 tasks are running. After the update they will pick up where they left off. 0 background processes will be stopped.')
    setMainLocale('zh')
  })
  it('a plain relaunch says Restart now', async () => {
    setMainLocale('en')
    expect(await ask({ tasks: 1, processes: 0 }, false, async () => true)).toMatchObject({ message: 'Restart now?', buttons: ['Later', 'Restart now'], defaultId: 1 })
    setMainLocale('zh')
    expect(await ask({ tasks: 1, processes: 0 }, false, async () => true)).toMatchObject({ message: '现在重启吗？', buttons: ['稍后', '立即重启'] })
  })
  it('keeps today\'s dialog when the setting is off, unreadable, the status is unknown or only processes run', async () => {
    const legacy = restartDialog({ tasks: 2, processes: 1 })
    expect(legacy.defaultId).toBe(0)
    expect(await ask({ tasks: 2, processes: 1 }, true, async () => false)).toEqual(legacy)
    expect(await ask({ tasks: 2, processes: 1 }, true)).toEqual(legacy) // 没接这个依赖(旧调用方)
    expect(await ask({ tasks: 2, processes: 1 }, true, async () => { throw new Error('config unreadable') })).toEqual(legacy)
    expect(await ask({ tasks: 0, processes: 0, unknown: true }, true, async () => true)).toEqual(restartDialog({ tasks: 0, processes: 0, unknown: true }))
    expect(await ask({ tasks: 0, processes: 2 }, true, async () => true)).toEqual(restartDialog({ tasks: 0, processes: 2 }))
  })
  it('Later still leaves the work untouched', async () => {
    const restart = vi.fn(), confirm = vi.fn(async () => false)
    expect(await createRestartGuard({ inspect: async () => ({ tasks: 1, processes: 0 }), confirm, restart, autoResume: async () => true })(true)).toEqual({ ok: false })
    expect(restart).not.toHaveBeenCalled()
  })
})
