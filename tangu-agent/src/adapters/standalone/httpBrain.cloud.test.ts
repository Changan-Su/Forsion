/**
 * brain.cloud.request —— 账号面的通用出口(forsion_account 两个工具经它读额度 / 用重置卡)。
 * 钉四件:
 *   - 身份由 brain 自己带(字符串令牌或每次现取的函数),调用方拿不到令牌,结果里也没有;
 *   - 路径闸只收规整形态:本云端 /api/ 之下,没有点段 / 空段 / 编码(前面的反代会合并斜杠、解码);/api/auth/ 整段拒(那里能把当前令牌原样换出来);
 *   - 没有云端凭据 → 不发请求,回 401 + not_signed_in(与服务端回的 401 = 令牌失效分得开);
 *   - 永不抛:状态码与 JSON 原样交回,网络断 / 超时 / 中止 → status 0 + error。
 * 负对照(实跑):去掉 /api/auth/ 那条判断 → 「/api/auth/ 整段拒」那条红(假服务器收到了请求)。
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { createHttpBrain } from './httpBrain.js'

interface Seen { method: string; url: string; auth: string; body: string }
let srv: http.Server | undefined
const seen: Seen[] = []
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
}

async function start(): Promise<string> {
  seen.length = 0
  srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      seen.push({ method: req.method || '', url: req.url || '', auth: String(req.headers.authorization || ''), body })
      respond(req, res)
    })
  })
  await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(srv.address() as any).port}`
}
afterEach(async () => {
  respond = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })) }
  if (srv) { srv.closeAllConnections(); await new Promise<void>((r) => srv!.close(() => r())); srv = undefined }
})

describe('brain.cloud.request', () => {
  it('带上 brain 的身份发出去,状态码与 JSON 原样交回;令牌是函数时每次现取;结果里没有令牌', async () => {
    const base = await start()
    let token = 'tok-1'
    const brain = createHttpBrain({ cloudUrl: `${base}/`, token: () => token })
    const a = await brain.cloud!.request({ path: '/api/token-quota/my' })
    expect(a).toEqual({ status: 200, json: { ok: true } })
    token = 'tok-2'
    respond = (_req, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no_reset_card' })) }
    const b = await brain.cloud!.request({ path: '/api/token-quota/reset-card/use', method: 'POST', body: { type: 'both' } })
    expect(b).toEqual({ status: 400, json: { error: 'no_reset_card' } })
    expect(seen).toEqual([
      { method: 'GET', url: '/api/token-quota/my', auth: 'Bearer tok-1', body: '' },
      { method: 'POST', url: '/api/token-quota/reset-card/use', auth: 'Bearer tok-2', body: '{"type":"both"}' },
    ])
    expect(JSON.stringify([a, b])).not.toContain('tok-')
  })

  it('查询串保留;响应不是 JSON → json 为 null,不抛', async () => {
    const base = await start()
    respond = (_req, res) => { res.writeHead(502, { 'Content-Type': 'text/html' }); res.end('<html>bad gateway</html>') }
    const r = await createHttpBrain({ cloudUrl: base, token: 't' }).cloud!.request({ path: '/api/usage/stats?days=7' })
    expect(r).toEqual({ status: 502, json: null })
    expect(seen[0].url).toBe('/api/usage/stats?days=7')
  })

  it('/api/auth/ 整段拒、/api/ 之外拒、换源拒、需要规整才合法的写法拒 —— 一个请求都不发', async () => {
    const base = await start()
    const brain = createHttpBrain({ cloudUrl: base, token: 't' })
    for (const path of [
      '/api/auth/handoff', '/api/auth/refresh', '/api/auth', '/API/AUTH/me', '/api/Auth/handoff',
      '/api/token-quota/../auth/handoff', '/api/token-quota/%2e%2e/auth/handoff', '/api//auth/handoff/../handoff',
      '/v1/images/generations', '/apix/thing', 'api/token-quota/my', '//evil.example/api/token-quota/my',
      'https://evil.example/api/token-quota/my', '/api/../admin/users',
      '/api/git/credential', '/api/Git/Credential', '/api/github/credential',
    ]) {
      const r = await brain.cloud!.request({ path, method: 'POST', body: {} })
      expect(r, path).toEqual({ status: 0, error: 'path_not_allowed' })
    }
    expect(await brain.cloud!.request({ path: '/api/x', method: 'PATCH' as any })).toEqual({ status: 0, error: 'invalid_method' })
    expect(seen).toEqual([])
  })

  it('不跟重定向:合法路径回 307 指向 /api/auth/refresh → 3xx 原样交回,第二个请求不发', async () => {
    const base = await start()
    respond = (req, res) => {
      if (req.url === '/api/token-quota/my') { res.writeHead(307, { Location: '/api/auth/refresh' }); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ token: 'tok-leaked' }))
    }
    const r = await createHttpBrain({ cloudUrl: base, token: 't' }).cloud!.request({ path: '/api/token-quota/my', method: 'POST', body: {} })
    expect(r).toEqual({ status: 307, json: null })
    expect(seen.map((s) => s.url)).toEqual(['/api/token-quota/my'])
  })

  it('没有云端凭据(桌面没登录)→ 不发请求,回 401 + not_signed_in;没配云端地址 → no_cloud_url', async () => {
    const base = await start()
    for (const token of ['', '   ', () => '']) {
      expect(await createHttpBrain({ cloudUrl: base, token }).cloud!.request({ path: '/api/token-quota/my' }))
        .toEqual({ status: 401, json: null, error: 'not_signed_in' })
    }
    expect(seen).toEqual([])
    expect(await createHttpBrain({ cloudUrl: '', token: 't' }).cloud!.request({ path: '/api/token-quota/my' })).toEqual({ status: 0, error: 'no_cloud_url' })
  })

  it('连不上 / 超时 / 调用方中止:status 0 + 原因,不抛', async () => {
    const base = await start()
    const brain = createHttpBrain({ cloudUrl: base, token: 't' })
    respond = () => { /* 不应答 */ }
    expect(await brain.cloud!.request({ path: '/api/token-quota/my', timeoutMs: 1_000 })).toEqual({ status: 0, error: 'timeout' })
    const ac = new AbortController()
    const p = brain.cloud!.request({ path: '/api/token-quota/my', signal: ac.signal })
    setTimeout(() => ac.abort(), 30)
    expect(await p).toEqual({ status: 0, error: 'aborted' })
    const dead = await createHttpBrain({ cloudUrl: 'http://127.0.0.1:1', token: 't' }).cloud!.request({ path: '/api/token-quota/my' })
    expect(dead.status).toBe(0)
    expect(typeof dead.error).toBe('string')
  })
})
