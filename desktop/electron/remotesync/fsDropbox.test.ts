/** fsDropbox 协议形状测试(mock fetch):分页 walk / 三态条件写 / ASCII 头转义 /
 *  not_found 幂等 / token 缓存 / 下载 size 校验。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asciiJson, createDropboxRemote, normBaseDir } from './fsDropbox'

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
