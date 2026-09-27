/**
 * unitWeb /engine 允许清单 × **引擎真 Express** 的差分回归(评审 A-desktop#0 / #2)。
 *
 * unitWeb.test.ts 的假引擎是裸 http.createServer,只能证明「匹配器自洽」;匹配器和 Express(parseurl +
 * path-to-regexp)对同一串理解不同的口子它永远绿 —— 09-27 评审就用原始 `#` 从局域网配对入口打穿了三条
 * deny 路由(Muse TODO 注入 / 收件箱系统投递 / 建团队)。这里把 ENGINE_ROUTES 的**每一行**按引擎的挂法
 * (app.use('/', router),路由写全路径;express 取 tangu-agent/node_modules 里引擎自己那份)注册到真 Express
 * 上,deny 行**先注册**(最坏情形:能同时命中的请求都先落到 deny 处理器),再对每条 deny 行做变体 fuzz:
 * 片段 / 尾缀 / 大小写 / 编码 / 空白,以及「把 `#` 或 NBSP 塞进某条 allow 行的参数段」的定向构造
 * (deny 行 × 同方法 allow 行的全量枚举)。
 *
 * 断言:经 unitWeb(局域网配对令牌 = lan 入口)发出的任何变体都**到不了** deny 处理器。
 * 非空性:同一批变体直接打 Express,deny 处理器确实被打中(每条 deny 行的「规范形态 + #x」都命中)——
 * 证明 fuzz 真的在测路由,不是全部 404。
 * 跑法:npx vitest run electron/unitWebExpress.test.ts
 */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { startUnitWeb, type UnitWebDeps } from './unitWeb'
import { ENGINE_ROUTES, type EngineRoute } from './engineRoutes.generated'

const require = createRequire(import.meta.url)
// 引擎自己的 express(版本 / parseurl / path-to-regexp 与线上引擎逐字相同)。缺了就是环境没装好 —— 直接红,不跳过。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('../../tangu-agent/node_modules/express') as any

type Hit = { row: string; via: string | undefined; url: string }

async function engineLikeExpress(): Promise<{ port: number; hits: Hit[]; allowHits: Hit[]; close: () => void }> {
  const hits: Hit[] = []
  const allowHits: Hit[] = []
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  const denyRouter = express.Router()
  const allowRouter = express.Router()
  for (const r of ENGINE_ROUTES) {
    const key = `${r.method} ${r.path}`
    const target = r.access === 'allow' ? allowRouter : denyRouter
    const sink = r.access === 'allow' ? allowHits : hits
    target[r.method.toLowerCase()](r.path, (req: http.IncomingMessage & { originalUrl: string }, res: any) => {
      sink.push({ row: key, via: req.headers['x-forsion-remote'] as string | undefined, url: req.originalUrl })
      res.status(200).json({ row: key })
    })
  }
  app.use('/', denyRouter) // 先 deny:能同时命中的请求一律先落 deny,最坏情形
  app.use('/', allowRouter)
  const server: http.Server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  return { port: (server.address() as AddressInfo).port, hits, allowHits, close: () => server.close() }
}

/** 原始字节发请求(不经 fetch / http.request 的规整与校验:`#`、NBSP 原样上线)。回状态码;-1 = 超时。 */
function rawStatus(port: number, method: string, target: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    let buf = ''
    const done = (code: number): void => { clearTimeout(t); sock.destroy(); resolve(code) }
    const t = setTimeout(() => done(-1), 5000)
    sock.on('data', (d) => { buf += d.toString('latin1'); const m = /^HTTP\/1\.1 (\d{3})/.exec(buf); if (m && buf.includes('\r\n\r\n')) done(Number(m[1])) })
    sock.on('error', () => done(0))
    sock.on('close', () => { const m = /^HTTP\/1\.1 (\d{3})/.exec(buf); done(m ? Number(m[1]) : 0) })
    const h = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')
    sock.write(Buffer.from(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n${h}Content-Length: 0\r\nConnection: close\r\n\r\n`, 'latin1'))
  })
}

const isParam = (s: string): boolean => s.startsWith(':')
const segsOf = (p: string): string[] => p.split('/').filter(Boolean)
const fill = (segs: string[]): string[] => segs.map((s) => (isParam(s) ? 'v1' : s))

/**
 * 定向构造:让 `#` / NBSP 落在 allow 行 A 的某个参数段里,而 Express 截断 / trim 之后恰好是 deny 行 P。
 * 形态一(m ≥ n):A[n-1] 是参数,取值 = P 第 n 段 + 标记,其后段按 A 填;
 * 形态二(m > n):P 的 n 段全对上 A,A[n] 是参数,取值 = 标记开头;Express 看到 `P/`(strict 关 = P)。
 * NBSP 只有在串尾才会被 url.parse trim 掉 → 只做「标记即串尾」的那几种。
 */
function smuggleTargets(p: EngineRoute, allowRows: EngineRoute[]): string[] {
  const P = segsOf(p.path)
  const n = P.length
  const out = new Set<string>()
  for (const a of allowRows) {
    const A = segsOf(a.path)
    const m = A.length
    if (m < n) continue
    // 前 n-1 段(形态一)/ 前 n 段(形态二)要两边都对得上;取值规则:谁是字面量就用谁。
    const pick = (i: number): string | null => {
      const pi = P[i]
      const ai = A[i]
      if (!isParam(pi) && !isParam(ai)) return pi.toLowerCase() === ai.toLowerCase() ? pi : null
      if (!isParam(pi)) return pi
      if (!isParam(ai)) return ai
      return 'v1'
    }
    const head: string[] = []
    let ok = true
    for (let i = 0; i < n - 1; i++) { const v = pick(i); if (v === null) { ok = false; break } head.push(v) }
    if (!ok) continue
    const last = isParam(P[n - 1]) ? 'v1' : P[n - 1]
    const tail = (from: number): string[] => fill(A.slice(from))
    if (isParam(A[n - 1])) {
      out.add('/' + [...head, last + '#', ...tail(n)].join('/'))
      out.add('/' + [...head, last + '#x', ...tail(n)].join('/'))
      if (m === n) out.add('/' + [...head, last + '\u00a0'].join('/'))
    }
    const vLast = pick(n - 1)
    if (m > n && vLast !== null && isParam(A[n])) {
      out.add('/' + [...head, vLast, '#', ...tail(n + 1)].join('/'))
      if (m === n + 1) out.add('/' + [...head, vLast, '\u00a0'].join('/'))
    }
  }
  return [...out]
}

/** 与方法无关的通用变体:片段 / 尾缀 / 大小写 / 编码 / 空白。 */
function genericVariants(concrete: string): string[] {
  const segs = concrete.split('/')
  const mixed = segs.map((s, i) => (i % 2 ? s.toUpperCase() : s)).join('/')
  const encLetter = concrete.replace(/\/([a-z])/, (_m, c: string) => `/%${c.charCodeAt(0).toString(16)}`)
  return [
    concrete,
    concrete + '/',
    concrete + '//',
    concrete.toUpperCase(),
    mixed,
    concrete.replace(/\//g, '//'),
    concrete + '#',
    concrete + '#x',
    concrete + '#/x/y',
    concrete + '/#',
    concrete + '?a=1#x',
    concrete + '#?a=1',
    concrete + '%23x',
    concrete + ';x',
    concrete + '/.',
    concrete + '/..',
    concrete + '/%2e',
    concrete + '%2Fx',
    concrete + '\u00a0',
    concrete + '/\u00a0',
    concrete + '\t',
    concrete + '\\',
    encLetter,
    concrete.replace(/\//g, '%2F'),
  ]
}

describe('unitWeb /engine × 引擎真 Express:deny 行的一切变体都到不了 deny 处理器', () => {
  it('fuzz 全部 deny 行(片段 / 尾缀 / 大小写 / 编码 / 空白 + deny×allow 定向构造)', async () => {
    const eng = await engineLikeExpress()
    const token = 'lan-device-token'
    const deps: UnitWebDeps = {
      getEngine: () => ({ url: `http://127.0.0.1:${eng.port}`, token: 'ENGINE_TOKEN', remoteMark: 'REMOTE_MARK' }),
      confirmPair: async () => false,
      pairedDevices: { list: () => [{ id: 'd1', name: 'lan', tokenHash: createHash('sha256').update(token).digest('hex'), createdAt: 0 }], add: async () => {} },
      readPlugins: async () => [],
      readSpaces: async () => [],
      readConfig: async () => ({}),
      writeConfig: async () => ({}),
      readProviders: async () => [],
      readHostFile: async () => null,
      readHostDir: async () => null,
      readHostStat: async () => null,
      meta: { instanceId: 'i', name: 'n', version: '0' },
      webDistDir: () => null,
      vault: () => null,
      log: () => {},
    }
    const web = await startUnitWeb(deps, { port: 0, bindHost: '127.0.0.1' })
    try {
      const deny = ENGINE_ROUTES.filter((r) => r.access !== 'allow')
      const allow = ENGINE_ROUTES.filter((r) => r.access === 'allow')
      expect(deny.length).toBeGreaterThan(50) // 表没被清空(清空会让本测试空转变绿)
      const cases: Array<{ method: string; target: string; row: string; kind: 'generic' | 'smuggle' }> = []
      for (const p of deny) {
        const concrete = '/' + fill(segsOf(p.path)).join('/')
        const methods = p.method === 'GET' ? ['GET', 'HEAD'] : [p.method]
        const sameMethodAllow = allow.filter((a) => a.method === p.method)
        for (const method of methods) {
          for (const t of genericVariants(concrete)) cases.push({ method, target: t, row: `${p.method} ${p.path}`, kind: 'generic' })
          for (const t of smuggleTargets(p, sameMethodAllow)) cases.push({ method, target: t, row: `${p.method} ${p.path}`, kind: 'smuggle' })
        }
      }
      const smuggles = cases.filter((c) => c.kind === 'smuggle')
      // 评审点名的三条 deny 路由都有针对它们的定向构造(枚举没有漏掉它们)
      for (const row of ['POST /agent/special/muse/todos/inject', 'POST /agent/inbox', 'POST /agent/teams']) {
        expect(smuggles.some((c) => c.row === row), row).toBe(true)
      }

      const auth = { Authorization: `Bearer ${token}` }
      const run = async <T>(items: T[], fn: (x: T) => Promise<void>): Promise<void> => {
        for (let i = 0; i < items.length; i += 64) await Promise.all(items.slice(i, i + 64).map(fn))
      }

      // ① 经 unitWeb(lan 入口):一条都不许到 deny 处理器;带 `#` / NBSP 的一律 400 BAD_PATH。
      const viaStatus = new Map<string, number>()
      await run(cases, async (c) => {
        viaStatus.set(`${c.method} ${c.target}`, await rawStatus(web.port, c.method, '/engine' + c.target, auth))
      })
      const leaked = eng.hits.filter((h) => h.via !== undefined)
      expect(leaked, JSON.stringify(leaked.slice(0, 10))).toEqual([])
      for (const c of cases) {
        const st = viaStatus.get(`${c.method} ${c.target}`)!
        // 被放行的(命中 allow 行的参数段)照常转给引擎,落 allow 处理器或 404 —— 只要不是 deny 就行,上面已钉
        if (/[#\u00a0\t\\]/.test(c.target)) expect(st, `${c.method} ${JSON.stringify(c.target)}`).toBe(400)
        else expect(st, `${c.method} ${JSON.stringify(c.target)}`).not.toBe(-1)
      }

      // ② 非空性:同一批变体直接打 Express(不经 unitWeb),deny 处理器确实被打中。
      eng.hits.length = 0
      const directReach = new Set<string>()
      await run(cases, async (c) => {
        const before = eng.hits.length
        const st = await rawStatus(eng.port, c.method, c.target)
        if (st === 200 && eng.hits.length > before) directReach.add(`${c.kind}|${c.method} ${c.target}`)
      })
      for (const p of deny) {
        const concrete = '/' + fill(segsOf(p.path)).join('/')
        expect(directReach.has(`generic|${p.method} ${concrete}#x`), `${p.method} ${concrete}#x 直打 Express 应命中 deny`).toBe(true)
      }
      // 定向构造同样真能打中 deny(它们正是 09-27 评审复现的那一类)
      expect([...directReach].filter((k) => k.startsWith('smuggle|')).length).toBeGreaterThanOrEqual(3)

      // ③ 反向健全:allow 行的规范形态经 unitWeb 确实转到引擎(代理没坏,① 不是因为全链不通才绿)。
      let allowOk = 0
      for (const a of allow.filter((x) => x.method === 'GET').slice(0, 10)) {
        const st = await rawStatus(web.port, 'GET', '/engine/' + fill(segsOf(a.path)).join('/'), auth)
        if (st === 200) allowOk++
      }
      expect(allowOk).toBeGreaterThan(0)
      expect(eng.allowHits.some((h) => h.via === 'lan')).toBe(true)
    } finally {
      await web.close()
      eng.close()
    }
  }, 60_000)
})
