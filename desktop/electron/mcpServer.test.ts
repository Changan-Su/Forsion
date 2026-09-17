import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { createServer, Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { callInboxSend, callTranscribeAudio, createMcpLifecycle, startForsionMcp, type McpDeps } from './mcpServer'

const listen = (s: Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)))

const deps = (over: Partial<McpDeps>): McpDeps => ({
  getEngine: () => ({ url: null, token: '' }),
  localSecret: 'secret',
  bridgeSecret: 'bridge',
  externalEnabled: () => true,
  homeDir: '/tmp',
  ...over,
})

describe('inbox_send proxy', () => {
  let srv: Server | undefined
  afterEach(() => srv?.close())

  it('proxies to engine POST /agent/inbox with bearer auth + normalized body', async () => {
    let got: { url?: string; method?: string; auth?: string; body?: unknown } = {}
    srv = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        got = { url: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(raw) }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, id: 'abc123' }))
      })
    })
    const port = await new Promise<number>((r) =>
      srv!.listen(0, '127.0.0.1', () => r((srv!.address() as { port: number }).port)),
    )

    const result = await callInboxSend(
      deps({ getEngine: () => ({ url: `http://127.0.0.1:${port}`, token: 'TKN' }) }),
      { title: '  Hello  ', body: 'World' },
    )

    expect(got.url).toBe('/agent/inbox')
    expect(got.method).toBe('POST')
    expect(got.auth).toBe('Bearer TKN')
    expect(got.body).toEqual({ title: 'Hello', body: 'World', sender_id: 'mcp' })
    expect(result.isError).toBeFalsy()
    expect((result.content[0] as { text: string }).text).toContain('abc123')
  })

  it('errors (no throw) when engine not ready', async () => {
    const result = await callInboxSend(deps({ getEngine: () => ({ url: null, token: '' }) }), { title: 'Hi' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/not ready/i)
  })

  it('surfaces engine non-2xx as tool error', async () => {
    srv = createServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ detail: 'title 必填' }))
    })
    const port = await new Promise<number>((r) =>
      srv!.listen(0, '127.0.0.1', () => r((srv!.address() as { port: number }).port)),
    )
    const result = await callInboxSend(
      deps({ getEngine: () => ({ url: `http://127.0.0.1:${port}`, token: 'TKN' }) }),
      { title: 'x' },
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('400')
  })
})

describe('MCP end-to-end over HTTP', () => {
  const e2eHome = mkdtempSync(join(tmpdir(), 'forsion-mcp-e2e-')) // desktop-bridge.json 别落到共享 tmpdir 根上
  afterAll(() => rmSync(e2eHome, { recursive: true, force: true }))
  it('lists tools and calls inbox_send through the transport, proxying to engine', async () => {
    let engineHit: { auth?: string; body?: unknown } = {}
    const engine = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        engineHit = { auth: req.headers.authorization, body: JSON.parse(raw) }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, id: 'e2e-1' }))
      })
    })
    const ePort = await listen(engine)

    const mcp = await startForsionMcp({
      getEngine: () => ({ url: `http://127.0.0.1:${ePort}`, token: 'ENGTKN' }),
      localSecret: 'SEC',
      bridgeSecret: 'BRD',
      externalEnabled: () => true,
      homeDir: e2eHome,
      log: () => {},
    })

    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { Authorization: 'Bearer SEC' } },
    })
    await client.connect(transport)
    try {
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name)).toContain('inbox_send')

      const result = await client.callTool({ name: 'inbox_send', arguments: { title: 'E2E' } })
      expect((result.content as { text: string }[])[0].text).toContain('e2e-1')
      expect(engineHit.auth).toBe('Bearer ENGTKN')
      expect(engineHit.body).toEqual({ title: 'E2E', body: '', sender_id: 'mcp' })
    } finally {
      await client.close()
      mcp.close()
      engine.close()
    }
  })

  it('rejects clients without the local secret (trust boundary)', async () => {
    const mcp = await startForsionMcp({
      getEngine: () => ({ url: null, token: '' }),
      localSecret: 'SEC',
      bridgeSecret: 'BRD',
      externalEnabled: () => true,
      homeDir: e2eHome,
      log: () => {},
    })
    const client = new Client({ name: 'test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { Authorization: 'Bearer WRONG' } },
    })
    await expect(client.connect(transport)).rejects.toThrow()
    mcp.close()
  })

  it('外部面关闭时:localSecret 被拒,bridgeSecret 仍通(常驻桥的双钥语义)', async () => {
    const mcp = await startForsionMcp({
      getEngine: () => ({ url: null, token: '' }),
      localSecret: 'SEC',
      bridgeSecret: 'BRD',
      externalEnabled: () => false,
      homeDir: e2eHome,
      log: () => {},
    })
    const mk = (secret: string) => {
      const c = new Client({ name: 'test', version: '1.0.0' })
      const t = new StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      })
      return { c, t }
    }
    try {
      const ext = mk('SEC')
      await expect(ext.c.connect(ext.t)).rejects.toThrow()
      const bridge = mk('BRD')
      await bridge.c.connect(bridge.t)
      const tools = await bridge.c.listTools()
      expect(tools.tools.map((t) => t.name)).toContain('transcribe_audio')
      await bridge.c.close()
    } finally {
      mcp.close()
    }
  })
})

describe('transcribe_audio (主进程 ASR 桥)', () => {
  it('转发路径与选项到 transcribeFile,segments 透传为 JSON', async () => {
    let got: { p?: string; req?: unknown } = {}
    const result = await callTranscribeAudio(
      deps({
        transcribeFile: async (p, req) => {
          got = { p, req }
          return { text: 'hello', segments: [{ start: 0, end: 1.5, text: 'hello' }] }
        },
      }),
      { path: '/tmp/a.wav', timestamps: true },
    )
    expect(got.p).toBe('/tmp/a.wav')
    expect(got.req).toEqual({ timestamps: true, language: undefined })
    expect(result.isError).toBeFalsy()
    const j = JSON.parse((result.content[0] as { text: string }).text)
    expect(j.text).toBe('hello')
    expect(j.segments).toHaveLength(1)
  })

  it('字符串返回(老口径)包成 {text};相对路径与非音频扩展名被拒;无 transcribeFile 回错误', async () => {
    const ok = await callTranscribeAudio(deps({ transcribeFile: async () => 'plain' }), { path: '/tmp/a.mp3' })
    expect(JSON.parse((ok.content[0] as { text: string }).text)).toEqual({ text: 'plain' })

    const rel = await callTranscribeAudio(deps({ transcribeFile: async () => 'x' }), { path: 'a.wav' })
    expect(rel.isError).toBe(true)
    const bad = await callTranscribeAudio(deps({ transcribeFile: async () => 'x' }), { path: '/tmp/a.pdf' })
    expect(bad.isError).toBe(true)
    const none = await callTranscribeAudio(deps({}), { path: '/tmp/a.wav' })
    expect(none.isError).toBe(true)
  })
})

describe('启动竞态(端口被抢 / 并发启动 / 开关顺序)', () => {
  const realHttpListen = Server.prototype.listen
  const cleanup: Array<() => void> = []
  afterEach(() => { for (const f of cleanup.splice(0)) f() })
  const squat = async (): Promise<number> => { const s = createServer(); cleanup.push(() => s.close()); return listen(s) }
  const freePort = async (): Promise<number> => { const s = createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p }
  const freePortBefore = async (): Promise<number> => { // 原型已被替换时取端口:临时还原,免得 freePort 自己的 listen 被拦
    const patched = Server.prototype.listen
    Server.prototype.listen = realHttpListen
    try { return await freePort() } finally { Server.prototype.listen = patched }
  }
  const tempHome = (): string => { const d = mkdtempSync(join(tmpdir(), 'forsion-mcp-')); cleanup.push(() => rmSync(d, { recursive: true, force: true })); return d }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const connectAs = async (url: string, secret: string) => {
    const c = new Client({ name: 'test', version: '1.0.0' })
    await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }))
    return c
  }

  it('端口在「探测 / 选定」之后、真绑定那一刻被别的进程抢走 → 不抛未处理 error、不挂住,顺延下一个口且 Host 白名单跟着新端口', async () => {
    const port = await freePort() // 先取端口再拦 listen:freePort 自己也是 http.Server
    const squatter = createNetServer()
    cleanup.push(() => squatter.close())
    const realListen = Server.prototype.listen
    let squatted = -1
    // 只拦 http.Server 的 listen(旧实现的探测用的是 net.Server,不受影响):真绑定前抢先占住它要绑的口。
    // listen(port, host) 的绑定排在 dns.lookup 的 nextTick 之后,先发起的 squatter 先绑上 → 真绑定必撞 EADDRINUSE
    Server.prototype.listen = function (this: Server, ...args: any[]) {
      if (squatted < 0 && typeof args[0] === 'number' && args[0] > 0) { squatted = args[0]; squatter.listen(args[0], '127.0.0.1') }
      return realListen.apply(this, args as any)
    } as typeof realListen
    cleanup.push(() => { Server.prototype.listen = realListen })
    const started = startForsionMcp(deps({ homeDir: tempHome() }), { port })
    cleanup.push(() => { void started.then((m) => m.close(), () => {}) }) // 超时判红后才晚到的服务器也收掉
    const outcome = await Promise.race([started, sleep(3000).then(() => 'hang' as const)])
    if (outcome === 'hang') throw new Error('startForsionMcp 挂住了(真绑定撞 EADDRINUSE 没人接)')
    expect((squatter.address() as { port: number } | null)?.port).toBe(squatted) // 抢占确实发生在它第一次要绑的口上
    expect(outcome.port).not.toBe(squatted)
    const c = await connectAs(outcome.url, 'bridge') // 白名单若还按抢占前的端口算,DNS-rebinding 保护会拒掉这次连接
    expect((await c.listTools()).tools.map((t) => t.name)).toContain('inbox_send')
    await c.close()
  })

  it('绑定成功后服务器再报 error(accept 报 EMFILE 之类)→ 只记日志,不抛成主进程未捕获异常', async () => {
    let server: Server | undefined
    const realListen = Server.prototype.listen
    Server.prototype.listen = function (this: Server, ...args: any[]) {
      server = this
      return realListen.apply(this, args as any)
    } as typeof realListen
    cleanup.push(() => { Server.prototype.listen = realListen })
    const logs: string[] = []
    const mcp = await startForsionMcp(deps({ homeDir: tempHome(), log: (m) => logs.push(m) }), { port: await freePortBefore() })
    cleanup.push(() => mcp.close())
    Server.prototype.listen = realListen
    expect(() => server!.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' }))).not.toThrow()
    expect(logs.some((m) => m.includes('accept EMFILE'))).toBe(true)
  })

  it('可试的口全被占 → reject EADDRINUSE,不留未处理的 error、不挂住', async () => {
    const busy = await squat()
    const outcome = await Promise.race([
      startForsionMcp(deps({ homeDir: tempHome() }), { port: busy, tries: 1 }).then(
        (m) => { m.close(); return 'bound' },
        (e: NodeJS.ErrnoException) => e.code,
      ),
      sleep(3000).then(() => 'hang'),
    ])
    expect(outcome).toBe('EADDRINUSE')
  })

  const lifecycle = async ({ startDelays = [] as number[], fail = (_n: number): boolean => false } = {}) => {
    const home = tempHome()
    const port = await freePort()
    const handles: Array<{ url: string }> = []
    const gateAtStart: boolean[] = []
    const logs: string[] = []
    let starts = 0
    const lc = createMcpLifecycle({
      start: async (externalEnabled) => {
        const n = ++starts
        gateAtStart.push(externalEnabled())
        await sleep(startDelays.shift() ?? 0)
        if (fail(n)) throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
        const h = await startForsionMcp(deps({ homeDir: home, externalEnabled }), { port })
        cleanup.push(() => h.close())
        handles.push(h)
        return h
      },
      homeDir: () => home,
      localSecret: () => 'secret',
      log: (m) => logs.push(m),
    })
    const extFile = join(home, 'forsion-mcp.json')
    return { lc, handles, gateAtStart, extFile, logs, starts: () => starts, published: () => existsSync(extFile) }
  }

  it('两次 apply 并发(先发的启动更慢)只起一个服务,最终态 = 最后一次请求', async () => {
    for (const [first, last] of [[true, false], [false, true]]) {
      const t = await lifecycle({ startDelays: [80, 5] })
      await Promise.all([t.lc.apply(first), t.lc.apply(last)])
      expect(t.starts()).toBe(1)
      expect(t.handles).toHaveLength(1)
      expect(t.published()).toBe(last)
      expect(t.lc.externalUrl()).toBe(last ? t.handles[0].url : null)
    }
  })

  it('开的请求正在等服务起来时来了关的请求 → 起好后不发布(不会先发布再撤销),最终态 = 关', async () => {
    const t = await lifecycle({ startDelays: [60] })
    const on = t.lc.apply(true)
    await sleep(10) // 已进 start()
    const off = t.lc.apply(false)
    await Promise.all([on, off])
    expect(t.logs.filter((m) => m.includes('claude mcp add'))).toEqual([]) // publishExternalEndpoint 一次都没发生
    expect(t.published()).toBe(false)
    expect(t.starts()).toBe(1)
  })

  it('启动那次在队列里现读配置、读得慢,期间用户关掉开关 → 读到的旧值(开)作废:不发布、守门没被重新打开', async () => {
    const t = await lifecycle()
    const boot = t.lc.apply(async () => { await sleep(60); return true }) // loadConfig 读到旧值 true,但读得慢
    await sleep(10)
    const user = t.lc.apply(false) // config:set 写入 false 后调用
    await Promise.all([boot, user])
    expect(t.published()).toBe(false)
    expect(t.lc.externalUrl()).toBeNull()
    expect(t.starts()).toBe(1)
    expect(t.gateAtStart).toEqual([false])
  })

  it('启动中 externalUrl 为 null;起好才给;关掉立刻拒外部密钥', async () => {
    const t = await lifecycle({ startDelays: [40] })
    const pending = t.lc.apply(true)
    expect(t.lc.externalUrl()).toBeNull()
    await pending
    const url = t.handles[0].url
    expect(t.lc.externalUrl()).toBe(url)
    await (await connectAs(url, 'secret')).close()
    const off = t.lc.apply(false)
    expect(t.lc.externalUrl()).toBeNull()
    await expect(connectAs(url, 'secret')).rejects.toThrow()
    await off
    expect(t.published()).toBe(false)
  })

  it('启动失败不缓存:本次调用拿到错误,下一次 apply 重新启动成功', async () => {
    const t = await lifecycle({ fail: (n) => n === 1 })
    await expect(t.lc.apply(true)).rejects.toThrow('EADDRINUSE')
    await t.lc.apply(true)
    expect(t.starts()).toBe(2)
    expect(t.handles).toHaveLength(1)
    expect(t.published()).toBe(true)
  })

  it('服务起不来时关掉开关 → 照样撤掉磁盘上残留的 forsion-mcp.json', async () => {
    const t = await lifecycle({ fail: () => true })
    writeFileSync(t.extFile, JSON.stringify({ url: 'http://127.0.0.1:3591/mcp', token: 'stale' }))
    await expect(t.lc.apply(false)).rejects.toThrow('EADDRINUSE')
    expect(t.published()).toBe(false)
  })
})
