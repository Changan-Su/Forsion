/**
 * ctx.net 主进程半边的安全闸。每一格判错都等于把本机 / 内网服务、或用户没看过的域名开放给插件,所以逐条钉死:
 *  ① 白名单(只认磁盘上的 manifest)、协议 / 端口 / userinfo、IP 字面量;
 *  ② 连接时的 DNS 闸(私网、混合解析、v4 映射),以及「第一跳正常、重定向到一个解析到内网的声明域名」那种 rebinding;
 *  ③ 重定向逐跳重判、上限 5 跳、换主机摘凭据、303 / POST 降级;
 *  ④ 正文 10 MB 上限(边读边数 + content-length 预判)、超时覆盖等首包与读正文;
 *  ⑤ 生产传输真把 lookup 挂在建连那一步(解析到 127.0.0.1 时根本不连),真 TLS 服务上解压后的字节也算进上限;
 *  ⑥ 按插件 id 从磁盘读 manifest(目录 = 装载器选中的那份,见 ipc.devplugins.test.ts):每次重读、id 对不上 / 坏清单 → 拒。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  createHttpsTransport, createManifestPatternLookup, guardedLookup, NET_MAX_BYTES, pluginNetRequest,
  type NetHop, type NetResolver, type NetTransport, type PluginNetDeps,
} from './pluginNet'

const PUBLIC = '93.184.216.34'
const dnsTable: Record<string, string[]> = {
  'api.example.com': [PUBLIC],
  'cdn.example.com': ['93.184.216.35'],
  'files.example.com': ['93.184.216.36'],
  'rebind.example.com': ['169.254.169.254'],
  'mixed.example.com': [PUBLIC, '10.0.0.5'],
  'mapped.example.com': ['::ffff:127.0.0.1'],
  'cgnat.example.com': ['100.64.0.1'],
  'other.example.org': ['93.184.216.40'],
}
const resolver: NetResolver = async (host) => (dnsTable[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
const PATTERNS = ['api.example.com', 'cdn.example.com', 'files.example.com', 'rebind.example.com', 'mixed.example.com', 'mapped.example.com', 'cgnat.example.com']

interface Reply { status: number; headers?: Record<string, string>; body?: Uint8Array[] | ((hop: NetHop) => AsyncIterable<Uint8Array>) }
/** 假传输:先像真连接一样跑一遍 lookup(DNS 闸就在这一步),再按路由回话。 */
function fake(route: (hop: NetHop, i: number) => Reply | Promise<Reply>): { transport: NetTransport; hops: NetHop[] } {
  const hops: NetHop[] = []
  const transport: NetTransport = async (hop) => {
    hops.push(hop)
    await new Promise<void>((resolve, reject) => {
      hop.lookup(hop.url.hostname, { all: true }, (err) => (err ? reject(err) : resolve()))
    })
    const r = await route(hop, hops.length - 1)
    const src = r.body
    const body = typeof src === 'function' ? src(hop) : (async function* () { for (const c of src ?? []) yield c })()
    return { status: r.status, headers: r.headers ?? {}, body, discard: () => {} }
  }
  return { transport, hops }
}
const deps = (transport: NetTransport, patterns: string[] | null = PATTERNS): PluginNetDeps => ({ patternsFor: async () => patterns, resolve: resolver, transport })
const ok = (body = 'hi'): Reply => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: [Buffer.from(body)] })
const req = (url: string, init?: unknown, d?: PluginNetDeps) => pluginNetRequest('my-plugin', url, init, d ?? deps(fake(() => ok()).transport))

describe('① allowlist and URL shape', () => {
  it('fetches a declared host and returns status, lower-cased headers, bytes and final URL', async () => {
    const f = fake(() => ({ status: 201, headers: { 'x-thing': 'a' }, body: [Buffer.from('he'), Buffer.from('llo')] }))
    const r = await pluginNetRequest('my-plugin', 'https://api.example.com/v1/x?q=1#frag', { headers: { Authorization: 'Bearer t' } }, deps(f.transport))
    expect(r).toMatchObject({ ok: true, status: 201, headers: { 'x-thing': 'a' }, url: 'https://api.example.com/v1/x?q=1' })
    expect(r.ok && Buffer.from(r.bytes).toString()).toBe('hello')
    expect(f.hops[0].headers).toMatchObject({ authorization: 'Bearer t', 'user-agent': 'Forsion' })
    expect(Object.keys(f.hops[0].headers)).not.toContain('cookie')
  })

  it('refuses undeclared hosts before any connection, and plugins with no readable manifest', async () => {
    const f = fake(() => ok())
    expect(await req('https://other.example.org/', undefined, deps(f.transport))).toMatchObject({ ok: false, code: 'net_domain_not_declared' })
    expect(await req('https://x.api.example.com/', undefined, deps(f.transport))).toMatchObject({ ok: false, code: 'net_domain_not_declared' })
    expect(await req('https://api.example.com/', undefined, deps(f.transport, null))).toMatchObject({ ok: false, code: 'net_domain_not_declared' })
    expect(f.hops).toHaveLength(0)
  })

  it.each([
    ['http://api.example.com/', 'net_bad_url'],
    ['https://api.example.com:8443/', 'net_bad_url'],
    ['https://user:pw@api.example.com/', 'net_bad_url'],
    ['not a url', 'net_bad_url'],
    ['file:///etc/passwd', 'net_bad_url'],
    ['https://127.0.0.1/', 'net_blocked_address'],
    ['https://[::1]/', 'net_blocked_address'],
    ['https://8.8.8.8/', 'net_blocked_address'],
    ['https://2130706433/', 'net_blocked_address'], // URL 把十进制整数主机名规范成 127.0.0.1
  ])('%s → %s', async (url, code) => {
    expect(await req(url)).toMatchObject({ ok: false, code })
  })

  it('accepts the explicit default port and a trailing dot', async () => {
    expect(await req('https://api.example.com:443/')).toMatchObject({ ok: true })
    expect(await req('https://api.example.com./')).toMatchObject({ ok: true, url: 'https://api.example.com/' })
  })

  it('rejects a bad plugin id', async () => {
    expect(await pluginNetRequest('../x', 'https://api.example.com/', undefined, deps(fake(() => ok()).transport))).toMatchObject({ ok: false, code: 'net_bad_request' })
  })
})

describe('② DNS checked at connect time', () => {
  it.each(['rebind.example.com', 'mixed.example.com', 'mapped.example.com', 'cgnat.example.com'])('%s → net_blocked_address', async (host) => {
    expect(await req(`https://${host}/`)).toMatchObject({ ok: false, code: 'net_blocked_address' })
  })

  it('a public first hop that redirects to a declared host resolving to a private address is refused (rebinding-style)', async () => {
    const f = fake((hop) => (hop.url.hostname === 'api.example.com' ? { status: 302, headers: { location: 'https://rebind.example.com/meta' } } : ok('secret')))
    expect(await req('https://api.example.com/', undefined, deps(f.transport))).toMatchObject({ ok: false, code: 'net_blocked_address' })
    expect(f.hops.map((h) => h.url.hostname)).toEqual(['api.example.com', 'rebind.example.com'])
  })

  it('guardedLookup answers both lookup shapes and filters by family', async () => {
    const st = { blocked: false }
    const lk = guardedLookup(async () => [{ address: PUBLIC, family: 4 }, { address: '2606:2800:220:1::1', family: 6 }], () => false, st)
    const all = await new Promise((res) => lk('h', { all: true }, (_e, a) => res(a)))
    expect(all).toEqual([{ address: PUBLIC, family: 4 }, { address: '2606:2800:220:1::1', family: 6 }])
    const one = await new Promise((res) => lk('h', { family: 6 }, (_e, a, f) => res([a, f])))
    expect(one).toEqual(['2606:2800:220:1::1', 6])
    const empty = await new Promise((res) => guardedLookup(async () => [], () => false, st)('h', {}, (e) => res((e as NodeJS.ErrnoException)?.code)))
    expect(empty).toBe('ENOTFOUND')
    expect(st.blocked).toBe(false)
  })
})

describe('③ redirects', () => {
  it('re-checks the allowlist, scheme and IP on every hop', async () => {
    const to = (location: string) => fake((hop, i) => (i === 0 ? { status: 301, headers: { location } } : ok()))
    expect(await req('https://api.example.com/', undefined, deps(to('https://other.example.org/').transport))).toMatchObject({ ok: false, code: 'net_domain_not_declared' })
    expect(await req('https://api.example.com/', undefined, deps(to('http://cdn.example.com/').transport))).toMatchObject({ ok: false, code: 'net_bad_url' })
    expect(await req('https://api.example.com/', undefined, deps(to('https://10.0.0.1/').transport))).toMatchObject({ ok: false, code: 'net_blocked_address' })
    const rel = to('/next?a=1')
    expect(await req('https://api.example.com/start', undefined, deps(rel.transport))).toMatchObject({ ok: true, url: 'https://api.example.com/next?a=1' })
  })

  it('follows at most 5 redirects', async () => {
    const chain = (n: number) => fake((_hop, i) => (i < n ? { status: 307, headers: { location: `/r${i + 1}` } } : ok()))
    expect(await req('https://api.example.com/', undefined, deps(chain(5).transport))).toMatchObject({ ok: true, url: 'https://api.example.com/r5' })
    const six = chain(6)
    expect(await req('https://api.example.com/', undefined, deps(six.transport))).toMatchObject({ ok: false, code: 'net_failed' })
    expect(six.hops).toHaveLength(6)
  })

  it('drops Authorization and Cookie when the host changes, keeps them on the same host', async () => {
    const f = fake((_hop, i) => (i === 0 ? { status: 302, headers: { location: '/same' } } : i === 1 ? { status: 302, headers: { location: 'https://cdn.example.com/x' } } : ok()))
    await req('https://api.example.com/', { headers: { authorization: 'Bearer t', cookie: 'a=1', 'x-keep': 'k' } }, deps(f.transport))
    expect(f.hops[1].headers).toMatchObject({ authorization: 'Bearer t', cookie: 'a=1' })
    expect(f.hops[2].headers.authorization).toBeUndefined()
    expect(f.hops[2].headers.cookie).toBeUndefined()
    expect(f.hops[2].headers['x-keep']).toBe('k')
  })

  it('303 and POST-on-302 become GET without the body; 307 keeps method and body', async () => {
    const f303 = fake((_hop, i) => (i === 0 ? { status: 303, headers: { location: '/done' } } : ok()))
    await req('https://api.example.com/', { method: 'POST', body: 'x', headers: { 'content-type': 'application/json' } }, deps(f303.transport))
    expect([f303.hops[1].method, f303.hops[1].body, f303.hops[1].headers['content-type']]).toEqual(['GET', null, undefined])
    const f307 = fake((_hop, i) => (i === 0 ? { status: 307, headers: { location: '/again' } } : ok()))
    await req('https://api.example.com/', { method: 'PUT', body: 'x' }, deps(f307.transport))
    expect(f307.hops[1].method).toBe('PUT')
    expect(Buffer.from(f307.hops[1].body!).toString()).toBe('x')
  })
})

describe('④ caps and request shape', () => {
  it('stops reading past 10 MB, and trusts a too-large Content-Length up front', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let pulled = 0
    const big = fake(() => ({ status: 200, body: () => (async function* () { for (let i = 0; i < 50; i++) { pulled++; yield chunk } })() }))
    expect(await req('https://api.example.com/', undefined, deps(big.transport))).toMatchObject({ ok: false, code: 'net_too_large' })
    expect(pulled).toBeLessThanOrEqual(11)
    const declared = fake(() => ({ status: 200, headers: { 'content-length': String(NET_MAX_BYTES + 1) }, body: [] }))
    expect(await req('https://api.example.com/', undefined, deps(declared.transport))).toMatchObject({ ok: false, code: 'net_too_large' })
    const exact = fake(() => ({ status: 200, body: Array.from({ length: 10 }, () => chunk) }))
    expect(await req('https://api.example.com/', undefined, deps(exact.transport))).toMatchObject({ ok: true })
  })

  it('times out while waiting for headers and while reading a slow body', async () => {
    const abortable = (hop: NetHop) => new Promise<never>((_, rej) => hop.signal.addEventListener('abort', () => rej(new Error('aborted'))))
    const hang = fake((hop) => abortable(hop))
    expect(await req('https://api.example.com/', { timeoutMs: 40 }, deps(hang.transport))).toMatchObject({ ok: false, code: 'net_timeout' })
    const slow = fake(() => ({ status: 200, body: (hop) => (async function* () { yield new Uint8Array(1); await abortable(hop) })() }))
    expect(await req('https://api.example.com/', { timeoutMs: 40 }, deps(slow.transport))).toMatchObject({ ok: false, code: 'net_timeout' })
  })

  it.each([
    [{ method: 'TRACE' }, 'net_bad_request'],
    [{ method: 'GET', body: 'x' }, 'net_bad_request'],
    [{ headers: { Host: 'evil' } }, 'net_bad_request'],
    [{ headers: { 'Content-Length': '1' } }, 'net_bad_request'],
    [{ headers: { 'Transfer-Encoding': 'chunked' } }, 'net_bad_request'],
    [{ headers: { 'Proxy-Thing': 'x' } }, 'net_bad_request'],
    [{ headers: { 'x-a': 'b\r\nInjected: 1' } }, 'net_bad_request'],
    [{ headers: { 'bad name': 'x' } }, 'net_bad_request'],
    [{ headers: ['x'] }, 'net_bad_request'],
    [{ body: { not: 'bytes' }, method: 'POST' }, 'net_bad_request'],
    [{ timeoutMs: -1 }, 'net_bad_request'],
  ])('init %j → %s', async (init, code) => {
    expect(await req('https://api.example.com/', init)).toMatchObject({ ok: false, code })
  })

  it('refuses a request body over 10 MB', async () => {
    expect(await req('https://api.example.com/', { method: 'POST', body: new Uint8Array(NET_MAX_BYTES + 1) })).toMatchObject({ ok: false, code: 'net_too_large' })
  })

  it('returns bytes that own their memory (no shared Buffer pool slab reaches the renderer)', async () => {
    const r = await req('https://api.example.com/', undefined, deps(fake(() => ok('tiny')).transport))
    expect(r.ok && [r.bytes.byteLength, r.bytes.buffer.byteLength, r.bytes.byteOffset]).toEqual([4, 4, 0])
  })

  it('caps concurrent requests per plugin', async () => {
    const releases: Array<() => void> = []
    const hang = fake(() => new Promise<Reply>((res) => releases.push(() => res(ok()))))
    const d = deps(hang.transport)
    const pending = Array.from({ length: 8 }, () => req('https://api.example.com/', undefined, d))
    await vi.waitFor(() => expect(releases).toHaveLength(8))
    expect(await req('https://api.example.com/', undefined, d)).toMatchObject({ ok: false, code: 'net_failed' })
    expect(await pluginNetRequest('other-plugin', 'https://api.example.com/', undefined, deps(fake(() => ok()).transport))).toMatchObject({ ok: true })
    for (const r of releases) r()
    expect((await Promise.all(pending)).every((r) => r.ok)).toBe(true)
    expect(await req('https://api.example.com/', undefined, deps(fake(() => ok()).transport))).toMatchObject({ ok: true }) // 名额还回来了
  })

  it('does not apply the Content-Length cap to HEAD', async () => {
    const f = fake(() => ({ status: 200, headers: { 'content-length': String(NET_MAX_BYTES * 3) }, body: [] }))
    expect(await req('https://api.example.com/', { method: 'HEAD' }, deps(f.transport))).toMatchObject({ ok: true, status: 200 })
  })

  it('lets the host own Accept-Encoding and defaults a string body to text/plain', async () => {
    const f = fake(() => ok())
    await req('https://api.example.com/', { method: 'POST', body: '{}', headers: { 'Accept-Encoding': 'evil' } }, deps(f.transport))
    expect(f.hops[0].headers['accept-encoding']).toBeUndefined()
    expect(f.hops[0].headers['content-type']).toBe('text/plain;charset=UTF-8')
  })
})

describe('⑤ production transport', () => {
  it('runs the DNS gate inside the real https connect: a name resolving to 127.0.0.1 is never connected to', async () => {
    const seen: string[] = []
    const r = await pluginNetRequest('my-plugin', 'https://api.example.com/', undefined, {
      patternsFor: async () => ['api.example.com'],
      resolve: async (h) => { seen.push(h); return [{ address: '127.0.0.1', family: 4 }] },
    })
    expect(r).toMatchObject({ ok: false, code: 'net_blocked_address' })
    expect(seen).toEqual(['api.example.com'])
  })

  // 真 TLS 服务(自签证书,本机端口):只有测试把 isBlockedIp 换成恒假才连得上。没有 openssl 的机器跳过。
  let tmp = ''
  let key = '', cert = ''
  let server: https.Server | null = null
  let port = 0
  const seenHeaders: Record<string, unknown>[] = []
  const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()
  beforeAll(async () => {
    if (!hasOpenssl) return
    tmp = mkdtempSync(path.join(os.tmpdir(), 'plugin-net-'))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'), '-days', '1', '-subj', '/CN=api.example.com'], { stdio: 'ignore' })
    key = readFileSync(path.join(tmp, 'k.pem'), 'utf8'); cert = readFileSync(path.join(tmp, 'c.pem'), 'utf8')
    server = https.createServer({ key, cert }, (rq, rs) => {
      seenHeaders.push({ ...rq.headers })
      if (rq.url === '/bomb') { rs.writeHead(200, { 'content-encoding': 'gzip' }); rs.end(zlib.gzipSync(Buffer.alloc(NET_MAX_BYTES + 1024))); return }
      // HEAD / 304 带 Content-Encoding 但没有正文:解压器若建了又没人读,会把主进程炸掉(Codex 评审实测)
      if (rq.url === '/head-gzip' || rq.url === '/not-modified') { rs.writeHead(rq.url === '/head-gzip' ? 200 : 304, { 'content-encoding': 'gzip', 'content-length': '20' }); rs.end(); return }
      // 叠起来的编码:先 gzip 再 br,声明成 `gzip, br`
      if (rq.url === '/stacked-bomb' || rq.url === '/stacked') {
        const raw = rq.url === '/stacked' ? Buffer.from('{"stacked":true}') : Buffer.alloc(NET_MAX_BYTES + 1024)
        rs.writeHead(200, { 'content-encoding': 'gzip, br' }); rs.end(zlib.brotliCompressSync(zlib.gzipSync(raw))); return
      }
      if (rq.url === '/compress') { rs.writeHead(200, { 'content-encoding': 'compress' }); rs.end('xx'); return }
      // 空正文 + gzip(分块,不带 Content-Length):浏览器给空正文,不报错
      if (rq.url === '/empty-gzip') { rs.writeHead(200, { 'content-encoding': 'gzip', 'transfer-encoding': 'chunked' }); rs.end(); return }
      // 重定向上带个认不出的编码:正文反正丢掉,不该让整次请求失败
      if (rq.url === '/redir-weird') { rs.writeHead(302, { location: '/json', 'content-encoding': 'UTF-8' }); rs.end('x'); return }
      rs.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' })
      rs.end(zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true }))))
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    port = (server!.address() as AddressInfo).port
  })
  afterAll(() => { server?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }) })
  const local = (): PluginNetDeps => ({
    patternsFor: async () => ['api.example.com'],
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    isBlockedIp: () => false,
    transport: createHttpsTransport({ ca: cert, port }),
  })

  it.skipIf(!hasOpenssl)('decodes gzip, sends no cookies, verifies the certificate', async () => {
    const r = await pluginNetRequest('my-plugin', 'https://api.example.com/json', undefined, local())
    expect(r.ok && JSON.parse(Buffer.from(r.bytes).toString())).toEqual({ ok: true })
    expect(r.ok && r.headers['content-encoding']).toBeUndefined()
    expect(seenHeaders.at(-1)?.cookie).toBeUndefined()
    const wrongCa = await pluginNetRequest('my-plugin', 'https://api.example.com/json', undefined, { ...local(), transport: createHttpsTransport({ port }) })
    expect(wrongCa).toMatchObject({ ok: false, code: 'net_failed' })
  })

  it.skipIf(!hasOpenssl)('counts decompressed bytes against the 10 MB cap (gzip bomb), stacked encodings included', async () => {
    expect(await pluginNetRequest('my-plugin', 'https://api.example.com/bomb', undefined, local())).toMatchObject({ ok: false, code: 'net_too_large' })
    expect(await pluginNetRequest('my-plugin', 'https://api.example.com/stacked-bomb', undefined, local())).toMatchObject({ ok: false, code: 'net_too_large' })
    const r = await pluginNetRequest('my-plugin', 'https://api.example.com/stacked', undefined, local())
    expect(r.ok && JSON.parse(Buffer.from(r.bytes).toString())).toEqual({ stacked: true })
    expect(await pluginNetRequest('my-plugin', 'https://api.example.com/compress', undefined, local())).toMatchObject({ ok: false, code: 'net_failed' })
  })

  it.skipIf(!hasOpenssl)('an empty gzip body is an empty body; a redirect body is never decoded', async () => {
    const empty = await pluginNetRequest('my-plugin', 'https://api.example.com/empty-gzip', undefined, local())
    expect(empty).toMatchObject({ ok: true, status: 200 })
    expect(empty.ok && empty.bytes.byteLength).toBe(0)
    const r = await pluginNetRequest('my-plugin', 'https://api.example.com/redir-weird', undefined, local())
    expect(r.ok && JSON.parse(Buffer.from(r.bytes).toString())).toEqual({ ok: true })
  })

  it.skipIf(!hasOpenssl)('bodiless responses with Content-Encoding (HEAD, 304) neither crash nor hang', async () => {
    const head = await pluginNetRequest('my-plugin', 'https://api.example.com/head-gzip', { method: 'HEAD' }, local())
    expect(head).toMatchObject({ ok: true, status: 200 })
    expect(head.ok && head.bytes.byteLength).toBe(0)
    expect(await pluginNetRequest('my-plugin', 'https://api.example.com/not-modified', undefined, local())).toMatchObject({ ok: true, status: 304 })
    await new Promise((r) => setTimeout(r, 50)) // 让迟到的流错误(若有)在测试结束前冒出来
  })
})

describe('⑥ manifest read from disk by plugin id', () => {
  let root = ''
  const write = (dir: string, manifest: unknown): void => { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest)) }
  const idOf = (dirName: string, manifestId: unknown): string | null =>
    typeof manifestId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(manifestId) ? manifestId : /^[a-z0-9][a-z0-9-]{0,63}$/.test(dirName) ? dirName : null
  beforeAll(() => { root = mkdtempSync(path.join(os.tmpdir(), 'plugin-net-manifest-')) })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('reads the selected copy, re-reads the manifest every time, refuses id mismatches and broken manifests', async () => {
    const dirs: Record<string, string> = { weather: path.join(root, 'Weather Folder'), broken: path.join(root, 'broken'), throws: path.join(root, 'x') }
    write(dirs.weather, { id: 'weather', network: ['api.weather.example', 'bad url', { toString: null }] })
    write(dirs.broken, '{ nope')
    const warn = vi.fn()
    const lookup = createManifestPatternLookup({
      sourceDir: async (id) => { if (id === 'throws') throw new Error('boom'); return dirs[id] ?? null },
      idOf, warn,
    })
    expect(await lookup('weather')).toEqual(['api.weather.example'])
    expect(await lookup('weather')).toEqual(['api.weather.example'])
    expect(warn).toHaveBeenCalledTimes(1) // 坏条目只报一次
    expect(await lookup('broken')).toBeNull()
    expect(await lookup('nobody')).toBeNull()
    expect(await lookup('throws')).toBeNull()
    write(dirs.weather, { id: 'weather', network: [] }) // 改了立刻生效
    expect(await lookup('weather')).toEqual([])
    write(dirs.weather, { id: 'impostor', network: ['api.weather.example'] }) // 换成别的 id → 不认
    expect(await lookup('weather')).toBeNull()
  })
})
