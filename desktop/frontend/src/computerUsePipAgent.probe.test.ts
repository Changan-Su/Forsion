/** pip 窗(?window=pip)里装出来的 ctx.tangu:stop / agentStatus / subscribeAgentStatus 走转发桥,不读本窗 store。
 *  单独一个文件:pipAgentClient() 按模块缓存,location / window.tangu 要在第一次调用之前就摆好。 */
import { describe, it, expect, vi, afterAll } from 'vitest'
import { installTanguProbe } from './tanguProbe'
import { readTangu } from './amadeus/plugins/tanguSeam'
import { useApp } from './stores/appStore'
import './tangu/store/standalone'

const bridge = {
  stop: vi.fn(async (_t: unknown) => true),
  watch: vi.fn((_k: string, _t: unknown) => {}),
  unwatch: vi.fn((_k: string) => {}),
  onStatus: vi.fn((_cb: (key: string, status: unknown) => void) => () => {}),
}
const g = globalThis as unknown as { location?: unknown; window?: unknown }
const hadLocation = 'location' in g, hadWindow = 'window' in g
const prevLocation = g.location, prevWindow = g.window
// 模块都装载完了再摆:装载期有读 window / document 的副作用(node 环境里没有)
function pretendPip(): void {
  g.location = { search: '?window=pip', hash: '', href: 'http://test/?window=pip' }
  g.window = { tangu: { pipAgent: bridge } }
}
function restore(): void {
  if (hadLocation) g.location = prevLocation; else delete g.location
  if (hadWindow) g.window = prevWindow; else delete g.window
}
afterAll(restore)

describe('pip 窗的 ctx.tangu 走转发桥', () => {
  it('stop / agentStatus / subscribeAgentStatus 都交给桥(本窗 store 里有同名 run 也不碰)', async () => {
    const localStop = vi.fn(async () => true)
    useApp.setState({ stop: localStop, runningBySession: { s1: 'r1' } } as never)
    pretendPip()
    try { installTanguProbe() } finally { restore() }
    const t = readTangu()!
    await expect(t.stop!({ runId: 'r1' })).resolves.toBe(true)
    expect(bridge.stop).toHaveBeenCalledWith({ runId: 'r1' })
    expect(localStop).not.toHaveBeenCalled()
    expect(t.agentStatus!({ runId: 'r1' })).toMatchObject({ phase: 'idle', runId: null }) // 还没推到 = idle,不读本窗
    expect(bridge.watch).toHaveBeenCalledWith('o:r:r1', { runId: 'r1' })
    const off = t.subscribeAgentStatus!(() => {}, 's9')
    expect(bridge.watch).toHaveBeenCalledWith('s:s9', 's9')
    off()
    expect(bridge.unwatch).toHaveBeenCalledWith('s:s9')
  })
})
