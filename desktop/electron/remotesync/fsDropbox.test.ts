/** fsDropbox 协议形状测试(mock fetch):分页 walk / 三态条件写 / ASCII 头转义 /
 *  not_found 幂等 / token 缓存 / 下载 size 校验。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asciiJson, createDropboxRemote, dropboxAuthUrl, dropboxCallbackServer, normBaseDir, parseDropboxCallback } from './fsDropbox'

type Call = { url: string; init?: RequestInit }
const calls: Call[] = []

const json = (body: unknown, status = 200, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.endsWith('/oauth2/token')) return json({ access_token: 'AT', expires_in: 14400 })
    return handler(u, init)
  })
}

const remote = () => createDropboxRemote({ appKey: 'k', refreshToken: 'rt', baseDir: '/Vault' })
const argOf = (c: Call): Record<string, unknown> =>
  JSON.parse((c.init!.headers as Record<string, string>)['Dropbox-API-Arg']) as Record<string, unknown>
const tokenCalls = (): number => calls.filter((c) => c.url.endsWith('/oauth2/token')).length
const isAscii = (s: string): boolean => [...s].every((c) => c.charCodeAt(0) < 128)

afterEach(() => {
  vi.unstubAllGlobals()
  calls.length = 0
})

describe('fsDropbox', () => {
  it('asciiJson / normBaseDir 纯函数', () => {
    expect(asciiJson({ path: '/V/笔.md' })).toBe('{"path":"/V/\\u7b14.md"}')
    expect(isAscii(asciiJson({ p: '测试📝' }))).toBe(true)
    expect(normBaseDir(undefined)).toBe('')
    expect(normBaseDir(' /a/b/ ')).toBe('/a/b')
    expect(normBaseDir('a\\b')).toBe('/a/b')
  })

  it('链接登录:授权 URL 带 redirect_uri/state,手贴流程则两者都不带', () => {
    const auto = new URL(dropboxAuthUrl('k', 'CH', { redirectUri: 'http://localhost:53682/', state: 'S' }))
    expect(auto.searchParams.get('redirect_uri')).toBe('http://localhost:53682/')
    expect(auto.searchParams.get('state')).toBe('S')
    expect(auto.searchParams.get('code_challenge')).toBe('CH')
    expect(auto.searchParams.get('token_access_type')).toBe('offline')
    const manual = new URL(dropboxAuthUrl('k', 'CH'))
    expect(manual.searchParams.has('redirect_uri')).toBe(false)
    expect(manual.searchParams.has('state')).toBe(false)
  })

  it('回环回调:state 必须相符;噪声请求报 no-code;拒绝授权带出错因', () => {
    expect(parseDropboxCallback('/?code=C&state=S', 'S')).toEqual({ code: 'C' })
    expect(parseDropboxCallback('/?code=C&state=EVIL', 'S')).toEqual({ error: 'state-mismatch' })
    expect(parseDropboxCallback('/?code=C', 'S')).toEqual({ error: 'state-mismatch' })
    expect(parseDropboxCallback('/favicon.ico', 'S')).toEqual({ error: 'no-code' })
    expect(parseDropboxCallback('/?error=access_denied&error_description=no&state=S', 'S')).toEqual({ error: 'access_denied: no' })
  })

  it('回环回调服务器:噪声请求不打断、拿到授权码后自关;端口被占则返回 null(降级手贴)', async () => {
    const got: unknown[] = []
    const srv = await dropboxCallbackServer(0, 'S', (r) => got.push(r))
    expect(srv).not.toBeNull()
    const base = `http://127.0.0.1:${srv!.port}`
    // 真 fetch(前面的用例 stub 过 fetch,这里已被 afterEach 还原)
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(404)
    expect(got).toEqual([]) // 噪声不算结果
    expect((await fetch(`${base}/?code=C1&state=S`)).status).toBe(200)
    expect(got).toEqual([{ code: 'C1' }])
    await expect(fetch(`${base}/?code=C2&state=S`)).rejects.toThrow() // 已自关

    const a = await dropboxCallbackServer(0, 'S', () => {})
    const b = await dropboxCallbackServer(a!.port, 'S', () => {})
    expect(b).toBeNull()
    a!.close()
  })

  it('walk:分页合并、folder 过滤、base 前缀剥离(中文);token 只刷一次', async () => {
    mockFetch((url) => {
      if (url.endsWith('/2/files/list_folder'))
        return json({
          entries: [
            { '.tag': 'folder', path_display: '/Vault/sub' },
            { '.tag': 'file', path_display: '/Vault/笔记/一.md', size: 3, rev: 'r1', client_modified: '2026-07-01T00:00:00Z' },
          ],
          cursor: 'c1',
          has_more: true,
        })
      if (url.endsWith('/2/files/list_folder/continue'))
        return json({
          entries: [{ '.tag': 'file', path_display: '/Vault/two.md', size: 5, rev: 'r2', server_modified: '2026-07-02T00:00:00Z' }],
          cursor: '',
          has_more: false,
        })
      return json({}, 500)
    })
    const out = await remote().walk()
    expect(out).toEqual([
      { key: '笔记/一.md', size: 3, mtimeMs: Date.parse('2026-07-01T00:00:00Z'), id: 'r1' },
      { key: 'two.md', size: 5, mtimeMs: Date.parse('2026-07-02T00:00:00Z'), id: 'r2' },
    ])
    expect(tokenCalls()).toBe(1)
  })

  it('walk:baseDir 未创建(409 not_found)= 空远端而非报错', async () => {
    mockFetch(() => new Response(JSON.stringify({ error_summary: 'path/not_found/..' }), { status: 409 }))
    expect(await remote().walk()).toEqual([])
  })

  it('writeFile 三态 mode;中文路径头纯 ASCII;client_modified 秒级', async () => {
    mockFetch((url) => {
      if (url.endsWith('/2/files/upload'))
        return json({ path_display: '/Vault/笔记/一.md', size: 2, rev: 'r9', client_modified: '2026-07-03T00:00:00Z' })
      return json({}, 500)
    })
    const r = remote()
    const ent = await r.writeFile('笔记/一.md', Buffer.from('hi'), 1751500000123, undefined, null)
    expect(ent.id).toBe('r9')
    const up = calls.find((c) => c.url.endsWith('/2/files/upload'))!
    const raw = (up.init!.headers as Record<string, string>)['Dropbox-API-Arg']
    expect(isAscii(raw)).toBe(true)
    const a = JSON.parse(raw) as { mode: unknown; path: string; client_modified: string; autorename: boolean }
    expect(a.mode).toBe('add')
    expect(a.path).toBe('/Vault/笔记/一.md')
    expect(a.autorename).toBe(false)
    expect(a.client_modified).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

    await r.writeFile('a.md', Buffer.from('x'), 1000, undefined, 'r1')
    expect(argOf(calls.at(-1)!).mode).toEqual({ '.tag': 'update', update: 'r1' })
    await r.writeFile('a.md', Buffer.from('x'), 1000, undefined, undefined)
    expect(argOf(calls.at(-1)!).mode).toBe('overwrite')
  })

  it('writeFile 409 conflict → cas-conflict', async () => {
    mockFetch((url) => {
      if (url.endsWith('/2/files/upload'))
        return new Response(JSON.stringify({ error_summary: 'path/conflict/file' }), { status: 409 })
      return json({}, 500)
    })
    await expect(remote().writeFile('a.md', Buffer.from('x'), 1000, undefined, 'r1')).rejects.toThrow(/cas-conflict/)
  })

  it('rm:parent_rev 透传;not_found 幂等;其余 409 = cas-conflict', async () => {
    let n = 0
    mockFetch((url) => {
      if (url.endsWith('/2/files/delete_v2')) {
        n++
        if (n === 1) return new Response(JSON.stringify({ error_summary: 'path_lookup/not_found/.' }), { status: 409 })
        return new Response(JSON.stringify({ error_summary: 'path/conflict/file' }), { status: 409 })
      }
      return json({}, 500)
    })
    const r = remote()
    await r.rm('x.md', undefined, 'r5') // not_found 吞掉(幂等)
    const del = calls.find((c) => c.url.endsWith('/2/files/delete_v2'))!
    expect(JSON.parse(String(del.init!.body))).toEqual({ path: '/Vault/x.md', parent_rev: 'r5' })
    await expect(r.rm('x.md')).rejects.toThrow(/cas-conflict/)
  })

  it('readFile:内容长度对 dropbox-api-result.size 校验,不符即抛', async () => {
    mockFetch((url) => {
      if (url.endsWith('/2/files/download'))
        return new Response('abc', { status: 200, headers: { 'dropbox-api-result': JSON.stringify({ size: 99 }) } })
      return json({}, 500)
    })
    await expect(remote().readFile('x.md')).rejects.toThrow(/size mismatch/)
  })
})
