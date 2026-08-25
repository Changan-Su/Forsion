import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { callInboxSend, callTranscribeAudio, startForsionMcp, type McpDeps } from './mcpServer'

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
      homeDir: tmpdir(),
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
      homeDir: tmpdir(),
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
      homeDir: tmpdir(),
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
