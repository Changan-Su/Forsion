import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { callInboxSend, startForsionMcp, type McpDeps } from './mcpServer'

const listen = (s: Server) =>
  new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)))

const deps = (over: Partial<McpDeps>): McpDeps => ({
  getEngine: () => ({ url: null, token: '' }),
  localSecret: 'secret',
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
})
