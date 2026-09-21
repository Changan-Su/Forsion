/**
 * 审批档写入失败要回滚(setExecConfig):引擎审批时现读会话**存值**,PUT 没成功 = 档没改 → 药丸不能停在新档上。
 * 在途的一批全部落定再判:最新一次存上了就信它,没存上就退到「最后一次存上的档」(不是「上一次点的」);中途不回滚。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from './appStore'

const putMock = vi.hoisted(() => vi.fn())
// 审批档走按键合并写(PATCH);老引擎回落 PUT 在 backendService 里,另有单测
vi.mock('../services/backendService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  patchSessionConfig: (...a: unknown[]) => putMock(...a),
}))

const g = globalThis as any
const flush = () => new Promise((r) => setTimeout(r, 0))
function deferred() {
  let resolve!: (v?: unknown) => void
  let reject!: (e: unknown) => void
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const mode = (sid: string) => useApp.getState().configBySession[sid]?.approvalMode

describe('setExecConfig 审批档写入', () => {
  const toast = vi.fn()
  beforeEach(() => {
    g.window = {} // rememberDefaults 摸 window.tangu
    putMock.mockReset()
    toast.mockReset()
    useApp.setState({ toast, configBySession: { s1: { execMode: 'host', approvalMode: 'full-auto', cwd: '/p' } } })
  })
  afterEach(() => { delete g.window })

  it('PUT 失败 → 退回原档并报错;其余键不动', async () => {
    putMock.mockRejectedValueOnce(new Error('HTTP 500'))
    useApp.getState().setExecConfig({ approvalMode: 'readonly' }, 's1')
    expect(mode('s1')).toBe('readonly') // 乐观显示
    await flush()
    expect(mode('s1')).toBe('full-auto')
    expect(useApp.getState().configBySession.s1.cwd).toBe('/p')
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'), true)
  })

  it('PUT 成功 → 停在新档,不报错', async () => {
    putMock.mockResolvedValueOnce({})
    useApp.getState().setExecConfig({ approvalMode: 'readonly' }, 's1')
    await flush()
    expect(mode('s1')).toBe('readonly')
    expect(toast).not.toHaveBeenCalled()
  })

  it('前一次失败时后一次还在途 → 不回滚,由后一次定', async () => {
    const a = deferred(); const b = deferred()
    putMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    useApp.getState().setExecConfig({ approvalMode: 'readonly' }, 's1')
    useApp.getState().setExecConfig({ approvalMode: 'auto-edit' }, 's1')
    a.reject(new Error('boom')); await flush()
    expect(mode('s1')).toBe('auto-edit')
    expect(toast).not.toHaveBeenCalled()
    b.resolve({}); await flush()
    expect(mode('s1')).toBe('auto-edit')
  })

  it('两次都失败 → 退回最初确认存上的档(不是第一次点的)', async () => {
    const a = deferred(); const b = deferred()
    putMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    useApp.getState().setExecConfig({ approvalMode: 'readonly' }, 's1')
    useApp.getState().setExecConfig({ approvalMode: 'auto-edit' }, 's1')
    a.reject(new Error('boom')); b.reject(new Error('boom')); await flush()
    expect(mode('s1')).toBe('full-auto')
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('前一次已存上、后一次失败 → 退回前一次的档', async () => {
    const a = deferred(); const b = deferred()
    putMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    useApp.getState().setExecConfig({ approvalMode: 'readonly' }, 's1')
    useApp.getState().setExecConfig({ approvalMode: 'auto-edit' }, 's1')
    a.resolve({}); await flush()
    b.reject(new Error('boom')); await flush()
    expect(mode('s1')).toBe('readonly')
  })

  it('最新一次先失败、更早那次后存上 → 退到更早那次存上的档(中途不回滚)', async () => {
    const a = deferred(); const b = deferred()
    putMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    useApp.getState().setExecConfig({ approvalMode: 'readonly' }, 's1')
    useApp.getState().setExecConfig({ approvalMode: 'auto-edit' }, 's1')
    b.reject(new Error('boom')); await flush()
    expect(mode('s1')).toBe('auto-edit') // 还有一次在途,先不判
    a.resolve({}); await flush()
    expect(mode('s1')).toBe('readonly')
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('两次都存上、但更早那次后落定 → 药丸对齐后落库的档并提示(不停在更严的最新档)', async () => {
    const a = deferred(); const b = deferred()
    putMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    useApp.getState().setExecConfig({ approvalMode: 'auto-edit' }, 's1')
    useApp.getState().setExecConfig({ approvalMode: 'readonly' }, 's1')
    b.resolve({}); await flush()
    expect(mode('s1')).toBe('readonly')
    a.resolve({}); await flush()
    expect(mode('s1')).toBe('auto-edit')
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('前一次在途时同档再点一次:它是这批最新的,前一次失败不会把它退掉', async () => {
    useApp.setState({ configBySession: { s1: { execMode: 'host', approvalMode: 'readonly' } } })
    const a = deferred(); const b = deferred()
    putMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    useApp.getState().setExecConfig({ approvalMode: 'full-auto' }, 's1')
    useApp.getState().setExecConfig({ approvalMode: 'full-auto' }, 's1')
    a.reject(new Error('boom')); b.resolve({}); await flush()
    expect(mode('s1')).toBe('full-auto')
    expect(toast).not.toHaveBeenCalled()
  })

  it('同档再点那次先失败、前一次后存上 → 停在已存上的新档,不报错', async () => {
    useApp.setState({ configBySession: { s1: { execMode: 'host', approvalMode: 'readonly' } } })
    const a = deferred(); const b = deferred()
    putMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    useApp.getState().setExecConfig({ approvalMode: 'full-auto' }, 's1')
    useApp.getState().setExecConfig({ approvalMode: 'full-auto' }, 's1')
    b.reject(new Error('boom')); await flush()
    a.resolve({}); await flush()
    expect(mode('s1')).toBe('full-auto')
    expect(toast).not.toHaveBeenCalled()
  })

  it('非审批档的 PUT 失败 → 不回滚、不报错(这些键随 run 的 agentConfig 下发,本地值当场生效)', async () => {
    putMock.mockRejectedValueOnce(new Error('HTTP 500'))
    useApp.getState().setExecConfig({ verifyCommand: 'npm test' }, 's1')
    await flush()
    expect(useApp.getState().configBySession.s1.verifyCommand).toBe('npm test')
    expect(toast).not.toHaveBeenCalled()
  })
})
