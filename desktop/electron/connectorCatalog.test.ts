import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addConnector, createConnectorCatalog, sanitizeCatalog, syncMcpServers, type ConnectorEntry } from './connectorCatalog'
import { applyMcpSnapshot } from '../shared/mcpConfig'

const pair = (s: string) => ({ zh: s, en: s })
const entry = (over: Partial<ConnectorEntry> & { id: string }): ConnectorEntry =>
  ({ kind: 'remote-mcp', status: 'published', order: 0, name: pair(over.id), description: pair('d'), url: `https://${over.id}.example/mcp`, ...over }) as ConnectorEntry

describe('sanitizeCatalog', () => {
  it('只收认识的字段,形状不对的条目整条丢', () => {
    const out = sanitizeCatalog({ connectors: [
      { ...entry({ id: 'notion' }), headers: { a: 'b' }, clientSecret: 'x', oauth: { clientId: 'c', scopes: ['r'], clientSecret: 's' } },
      { ...entry({ id: 'bad' }), url: 'http://evil.example/mcp' }, // 明文远端
      { ...entry({ id: 'BAD!' }) },
      { ...entry({ id: 'draft' }), status: 'draft' },
      { ...entry({ id: 'noname' }), name: { zh: 'x' } },
      { ...entry({ id: 'amap', order: -1 }), url: 'https://mcp.amap.com/mcp?key={userKey}', auth: { type: 'user-key', applyUrl: 'https://console.amap.com' }, alwaysAsk: ['ride', 3] },
    ] })
    expect(out.map((c) => c.id)).toEqual(['amap', 'notion'])
    expect(out[1]).not.toHaveProperty('headers')
    expect(out[1].oauth).toEqual({ clientId: 'c', scopes: ['r'] })
    expect(out[0]).toMatchObject({ auth: { type: 'user-key' }, alwaysAsk: ['ride'] })
    expect(() => sanitizeCatalog({})).toThrow()
  })
})

describe('连接 / 对账', () => {
  it('连接写模板与标记;同名用户条目不覆盖;已连着原样返回', () => {
    const amap = entry({ id: 'amap', url: 'https://mcp.amap.com/mcp?key={userKey}' })
    const r = addConnector({}, amap)
    expect(r).toMatchObject({ name: 'amap', added: true })
    expect(r.servers.amap).toEqual({ url: 'https://mcp.amap.com/mcp?key={userKey}', connector: 'amap' })
    expect(addConnector(r.servers, amap)).toMatchObject({ name: 'amap', added: false })
    const mine = { notion: { url: 'https://my.example/mcp' } }
    expect(addConnector(mine, entry({ id: 'notion' }))).toMatchObject({ name: 'notion-connector', added: true })
    expect(() => addConnector({}, entry({ id: 'old', status: 'retired' }))).toThrow(/no longer available/)
  })

  it('地址变了跟着改、enabled 留用户的;下线的照样跟;没标记的不动;没变 = undefined', () => {
    const servers = {
      notion: { url: 'https://old.example/mcp', connector: 'notion', enabled: false, timeoutMs: 5000 },
      mine: { url: 'https://old.example/mcp' },
    }
    const next = syncMcpServers(servers, [entry({ id: 'notion', status: 'retired', url: 'https://new.example/mcp', oauth: { clientId: 'c' } })])!
    expect(next.notion).toEqual({ url: 'https://new.example/mcp', oauth: { clientId: 'c' }, connector: 'notion', enabled: false, timeoutMs: 5000 })
    expect(next.mine).toBe(servers.mine)
    expect(syncMcpServers(next, [entry({ id: 'notion', url: 'https://new.example/mcp', oauth: { clientId: 'c' } })])).toBeUndefined()
  })

  it('标记活过设置页的编辑(停用 / 启用走 applyMcpSnapshot)', () => {
    const cur = { amap: { url: 'https://mcp.amap.com/mcp?key={userKey}', connector: 'amap' } }
    const off = applyMcpSnapshot(cur, { amap: { ...cur.amap, enabled: false } }, cur)
    expect(off.amap).toEqual({ ...cur.amap, enabled: false })
  })
})

describe('拉目录', () => {
  let dir = ''
  afterEach(() => { vi.unstubAllGlobals(); if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('拉到就写缓存并对账;拉不到回缓存(offline)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'conn-cat-'))
    let servers: Record<string, any> = { notion: { url: 'https://old.example/mcp', connector: 'notion' } }
    const cat = createConnectorCatalog({
      base: async () => 'https://forsion.example',
      cacheFile: () => join(dir, 'connector-catalog.json'),
      updateMcpServers: async (fn) => { servers = fn(servers) ?? servers; return servers },
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('https://forsion.example/api/connectors')
      return new Response(JSON.stringify({ connectors: [entry({ id: 'notion', url: 'https://mcp.notion.com/mcp', alwaysAsk: ['delete'] })] }))
    }))
    const live = await cat.refresh()
    expect(live).toMatchObject({ offline: false, connectors: [{ id: 'notion' }] })
    expect(servers.notion.url).toBe('https://mcp.notion.com/mcp')
    expect(JSON.parse(readFileSync(join(dir, 'connector-catalog.json'), 'utf8')).connectors[0].alwaysAsk).toEqual(['delete'])

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await cat.refresh()).toMatchObject({ offline: true, connectors: [{ id: 'notion' }] })
    writeFileSync(join(dir, 'connector-catalog.json'), '{broken')
    expect(await cat.refresh()).toEqual({ offline: true, connectors: [], fetchedAt: null })
  })
})
