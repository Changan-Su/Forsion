import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRun } from './agentRunService'
import { __resetClientSurfacesForTest, registerClientSurface } from './clientSurfaces'

const cfg = {
  backendUrl: 'https://example.test',
  token: 'token',
  modelId: 'model',
} as any

async function sentBody(): Promise<any> {
  await startRun(cfg, { sessionId: 's', message: 'hello' })
  const init = vi.mocked(fetch).mock.calls[0]?.[1]
  return JSON.parse(String(init?.body || '{}'))
}

describe('startRun client tag', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ runId: 'r' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
  })

  afterEach(() => { vi.unstubAllGlobals(); __resetClientSurfacesForTest() })

  it.each([
    [{ cloudWeb: true }, 'web/'],
    [{ cloudWeb: true, mobile: true }, 'mobile/'],
  ])('在宿主垫片就位后按请求时环境识别端类型 %#', async (tangu, prefix) => {
    // agentRunService 可能先被其它共享模块求值；端类型不能在模块加载时永久冻结。
    vi.stubGlobal('window', { tangu })

    const body = await sentBody()
    expect(body.client).toMatch(new RegExp(`^${prefix.replace('/', '\\/')}`))
  })

  it('没有注册能力面(desktop/web)时照样送空的 client_capabilities', async () => {
    const body = await sentBody()
    expect(body.client_capabilities).toEqual([])
  })

  it('client_capabilities 取请求时已注册能力面的并集', async () => {
    let on = false
    registerClientSurface('phone', { capabilities: () => (on ? ['phone.intents'] : []), exec: () => {} })
    expect((await sentBody()).client_capabilities).toEqual([])
    on = true // 移动端开关随时会变:不能在注册时冻结
    vi.mocked(fetch).mockClear()
    expect((await sentBody()).client_capabilities).toEqual(['phone.intents'])
  })
})
