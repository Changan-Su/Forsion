/**
 * unitWeb 的委托管理员档与隧道基址(真 HTTP,零 electron):
 *   · 隧道来路的 index.html 用相对 <base>(经中转时浏览器地址多一段路径前缀),本机 / 局域网来路照旧给绝对基址;
 *   · 开关开 + 隧道 + 验过的 role=admin 操作者声明 → 缺省全拒(GET 也算),只放 DELEGATED_ADMIN_UNIT_ROUTES、
 *     路由表 delegatedAdmin 标记的引擎路由与静态资源;放行的引擎请求盖 x-forsion-remote-role;每次写在本机日志留一行;
 *   · 断言的 MAC 被改 / 重放 / 换方法或路径 → 403,不降级;
 *   · 开关关着时合法的操作者声明一律无视,按今天的隧道档(不升档)。
 * 跑法:npx vitest run electron/unitWebDelegatedAdmin.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { startUnitWeb, delegatedEngineAllowed, delegatedNonEngineAllowed, relativeBaseHref, DELEGATED_ADMIN_UNIT_ROUTES, type UnitWebDeps } from './unitWeb'
import { ENGINE_ROUTES } from './engineRoutes.generated'
import { PRODUCT } from './product'
import { signProxyCaller, type ProxyCaller, type ProxyOperator } from './unitCaller'
import type { GateResult } from '../shared/remoteSessions'

type Seen = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }
async function fakeEngine(): Promise<{ url: string; seen: Seen[]; close(): void }> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method || '', path: req.url || '', headers: req.headers, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() }
}

const OWNER_TOKEN = 'owner-token-for-lan'
const ADMIN: ProxyOperator = { uid: 'user-42', role: 'admin', name: '王 管理员' }
const PHONE: ProxyCaller = { unit: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f', kind: 'phone', name: 'Phone', platform: 'android', registeredAt: null }

interface Boot {
  base: string
  key: string
  internal: string
  engine: Awaited<ReturnType<typeof fakeEngine>>
  logs: string[]
  routed: string[]
  configWrites: unknown[]
  close(): void
}
const open: Boot[] = []
afterEach(() => { for (const b of open.splice(0)) b.close() })

async function boot(opts: { delegated?: boolean | (() => boolean); locked?: boolean; gate?: (q: { method: string; path: string }) => GateResult } = {}): Promise<Boot> {
  const engine = await fakeEngine()
  const dist = await mkdtemp(join(tmpdir(), 'unit-delegated-'))
  await mkdir(join(dist, 'assets'))
  await writeFile(join(dist, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
  await writeFile(join(dist, 'assets', 'app.js'), 'console.log(1)')
  const logs: string[] = [], routed: string[] = [], configWrites: unknown[] = []
  const delegated = opts.delegated
  const deps: UnitWebDeps = {
    getEngine: () => ({ url: engine.url, token: 'ENGINE_TOKEN', remoteMark: 'REMOTE_MARK' }),
    confirmPair: async () => false,
    pairedDevices: { list: () => [{ id: 'owner', name: 'owner', tokenHash: createHash('sha256').update(OWNER_TOKEN).digest('hex'), createdAt: 0 }], add: async () => {} },
    readPlugins: async () => [{ id: 'demo' }],
    readSpaces: async () => [],
    readConfig: async () => ({ agentDeskEnabled: true }),
    writeConfig: async (patch) => { configWrites.push(patch); return {} },
    readProviders: async () => [],
    readHostFile: async () => null, readHostDir: async () => null, readHostStat: async () => null,
    meta: { instanceId: 'inst-1', name: 'Unit', version: '9.9.9' },
    projection: { mode: 'local', basePath: '/web/', product: PRODUCT },
    routeRequest: (req, res) => {
      const p = (req.url || '/').split('?')[0]
      if (p.startsWith('/plugin-backend')) { routed.push(p); res.writeHead(200); res.end('plugin'); return true }
      return false
    },
    webDistDir: () => dist,
    vault: () => ({ call: async () => null, onEvent: () => () => {}, assetAbs: async () => null, absPath: () => '/nonexistent', root: () => null }),
    log: (m) => { logs.push(m) },
    ...(delegated === undefined ? {} : { delegatedAdmin: typeof delegated === 'function' ? delegated : () => delegated }),
    ...(opts.locked ? { remoteLock: () => true } : {}),
    ...(opts.gate ? { remoteAccess: { gateEngine: (q) => opts.gate!(q), status: () => ({ remoteSessions: false, principal: 'account', caller: 'unconfirmed', maxApprovalMode: 'auto-edit' }), request: async () => ({ remoteSessions: false, principal: 'account', caller: 'unconfirmed', maxApprovalMode: 'auto-edit' }) } } : {}),
  }
  const handle = await startUnitWeb(deps, { port: 0, bindHost: '127.0.0.1' })
  const b: Boot = { base: `http://127.0.0.1:${handle.port}`, key: handle.proxyCallerKey, internal: handle.internalSecret, engine, logs, routed, configWrites, close: () => { void handle.close(); engine.close() } }
  open.push(b)
  return b
}

let seq = 0
/** 隧道请求:内部密钥 + 按实际发出的目标签的断言(operator / caller 可选)。sign 可覆写签进去的方法 / 目标(换路径测试)。 */
async function tunnel(b: Boot, method: string, path: string, o: { operator?: ProxyOperator | null; caller?: ProxyCaller | null; body?: unknown; headers?: Record<string, string>; sign?: { method?: string; target?: string }; assertion?: string } = {}) {
  const operator = o.operator === undefined ? ADMIN : o.operator
  const caller = o.caller ?? null
  const headers: Record<string, string> = { 'x-unit-internal': b.internal, ...o.headers }
  if (o.assertion) headers['x-unit-caller'] = o.assertion
  else if (operator || caller) headers['x-unit-caller'] = signProxyCaller(b.key, { dispatchId: `d-${++seq}`, method: o.sign?.method ?? method, target: o.sign?.target ?? path, caller, operator })
  if (o.body !== undefined) headers['content-type'] = 'application/json'
  const r = await fetch(b.base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), redirect: 'manual' })
  const text = await r.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* html / plain */ }
  return { status: r.status, text, json, headers: r.headers, assertion: headers['x-unit-caller'] }
}
const lan = async (b: Boot, path: string) => {
  const r = await fetch(b.base + path, { headers: { Authorization: `Bearer ${OWNER_TOKEN}` }, redirect: 'manual' })
  return { status: r.status, text: await r.text(), headers: r.headers }
}

describe('relativeBaseHref', () => {
  it('从请求目录走回投影根', () => {
    expect(relativeBaseHref('/web/', '/web/')).toBe('./')
    expect(relativeBaseHref('/web/index.html', '/web/')).toBe('./')
    expect(relativeBaseHref('/web/space/notes', '/web/')).toBe('../')
    expect(relativeBaseHref('/web/a/b/c', '/web/')).toBe('../../')
    expect(relativeBaseHref('/', '/web/')).toBe('web/')
    expect(relativeBaseHref('/other/x', '/web/')).toBe('../web/')
    expect(relativeBaseHref('/a/b', '/')).toBe('../')
    expect(relativeBaseHref('/', '/')).toBe('./')
  })
})

describe('index.html 基址:隧道相对、本机 / 局域网照旧绝对', () => {
  it('局域网(工作区主人)来路:根与深层路径都是 <base href="/web/">', async () => {
    const b = await boot()
    for (const p of ['/web/', '/web/space/notes']) {
      const r = await lan(b, p)
      expect(r.status).toBe(200)
      expect(r.text).toContain('<head><base href="/web/"><script>')
    }
    // 308 也照旧是绝对地址
    const r = await lan(b, '/web?x=1')
    expect(r.status).toBe(308)
    expect(r.headers.get('location')).toBe('/web/?x=1')
  })
  it('隧道来路(不带断言):按请求深度给相对基址,资源与 unit/* 相对它都落回这台设备的投影根', async () => {
    const b = await boot()
    const cases: Array<[string, string]> = [['/web/', './'], ['/web/space/notes', '../'], ['/web/a/b/c', '../../'], ['/', 'web/']]
    for (const [p, base] of cases) {
      const r = await tunnel(b, 'GET', p, { operator: null })
      expect(r.status, p).toBe(200)
      expect(r.text, p).toContain(`<head><base href="${base}"><script>`)
      expect(r.text, p).not.toContain('<base href="/web/">')
    }
    // 不带尾斜杠的入口:隧道不跳转(中转会带着签给原目标的断言去跟随),直接回壳,基址从 …/web 落回投影根
    const bare = await tunnel(b, 'GET', '/web?x=1', { operator: null })
    expect(bare.status).toBe(200)
    expect(bare.text).toContain('<base href="web/">')
  })
})

describe('委托管理员档(开关开)', () => {
  it('白名单内的引擎读写放行:盖隧道来路、远端标记与角色头;写不过会话档闸;caller 可缺', async () => {
    const b = await boot({ delegated: true, gate: () => ({ ok: false, status: 403, body: { code: 'REMOTE_SESSIONS_OFF', detail: 'off' } }) })
    const allowed: Array<[string, string, unknown?]> = [
      ['GET', '/web/engine/health'],
      ['GET', '/web/engine/agent/agents'],
      ['GET', '/web/engine/agent/agents-meta'],
      ['POST', '/web/engine/agent/agents', { name: 'n', systemPrompt: 'p' }],
      ['PATCH', '/web/engine/agent/agents/demo', { description: 'd' }],
      ['DELETE', '/web/engine/agent/agents/demo'],
      ['GET', '/web/engine/agent/models'],
      ['GET', '/web/engine/agent/skills?agentSlug=demo'],
      ['GET', '/web/engine/agent/skills/catalog?agentSlug=demo'],
      ['PUT', '/web/engine/agent/skills/catalog/local%3Ax/disabled?agentSlug=demo', { disabled: true }],
      ['GET', '/web/engine/agent/special/schedule'],
      ['POST', '/web/engine/agent/special/schedule/demo/entries', { title: 't' }],
      ['DELETE', '/web/engine/agent/special/schedule/demo/entries/e1'],
    ]
    for (const [method, path, body] of allowed) {
      const r = await tunnel(b, method, path, { body })
      expect(r.status, `${method} ${path}`).toBe(200)
      const hit = b.engine.seen.at(-1)!
      expect(hit.method).toBe(method)
      expect(hit.path).toBe(path.slice('/web/engine'.length))
      expect(hit.headers['x-forsion-remote']).toBe('tunnel')
      expect(hit.headers['x-forsion-remote-mark']).toBe('REMOTE_MARK')
      expect(hit.headers['x-forsion-remote-role']).toBe('delegated-admin')
      expect(hit.headers['x-forsion-remote-caller']).toBeUndefined()
      expect(hit.headers['x-unit-caller']).toBeUndefined()
    }
    // caller 与 operator 同在:调用方头照盖
    await tunnel(b, 'GET', '/web/engine/agent/agents', { caller: PHONE })
    expect(b.engine.seen.at(-1)!.headers['x-forsion-remote-caller']).toBeTruthy()
  })

  it('壳的四条只读与静态资源放行;插件后端挂载不进(先于 routeRequest 判)', async () => {
    const b = await boot({ delegated: true })
    for (const p of ['/web/unit/whoami', '/web/unit/config', '/web/unit/plugins', '/web/unit/spaces', '/web/', '/web/space/agents', '/web/assets/app.js']) {
      expect((await tunnel(b, 'GET', p)).status, p).toBe(200)
    }
    expect((await tunnel(b, 'GET', '/web/')).text).toContain('<base href="./">')
    const backend = await tunnel(b, 'GET', '/plugin-backend/x')
    expect(backend.status).toBe(200) // 当静态资源:回的是壳(index.html),不是插件后端
    expect(backend.text).toContain('<base href="../web/">')
    expect((await tunnel(b, 'POST', '/plugin-backend/x', { body: {} })).status).toBe(403)
    expect(b.routed).toEqual([])
  })

  it('不放的每一类都 403 LOCAL_ONLY(GET 也算),且引擎收不到', async () => {
    const b = await boot({ delegated: true })
    const denied: Array<[string, string, unknown?]> = [
      // 会话与消息(GET 也拒)
      ['GET', '/web/engine/agent/sessions'],
      ['GET', '/web/engine/agent/sessions/s1/messages'],
      ['POST', '/web/engine/agent/sessions', {}],
      ['POST', '/web/engine/agent/runs', {}],
      ['GET', '/web/engine/agent/sessions/attention'],
      // 记忆 / human / 电脑历史 / 收件箱 / 用量 / 同步
      ['GET', '/web/engine/agent/memory'],
      ['GET', '/web/engine/agent/agents/demo/memory'],
      ['GET', '/web/engine/agent/agents/demo/harness'],
      ['GET', '/web/engine/agent/human/SOUL.md'],
      ['GET', '/web/engine/agent/user-profile'],
      ['GET', '/web/engine/agent/inbox'],
      ['GET', '/web/engine/agent/inbox/unread-count'],
      ['GET', '/web/engine/agent/sync/status'],
      ['POST', '/web/engine/agent/sync', {}],
      // Hooks(读和写)、MCP 配置与探测、工具清单(带 MCP 状态)
      ['GET', '/web/engine/agent/hooks'],
      ['PUT', '/web/engine/agent/hooks', {}],
      ['POST', '/web/engine/agent/mcp/probe', {}],
      ['POST', '/web/engine/agent/mcp/demo/key', {}],
      ['GET', '/web/engine/agent/tools'],
      // 审批规则、插件安装、通道
      ['GET', '/web/engine/agent/approval-rules'],
      ['PUT', '/web/engine/agent/approval-rules', {}],
      ['POST', '/web/engine/agent/plugins/install', {}],
      ['GET', '/web/engine/agent/plugins'],
      ['GET', '/web/engine/agent/channels'],
      // 技能的上传 / 导入 / 编辑,Agent 的改名 / 名册 meta 写
      ['POST', '/web/engine/agent/skills/upload', {}],
      ['POST', '/web/engine/agent/skills/catalog/import', {}],
      ['PATCH', '/web/engine/agent/skills/catalog/k', {}],
      ['POST', '/web/engine/agent/agents/demo/rename', {}],
      ['PUT', '/web/engine/agent/agents-meta', {}],
      // 表里没有的引擎路径
      ['GET', '/web/engine/agent/not-a-route'],
    ]
    for (const [method, path, body] of denied) {
      const r = await tunnel(b, method, path, { body })
      expect(r.status, `${method} ${path}`).toBe(403)
      expect(r.json?.code, `${method} ${path}`).toBe('LOCAL_ONLY')
    }
    const unitDenied: Array<[string, string, unknown?]> = [
      ['PUT', '/web/unit/config', { agentDeskEnabled: false }],
      ['GET', '/web/unit/meta'],
      ['GET', '/web/unit/providers'],
      ['GET', '/web/unit/remote-access'],
      ['GET', '/web/unit/hostfile?path=/x'],
      ['GET', '/web/unit/hostdir?path=/x'],
      ['POST', '/web/unit/p2p/offer', {}],
      ['POST', '/web/vault/rpc', { ch: 'vault:files', args: [] }],
      ['POST', '/web/vault/asset-token', {}],
      ['GET', '/web/vault/events'],
      ['GET', '/web/vault/asset?path=a.png'],
    ]
    for (const [method, path, body] of unitDenied) {
      const r = await tunnel(b, method, path, { body })
      expect(r.status, `${method} ${path}`).toBe(403)
      expect(r.json?.code, `${method} ${path}`).toBe('LOCAL_ONLY')
    }
    expect(b.engine.seen).toEqual([])
    expect(b.configWrites).toEqual([])
  })

  it('留痕:每次写一行(操作者、方法、路径、结果码、时刻;被拒的也记),读不记,不记请求体与 query', async () => {
    const b = await boot({ delegated: true })
    await tunnel(b, 'GET', '/web/engine/agent/agents')
    await tunnel(b, 'PATCH', '/web/engine/agent/agents/demo?x=secret-query', { body: { description: 'BODY-SENTINEL' } })
    await tunnel(b, 'PUT', '/web/engine/agent/hooks', { body: { hooks: 'BODY-SENTINEL' } })
    const lines = b.logs.filter((l) => l.includes('delegated admin write'))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\[unit-web\] delegated admin write: uid=user-42 name="王 管理员" PATCH \/engine\/agent\/agents\/demo -> 200 at \d{4}-\d\d-\d\dT/)
    expect(lines[1]).toMatch(/PUT \/engine\/agent\/hooks -> 403 at /)
    expect(b.logs.join('\n')).not.toContain('BODY-SENTINEL')
    expect(b.logs.join('\n')).not.toContain('secret-query')
  })

  it('急停锁定照旧生效:白名单里的写 423,读放行;锁定挡下的写也留痕', async () => {
    const b = await boot({ delegated: true, locked: true })
    expect((await tunnel(b, 'GET', '/web/engine/agent/agents')).status).toBe(200)
    expect((await tunnel(b, 'PATCH', '/web/engine/agent/agents/demo', { body: {} })).status).toBe(423)
    expect((await tunnel(b, 'PUT', '/web/unit/config', { body: {} })).status).toBe(423)
    const lines = b.logs.filter((l) => l.includes('delegated admin write'))
    expect(lines.map((l) => / (PATCH|PUT) (\S+) -> (\d+)/.exec(l)?.slice(1).join(' '))).toEqual(['PATCH /engine/agent/agents/demo 423', 'PUT /unit/config 423'])
  })

  it('不带尾斜杠的入口带着委托管理员断言也能打开(不经 308)', async () => {
    const b = await boot({ delegated: true })
    const r = await tunnel(b, 'GET', '/web')
    expect(r.status).toBe(200)
    expect(r.text).toContain('<base href="web/">')
  })

  it('入站的角色头一律不透传:没有操作者声明的隧道请求、局域网主人都盖不上', async () => {
    const b = await boot({ delegated: true })
    await tunnel(b, 'GET', '/web/engine/agent/agents', { operator: null, headers: { 'x-forsion-remote-role': 'delegated-admin' } })
    expect(b.engine.seen.at(-1)!.headers['x-forsion-remote-role']).toBeUndefined()
    await tunnel(b, 'GET', '/web/engine/agent/agents', { operator: null, caller: PHONE, headers: { 'x-forsion-remote-role': 'delegated-admin' } })
    expect(b.engine.seen.at(-1)!.headers['x-forsion-remote-role']).toBeUndefined()
    await fetch(`${b.base}/web/engine/agent/agents`, { headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'x-forsion-remote-role': 'delegated-admin' } })
    expect(b.engine.seen.at(-1)!.headers['x-forsion-remote-role']).toBeUndefined()
  })

  it('操作者声明只在隧道来路生效:局域网带同一枚断言照旧是主人(直通,不盖角色)', async () => {
    const b = await boot({ delegated: true })
    const assertion = signProxyCaller(b.key, { dispatchId: 'lan-1', method: 'GET', target: '/web/engine/agent/sessions', operator: ADMIN })
    const r = await fetch(`${b.base}/web/engine/agent/sessions`, { headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'x-unit-caller': assertion } })
    expect(r.status).toBe(200)
    expect(b.engine.seen.at(-1)!.headers['x-forsion-remote']).toBeUndefined()
  })
})

describe('断言被改 / 重放 / 换方法或路径 → 403,不降级', () => {
  it('MAC 被改:引擎与静态面都 403 BAD_CALLER_ASSERTION', async () => {
    const b = await boot({ delegated: true })
    const good = signProxyCaller(b.key, { dispatchId: 'x-1', method: 'GET', target: '/web/engine/agent/agents', operator: ADMIN })
    const [v, body, mac] = good.split('.')
    const flipped = `${v}.${body}.${mac.slice(0, -2)}${mac.endsWith('AA') ? 'BB' : 'AA'}`
    const r = await tunnel(b, 'GET', '/web/engine/agent/agents', { assertion: flipped })
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('BAD_CALLER_ASSERTION')
    // 载荷被换成别的操作者(MAC 不变)
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), o: { uid: 'someone-else', role: 'admin', name: 'x' } })).toString('base64url')
    expect((await tunnel(b, 'GET', '/web/engine/agent/agents', { assertion: `${v}.${forged}.${mac}` })).status).toBe(403)
    const staticForged = signProxyCaller('f'.repeat(64), { dispatchId: 'x-2', method: 'GET', target: '/web/', operator: ADMIN })
    expect((await tunnel(b, 'GET', '/web/', { assertion: staticForged })).status).toBe(403)
    expect(b.engine.seen).toEqual([])
  })
  it('重放:同一枚断言第二次 403', async () => {
    const b = await boot({ delegated: true })
    const first = await tunnel(b, 'GET', '/web/engine/agent/agents')
    expect(first.status).toBe(200)
    const again = await tunnel(b, 'GET', '/web/engine/agent/agents', { assertion: first.assertion })
    expect(again.status).toBe(403)
    expect(again.json.code).toBe('BAD_CALLER_ASSERTION')
    expect(b.engine.seen).toHaveLength(1)
  })
  it('换路径 / 换方法:403(签给 Agent 列表的拿去读会话、签给 GET 的拿去 PATCH)', async () => {
    const b = await boot({ delegated: true })
    expect((await tunnel(b, 'GET', '/web/engine/agent/sessions', { sign: { target: '/web/engine/agent/agents' } })).status).toBe(403)
    expect((await tunnel(b, 'PATCH', '/web/engine/agent/agents/demo', { body: {}, sign: { method: 'GET' } })).status).toBe(403)
    expect((await tunnel(b, 'GET', '/web/unit/config', { sign: { target: '/web/unit/whoami' } })).status).toBe(403)
    expect(b.engine.seen).toEqual([])
  })
})

describe('开关关着:合法的操作者声明不升档,按今天的隧道档', () => {
  for (const [label, delegated] of [['缺省(桌面不传)', undefined], ['显式关', false], ['读开关抛错', () => { throw new Error('boom') }]] as const) {
    it(label, async () => {
      const b = await boot({ delegated: delegated as never })
      // 今天的隧道基础档:读会话照旧 200,不盖角色头
      expect((await tunnel(b, 'GET', '/web/engine/agent/sessions')).status).toBe(200)
      expect(b.engine.seen.at(-1)!.headers['x-forsion-remote-role']).toBeUndefined()
      // 写 Agent 仍是 deny-remote
      const w = await tunnel(b, 'PATCH', '/web/engine/agent/agents/demo', { body: {} })
      expect(w.status).toBe(403)
      expect(w.json.code).toBe('LOCAL_ONLY')
      // 插件后端照常经 routeRequest;不留委托管理员的痕
      expect((await tunnel(b, 'GET', '/plugin-backend/x')).text).toBe('plugin')
      expect(b.logs.some((l) => l.includes('delegated admin write'))).toBe(false)
    })
  }
})

describe('白名单的数据形状', () => {
  it('引擎半:路由表里带 delegatedAdmin 标记的就是这 17 条(增删要同改生成器 DELEGATED_ADMIN 与这里)', () => {
    const marked = ENGINE_ROUTES.filter((r) => r.delegatedAdmin).map((r) => `${r.method} ${r.path}`).sort()
    expect(marked).toEqual([
      'DELETE /agent/agents/:slug', 'DELETE /agent/agents/:slug/avatar', 'DELETE /agent/special/schedule/:slug/entries/:id',
      'GET /agent/agents', 'GET /agent/agents-meta', 'GET /agent/agents/:slug/avatar', 'GET /agent/models',
      'GET /agent/skills', 'GET /agent/skills/catalog', 'GET /agent/special/schedule', 'GET /agent/tool-catalog', 'GET /health',
      'PATCH /agent/agents/:slug', 'POST /agent/agents', 'POST /agent/agents/:slug/avatar', 'POST /agent/special/schedule/:slug/entries',
      'PUT /agent/skills/catalog/:key/disabled',
    ])
  })
  it('判定函数与表一致:同一路径命中多行时任一行没标记即拒;HEAD 按 GET', () => {
    expect(delegatedEngineAllowed('GET', '/agent/agents')).toBe(true)
    expect(delegatedEngineAllowed('HEAD', '/agent/agents')).toBe(true)
    expect(delegatedEngineAllowed('GET', '/agent/agents/demo/harness')).toBe(false)
    expect(delegatedEngineAllowed('GET', '/agent/sessions')).toBe(false)
    expect(delegatedEngineAllowed('GET', '/agent/nope')).toBe(false)
    // :key 与字面段同时命中的那类:catalog/import(POST)只命中不带标记的行
    expect(delegatedEngineAllowed('POST', '/agent/skills/catalog/import')).toBe(false)
    for (const [m, p] of DELEGATED_ADMIN_UNIT_ROUTES) expect(delegatedNonEngineAllowed(m, p)).toBe(true)
    expect(delegatedNonEngineAllowed('PUT', '/unit/config')).toBe(false)
    expect(delegatedNonEngineAllowed('GET', '/unit/meta')).toBe(false)
    expect(delegatedNonEngineAllowed('GET', '/vault/asset')).toBe(false)
    expect(delegatedNonEngineAllowed('HEAD', '/assets/a.js')).toBe(true)
    expect(delegatedNonEngineAllowed('POST', '/assets/a.js')).toBe(false)
  })
})
