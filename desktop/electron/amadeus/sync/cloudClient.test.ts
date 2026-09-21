/**
 * 上行 gzip:文本整份 PUT 走 Content-Encoding: gzip,解开必须逐字节等于原 JSON(含 CJK);小体不压。
 * 真链路(Express inflate / nginx 透传)由 scripts/probe-gzip-upload.mjs 验,这里只钉客户端这一半。
 */
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { createCloudClient } from './cloudClient'

const calls: Array<{ url: string; init: RequestInit & { headers: Record<string, string> } }> = []
const stubFetch = (): void => {
  calls.length = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ seq: 2, hash: 'h' }), { status: 200 })
  })
}
afterEach(() => vi.unstubAllGlobals())

it('putFile gzips the JSON body and it inflates back to the exact payload', async () => {
  stubFetch()
  const content = '# 同步测试 — gzip ✓\n'.repeat(400)
  await createCloudClient({ baseUrl: 'https://cloud.example', token: 't', clientId: 'dev' }).putFile('v1', '笔记/a.md', content, 7)
  const { init } = calls[0]
  expect(init.headers['Content-Encoding']).toBe('gzip')
  expect(init.headers['Content-Type']).toBe('application/json')
  const body = init.body as unknown as Buffer
  expect(JSON.parse(gunzipSync(body).toString('utf8'))).toEqual({ path: '笔记/a.md', content, baseSeq: 7 })
  expect(body.byteLength).toBeLessThan(Buffer.byteLength(content) / 4)
})

it('small JSON bodies (move/rename) are sent as-is', async () => {
  stubFetch()
  await createCloudClient({ baseUrl: 'https://cloud.example', token: 't', clientId: 'dev' }).move('v1', 'a.md', 'b.md')
  const { init } = calls[0]
  expect(init.headers['Content-Encoding']).toBeUndefined()
  expect(JSON.parse(init.body as string)).toEqual({ from: 'a.md', to: 'b.md' })
})
