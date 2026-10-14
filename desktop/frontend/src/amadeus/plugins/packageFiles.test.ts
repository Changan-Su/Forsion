// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
const read = vi.hoisted(() => vi.fn())
vi.mock('../api', () => ({ amadeus: { pluginPackageFiles: read } }))
import { usePluginStore } from './pluginStore'
import type { PluginContext } from './types'
let ctx: PluginContext
beforeEach(() => {
  for (const id of usePluginStore.getState().activeIds) usePluginStore.getState().disable(id)
  usePluginStore.setState({ initialized: false })
  localStorage.clear(); read.mockReset()
  usePluginStore.getState().init([{ id: 'package-probe', name: 'Probe', version: '1', setup(c) { ctx = c } }])
})
describe('packageFiles host facade', () => {
  it('binds identity and refuses retained handles after disable', async () => {
    read.mockResolvedValue('hello')
    expect(await ctx.packageFiles!.readText('plugins/a/main.js')).toBe('hello')
    expect(read).toHaveBeenCalledWith('package-probe', 'plugins/a/main.js', false)
    usePluginStore.getState().disable('package-probe')
    await expect(ctx.packageFiles!.readText('manifest.json')).rejects.toThrow('disabled')
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('does not deliver an in-flight read to an unloaded plugin', async () => {
    let finish!: (s: string[]) => void
    read.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const p = ctx.packageFiles!.list('plugins')
    usePluginStore.getState().disable('package-probe'); finish(['a'])
    await expect(p).rejects.toThrow('disabled')
  })
})
