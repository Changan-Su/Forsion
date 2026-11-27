/** abortableFetch:Electron net.fetch 与 Node fetch 的差别由包装补齐(实测见文件头注释与 check:remotesync-netfetch)。 */
import { describe, expect, it } from 'vitest'
import { abortableFetch } from './abortableFetch'

describe('abortableFetch', () => {
  it('一律 credentials:omit + cache:no-store;原样透传 method / headers / body / signal;URL 对象转成字符串;响应原样返回', async () => {
    const seen: Array<{ input: string | Request; init?: RequestInit }> = []
    const original = new Response('{"ok":1}', { status: 201, headers: { location: 'https://up/s1' } })
    const f = abortableFetch(async (input, init) => {
      seen.push({ input, init })
      return original
    })
    const ac = new AbortController()
    const rsp = await f(new URL('https://api/x?q=1'), { method: 'PATCH', headers: { a: 'b' }, body: 'B', signal: ac.signal, credentials: 'include' })
    expect(seen[0].input).toBe('https://api/x?q=1')
    expect(seen[0].init).toMatchObject({ method: 'PATCH', headers: { a: 'b' }, body: 'B', signal: ac.signal, credentials: 'omit', cache: 'no-store' })
    expect(rsp).toBe(original) // 不缓冲、不重建:大文件不多拷一份,429 的正文照旧由后端自己读
  })

  it('已 abort 的 signal(init 或 Request 上的):不调底层,直接 reject', async () => {
    let calls = 0
    const f = abortableFetch(async () => { calls++; return new Response('x') })
    const ac = new AbortController()
    ac.abort()
    await expect(f('https://x', { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(f(new Request('https://x', { signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(0)
  })

  it('底层的拒绝原样抛给调用方(abort / 网络错误)', async () => {
    const f = abortableFetch(async () => { throw new Error('net::ERR_PROXY_CONNECTION_FAILED') })
    await expect(f('https://x')).rejects.toThrow(/ERR_PROXY_CONNECTION_FAILED/)
  })
})
