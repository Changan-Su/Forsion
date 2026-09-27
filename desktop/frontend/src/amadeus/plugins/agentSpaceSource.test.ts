// @vitest-environment happy-dom
/**
 * agent 自建 Space 的 sourceURL(2026-09-27):只给 agent Space 的代码打、带加载序号;其它已安装插件求值路径逐字不变。
 * 走真实的「外置源 → toPlugin → setup」路径(IPC 桩与 devSandbox.test 同一套;环境必须是 happy-dom,理由见那边)。
 * builtins/agentSpaceSync 靠这个地址把挂载之后没接住的错误认领回 Muse,重载后旧版漏清的定时器不算新版的。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalPluginSource } from '@amadeus-shared/ipc'

const env = vi.hoisted(() => ({ sources: [] as ExternalPluginSource[] }))
vi.mock('../api', () => ({
  amadeus: { listPlugins: async () => env.sources, listPages: async () => [], listFiles: async () => [] },
}))

const { usePluginStore, agentSpaceSourceUrl } = await import('./pluginStore')

const source = (over: Partial<ExternalPluginSource> & { id: string }): ExternalPluginSource => ({
  name: over.id, version: '0.0.1', apiVersion: 1, code: '', ...over,
})
type Probe = { __agentThrow?: () => void; __plainThrow?: () => void }
const g = globalThis as unknown as Probe
const stackOf = (fn: (() => void) | undefined): string => {
  try { fn?.() } catch (e) { return String((e as Error).stack) }
  return ''
}

beforeEach(() => {
  usePluginStore.setState({ plugins: [], activeIds: [], disabledIds: [], disposers: {}, lastSetupError: {}, initialized: false })
  env.sources = []
  delete g.__agentThrow
  delete g.__plainThrow
})

describe('agent Space 的 sourceURL', () => {
  it('栈帧带当前这一版的地址(函数体第 1 行 = 源第 3 行);普通已安装插件不打;重载后序号变、新栈帧用新地址', async () => {
    const agentCode = 'globalThis.__agentThrow = () => { null.boom = 1 }'
    env.sources = [
      source({ id: 'agent-muse', agent: 'muse', code: agentCode }),
      source({ id: 'plain', code: 'globalThis.__plainThrow = () => { null.boom = 1 }' }),
    ]
    await usePluginStore.getState().loadExternal()
    const url1 = agentSpaceSourceUrl('agent-muse')
    expect(url1).toMatch(/^forsion-agent-space\/agent-muse\/\d+\/main\.js$/)
    expect(stackOf(g.__agentThrow)).toContain(`${url1}:3:`)
    expect(stackOf(g.__plainThrow)).toMatch(/TypeError/)
    expect(stackOf(g.__plainThrow)).not.toContain('forsion-agent-space')

    env.sources = [source({ id: 'agent-muse', agent: 'muse', code: `${agentCode}\n// v2` })] // 代码变了才真重载
    await usePluginStore.getState().reloadOne('agent-muse')
    const url2 = agentSpaceSourceUrl('agent-muse')
    expect(url2).not.toBe(url1)
    expect(stackOf(g.__agentThrow)).toContain(`${url2}:3:`)
  })
})
