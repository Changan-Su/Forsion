/**
 * /unit/hostfile 读范围不被远端可写的会话路径放大(Codex 终审 out1 #2 / D1)—— 真 unitWeb 整链:
 *   局域网配对设备 → unitWeb /engine 反代(盖 x-forsion-remote)→ 假引擎(会话按**今天引擎的语义**存:
 *   远端 POST 建会话盖 agent_config.remoteOrigin,远端 PATCH project_path **不盖**)→ 同一设备 GET /unit/hostfile。
 * readHostFile 与 main.ts 同一套组合(composeUnitRoots + openUnitHostFile),根的来源、登记表、种子闸都是生产代码。
 *
 * 断言:
 *   ① 本机会话的项目目录照常可读(种子收进登记表);
 *   ② 远端把本机会话的 project_path PATCH 成不在受保护清单里的浏览器配置目录 → 读 Login Data 404;
 *   ③ 远端新建一个开在那儿的会话(带远程标记)→ 同样 404;远端派生 / 改出来的目录一律不算;
 *   ④ 本机原生选择框选过的目录(登记表 add)→ 开在那儿的本机会话可读(正常面不被误伤);
 *   ⑤ 种子闸:种子完成前远端 /engine 一律 503,完成后放行 —— 远端没有窗口抢在种子之前改 project_path。
 * 跑法:npx vitest run electron/unitHostChain.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { startUnitWeb, type UnitWebHandle } from './unitWeb'
import { buildUnitScopeGuard, openUnitHostFile, type UnitScopeGuard } from './unitHostScope'
import { composeUnitRoots, createFileProjectRegistry, createUnitSessionRoots, seedGatedEngine, type LocalProjectRegistry, type UnitSessionRootsSource } from './unitLocalRoots'

interface Row { id: string; project_path: string | null; archived: boolean; agent_config: Record<string, unknown> | null }

/** 假引擎:会话表在内存里,远端 / 本机的写语义与 tangu-agent routes/sessions.ts 今天的行为一致。 */
function fakeEngine(): Promise<{ url: string; rows: Row[]; hits: string[]; close(): void }> {
  const rows: Row[] = []
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const u = new URL(req.url || '/', 'http://x')
      hits.push(`${req.method} ${u.pathname}`)
      const remote = req.headers['x-forsion-remote']
      const body = raw ? JSON.parse(raw) : {}
      const send = (code: number, j: unknown): void => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)) }
      if (u.pathname === '/agent/sessions' && req.method === 'GET') {
        const archived = u.searchParams.get('archived') === 'true'
        return send(200, { sessions: rows.filter((r) => r.archived === archived) })
      }
      if (u.pathname === '/agent/sessions' && req.method === 'POST') {
        const row: Row = { id: randomUUID(), project_path: body.project_path ?? null, archived: false, agent_config: remote ? { remoteOrigin: { via: String(remote), marked: true, at: 'now' } } : null }
        rows.push(row)
        return send(200, { session: row })
      }
      const m = /^\/agent\/sessions\/([^/]+)$/.exec(u.pathname)
      if (m && req.method === 'PATCH') {
        const row = rows.find((r) => r.id === m[1])
        if (!row) return send(404, { detail: 'Session not found' })
        if (typeof body.project_path === 'string' || body.project_path === null) row.project_path = body.project_path // 今天的引擎:不盖远程标记
        return send(200, { session: row })
      }
      send(404, { detail: 'fake engine' })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, rows, hits, close: () => server.close() })
  }))
}

const LAN_TOKEN = 'lan-device-token'
let home = ''
let ws = ''
let proj = ''
let picked = ''
let browserProfile = ''
let guard: UnitScopeGuard
let engine: Awaited<ReturnType<typeof fakeEngine>>
let registry: LocalProjectRegistry
let source: UnitSessionRootsSource
let web: UnitWebHandle
let base = ''
let localSessionId = ''

beforeAll(async () => {
  home = realpathSync(await mkdtemp(join(tmpdir(), 'unit-chain-')))
  ws = join(home, 'Forsion')
  proj = join(home, 'code', 'app')
  picked = join(home, 'code', 'picked')
  // 不在受保护清单里的第三方应用配置目录(浏览器登录库 / Cookies)
  browserProfile = join(home, 'Library', 'Application Support', 'SomeBrowser', 'Default')
  for (const [dir, file, body] of [
    [ws, 'doc.md', 'ws'], [proj, 'a.md', 'project file'], [picked, 'b.md', 'picked file'],
    [browserProfile, 'Login Data', 'SAVED-PASSWORDS'], [join(home, '.forsion'), 'auth.json', '{"token":"T"}'],
  ] as const) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, file), body)
  }
  guard = buildUnitScopeGuard({ home, forsionHome: join(home, '.forsion'), userData: join(home, 'AppData', 'Forsion'), appData: join(home, 'AppData') })
  engine = await fakeEngine()
  // 升级前就有的本机会话(项目目录 proj)
  localSessionId = randomUUID()
  engine.rows.push({ id: localSessionId, project_path: proj, archived: false, agent_config: { execMode: 'host' } })
  registry = createFileProjectRegistry(join(home, 'AppData', 'Forsion', 'unit-local-project-roots.json'))
  const local = (): { url: string; token: string; remoteMark: string } => ({ url: engine.url, token: 'LOCAL', remoteMark: 'MARK' })
  source = createUnitSessionRoots({ engine: local, registry, ttlMs: 0 }) // ttl 0:每次现拉,15s 缓存不许掩盖 PATCH
  const env = { home }
  web = await startUnitWeb({
    getEngine: seedGatedEngine(local, source),
    confirmPair: async () => false,
    pairedDevices: { list: () => [{ id: 'd', name: 'lan', tokenHash: createHash('sha256').update(LAN_TOKEN).digest('hex'), createdAt: 0 }], add: async () => {} },
    readPlugins: async () => [], readSpaces: async () => [], readConfig: async () => ({}), writeConfig: async () => ({}), readProviders: async () => [],
    // 与 main.ts 的 readHostFile 同一套:composeUnitRoots(本机确认过的会话根)→ openUnitHostFile(realpath 钳制 + fd 绑定)
    readHostFile: async (p) => {
      const roots = await composeUnitRoots({ base: [ws], registry, source, env, guard })
      const opened = await openUnitHostFile(p, roots, env, guard)
      if (!opened) return null
      try { return { mimeType: 'text/plain', content: (await opened.fh.readFile()).toString('base64'), size: opened.st.size } } finally { await opened.fh.close() }
    },
    readHostDir: async () => null, readHostStat: async () => null,
    meta: { instanceId: 'i', name: 'n', version: '0' }, webDistDir: () => null, vault: () => null, log: () => {},
  }, { port: 0, bindHost: '127.0.0.1' })
  base = `http://127.0.0.1:${web.port}`
})
afterAll(async () => { await web?.close(); engine?.close() })

const LAN = { Authorization: `Bearer ${LAN_TOKEN}` }
const remoteEngine = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}/engine${path}`, { method, headers: { ...LAN, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
const hostfile = async (p: string): Promise<{ status: number; text: string }> => {
  const r = await fetch(`${base}/unit/hostfile?path=${encodeURIComponent(p)}`, { headers: LAN })
  const j = (await r.json()) as { content?: string }
  return { status: r.status, text: j.content ? Buffer.from(j.content, 'base64').toString('utf8') : '' }
}

describe('unit hostfile × 远端可写的会话路径(真 unitWeb 整链)', () => {
  it('种子闸:种子完成前远端 /engine 一律 503(一个字节都到不了引擎);完成后放行', async () => {
    const before = engine.hits.filter((h) => h.startsWith('PATCH')).length
    const r = await remoteEngine('PATCH', `/agent/sessions/${localSessionId}`, { project_path: browserProfile })
    expect(r.status).toBe(503)
    expect(engine.hits.filter((h) => h.startsWith('PATCH')).length).toBe(before)
    for (let i = 0; i < 50 && !source.seeded(); i++) await new Promise((res) => setTimeout(res, 20))
    expect(source.seeded()).toBe(true)
    expect(registry.roots()).toEqual([proj]) // 种子 = 当时已有、无远程标记的本机会话目录
    expect((await remoteEngine('GET', '/agent/sessions')).status).toBe(200)
  })

  it('本机会话的项目目录照常可读;受保护路径照常 404', async () => {
    expect(await hostfile(join(proj, 'a.md'))).toEqual({ status: 200, text: 'project file' })
    expect((await hostfile(join(home, '.forsion', 'auth.json'))).status).toBe(404)
  })

  it('远端把本机会话的 project_path PATCH 成浏览器配置目录 → Login Data 404(引擎没盖标记也拦得住)', async () => {
    const r = await remoteEngine('PATCH', `/agent/sessions/${localSessionId}`, { project_path: browserProfile })
    expect(r.status).toBe(200)
    expect(engine.rows.find((x) => x.id === localSessionId)?.project_path).toBe(browserProfile) // 引擎确实改了、且没标记
    expect(engine.rows.find((x) => x.id === localSessionId)?.agent_config?.remoteOrigin).toBeUndefined()
    const got = await hostfile(join(browserProfile, 'Login Data'))
    expect(got.status).toBe(404)
    expect(got.text).not.toContain('SAVED-PASSWORDS')
    // 改回来:本机目录照常
    await remoteEngine('PATCH', `/agent/sessions/${localSessionId}`, { project_path: proj })
    expect((await hostfile(join(proj, 'a.md'))).status).toBe(200)
  })

  it('远端新建开在浏览器配置目录的会话(带远程标记)→ 404', async () => {
    const r = await remoteEngine('POST', '/agent/sessions', { title: 't', project_path: browserProfile })
    expect(r.status).toBe(200)
    expect(engine.rows.at(-1)?.agent_config?.remoteOrigin).toBeTruthy()
    expect((await hostfile(join(browserProfile, 'Login Data'))).status).toBe(404)
  })

  it('远端新建开在**登记过的本机项目**里的会话:带远程标记的行本身不算根,但同目录的本机会话照样让它可读', async () => {
    const r = await remoteEngine('POST', '/agent/sessions', { title: 't2', project_path: proj })
    expect(r.status).toBe(200)
    expect((await hostfile(join(proj, 'a.md'))).status).toBe(200)
  })

  it('本机原生选择框选过的目录(登记表 add)→ 开在那儿的本机会话可读;没登记的本机会话目录不算', async () => {
    engine.rows.push({ id: randomUUID(), project_path: picked, archived: false, agent_config: null })
    expect((await hostfile(join(picked, 'b.md'))).status).toBe(404) // 升级后才建、没经选择框:不在本机根里
    await registry.add([picked])
    expect(await hostfile(join(picked, 'b.md'))).toEqual({ status: 200, text: 'picked file' })
  })
})
