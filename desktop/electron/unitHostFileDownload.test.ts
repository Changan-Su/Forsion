/**
 * P1-DL · /unit/hostfile/download:手机 / 设备页下载 agent 用 display_file 交出来的主机文件(原字节,流式)。
 *
 * ① 路由判据与 /unit/hostfile 逐条同判(真 unitWeb + 真解析 openUnitHostRegularFile + 真凭据闸 buildUnitScopeGuard,
 *    与 main.ts 的 readHostFile / openHostFile 同一套组合):根内 200、根外 404、根内的凭据文件 404、未配对 401、
 *    急停锁定(K2)同判、K4 会话档闸与坏的调用方断言都不影响(/unit/host* 按 G9 不过 K4)—— 两条路任何一条单独变了都红。
 * ② 响应形态:原字节、Content-Length、按扩展名的 Content-Type、Content-Disposition(ASCII 兜底 + filename* 中文原名)、
 *    nosniff + CSP sandbox;超 256MB 回 413 不开流。
 * ③ 流式回包:假 hub(宣告 stream-sec-headers)→ **真** UnitHost → **真** unitWeb,12MB 文件走 /stream/ 回包、字节无损;
 *    同一文件的 /unit/hostfile 预览在隧道上是 tooLarge(4MB 信封余量)—— 这正是要另开下载路由的原因。
 * 跑法:npx vitest run electron/unitHostFileDownload.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, open as openFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { startUnitWeb, HOST_DOWNLOAD_MAX_BYTES, type UnitWebDeps, type UnitWebHandle } from './unitWeb'
// @ts-expect-error 私有包不带类型;这里只用运行时导出(UnitHost 自 2026-09-28 住在 Forsion Extend 0.6,签名策略仍在宿主 unitCaller.ts)
import { UnitHost } from '@forsion/extend/dist/desktop.mjs'
import { makeCallerHeaders } from './unitCaller'
import { buildUnitScopeGuard, openUnitHostRegularFile, type UnitScopeGuard } from './unitHostScope'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 5000): Promise<boolean> {
  const t0 = Date.now()
  while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(20) }
  return true
}
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

const LAN_TOKEN = 'lan-device-token'
const LAN = { Authorization: `Bearer ${LAN_TOKEN}` }
const CN_NAME = '介绍….docx'
let home = ''
let ws = ''
let forsionHome = ''
let guard: UnitScopeGuard
let docBytes: Buffer
let bigBytes: Buffer
let locked = false
let web: UnitWebHandle
let base = ''

/** 与 main.ts 同一种装配:两条路都经 openUnitHostRegularFile(同一份根 / 凭据闸 / fd 绑定)。 */
function hostDeps(roots: { base: string[]; session: string[] }): Pick<UnitWebDeps, 'readHostFile' | 'openHostFile'> {
  const env = { home }
  return {
    readHostFile: async (p, maxBytes) => {
      const opened = await openUnitHostRegularFile(p, roots, env, guard)
      if (!opened) return null
      try {
        if (opened.st.size > Math.min(maxBytes || 50 * 1024 * 1024, 50 * 1024 * 1024)) return { mimeType: 'application/octet-stream', content: '', size: opened.st.size, tooLarge: true }
        return { mimeType: 'application/octet-stream', content: (await opened.fh.readFile()).toString('base64'), size: opened.st.size }
      } finally { await opened.fh.close() }
    },
    openHostFile: async (p) => {
      const opened = await openUnitHostRegularFile(p, roots, env, guard)
      return opened ? { fh: opened.fh, real: opened.real, size: opened.st.size } : null
    },
  }
}

function webDeps(extra: Partial<UnitWebDeps> = {}): UnitWebDeps {
  return {
    getEngine: () => ({ url: 'http://127.0.0.1:9', token: 'ENGINE', remoteMark: 'MARK' }),
    confirmPair: async () => false,
    pairedDevices: { list: () => [{ id: 'd', name: 'lan', tokenHash: createHash('sha256').update(LAN_TOKEN).digest('hex'), createdAt: 0 }], add: async () => {} },
    readPlugins: async () => [], readSpaces: async () => [], readConfig: async () => ({}), writeConfig: async () => ({}), readProviders: async () => [],
    ...hostDeps({ base: [ws, forsionHome], session: [] }), // 凭据目录也在根里:证明拦它的是凭据闸,不只是「不在根内」
    readHostDir: async () => null, readHostStat: async () => null,
    meta: { instanceId: 'i', name: 'n', version: '0' }, webDistDir: () => null, vault: () => null, log: () => {},
    remoteLock: () => locked,
    // K4 会话档闸一律拒:/unit/host* 按 G9 不过它 —— 两条路都不该被它影响
    remoteAccess: {
      gateEngine: () => ({ ok: false, status: 403, body: { code: 'REMOTE_SESSIONS_OFF', detail: 'off' } as any }),
      status: () => ({ remoteSessions: false, principal: 'lan', caller: 'unconfirmed', maxApprovalMode: 'auto-edit' }),
      request: async () => ({ remoteSessions: false, principal: 'lan', caller: 'unconfirmed', maxApprovalMode: 'auto-edit' }),
    },
    ...extra,
  }
}

beforeAll(async () => {
  home = realpathSync(await mkdtemp(join(tmpdir(), 'unit-dl-')))
  ws = join(home, 'Forsion')
  forsionHome = join(home, '.forsion')
  await mkdir(join(ws, 'sub'), { recursive: true })
  await mkdir(forsionHome, { recursive: true })
  docBytes = randomBytes(300 * 1024) // > 256KB:隧道上走流式
  bigBytes = randomBytes(12 * 1024 * 1024) // > 10MB 信封
  await writeFile(join(ws, CN_NAME), docBytes)
  await writeFile(join(ws, 'big.bin'), bigBytes)
  await writeFile(join(ws, 'empty.txt'), '')
  await writeFile(join(home, 'outside.txt'), 'OUTSIDE')
  await writeFile(join(forsionHome, 'auth.json'), '{"token":"SECRET"}')
  guard = buildUnitScopeGuard({ home, forsionHome })
  web = await startUnitWeb(webDeps(), { port: 0, bindHost: '127.0.0.1' })
  base = `http://127.0.0.1:${web.port}`
})
afterAll(async () => { await web?.close(); await rm(home, { recursive: true, force: true }) })

const get = (route: 'hostfile' | 'hostfile/download', p: string, headers: Record<string, string> = LAN): Promise<Response> =>
  fetch(`${base}/unit/${route}?path=${encodeURIComponent(p)}`, { headers })
/** 两条路对同一个请求的状态码(下载的 body 读掉,别占着连接)。 */
async function both(p: string, headers?: Record<string, string>): Promise<[number, number]> {
  const a = await get('hostfile', p, headers); await a.arrayBuffer()
  const b = await get('hostfile/download', p, headers); await b.arrayBuffer()
  return [a.status, b.status]
}

describe('/unit/hostfile/download × /unit/hostfile 同判(真 unitWeb + 真解析)', () => {
  it('根内文件:原字节 + 长度 + 按扩展名的类型 + 中文名的 Content-Disposition + 惰化头', async () => {
    const r = await get('hostfile/download', join(ws, CN_NAME))
    expect(r.status).toBe(200)
    const body = Buffer.from(await r.arrayBuffer())
    expect(sha(body)).toBe(sha(docBytes))
    expect(r.headers.get('content-length')).toBe(String(docBytes.length))
    expect(r.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    const cd = r.headers.get('content-disposition') || ''
    expect(cd).toBe(`attachment; filename="___.docx"; filename*=UTF-8''${encodeURIComponent(CN_NAME)}`)
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('content-security-policy')).toBe('sandbox')
    expect((await get('hostfile', join(ws, CN_NAME))).status).toBe(200) // 预览同判
  })

  it('空文件:200 + 长度 0', async () => {
    const r = await get('hostfile/download', join(ws, 'empty.txt'))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-length')).toBe('0')
    expect((await r.arrayBuffer()).byteLength).toBe(0)
  })

  it('根外 / 根内的凭据文件 / 不存在 / 目录:两条都 404,凭据一个字节都不出', async () => {
    expect(await both(join(home, 'outside.txt'))).toEqual([404, 404])
    expect(await both(join(forsionHome, 'auth.json'))).toEqual([404, 404])
    expect(await both(join(ws, 'missing.docx'))).toEqual([404, 404])
    expect(await both(join(ws, 'sub'))).toEqual([404, 404])
    const leak = await get('hostfile/download', join(forsionHome, 'auth.json'))
    expect(await leak.text()).not.toContain('SECRET')
  })

  it('未配对 401;坏的配对令牌同样 401', async () => {
    expect(await both(join(ws, CN_NAME), {})).toEqual([401, 401])
    expect(await both(join(ws, CN_NAME), { Authorization: 'Bearer nope' })).toEqual([401, 401])
  })

  it('急停锁定(K2):两条同判(GET = 读,放行)', async () => {
    locked = true
    try {
      expect(await both(join(ws, CN_NAME))).toEqual([200, 200])
      expect(await both(join(home, 'outside.txt'))).toEqual([404, 404])
    } finally { locked = false }
  })

  it('K4:会话档闸拒一切、隧道上带着验不过的调用方断言 —— 两条同判(都不过 K4,与 hostdir / hoststat 同类)', async () => {
    expect(await both(join(ws, CN_NAME))).toEqual([200, 200])
    const tunnel = { 'x-unit-internal': web.internalSecret, 'x-unit-caller': 'garbage' }
    expect(await both(join(ws, CN_NAME), tunnel)).toEqual([200, 200])
  })

  it(`超过 ${HOST_DOWNLOAD_MAX_BYTES / 1048576}MB:413 HOST_DOWNLOAD_TOO_LARGE,不开流`, async () => {
    const huge = join(ws, 'huge.bin')
    const fh = await openFile(huge, 'w'); await fh.truncate(HOST_DOWNLOAD_MAX_BYTES + 1); await fh.close() // 稀疏文件
    try {
      const r = await get('hostfile/download', huge)
      expect(r.status).toBe(413)
      expect(await r.json()).toMatchObject({ code: 'HOST_DOWNLOAD_TOO_LARGE', size: HOST_DOWNLOAD_MAX_BYTES + 1 })
    } finally { await rm(huge, { force: true }) }
  })

  it('没有 openHostFile 的宿主(便携 Unit 等):501,不回落别的读法', async () => {
    const w = await startUnitWeb(webDeps({ openHostFile: undefined }), { port: 0, bindHost: '127.0.0.1' })
    try {
      const r = await fetch(`http://127.0.0.1:${w.port}/unit/hostfile/download?path=${encodeURIComponent(join(ws, CN_NAME))}`, { headers: LAN })
      expect(r.status).toBe(501)
      expect(((await r.json()) as any).code).toBe('HOST_DOWNLOAD_UNSUPPORTED')
    } finally { await w.close() }
  })
})

describe('隧道流式回包:假 hub → 真 UnitHost → 真 unitWeb(>10MB 字节无损)', () => {
  let hub: http.Server
  let channel: http.ServerResponse | null = null
  const replies = new Map<string, { leg: 'stream' | 'resp'; status: number; ct: string; body: Buffer }>()
  let unitHost: { start(): void; stop(): void }

  beforeAll(async () => {
    hub = http.createServer((req, res) => {
      const url = req.url || ''
      if (url.endsWith('/channel')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(': connected\n\nevent: ready\ndata: {"caps":["stream-sec-headers"]}\n\n') // 线上网关的能力宣告
        channel = res
        return
      }
      const m = /\/(resp|stream)\/([^/?]+)/.exec(url)
      if (m) {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const raw = Buffer.concat(chunks)
          if (m[1] === 'stream') {
            const q = new URL(url, 'http://x').searchParams
            replies.set(m[2], { leg: 'stream', status: Number(q.get('status')), ct: String(q.get('ct')), body: raw })
          } else {
            const j = JSON.parse(raw.toString('utf8')) as { status: number; headers: Record<string, string>; bodyB64?: string }
            replies.set(m[2], { leg: 'resp', status: j.status, ct: j.headers['content-type'], body: Buffer.from(j.bodyB64 || '', 'base64') })
          }
          res.writeHead(200); res.end('{}')
        })
        return
      }
      res.writeHead(404); res.end()
    })
    await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r))
    const hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`
    unitHost = new UnitHost({
      getCreds: () => ({ cloudUrl: hubUrl, token: 'tok' }),
      getUnitWeb: () => ({ url: base, internalSecret: web.internalSecret }),
      callerHeaders: makeCallerHeaders(() => web.proxyCallerKey, () => {}),
      getLanUrl: () => null,
      getPairing: () => ({ unitId: 'mac', secret: 's' }),
      savePairing: async () => {}, clearPairing: async () => {},
      log: () => {},
      readIdleMs: 0,
    })
    unitHost.start()
    expect(await until(() => channel !== null)).toBe(true)
  })
  afterAll(() => { unitHost?.stop(); channel?.destroy(); hub?.closeAllConnections(); hub?.close() })

  const dispatch = (id: string, path: string): void => {
    channel!.write(`event: dispatch\ndata: ${JSON.stringify({ id, method: 'GET', path, body: null })}\n\n`)
  }

  it('12MB 文件:走 /stream/ 回包(不进 10MB 信封),字节与类型原样', async () => {
    dispatch('dl-big', `/unit/hostfile/download?path=${encodeURIComponent(join(ws, 'big.bin'))}`)
    expect(await until(() => replies.has('dl-big'), 15_000)).toBe(true)
    const r = replies.get('dl-big')!
    expect(r.leg).toBe('stream')
    expect(r.status).toBe(200)
    expect(r.ct).toBe('application/octet-stream')
    expect(r.body.length).toBe(bigBytes.length)
    expect(sha(r.body)).toBe(sha(bigBytes))
  })

  it('中文名的 docx(300KB)同样走流式,原字节', async () => {
    dispatch('dl-doc', `/unit/hostfile/download?path=${encodeURIComponent(join(ws, CN_NAME))}`)
    expect(await until(() => replies.has('dl-doc'), 15_000)).toBe(true)
    const r = replies.get('dl-doc')!
    expect(r.leg).toBe('stream')
    expect(sha(r.body)).toBe(sha(docBytes))
  })

  it('对照:同一个 12MB 文件的 /unit/hostfile 预览在隧道上只能回 tooLarge(这就是要另开下载路由的原因)', async () => {
    dispatch('pv-big', `/unit/hostfile?path=${encodeURIComponent(join(ws, 'big.bin'))}`)
    expect(await until(() => replies.has('pv-big'), 15_000)).toBe(true)
    const r = replies.get('pv-big')!
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body.toString('utf8'))).toMatchObject({ tooLarge: true, size: bigBytes.length })
  })
})
