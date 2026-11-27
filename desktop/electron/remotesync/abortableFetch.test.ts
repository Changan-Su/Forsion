/** abortableFetch:Electron net.fetch 与 Node fetch 的差别由包装补齐(实测见文件头注释与 check:remotesync-netfetch)。
 *  底层用假 fetch 模拟「响应体永远读不完、也不理 abort」的最坏情况。 */
import { describe, expect, it } from 'vitest'
import { abortableFetch, type BaseFetch } from './abortableFetch'

/** 响应头立刻到、响应体吐一块后永远挂着(且不理 signal / cancel)—— net.fetch 读体途中 abort 的样子。 */
const hangingBody = (): Response => {
  let n = 0
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (n++ === 0) ctrl.enqueue(new Uint8Array([1, 2, 3]))
      return new Promise(() => {}) // 永不再给
    },
  })
  return new Response(body, { status: 200, headers: { 'x-a': '1' } })
}

describe('abortableFetch', () => {
  it('读响应体途中 abort:立刻 reject AbortError,不被底层拖住', async () => {
    const f = abortableFetch(async () => hangingBody())
    const ac = new AbortController()
    const p = f('https://x/y', { signal: ac.signal })
    setTimeout(() => ac.abort(), 20)
    const t0 = Date.now()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('已 abort 的 signal 直接 reject;等响应头时 abort 也 reject', async () => {
    const never: BaseFetch = () => new Promise(() => {})
    const ac = new AbortController()
    ac.abort()
    await expect(abortableFetch(never)('https://x', { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const ac2 = new AbortController()
    const p = abortableFetch(never)('https://x', { signal: ac2.signal })
    ac2.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('一律 credentials:omit + cache:no-store;原样透传 method / headers / body / signal;URL 对象转成字符串', async () => {
    const seen: Array<{ input: string | Request; init?: RequestInit }> = []
    const f = abortableFetch(async (input, init) => {
      seen.push({ input, init })
      return new Response('{"ok":1}', { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json', location: 'https://up/s1' } })
    })
    const ac = new AbortController()
    const rsp = await f(new URL('https://api/x?q=1'), { method: 'PATCH', headers: { a: 'b' }, body: 'B', signal: ac.signal, credentials: 'include' })
    expect(seen[0].input).toBe('https://api/x?q=1')
    expect(seen[0].init).toMatchObject({ method: 'PATCH', headers: { a: 'b' }, body: 'B', signal: ac.signal, credentials: 'omit', cache: 'no-store' })
    expect(rsp.status).toBe(201)
    expect(rsp.statusText).toBe('Created')
    expect(rsp.headers.get('location')).toBe('https://up/s1')
    expect(await rsp.json()).toEqual({ ok: 1 })
  })

  it('204 / 304 这类无体状态照常返回,不因 new Response 带体而抛', async () => {
    for (const status of [204, 304]) {
      const rsp = await abortableFetch(async () => new Response(null, { status }))('https://x')
      expect(rsp.status).toBe(status)
      expect(await rsp.text()).toBe('')
    }
  })

  it('非 2xx 照样带回响应体(后端要拿错误正文判 not_found / conflict)', async () => {
    const rsp = await abortableFetch(async () => new Response('{"error_summary":"path/not_found/"}', { status: 409 }))('https://x')
    expect(rsp.ok).toBe(false)
    expect(await rsp.text()).toContain('not_found')
  })
})
