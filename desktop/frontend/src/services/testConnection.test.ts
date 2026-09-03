/** P0-b:/health 不鉴权 → 追一次带鉴权 GET,**只认 401** 判死;403/404/5xx/网络错不算(2026-09-02)。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_PROBE_PATH, testConnection } from './agentRunService'
import { setUnauthorizedHandler } from './http'

const cfg = { backendUrl: 'http://127.0.0.1:1', token: 't', modelId: '' } as any
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('testConnection 鉴权探针', () => {
  let probeStatus: number | 'throw' = 200
  const unauthorized = vi.fn()
  beforeEach(() => {
    unauthorized.mockReset()
    setUnauthorizedHandler(unauthorized)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return json(200, { ok: true, sandbox: 'none' })
      if (String(url).endsWith(AUTH_PROBE_PATH)) {
        if (probeStatus === 'throw') throw new Error('boom')
        return json(probeStatus, {})
      }
      return json(404)
    }))
  })
  afterEach(() => { vi.unstubAllGlobals(); setUnauthorizedHandler(() => {}) })

  it('health 200 + 探针 200 → ok,且两条请求都带 Bearer', async () => {
    probeStatus = 200
    const r = await testConnection(cfg)
    expect(r.ok).toBe(true)
    const calls = vi.mocked(fetch).mock.calls
    expect(calls.map((c) => String(c[0]))).toEqual([`${cfg.backendUrl}/health`, `${cfg.backendUrl}${AUTH_PROBE_PATH}`])
    expect(calls.every((c) => (c[1] as any).headers.Authorization === 'Bearer t')).toBe(true)
  })

  it('health 200 但探针 401 → ok:false(token 漂了不再假绿),且 401 拦截器照常触发', async () => {
    probeStatus = 401
    const r = await testConnection(cfg)
    expect(r.ok).toBe(false)
    expect(r.authRejected).toBe(true)
    expect(r.message).toContain('401')
    expect(unauthorized).toHaveBeenCalledTimes(1)
  })

  it.each([403, 404, 500])('探针 %i 不算连接失败(只认 401)', async (st) => {
    probeStatus = st
    const r = await testConnection(cfg)
    expect(r.ok).toBe(true)
    expect(r.authRejected).toBeFalsy()
  })

  it('探针网络错不算连接失败;health 失败照旧判死', async () => {
    probeStatus = 'throw'
    expect((await testConnection(cfg)).ok).toBe(true)
    vi.mocked(fetch).mockImplementation(async () => json(503))
    const r = await testConnection(cfg)
    expect(r.ok).toBe(false)
    expect(r.message).toBe('HTTP 503')
  })
})
