/**
 * Unit 设备页桥(web/src/amadeus/unitBridge.ts)断线补课要认 v4 笔记(评审 G1-04 远端那半)。
 * Unit 的 SSE 没有 seq、断线期间的事件无从重放,补课只能「凡开着的笔记都回灌一遍」。
 * 旧写法只 fire lastLoadedPage —— 那是 v3 loadPage 设的;v4 笔记主要走 readTextFile,不保证设它(web 原地分支
 * 会设,其余路径不设;也不许在 readTextFile 里补记:会把资源 URL 基准与「上次打开」弄乱)。开着的 v4 实例以
 * unified 生命周期登记处为准(lifecycle.unifiedPaths)。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IPC } from '@amadeus-shared/ipc'
import { createUnitAmadeusBridge } from '../../../web/src/amadeus/unitBridge'
import { registerUnifiedPipe } from './amadeus/unified/lifecycle'

class FakeES {
  static all: FakeES[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) { FakeES.all.push(this) }
  close(): void { this.closed = true }
  send(d: unknown): void { this.onmessage?.({ data: JSON.stringify(d) }) }
}

const rpcCalls: string[] = []
const offs: Array<() => void> = []
beforeEach(() => {
  FakeES.all = []
  rpcCalls.length = 0
  vi.useFakeTimers()
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.stubGlobal('EventSource', FakeES)
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/vault/asset-token')) return new Response(JSON.stringify({ token: 'at1', ttlSec: 600 }))
    if (url.pathname.endsWith('/vault/rpc')) {
      const { ch } = JSON.parse(String(init?.body)) as { ch: string }
      rpcCalls.push(ch)
      const result = ch === IPC.readTextFile ? '# note\n' : ch === IPC.loadPage ? { manifest: null, contents: {} } : null
      return new Response(JSON.stringify({ ok: true, result }))
    }
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => {
  for (const off of offs.splice(0)) off()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const boot = async () => {
  const bridge = await createUnitAmadeusBridge({ base: 'http://unit.test/', getToken: () => 'tok', onAuthError: vi.fn() })
  const first = FakeES.all[0]
  expect(first, 'SSE 在首枚资源令牌到手后起').toBeTruthy()
  first.onopen?.()
  const fired: string[] = []
  offs.push(bridge.onExternalChange((p) => fired.push(p)))
  return { bridge, first, fired }
}

it('断线重连补课:开着的 v4 笔记(只经 readTextFile 打开)也回灌,不只 lastLoadedPage', async () => {
  const { bridge, first, fired } = await boot()
  await bridge.loadPage('Start.md') // 启动页恢复走 v3 loadPage → lastLoadedPage = Start.md
  expect(await bridge.readTextFile('notes/Note.md')).toBe('# note\n') // v4 路由只读正文
  offs.push(registerUnifiedPipe({ path: 'notes/Note.md', flush: async () => {}, retire: () => {} }))
  offs.push(registerUnifiedPipe({ path: 'notes/Note.md', flush: async () => {}, retire: () => {} })) // 同篇分屏:只补一次

  first.onerror?.() // 断线 → 退避重连(1s + ≤0.5s 抖动)
  await vi.advanceTimersByTimeAsync(2000)
  const second = FakeES.all[1]
  expect(second, '重连').toBeTruthy()
  second.onopen?.()
  expect([...fired].sort()).toEqual(['Start.md', 'notes/Note.md'])
})

it('首连不补课;SSE 送来的笔记改动按 origin 去回声后照常进 onExternalChange', async () => {
  const { first, fired } = await boot()
  offs.push(registerUnifiedPipe({ path: 'notes/Note.md', flush: async () => {}, retire: () => {} }))
  expect(fired).toEqual([])
  first.send({ ch: IPC.externalChange, payload: 'notes/Note.md', origin: 'host' })
  expect(fired).toEqual(['notes/Note.md'])
})
