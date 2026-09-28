// P1-K6 S2 · 服务层按会话路由 + 远端能力预判(§3.3 / §3.7):焦点在「我的电脑」时,老调用点(传整份 cfg)的会话类请求
// 打那台电脑;deny-remote 的五个不发请求直接给本地化 LOCAL_ONLY;缩略图不给直链;上传按 9MB 分批;hub 的失败给人话。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translateFor } from '../i18n'

type Reply = { status: number; body?: unknown }
let router: (url: string, method: string) => Reply = () => ({ status: 200, body: {} })
const calls: Array<{ url: string; method: string; body?: string; opts?: unknown }> = []
vi.mock('./http', () => ({
  authFetch: async (url: string, init?: RequestInit, opts?: unknown) => {
    const method = (init?.method || 'GET').toUpperCase()
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined, opts })
    const r = router(url, method)
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status })
  },
}))

const api = await import('./backendService')
const T = await import('./engine/targets')
const H = await import('./engine/health')

const U = '7f0e8a52-0000-4000-8000-00000000000a'
const API = 'https://api.forsion.test/api'
const UNIT = `${API}/units/${U}/proxy/engine`
const home = { backendUrl: API, token: 'forsion-token', modelId: '' }

beforeEach(async () => {
  calls.length = 0
  router = () => ({ status: 200, body: {} })
  H.resetHealth()
  T.resetFocusForTests()
  vi.stubGlobal('window', { tangu: { mobile: true } })
  T.installEngineHost({ cfg: () => home, desktopConfig: () => ({ cloudApiBase: API }) })
  await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: 'Mac mini' })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('会话类老调用点跟着会话走', () => {
  it('listMessages / getSessionConfig / readWorkspaceFile / updateSession 打那台电脑,带目标键', async () => {
    await api.listMessages(home, 's1')
    await api.getSessionConfig(home, 's1')
    await api.readWorkspaceFile(home, 's1', 'out/a.png')
    await api.updateSession(home, 's1', { title: 'x' }).catch(() => {})
    expect(calls.map((c) => c.url.startsWith(`${UNIT}/agent/`))).toEqual([true, true, true, true])
    expect(calls.every((c) => (c.opts as { target?: string })?.target === `unit:${U}`)).toBe(true)
  })

  it('目录类(listAgents)与 home 类(收件箱 / 设置)仍打 home —— 管理面板自己传 cfg 调它们', async () => {
    await api.listAgents(home)
    await api.getApprovalRules(home).catch(() => {})
    expect(calls.map((c) => c.url.startsWith(`${API}/agent/`))).toEqual([true, true])
  })
})

describe('deny-remote 的五个:服务层预判,不发请求', () => {
  it.each([
    ['deleteSession', () => api.deleteSession(home, 's1')],
    ['deleteMessages', () => api.deleteMessages(home, 's1', ['m1'])],
    ['restoreCheckpoint', () => api.restoreCheckpoint(home, 's1', 1)],
    ['putSessionConfig', () => api.putSessionConfig(home, 's1', { execMode: 'host' })],
    ['deleteWorkspaceFile', () => api.deleteWorkspaceFile(home, 's1', 'a.txt')],
  ])('%s → 异步拒(调用方 .catch 接得住)、LOCAL_ONLY、零请求', async (_name, call) => {
    let p!: Promise<unknown>
    expect(() => { p = call() }).not.toThrow()
    await expect(p).rejects.toMatchObject({ code: 'LOCAL_ONLY', status: 403, message: translateFor('zh', 'unitpage.localOnly') })
    expect(calls).toEqual([])
  })

  it('焦点回 home 后照常发(本端没有这条限制)', async () => {
    await T.setFocusTarget({ kind: 'home' })
    await api.deleteSession(home, 's1')
    expect(calls.map((c) => [c.method, c.url])).toEqual([['DELETE', `${API}/agent/sessions/s1`]])
  })

  it('patchSessionConfig 遇老引擎 404:远端不回落整对象 PUT(那条 deny-remote),原错交出去', async () => {
    router = (_url, method) => (method === 'PATCH' ? { status: 404, body: { detail: 'Not found' } } : { status: 200, body: {} })
    await expect(api.patchSessionConfig(home, 's1', { approvalMode: 'readonly' }, () => ({}))).rejects.toMatchObject({ status: 404 })
    expect(calls.map((c) => c.method)).toEqual(['PATCH'])
  })
})

describe('缩略图 / 下载 / 上传', () => {
  it('workspaceDownloadUrl:unit → null(缩略图改走读字节做 blob,凭据永不进 URL);home → 直链', async () => {
    expect(api.workspaceDownloadUrl(home, 's1', 'a.png')).toBeNull()
    await T.setFocusTarget({ kind: 'home' })
    expect(api.workspaceDownloadUrl(home, 's1', 'a.png')).toBe(`${API}/agent/workspace/download?sessionId=s1&appId=tangu&path=a.png`)
  })

  it('uploadWorkspaceFiles:unit 按单次 ≤ 9MB 分批,结果合并;单个文件超限前端就拒(不白传一趟)', async () => {
    router = (url, method) => (method === 'POST' && url.endsWith('/agent/workspace/upload') ? { status: 200, body: { success: true, saved: 2, total: 2, errors: [] } } : { status: 200, body: {} })
    const four = 'A'.repeat(4 * 1024 * 1024)
    const r = await api.uploadWorkspaceFiles(home, 's1', [
      { path: 'a.bin', content: four, encoding: 'base64' },
      { path: 'b.bin', content: four, encoding: 'base64' },
      { path: 'c.bin', content: four, encoding: 'base64' },
    ])
    const posts = calls.filter((c) => c.url.endsWith('/agent/workspace/upload'))
    expect(posts.length).toBe(2)
    expect(posts.every((c) => c.body!.length <= api.UNIT_UPLOAD_BATCH_BYTES)).toBe(true)
    expect(posts.map((c) => JSON.parse(c.body!).files.map((f: { path: string }) => f.path))).toEqual([['a.bin', 'b.bin'], ['c.bin']])
    expect(r).toEqual({ success: true, saved: 4, total: 4, errors: [] })
    calls.length = 0
    await expect(api.uploadWorkspaceFiles(home, 's1', [{ path: 'big.bin', content: 'A'.repeat(10 * 1024 * 1024) }]))
      .rejects.toMatchObject({ code: 'UNIT_BODY_TOO_LARGE', message: translateFor('zh', 'engine.target.tooLarge') })
    expect(calls).toEqual([])
  })
})

describe('hub 的失败给人话 + 记健康', () => {
  it.each([
    [503, 'UNIT_OFFLINE', 'offline', 'engine.target.offline'],
    [503, 'ENGINE_NOT_READY', 'engine-unavailable', 'engine.target.engineUnavailable'],
    [413, 'UNIT_BODY_TOO_LARGE', null, 'engine.target.tooLarge'],
    [404, 'UNIT_NOT_FOUND', 'gone', 'engine.target.gone'],
    [503, 'CALLER_UNAVAILABLE', 'caller-unavailable', 'engine.refusal.callerUnavailable'],
    [403, 'BAD_CALLER_ASSERTION', 'caller-unavailable', 'engine.refusal.badCallerAssertion'],
  ])('%i %s → %s', async (status, code, health, key) => {
    router = () => ({ status, body: { code, detail: 'english detail' } })
    await expect(api.listMessages(home, 's1')).rejects.toMatchObject({ status, message: translateFor('zh', key, { name: 'Mac mini' }) })
    if (health) expect(H.healthOf(`unit:${U}`).state).toBe(health)
  })
})
