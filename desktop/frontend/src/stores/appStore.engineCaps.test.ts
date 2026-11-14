import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const service = vi.hoisted(() => ({ caps: vi.fn() }))
vi.mock('../services/backendService', async (original) => ({
  ...await original<typeof import('../services/backendService')>(),
  getEngineCapabilities: service.caps,
}))
import { useApp } from './appStore'

// 外部引擎的模型下拉(engineCaps):当前模型缺 API key 失败后,清单要在用户照提示登录之后看得到新模型;
// 先发、晚回、还失败了的旧请求不能盖掉新结果。
type Caps = { models: Array<{ id: string; name: string }>; currentModelId?: string; commands: [] }
const caps = (...names: string[]): Caps => ({ models: names.map((n) => ({ id: n, name: n })), commands: [] })
const EMPTY = caps() // getEngineCapabilities 把失败吞成空清单
const deferred = () => { let resolve!: (v: Caps) => void; const p = new Promise<Caps>((r) => { resolve = r }); return { p, resolve } }
const flush = () => new Promise((r) => setTimeout(r, 0))
const models = () => useApp.getState().engineCaps.dsh?.models.map((m) => m.name)

const initial = useApp.getState()
let n = 0
beforeEach(() => { vi.resetAllMocks(); useApp.setState({ ...initial, engineCaps: {} }, true); n += 1 })
afterEach(() => useApp.setState(initial, true))

describe('ensureEngineCaps', () => {
  it('取过就不再取;标了过时之后不当场取,下一次调用让引擎重新探测(fresh)', async () => {
    const id = `dsh-${n}`
    service.caps.mockResolvedValueOnce(caps('official'))
    useApp.getState().ensureEngineCaps(id); await flush()
    useApp.getState().ensureEngineCaps(id); await flush()
    expect(service.caps).toHaveBeenCalledTimes(1)
    expect(service.caps.mock.calls[0][2]).toBe(false)

    useApp.getState().ensureEngineCaps(id, 'stale') // 失败那一刻:用户还没登录,不取
    expect(service.caps).toHaveBeenCalledTimes(1)

    service.caps.mockResolvedValueOnce(caps('official', 'account'))
    useApp.getState().ensureEngineCaps(id); await flush() // 登录之后打开模型菜单
    expect(service.caps).toHaveBeenCalledTimes(2)
    expect(service.caps.mock.calls[1][2]).toBe(true)
    expect(useApp.getState().engineCaps[id].models.map((m) => m.name)).toEqual(['official', 'account'])

    useApp.getState().ensureEngineCaps(id); await flush() // 取到了就不再过时
    expect(service.caps).toHaveBeenCalledTimes(2)
  })

  it('重新探测失败(空清单):留着原来那份,过时的记号也留着,下次再取', async () => {
    service.caps.mockResolvedValueOnce(caps('official'))
    useApp.getState().ensureEngineCaps('dsh'); await flush()
    useApp.getState().ensureEngineCaps('dsh', 'stale')
    service.caps.mockResolvedValueOnce(EMPTY)
    useApp.getState().ensureEngineCaps('dsh'); await flush()
    expect(models()).toEqual(['official'])
    service.caps.mockResolvedValueOnce(caps('official', 'account'))
    useApp.getState().ensureEngineCaps('dsh'); await flush()
    expect(service.caps.mock.calls[2][2]).toBe(true)
    expect(models()).toEqual(['official', 'account'])
  })

  it('先发的请求晚回来(还失败了):不盖后发的那次', async () => {
    const first = deferred(); const second = deferred()
    service.caps.mockReturnValueOnce(first.p).mockReturnValueOnce(second.p)
    useApp.getState().ensureEngineCaps('dsh') // 还没有清单:发第一次
    useApp.getState().ensureEngineCaps('dsh', 'stale')
    useApp.getState().ensureEngineCaps('dsh') // 发第二次
    second.resolve(caps('official', 'account')); await flush()
    first.resolve(EMPTY); await flush()
    expect(models()).toEqual(['official', 'account'])
    const third = deferred(); const fourth = deferred()
    service.caps.mockReturnValueOnce(third.p).mockReturnValueOnce(fourth.p)
    useApp.getState().ensureEngineCaps('dsh', 'stale'); useApp.getState().ensureEngineCaps('dsh')
    useApp.getState().ensureEngineCaps('dsh', 'stale'); useApp.getState().ensureEngineCaps('dsh')
    fourth.resolve(caps('new')); await flush()
    third.resolve(caps('old')); await flush() // 旧的成功了也不盖
    expect(models()).toEqual(['new'])
  })
})
