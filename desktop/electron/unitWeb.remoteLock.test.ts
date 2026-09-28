/**
 * P1 · K2 S3(方案 §6.5 效果):锁定期间非本机入口只剩 GET / HEAD + 中止(+ asset-token、只读 vault RPC)。真 HTTP 全链,零 electron。
 * 放在单独文件而不是 unitWeb.test.ts:那份是 K1 / K4 / K2 共同追加的热文件,这里自带最小 boot。
 * 次序(INTEGRATION §2.3 / R-26):/engine 分支的锁定检查在 K4 会话档闸**之前** —— 锁定时 gateEngine 根本不被问到(不会排出首次确认)。
 * 负对照:未接 remoteLock 的 unitWeb 跑同一组 → 写入全部照常 200 / 到达引擎(实跑见红,记在 K2 交付报告)。
 */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { IPC } from '../shared/amadeus/ipc'
import type { VaultFace } from './amadeus/ipc'
import { startUnitWeb, type UnitWebDeps } from './unitWeb'
import { PRODUCT } from './product'
import type { UnitCaller } from './unitCaller'

type Seen = { method: string; path: string }
async function fakeEngine(): Promise<{ url: string; seen: Seen[]; close(): void }> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ method: req.method || '', path: req.url || '' })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() }
}

async function boot(o: { locked: () => boolean; projection?: UnitWebDeps['projection'] }) {
  const engine = await fakeEngine()
  const vaultCalls: string[] = []
  const vault: VaultFace = {
    call: async (ch) => { vaultCalls.push(ch); return ch === IPC.listPages ? ['a.md'] : null },
    onEvent: () => () => {},
    assetAbs: async () => null,
    absPath: (rel) => `/nonexistent/${rel}`,
    root: () => null,
  }
  const gateCalls: Array<{ method: string; path: string; caller: UnitCaller }> = []
  const pairs: Array<{ name: string }> = []
  const configWrites: unknown[] = []
  const paired: Array<{ id: string; name: string; tokenHash: string; createdAt: number }> = []
  const deps: UnitWebDeps = {
    getEngine: () => ({ url: engine.url, token: 'ENGINE_TOKEN', remoteMark: 'MARK' }),
    confirmPair: async (info) => { pairs.push(info); return false },
    pairedDevices: { list: () => paired, add: async (d) => { paired.push(d) } },
    readPlugins: async () => [],
    readSpaces: async () => [],
    readConfig: async () => ({ agentDeskEnabled: true }),
    writeConfig: async (p) => { configWrites.push(p); return {} },
    readProviders: async () => [],
    readHostFile: async () => null,
    readHostDir: async () => null,
    readHostStat: async () => null,
    meta: { instanceId: 'i', name: 'mac', version: '1' },
    p2pAnswer: async () => 'answer-sdp',
    webDistDir: () => null,
    vault: () => vault,
    log: () => {},
    // 会话档闸一律放行:这里只测锁定这一层(且断言锁定时它根本不被问到)
    remoteAccess: {
      gateEngine: (q) => { gateCalls.push(q); return { ok: true } },
      status: () => ({ remoteSessions: true, principal: 'account', caller: 'trusted', maxApprovalMode: 'auto-edit' }),
      request: async () => { pairs.push({ name: 'remote-access-request' }); return { remoteSessions: true, principal: 'account', caller: 'pending', maxApprovalMode: 'auto-edit' } },
    },
    ...(o.projection ? { projection: o.projection } : {}),
    remoteLock: o.locked,
  } as UnitWebDeps
  const handle = await startUnitWeb(deps, { port: 0, bindHost: '127.0.0.1' })
  return {
    base: `http://127.0.0.1:${handle.port}`, handle, engine, vaultCalls, gateCalls, pairs, configWrites, paired,
    close: () => { void handle.close(); engine.close() },
  }
}

const raw = (base: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> =>
  new Promise((res, rej) => {
    const u = new URL(base)
    const r = http.request({ host: u.hostname, port: u.port, method, path, headers }, (resp) => {
      let b = ''
      resp.on('data', (c) => { b += c })
      resp.on('end', () => res({ status: resp.statusCode || 0, body: b }))
    })
    r.on('error', rej)
    if (body !== undefined) r.write(body)
    r.end()
  })
const code = (r: { body: string }): string | undefined => { try { return JSON.parse(r.body).code } catch { return undefined } }

describe('unitWeb × 远程锁定(P1-K2 S3)', () => {
  it('锁定:/engine 只剩读 + 中止;写一律 423 且到不了引擎;锁定检查先于会话档闸', async () => {
    const b = await boot({ locked: () => true })
    try {
      const tunnel = { 'x-unit-internal': b.handle.internalSecret, 'Content-Type': 'application/json' }
      for (const [m, p] of [['POST', '/engine/agent/runs'], ['POST', '/engine/agent/runs/r1/approvals/a1'], ['POST', '/engine/agent/runs/r1/inquiries/i1'],
        ['POST', '/engine/agent/runs/r1/steer'], ['PATCH', '/engine/agent/sessions/s1'], ['POST', '/engine/agent/special/muse/todos/t1/approve']] as const) {
        const r = await raw(b.base, m, p, tunnel, '{}')
        expect([m, p, r.status, code(r)]).toEqual([m, p, 423, 'REMOTE_LOCKED'])
      }
      expect(b.engine.seen).toEqual([])
      expect(b.gateCalls).toEqual([]) // R-26:锁定时 K4 闸根本不被问到(不会排首次确认)
      expect((await raw(b.base, 'GET', '/engine/agent/sessions', tunnel)).status).toBe(200)
      expect((await raw(b.base, 'POST', '/engine/agent/runs/r1/abort', tunnel, '{}')).status).toBe(200)
      expect((await raw(b.base, 'POST', '/engine/Agent/Runs/r1/ABORT/', tunnel, '{}')).status).toBe(200) // 规整后同样是中止
      expect(b.engine.seen.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /agent/sessions', 'POST /agent/runs/r1/abort', 'POST /Agent/Runs/r1/ABORT'])
    } finally { b.close() }
  })

  it('锁定:/vault/rpc 写通道与有副作用的通道 423,只读通道照常;asset-token 照常', async () => {
    const b = await boot({ locked: () => true })
    try {
      const tunnel = { 'x-unit-internal': b.handle.internalSecret, 'Content-Type': 'application/json' }
      const rpc = (ch: string) => raw(b.base, 'POST', '/vault/rpc', tunnel, JSON.stringify({ ch, args: [] }))
      for (const ch of [IPC.savePage, IPC.saveVaultBytes, IPC.deletePage, IPC.dbWriteCas, IPC.writeTextFile, IPC.loadPage, IPC.fetchLinkMeta]) {
        const r = await rpc(ch)
        expect([ch, r.status, code(r)]).toEqual([ch, 423, 'REMOTE_LOCKED'])
      }
      expect(b.vaultCalls).toEqual([])
      expect((await rpc(IPC.listPages)).status).toBe(200)
      expect((await rpc(IPC.readPage)).status).toBe(200)
      expect(b.vaultCalls).toEqual([IPC.listPages, IPC.readPage])
      expect((await raw(b.base, 'POST', '/vault/asset-token', tunnel, '{}')).status).toBe(200)
    } finally { b.close() }
  })

  it('锁定:配对 / 直连 / 配置写 / 首次确认请求 / 将来的 /unit/mcp 一律 423;读面照常', async () => {
    const b = await boot({ locked: () => true })
    try {
      const tunnel = { 'x-unit-internal': b.handle.internalSecret, 'Content-Type': 'application/json' }
      for (const [m, p, h] of [
        ['POST', '/unit/pair/request', {}], ['POST', '/unit/p2p/offer', tunnel], ['PUT', '/unit/config', tunnel],
        ['POST', '/unit/remote-access/request', tunnel], ['POST', '/unit/mcp', tunnel],
      ] as const) {
        const r = await raw(b.base, m, p, h as Record<string, string>, '{"sdp":"x","name":"evil"}')
        expect([m, p, r.status, code(r)]).toEqual([m, p, 423, 'REMOTE_LOCKED'])
      }
      expect(b.pairs).toEqual([]) // 没有弹配对框、没有排首次确认
      expect(b.configWrites).toEqual([])
      expect((await raw(b.base, 'GET', '/unit/config', tunnel)).status).toBe(200)
      expect((await raw(b.base, 'GET', '/unit/remote-access', tunnel)).status).toBe(200)
      expect((await raw(b.base, 'GET', '/unit/meta', {})).status).toBe(200)
    } finally { b.close() }
  })

  it('未锁:同一组请求照常(写到得了引擎 / 库 / 配置)', async () => {
    const b = await boot({ locked: () => false })
    try {
      const tunnel = { 'x-unit-internal': b.handle.internalSecret, 'Content-Type': 'application/json' }
      expect((await raw(b.base, 'POST', '/engine/agent/runs', tunnel, '{}')).status).toBe(200)
      expect(b.gateCalls.length).toBe(1)
      expect((await raw(b.base, 'POST', '/vault/rpc', tunnel, JSON.stringify({ ch: IPC.savePage, args: [] }))).status).toBe(200)
      expect((await raw(b.base, 'PUT', '/unit/config', tunnel, '{}')).status).toBe(200)
      expect((await raw(b.base, 'POST', '/unit/p2p/offer', tunnel, '{"sdp":"x"}')).status).toBe(200)
    } finally { b.close() }
  })

  it('锁状态每请求现查(急停那一刻起生效、解锁立即恢复);便携 Unit 的工作区主人不受锁影响', async () => {
    let locked = false
    const b = await boot({ locked: () => locked })
    try {
      const tunnel = { 'x-unit-internal': b.handle.internalSecret, 'Content-Type': 'application/json' }
      expect((await raw(b.base, 'POST', '/engine/agent/runs', tunnel, '{}')).status).toBe(200)
      locked = true
      expect((await raw(b.base, 'POST', '/engine/agent/runs', tunnel, '{}')).status).toBe(423)
      locked = false
      expect((await raw(b.base, 'POST', '/engine/agent/runs', tunnel, '{}')).status).toBe(200)
    } finally { b.close() }
    const owner = 'owner-key-k2'
    const o = await boot({ locked: () => true, projection: { mode: 'local', basePath: '/', product: PRODUCT } })
    try {
      o.paired.push({ id: 'owner', name: 'owner', tokenHash: createHash('sha256').update(owner).digest('hex'), createdAt: 0 })
      expect((await raw(o.base, 'POST', '/engine/agent/runs', { Authorization: `Bearer ${owner}` }, '{}')).status).toBe(200)
    } finally { o.close() }
  })
})
