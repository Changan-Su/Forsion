// @vitest-environment happy-dom
/**
 * 会话配置按键合并写(patchSessionConfig):只带要改的键,undefined 上线为 null(= 删键);
 * 老引擎没有 PATCH 路由(404/405)→ 回落整对象 PUT(full() 给的本地最新整对象);别的失败照常抛。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authFetch } from './http'
import { patchSessionConfig } from './backendService'

vi.mock('./http', () => ({ authFetch: vi.fn() }))
const cfg = { backendUrl: 'http://local-engine', token: 't' } as any
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const calls = () => vi.mocked(authFetch).mock.calls.map(([url, init]) => ({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined }))

beforeEach(() => { vi.mocked(authFetch).mockReset() })

describe('patchSessionConfig', () => {
  it('PATCH 只带这几个键,undefined 上线为 null', async () => {
    vi.mocked(authFetch).mockImplementation(() => json({ agent_config: { thinkingLevel: 'high' } }))
    const full = vi.fn(() => ({ approvalMode: 'readonly' as const }))
    expect(await patchSessionConfig(cfg, 's/1', { thinkingLevel: 'high', engineId: undefined }, full)).toEqual({ thinkingLevel: 'high' })
    expect(calls()).toEqual([{ url: 'http://local-engine/agent/sessions/s%2F1/config', method: 'PATCH', body: { thinkingLevel: 'high', engineId: null } }])
    expect(full).not.toHaveBeenCalled()
  })

  it.each([404, 405])('老引擎(PATCH %i)→ 回落整对象 PUT', async (status) => {
    vi.mocked(authFetch).mockImplementationOnce(() => json({ detail: `HTTP ${status}` }, status)).mockImplementationOnce(() => json({ agent_config: { execMode: 'host', thinkingLevel: 'high' } }))
    const out = await patchSessionConfig(cfg, 's1', { thinkingLevel: 'high' }, () => ({ execMode: 'host', thinkingLevel: 'high' }))
    expect(out).toEqual({ execMode: 'host', thinkingLevel: 'high' })
    expect(calls().map((c) => [c.method, c.body])).toEqual([['PATCH', { thinkingLevel: 'high' }], ['PUT', { execMode: 'host', thinkingLevel: 'high' }]])
  })

  it('别的失败(500)照常抛,不回落 PUT', async () => {
    vi.mocked(authFetch).mockImplementation(() => json({ detail: 'boom' }, 500))
    await expect(patchSessionConfig(cfg, 's1', { planMode: true }, () => ({}))).rejects.toThrow('boom')
    expect(calls().map((c) => c.method)).toEqual(['PATCH'])
  })
})
