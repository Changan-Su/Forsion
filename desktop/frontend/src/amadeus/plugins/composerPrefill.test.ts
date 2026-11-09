// @vitest-environment happy-dom
// ctx.tangu.mountComposer 把宿主输入框的 prefill 转给插件(主页插件化 H8,2026-11-09 Codex 评审补):
// 宿主有才转(插件按 typeof 判),插件停用后不再往输入框里填。
import { describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ get amadeus() { return undefined } }))

const { usePluginStore } = await import('./pluginStore')
const { setTanguProbe } = await import('./tanguSeam')
type Ctx = import('./types').PluginContext

function ctxOf(id: string): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c } }])
  return ref!
}
const handle = (extra: object = {}) => ({ focus: vi.fn(), startVoice: vi.fn(), draft: () => '', dispose: vi.fn(), ...extra })

describe('mountComposer.prefill', () => {
  it('宿主有 prefill → 转给插件;插件停用后不再填', async () => {
    const prefill = vi.fn()
    setTanguProbe({ mountComposer: () => handle({ prefill }) } as never)
    try {
      const ctx = ctxOf('forsion-home')
      const m = ctx.tangu!.mountComposer!(document.createElement('div'))
      expect(typeof m.prefill).toBe('function')
      m.prefill!('明天的会议')
      expect(prefill).toHaveBeenCalledWith('明天的会议')
      await usePluginStore.getState().disable('forsion-home')
      m.prefill!('又一句')
      expect(prefill).toHaveBeenCalledTimes(1)
    } finally { setTanguProbe(null) }
  })

  it('宿主没有 prefill → 插件这边也没有(按 typeof 判得出来)', () => {
    setTanguProbe({ mountComposer: () => handle() } as never)
    try {
      const m = ctxOf('another-plugin').tangu!.mountComposer!(document.createElement('div'))
      expect(m.prefill).toBeUndefined()
    } finally { setTanguProbe(null) }
  })
})
