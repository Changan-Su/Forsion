import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRun } from './agentRunService'

const cfg = {
  backendUrl: 'https://example.test',
  token: 'token',
  modelId: 'model',
} as any

describe('startRun client tag', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ runId: 'r' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each([
    [{ cloudWeb: true }, 'web/'],
    [{ cloudWeb: true, mobile: true }, 'mobile/'],
  ])('在宿主垫片就位后按请求时环境识别端类型 %#', async (tangu, prefix) => {
    // agentRunService 可能先被其它共享模块求值；端类型不能在模块加载时永久冻结。
    vi.stubGlobal('window', { tangu })

    await startRun(cfg, { sessionId: 's', message: 'hello' })

    const init = vi.mocked(fetch).mock.calls[0]?.[1]
    const body = JSON.parse(String(init?.body || '{}'))
    expect(body.client).toMatch(new RegExp(`^${prefix.replace('/', '\\/')}`))
  })
})
