/**
 * 账号编排(accountCore.ts)—— 抽出 main.ts 前那两份「按字符串切源码进 vm 跑」的用例(authMainLifecycle / externalAuthLifecycle)改写成
 * 对真模块的断言:五条入口的宿主侧顺序(握手 → 停同步 → 写凭据 → 引擎 → 设备互联 → 起同步 → 广播)、外部变化先 flush 再挪根、
 * 握手失败不重启不改凭据、IPC 路径先更新去重快照 → watcher 跳过、没有 Extend 时 refresh 立即完成。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createAccountCore, credKey, type AccountCoreDeps, type ExternalCredsChange } from './accountCore'
import type { TanguCreds } from './forsionAuth'

const a: TanguCreds = { cloudUrl: 'https://accounts.test', token: 'tok-a', model: 'm' }
const b: TanguCreds = { cloudUrl: 'https://accounts.test', token: 'tok-b' }

/** 假渲染层:收到 auth:will-change 立刻回 auth:ready(events 与生产一样是 ipcMain 形状)。 */
function harness(opts: { prepareFails?: boolean; managed?: boolean } = {}) {
  let creds: TanguCreds = { ...a }
  const events = new EventEmitter()
  const order: string[] = []
  const renderer = {
    id: 7,
    send: (channel: string, payload: unknown) => {
      order.push('flush')
      if (opts.prepareFails) { events.emit('auth:ready', { sender: { id: 7 } }, (payload as { requestId: string }).requestId, 'ENOSPC'); return }
      events.emit('auth:ready', { sender: { id: 7 } }, (payload as { requestId: string }).requestId)
    },
    once: () => {}, removeListener: () => {},
  }
  const deps: AccountCoreDeps = {
    loadCreds: () => ({ ...creds }),
    saveCreds: vi.fn((c: TanguCreds) => { creds = { ...c }; order.push('write') }),
    saveConfig: vi.fn(async () => { order.push('config') }),
    loadConfig: async () => ({ mode: opts.managed === false ? 'external' : 'managed' }),
    ensureBackend: vi.fn(async () => { order.push('backend') }),
    refreshUnitHost: vi.fn(() => { order.push('unit') }),
    renderers: () => [renderer],
    events: events as unknown as AccountCoreDeps['events'],
    broadcast: vi.fn((channel: string) => { order.push(channel) }),
    stopSync: vi.fn(async () => { order.push('stop') }),
    restartSync: vi.fn(async () => { order.push('restart') }),
    log: vi.fn(),
  }
  const core = createAccountCore(deps)
  return { core, deps, order, creds: () => creds, setFile: (c: TanguCreds) => { creds = { ...c } } }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('accountCore', () => {
  it('commit:握手 → 停同步 → 写 cloudUrl → 写 auth.json(合并 model)→ 引擎 → 设备互联 → 起同步 → 广播;assertCurrent 三处关口', async () => {
    const h = harness()
    const asserts: number[] = []
    await h.core.transition(() => h.core.commit({ cloudUrl: b.cloudUrl!, token: b.token! }, () => { asserts.push(h.order.length) }))
    expect(h.order).toEqual(['flush', 'stop', 'config', 'write', 'backend', 'unit', 'restart', 'auth:changed'])
    expect(h.creds()).toEqual({ cloudUrl: b.cloudUrl, token: b.token, model: 'm' })
    expect(asserts).toHaveLength(3)
    expect(h.deps.broadcast).toHaveBeenLastCalledWith('auth:changed', { loggedIn: true })
  })

  it('onCommitPoint:握手 + 停同步之后、写 auth.json 之前调一次;握手失败 / assertCurrent 抛错都不调(Extend 的记账 / 忘账号 / 吊销挂在这里)', async () => {
    const h = harness()
    await h.core.transition(() => h.core.commit({ cloudUrl: b.cloudUrl!, token: b.token! }, undefined, () => h.order.push('commit-point')))
    expect(h.order).toEqual(['flush', 'stop', 'config', 'commit-point', 'write', 'backend', 'unit', 'restart', 'auth:changed'])
    const h2 = harness()
    await h2.core.transition(() => h2.core.clear(undefined, () => h2.order.push('commit-point')))
    expect(h2.order).toEqual(['flush', 'stop', 'commit-point', 'write', 'backend', 'unit', 'restart', 'auth:changed'])
    const h3 = harness({ prepareFails: true })
    const hook = vi.fn()
    await expect(h3.core.transition(() => h3.core.clear(undefined, hook))).rejects.toThrow()
    expect(hook).not.toHaveBeenCalled()
    const h4 = harness()
    await expect(h4.core.transition(() => h4.core.commit({ cloudUrl: b.cloudUrl!, token: b.token! }, () => { if (h4.order.includes('config')) throw new Error('cancelled') }, hook))).rejects.toThrow('cancelled')
    expect(hook).not.toHaveBeenCalled()
    expect(h4.creds()).toEqual(a)
  })

  it('clear:只删 token(留 cloudUrl / model),链同 commit(没有 config 写)', async () => {
    const h = harness()
    await h.core.transition(() => h.core.clear())
    expect(h.order).toEqual(['flush', 'stop', 'write', 'backend', 'unit', 'restart', 'auth:changed'])
    expect(h.creds()).toEqual({ cloudUrl: a.cloudUrl, model: 'm' })
    expect(h.deps.broadcast).toHaveBeenLastCalledWith('auth:changed', { loggedIn: false })
  })

  it('external 模式不重启引擎;assertCurrent 抛错 = 中止且不写凭据,但 finally 里仍起同步 + 广播', async () => {
    const h = harness({ managed: false })
    await expect(h.core.transition(() => h.core.commit({ cloudUrl: b.cloudUrl!, token: b.token! }, () => {
      if (h.order.includes('stop')) throw new Error('Account switch cancelled.')
    }))).rejects.toThrow('cancelled')
    expect(h.order).toEqual(['flush', 'stop', 'restart', 'auth:changed'])
    expect(h.creds()).toEqual(a)
    expect(h.deps.ensureBackend).not.toHaveBeenCalled()
  })

  it('握手失败(编辑器没存下):广播 auth:changed 后抛错,不停同步、不写凭据、不重启', async () => {
    const h = harness({ prepareFails: true })
    await expect(h.core.transition(() => h.core.clear())).rejects.toThrow(/Unable to save an open editor/)
    expect(h.order).toEqual(['flush', 'auth:changed'])
    expect(h.creds()).toEqual(a)
    expect(h.deps.stopSync).not.toHaveBeenCalled()
    expect(h.deps.restartSync).not.toHaveBeenCalled()
  })

  it('transition 串行:第二条等第一条跑完', async () => {
    const h = harness()
    const first = h.core.transition(() => h.core.clear())
    const second = h.core.transition(async () => h.order.push('second'))
    await Promise.all([first, second])
    expect(h.order.indexOf('second')).toBeGreaterThan(h.order.indexOf('auth:changed'))
  })

  it('外部变化(watcher):300ms 防抖;先调 Extend 钩子(previous/current),再 flush → 停同步 → 更新快照 → 引擎 → 设备互联 → 起同步 → 广播;不写凭据', async () => {
    const h = harness()
    const seen: ExternalCredsChange[] = []
    h.core.onExternalChange((c) => { seen.push(c); h.order.push('hook') })
    h.setFile(b) // 别的进程改了 auth.json
    h.core.onAuthFileMaybeChanged(); h.core.onAuthFileMaybeChanged()
    await vi.advanceTimersByTimeAsync(301)
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([{ previous: a, current: b }])
    expect(h.order).toEqual(['hook', 'flush', 'stop', 'backend', 'unit', 'restart', 'auth:changed'])
    expect(h.deps.saveCreds).not.toHaveBeenCalled()
    // 快照已更新:再触发一次 watcher 是空操作
    h.core.onAuthFileMaybeChanged()
    await vi.advanceTimersByTimeAsync(301)
    expect(h.order.filter((x) => x === 'hook')).toHaveLength(1)
  })

  it('外部变化时握手失败:不挪根不重启,凭据保持文件里的新值,钩子已经跑过(Extend 那边的忘记账号不回滚)', async () => {
    const h = harness({ prepareFails: true })
    const hook = vi.fn()
    h.core.onExternalChange(hook)
    h.setFile({ cloudUrl: a.cloudUrl })
    h.core.onAuthFileMaybeChanged()
    await vi.advanceTimersByTimeAsync(301)
    await vi.advanceTimersByTimeAsync(0)
    expect(hook).toHaveBeenCalledWith({ previous: a, current: { cloudUrl: a.cloudUrl } })
    expect(h.order).toEqual(['flush', 'auth:changed'])
    expect(h.deps.restartSync).not.toHaveBeenCalled()
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('external account change failed'))
  })

  it('IPC 路径先更新去重快照 → watcher 随后触发识别为已处理;writeCreds(续期)同样', async () => {
    const h = harness()
    await h.core.transition(() => h.core.commit({ cloudUrl: b.cloudUrl!, token: b.token! }))
    const n = h.order.length
    h.core.onAuthFileMaybeChanged()
    await vi.advanceTimersByTimeAsync(301)
    expect(h.order).toHaveLength(n)
    h.core.writeCreds({ token: 'tok-b-fresh' })
    expect(h.creds()).toEqual({ cloudUrl: b.cloudUrl, token: 'tok-b-fresh', model: 'm' })
    expect(h.core.currentAuthKey()).toBe(credKey(b.cloudUrl!, 'tok-b-fresh'))
    h.core.onAuthFileMaybeChanged()
    await vi.advanceTimersByTimeAsync(301)
    expect(h.order).toHaveLength(n + 1) // 只多了 writeCreds 那次 write
  })

  it('refresh:没登记续期实现 = 立即完成;登记了就透传 timeoutMs', async () => {
    const h = harness()
    await expect(h.core.refresh(4000)).resolves.toBeUndefined()
    const fn = vi.fn(async () => {})
    h.core.setRefresher(fn)
    await h.core.refresh(4000)
    expect(fn).toHaveBeenCalledWith(4000)
  })
})
