import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { get as httpGet, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import {
  resolveSafe, transpileForServe, servePathRoot, serveDir, setForsionPreviewHooks, stopCodePreview,
  serveProductRoot, setPreviewPersistence, previewToken, TOKEN_CAP, type PreviewPersistedState,
} from './codePreview'

/** 带 Host 头打真服务器(node fetch 不解析 *.localhost,用裸 http + Host 头模拟 Chromium 行为)。 */
const get = (port: string, path: string, host?: string): Promise<{ code: number; body: string }> =>
  new Promise((res, rej) => {
    httpGet({ host: '127.0.0.1', port, path, headers: host ? { host } : {} }, (r) => {
      let b = ''
      r.on('data', (c) => { b += c })
      r.on('end', () => res({ code: r.statusCode || 0, body: b }))
    }).on('error', rej)
  })

/** 从进程活动句柄里捞出监听着该端口的那台 http 服务器 —— 模块不导出 server 实例,只能这么拿。
 *  `listen` 是 Server 有而 Socket 没有的方法,用它把被 accept 的连接(localPort 与服务器同号)排掉。 */
const activeServerOn = (port: number): Server | null => {
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() || []
  for (const h of handles) {
    const s = h as Server
    if (typeof s?.listen !== 'function' || typeof s?.address !== 'function') continue
    const a = s.address()
    if (typeof a === 'object' && a && a.port === port) return s
  }
  return null
}

describe('codePreview transpileForServe (按需 JSX/TS 转译)', () => {
  it('transpiles .tsx → ESM,jsx-runtime 自动导入', () => {
    const out = transpileForServe('const A = () => <div className="x">hi</div>; export default A', '.tsx', 'App.tsx')
    expect(out).toContain('react/jsx-runtime') // automatic runtime
    expect(out).not.toContain('<div') // JSX 已转译
    expect(out).toContain('export default A')
  })
  it('strips TS types from .ts', () => {
    const out = transpileForServe('export const n: number = 1', '.ts')
    expect(out).toContain('export const n = 1')
  })
  it('非转译扩展返回 null(原样服务)', () => {
    expect(transpileForServe('body{}', '.css')).toBeNull()
    expect(transpileForServe('<html>', '.html')).toBeNull()
  })
  it('语法错误 → 不抛,返回一段报错 JS(iframe 控制台可见,不白屏)', () => {
    const out = transpileForServe('const = = =', '.tsx', 'bad.tsx')
    expect(out).toContain('console.error')
    expect(out).toContain('transpile error')
  })
})

describe('codePreview resolveSafe (穿越守卫)', () => {
  const root = '/tmp/proj'
  it('serves files inside root', () => {
    expect(resolveSafe(root, '/index.html')).toBe('/tmp/proj/index.html')
    expect(resolveSafe(root, '/sub/app.js')).toBe('/tmp/proj/sub/app.js')
    expect(resolveSafe(root, '/')).toBe('/tmp/proj')
  })
  it('blocks path traversal out of root', () => {
    expect(resolveSafe(root, '/../etc/passwd')).toBeNull()
    expect(resolveSafe(root, '/../../secret')).toBeNull()
    expect(resolveSafe(root, '/sub/../../out')).toBeNull()
  })
  it('rejects NUL and bad encoding', () => {
    expect(resolveSafe(root, '/%00')).toBeNull()
    expect(resolveSafe(root, '/%')).toBeNull() // 非法 URI 编码
  })
})

describe('Forsion Connect 端点在两种根都可达', () => {
  afterAll(() => stopCodePreview())

  it('令牌根(Agent Desk/wsfile/笔记预览)与 Coding Space 主根都供 SDK 与 __forsion 代理', async () => {
    setForsionPreviewHooks({ sdkJs: 'window.__sdk=1', proxy: (_req, res) => { res.end('{"proxied":1}') } })
    const dir = mkdtempSync(join(tmpdir(), 'fc-preview-'))
    writeFileSync(join(dir, 'index.html'), 'hi')

    // 令牌根:普通聊天里 agent 生成的 AI 页面走这条,漏了它 window.forsion 直接 404(tangu-session-9d1fa366)
    const { origin, token } = await servePathRoot(dir)
    const tPort = new URL(origin).port
    const tHost = `${token}.localhost:${tPort}`
    expect((await get(tPort, '/forsion-connect.js', tHost)).body).toContain('__sdk')
    expect((await get(tPort, '/__forsion/config', tHost)).body).toContain('proxied')
    expect((await get(tPort, '/index.html', tHost)).body).toBe('hi') // 正常静态服务不受影响
    expect((await get(tPort, '/forsion-connect.js')).code).toBe(404) // 无有效 token 照旧 404

    // Coding Space 主根(回归:重构抽 helper 后不能丢)
    const { origin: mainOrigin } = await serveDir(dir)
    const mPort = new URL(mainOrigin).port
    expect((await get(mPort, '/forsion-connect.js')).body).toContain('__sdk')
    expect((await get(mPort, '/__forsion/config')).body).toContain('proxied')
  })
})

describe('产物稳定源(令牌持久化 + 粘性端口)', () => {
  // 每个用例自己一台服务器、自己一份持久化;setPreviewPersistence(null) 同时丢掉上一个用例的状态缓存。
  beforeEach(() => { stopCodePreview(); setPreviewPersistence(null) })
  afterAll(() => { stopCodePreview(); setPreviewPersistence(null) })

  const mkdir = (body = 'hi'): string => {
    const dir = mkdtempSync(join(tmpdir(), 'product-preview-'))
    writeFileSync(join(dir, 'index.html'), body)
    return dir
  }
  const hostOf = (r: { origin: string; token: string }): string => `${r.token}.localhost:${new URL(r.origin).port}`
  /** 借一个空闲端口再还回去:拿来当「上次记下的端口」。 */
  const freePort = (): Promise<number> => new Promise((res, rej) => {
    const s = createNetServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const p = typeof a === 'object' && a ? a.port : 0
      s.close(() => res(p))
    })
  })
  /** 记下每次 save 的快照(state 是同一个可变对象,必须深拷)。 */
  const recorder = (initial: PreviewPersistedState | null) => {
    const saves: PreviewPersistedState[] = []
    setPreviewPersistence({ load: () => initial, save: (s) => { saves.push(JSON.parse(JSON.stringify(s))) } })
    return saves
  }

  it('productId 形状不对直接抛(信任边界,不落进 token 表)', async () => {
    await expect(serveProductRoot('', mkdir())).rejects.toThrow()
    await expect(serveProductRoot('bad id!', mkdir())).rejects.toThrow()
    await expect(serveProductRoot('../etc', mkdir())).rejects.toThrow()
    await expect(serveProductRoot('a'.repeat(65), mkdir())).rejects.toThrow()
  })

  it('停掉预览再起,同一产物拿到同一令牌(没装持久化也算)', async () => {
    const dir = mkdir()
    const a = await serveProductRoot('p_stable', dir)
    expect(a.token).toMatch(/^[0-9a-f]{32}$/)
    stopCodePreview()
    const b = await serveProductRoot('p_stable', dir)
    expect(b.token).toBe(a.token)
    expect((await get(new URL(b.origin).port, '/index.html', hostOf(b))).body).toBe('hi')
  })

  it('落盘过的令牌被新一轮 load 复用(换进程 = 换源 的根治)', async () => {
    const token = 'a'.repeat(32)
    recorder({ tokens: { p_load: token } })
    const r = await serveProductRoot('p_load', mkdir())
    expect(r.token).toBe(token)
    expect(r.origin).toBe(`http://${token}.localhost:${new URL(r.origin).port}`)
    expect((await get(new URL(r.origin).port, '/index.html', hostOf(r))).body).toBe('hi')
  })

  it('落盘的令牌形状不对 → 重新发一个并写回', async () => {
    const saves = recorder({ tokens: { p_bad: 'NOT-A-TOKEN' } })
    const r = await serveProductRoot('p_bad', mkdir())
    expect(r.token).toMatch(/^[0-9a-f]{32}$/)
    expect(saves.some((s) => s.tokens?.p_bad === r.token)).toBe(true)
  })

  it('load() 抛了 → 本轮对持久化**只读**,一次 save 都不许发(否则一次读盘失败抹掉全部令牌)', async () => {
    // 盘上本来有端口 + 三个产物的令牌;本次启动读盘失败一次(非法 JSON / EACCES / EMFILE…)。
    const saves: PreviewPersistedState[] = []
    setPreviewPersistence({
      load: () => { throw new Error('load boom') },
      save: (s) => { saves.push(JSON.parse(JSON.stringify(s))) },
    })
    // ① 随便开个普通预览就会走到端口写回 —— 连产物都不用碰,盘上就能只剩 {"port":N}。
    const plain = await servePathRoot(mkdir())
    expect(plain.token).toMatch(/^[0-9a-f]{32}$/)
    expect(saves).toHaveLength(0)
    // ② 发新产物令牌是第二个写回点。
    const r = await serveProductRoot('p_throw', mkdir())
    expect(r.token).toMatch(/^[0-9a-f]{32}$/)
    expect(saves).toHaveLength(0)
    // 只读归只读,预览本身照常(退化成今天的随机源)。
    expect((await get(new URL(r.origin).port, '/index.html', hostOf(r))).body).toBe('hi')
  })

  it('save() 抛不影响预览;load() 返回 null 是「还没有这个文件」,照常写回(不是失败)', async () => {
    let saved = 0
    setPreviewPersistence({ load: () => null, save: () => { saved++; throw new Error('save boom') } })
    const r = await serveProductRoot('p_fresh', mkdir())
    expect(r.token).toMatch(/^[0-9a-f]{32}$/)
    expect(saved).toBeGreaterThan(0) // null ≠ 读盘失败,新装的机器必须能写下第一份
    expect((await get(new URL(r.origin).port, '/index.html', hostOf(r))).body).toBe('hi')
  })

  it('load() 正常 → 新令牌是**追加**,盘上原有的 A/B/C 一个不少', async () => {
    const [a, b, c] = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)]
    const saves = recorder({ port: 1, tokens: { p_aaa: a, p_bbb: b, p_ccc: c } })
    const r = await serveProductRoot('p_new', mkdir())
    expect(saves.length).toBeGreaterThan(0)
    const last = saves[saves.length - 1]
    expect(last.tokens).toMatchObject({ p_aaa: a, p_bbb: b, p_ccc: c })
    expect(last.tokens?.p_new).toBe(r.token)
  })

  it('落盘的 tokens 是数组(文件被改坏)→ 当没有,并换成正经对象写回', async () => {
    // typeof [] === 'object' 能过闸,但往数组上写字符串键会被 JSON.stringify 原样丢掉 →
    // 盘上永远是 [],每次启动都换源,不报错不崩溃。recorder 的快照正好走一趟 JSON 往返,能照出来。
    const saves = recorder({ tokens: [] as unknown as Record<string, string> })
    const r = await serveProductRoot('p_arr', mkdir())
    expect(r.token).toMatch(/^[0-9a-f]{32}$/)
    const last = saves[saves.length - 1]
    expect(Array.isArray(last.tokens)).toBe(false)
    expect(last.tokens?.p_arr).toBe(r.token)
  })

  it('原型链保留字当 productId 一律拒(写进去是静默 no-op → 该产物每次都换源)', async () => {
    await expect(serveProductRoot('__proto__', mkdir())).rejects.toThrow()
    await expect(serveProductRoot('constructor', mkdir())).rejects.toThrow()
    await expect(serveProductRoot('prototype', mkdir())).rejects.toThrow()
  })

  it('碰撞守卫:stop 之后靠 pinnedTokens 也要认出「这令牌另一个产物占着」', async () => {
    // dup 那条用例里老令牌同时躺在 tokenToRoot 里,光靠 tokenToRoot 就过了 —— 测不到 pinned 这一项。
    // 而它唯一起作用的时机正是 stopCodePreview() 之后:tokenToRoot 清空、钉死集保留。
    const shared = 'd'.repeat(32)
    recorder({ tokens: { p_pin1: shared, p_pin2: shared } })
    const dirA = mkdir()
    const a = await serveProductRoot('p_pin1', dirA)
    expect(a.token).toBe(shared)
    stopCodePreview()
    const b = await serveProductRoot('p_pin2', mkdir('other'))
    expect(b.token).not.toBe(shared)
    // 两个产物各服务各的目录才算隔离住(共源 = 互相读得到对方的 localStorage)。
    const a2 = await serveProductRoot('p_pin1', dirA)
    expect(a2.token).toBe(shared)
    const port = new URL(b.origin).port
    expect((await get(port, '/index.html', hostOf(b))).body).toBe('other')
    expect((await get(port, '/index.html', hostOf(a2))).body).toBe('hi')
  })

  it('listen 成功后两种根都留着常驻 error 兜底(晚到的 server error 不许变成主进程 uncaughtException)', async () => {
    const dir = mkdir()
    const tokenRoot = await servePathRoot(dir)
    const mainRoot = await serveDir(dir)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {}) // 兜底会打日志,别刷屏;顺便断言它真打了
    try {
      for (const [label, origin] of [['令牌根', tokenRoot.origin], ['主根', mainRoot.origin]] as const) {
        const srv = activeServerOn(Number(new URL(origin).port))
        expect(srv, label).toBeTruthy()
        // 监听数归零时 emit('error') 会被 EventEmitter 直接 throw 出去 = 主进程 uncaughtException。
        expect(srv!.listenerCount('error'), label).toBeGreaterThan(0)
        expect(() => srv!.emit('error', new Error('late boom')), label).not.toThrow()
      }
      expect(logged).toHaveBeenCalledTimes(2)
    } finally { logged.mockRestore() }
  })

  it('两个产物绝不共用令牌(落盘文件里抄成同一串也不行)', async () => {
    const dup = 'b'.repeat(32)
    recorder({ tokens: { p_dup1: dup, p_dup2: dup } })
    const a = await serveProductRoot('p_dup1', mkdir())
    const b = await serveProductRoot('p_dup2', mkdir('other'))
    expect(a.token).toBe(dup)
    expect(b.token).not.toBe(dup)
    // 共源就意味着能读到对方的 localStorage —— 各自只服务自己的目录才算隔离住了。
    expect((await get(new URL(b.origin).port, '/index.html', hostOf(b))).body).toBe('other')
    expect((await get(new URL(a.origin).port, '/index.html', hostOf(a))).body).toBe('hi')
  })

  it('粘性端口:空闲就复用;被占则退回随机口并记下新端口', async () => {
    const want = await freePort()
    let state: PreviewPersistedState = { port: want }
    setPreviewPersistence({ load: () => state, save: (s) => { state = JSON.parse(JSON.stringify(s)) } })

    const a = await serveProductRoot('p_port', mkdir())
    expect(new URL(a.origin).port).toBe(String(want)) // 复用成功 → 源一字不差

    stopCodePreview()
    const squatter = createNetServer()
    await new Promise<void>((r, j) => { squatter.once('error', j); squatter.listen(want, '127.0.0.1', () => r()) })
    try {
      const b = await serveProductRoot('p_port', mkdir())
      expect(new URL(b.origin).port).not.toBe(String(want)) // EADDRINUSE → listen(0)
      expect(state.port).toBe(Number(new URL(b.origin).port)) // 且记下来,下次从新端口开始粘
      expect(b.token).toBe(a.token) // 端口换了令牌不换
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()))
    }
  })

  it('产物令牌不参与 LRU:发满 TOKEN_CAP 个路径令牌也挤不掉它', async () => {
    const r = await serveProductRoot('p_pin', mkdir())
    for (let i = 0; i < TOKEN_CAP + 8; i++) previewToken(join(tmpdir(), `lru-fill-${i}`))
    expect((await get(new URL(r.origin).port, '/index.html', hostOf(r))).body).toBe('hi') // 还在服务 = 没被淘汰
  })

  it('同目录的 servePathRoot 落到产物令牌上(编辑态预览与启动后同源)', async () => {
    const dir = mkdir()
    const p = await serveProductRoot('p_same', dir)
    const s = await servePathRoot(dir)
    expect(s.token).toBe(p.token)
    expect(s.origin).toBe(p.origin)
  })

  it('项目被挪走/改名:令牌不变,只改指向(源不变 = 产物数据不丢)', async () => {
    const before = mkdir('before')
    const after = mkdir('after')
    const a = await serveProductRoot('p_move', before)
    const b = await serveProductRoot('p_move', after)
    expect(b.token).toBe(a.token)
    expect((await get(new URL(b.origin).port, '/index.html', hostOf(b))).body).toBe('after')
    // 旧目录的 rootToToken 也跟着走,别留一条指向新内容的僵尸映射
    const stale = await servePathRoot(before)
    expect(stale.token).not.toBe(a.token)
  })
})
