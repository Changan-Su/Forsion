/**
 * 移动端「云端库点笔记 → 当前库里没有这篇笔记」e2e —— `npm run e2e:cloudnote`(mobile 目录,先 npm run build)。
 *
 * 起因(2026-11-09 用户实报):手机上云端库(Cloud工作区 + 别的设备同步来的库分区)很多笔记点进去显示
 * 「当前库里没有这篇笔记」,过一会儿又好了。服务端逐篇 GET 全是 200,生产访问日志里那几下请求根本没到 ——
 * 手机这边网络失败。编辑器把读出错(`.catch(() => null)`)当成了「没有这个文件」;只有这一面名单里有这篇时才改判
 * 「加载失败 + 重试」。修法(amadeus/unified/router.ts readVerdict):读出错一律判读不出,判定由 router.test.ts 钉住。
 * ⚠️ 这台仪器**没能**在界面上逼出用户那一屏(要「读出错」+「名单里没有」同时成立,冷启动时手机不会自动回到上一篇)——
 * 它钉的是回归:限流 / 断网时点笔记都不许出「当前库里没有这篇笔记」,点开笔记不往云端写任何东西。
 *
 * 假云端库(判据镜像 server 的 amadeus 模块,同 e2e:plugins 的 startFakeCloud)+ 开关:
 * limit.file / limit.tree = 回 429(与生产 express-rate-limit 回包同形);limit.net = 页面路由 abort(请求到不了服务端)。
 *
 * 场景:
 *  A. 不限流:抽屉里点根上的笔记 / 同步库分区里的笔记 → 编辑器装入正文。
 *  B. 限流中点一篇:不显示「当前库里没有这篇笔记」;限流过去后能读出正文(自动或点重试)。
 *  C. 断网冷启动:不显示「当前库里没有这篇笔记」。已知另一件事(未修,只打 INFO):断网冷启动时整个云端库打不开,
 *     网络回来也不会自己重开。
 *
 * 种子:缺省是内置的几篇;CLOUD_SEED=<json>(`{ path: { kind, content } }`)可换成真实库的导出,只在本机用,别进仓库。
 */
const os = require('os')
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { startPreview } = require('./lib/preview.cjs')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 借 desktop 的 */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

const SHOTS = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'e2e-cloudnote')
const NEGATIVE = process.env.E2E_NEGATIVE === '1'

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) { const e = path.join(root, d, rel); if (fs.existsSync(e)) return e }
  }
  for (const exe of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(exe)) return exe
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE')
}

const BUILTIN_SEED = {
  '根上笔记.md': { kind: 'page', content: '# 根上笔记\n\n根上笔记的正文。\n' },
  'Fiary/20260719.md': { kind: 'page', content: '日记正文 0719。\n' },
  'WMOSv11/.forsion-vault.md': { kind: 'page', content: '---\ndevices: []\n---\n' },
  'WMOSv11/MOC-Forsion.fd/Forsion-2.14.md': { kind: 'page', content: '# Forsion 2.14\n\n别的设备同步来的笔记。\n' },
  'WMOSv11/同步来的.md': { kind: 'page', content: '同步来的正文。\n' },
}

/** 假云端库 + 限流开关。limit = { file: bool, tree: bool }。 */
function startFakeCloud(seed) {
  const rows = new Map()
  let changeSeq = 0
  const limit = { file: false, tree: false, net: false } // net = 断网:请求根本到不了服务端(由页面路由 abort)
  const hits = { file429: 0, tree429: 0, file200: 0 }
  const kindOf = (p) => (/\.md$/i.test(p) ? 'page' : /\.db$/i.test(p) ? 'db' : 'binary')
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
  for (const [p, v] of Object.entries(seed)) {
    rows.set(p, { kind: v.kind || kindOf(p), body: Buffer.from(v.content == null ? 'x' : String(v.content), 'utf8'), seq: 1 })
  }
  const srv = http.createServer(async (req, res) => {
    const json = (status, body, headers) => { res.writeHead(status, { 'content-type': 'application/json', ...(headers || {}) }); res.end(JSON.stringify(body)) }
    // 生产 express-rate-limit(draft-7)回包同形
    const limited = () => json(429, { detail: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED' }, { ratelimit: 'limit=200, remaining=0, reset=20', 'ratelimit-policy': '200;w=60' })
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const raw = Buffer.concat(chunks)
      const u = new URL(req.url, 'http://fake')
      if (u.pathname === '/api/amadeus/vaults') return json(200, { vaults: [{ id: 'default', name: 'My Vault', lastChangeSeq: changeSeq, sizeBytes: 0, createdAt: '2026-10-01T00:00:00Z', role: 'owner' }] })
      const m = /^\/api\/amadeus\/vaults\/default\/([a-z-]+)$/.exec(u.pathname)
      const q = (k) => u.searchParams.get(k) || ''
      switch (m ? `${req.method} ${m[1]}` : '') {
        case 'GET tree': {
          if (limit.tree) { hits.tree429++; return limited() }
          const entries = [...rows].map(([p, r]) => ({ path: p, kind: r.kind, seq: r.seq, hash: sha(r.body), size: r.body.length }))
          const folders = new Set()
          for (const e of entries) for (let d = path.posix.dirname(e.path); d !== '.'; d = path.posix.dirname(d)) folders.add(d)
          return json(200, {
            pages: entries.filter((e) => e.kind === 'page').map((e) => e.path),
            files: entries.filter((e) => e.kind !== 'page').map((e) => ({ path: e.path, size: e.size })),
            folders: [...folders], entries, seq: changeSeq, maxFileBytes: 5 * 1024 * 1024,
          })
        }
        case 'GET file': {
          if (limit.file) { hits.file429++; return limited() }
          const r = rows.get(q('path'))
          if (!r) return json(404, { detail: 'file not found' })
          if (r.kind === 'binary') return json(400, { code: 'BINARY', detail: 'binary file: use GET /vaults/:v/asset' })
          hits.file200++
          return json(200, { path: q('path'), kind: r.kind, content: r.body.toString('utf8'), seq: r.seq, hash: sha(r.body), updatedAt: '2026-10-01T00:00:00Z' })
        }
        case 'PUT file': {
          // 这台仪器只读:任何写都记下来(点开笔记不该写云端)。
          const b = JSON.parse(raw.toString('utf8') || '{}')
          hits.writes = (hits.writes || []).concat(String(b.path))
          const cur = rows.get(b.path)
          if (Number(b.baseSeq) === 0 && cur) return json(409, { code: 'EXISTS', seq: cur.seq, content: cur.body.toString('utf8') })
          const body = Buffer.from(String(b.content ?? ''), 'utf8')
          const seq = (cur?.seq ?? 0) + 1
          rows.set(b.path, { kind: kindOf(b.path), body, seq }); changeSeq++
          return json(200, { seq, hash: sha(body) })
        }
        default:
          return json(404, { detail: 'not found' })
      }
    } catch (e) {
      json(500, { detail: String(e && e.message ? e.message : e) })
    }
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    origin: `http://127.0.0.1:${srv.address().port}`, limit, hits,
    close: () => { srv.closeAllConnections(); srv.close() },
  })))
}

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }
  fs.mkdirSync(SHOTS, { recursive: true })
  const seed = process.env.CLOUD_SEED ? JSON.parse(fs.readFileSync(process.env.CLOUD_SEED, 'utf8')) : BUILTIN_SEED
  const pagesInSeed = Object.keys(seed).filter((p) => /\.md$/i.test(p) && !p.split('/').some((s) => s.startsWith('.')))
  const fake = await startFakeCloud(seed)
  const preview = await startPreview(root)

  let browser = null
  const fails = []
  const pass = (n, x) => console.log(`PASS  ${n}${x ? `  | ${x}` : ''}`)
  const fail = (n, x) => { fails.push(n); console.log(`FAIL  ${n}${x ? `  | ${x}` : ''}`) }
  const check = (ok, n, x) => (ok ? pass(n, x) : fail(n, x))
  try {
    await preview.ready()
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'zh-CN' })
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('forsion_token', 'e2e-cloudnote')
        localStorage.setItem('amadeus_vault_mode', 'cloud')
      } catch { /* ignore */ }
    })
    const page = await ctx.newPage()
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    await page.route('**/api/amadeus/**', (r) => {
      const u = new URL(r.request().url())
      if (/\/events$/.test(u.pathname)) return r.abort() // SSE:假云端不实现
      if (fake.limit.net) { fake.hits.netDropped = (fake.hits.netDropped || 0) + 1; return r.abort('internetdisconnected') }
      return r.continue({ url: `${fake.origin}/api/amadeus${u.pathname.replace(/^.*?\/api\/amadeus/, '')}${u.search}` })
    })
    const cdp = await ctx.newCDPSession(page)
    const tapBox = async (b) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
      await new Promise((r) => setTimeout(r, 60))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(400)
    }
    const tap = async (locator) => {
      await locator.first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
      const b = await locator.first().boundingBox({ timeout: 5000 })
      if (!b) throw new Error('目标不可见')
      await tapBox(b)
    }
    const drawerOpen = async () => {
      if (await page.$('.mb-drawer--left.open')) return
      await tap(page.locator('.mb-topbar .mb-icon-btn'))
      await page.waitForTimeout(600)
    }
    const enterAmadeus = async () => {
      await drawerOpen()
      const tabs = await page.$$eval('.mb-drawer-foot .mb-tab', (els) => els.map((e) => e.dataset.space || ''))
      const idx = tabs.indexOf('amadeus')
      if (idx < 0) throw new Error(`左抽屉底部没有 Amadeus space tab(现有: ${tabs.join(',')})`)
      await tap(page.locator(`.mb-drawer-foot .mb-tab >> nth=${idx}`))
      await page.waitForTimeout(1200)
    }
    /** 主区现在显示什么:missing / unreadable / 正文里含 needle / 其他。 */
    const mainState = (needle) => page.evaluate((needle) => {
      const txt = (document.querySelector('.mb-main')?.innerText || document.body.innerText || '')
      if (/当前库里没有这篇笔记/.test(txt)) return 'missing'
      if (needle && txt.includes(needle)) return 'content'
      if (/加载失败|读不出|重试/.test(txt)) return 'unreadable'
      return 'other:' + txt.replace(/\s+/g, ' ').slice(0, 80)
    }, needle)
    const waitState = async (needle, want, ms = 6000) => {
      let s = ''
      for (let t = 0; t < ms; t += 250) { s = await mainState(needle); if (want.includes(s)) return s; await page.waitForTimeout(250) }
      return s
    }
    /** 树上点开一篇:笔记行 = `.t2s-srow[data-sel-id=<完整路径>]`;不在就逐级展开祖先文件夹行(`.t2s-folder-row`)。
     *  同步库分区(WMOSv11 这种)是分区头、缺省展开,它下面的文件夹行不带分区名。 */
    const openFromTree = async (p) => {
      await drawerOpen()
      const row = page.locator(`.mb-drawer--left .t2s-srow[data-sel-id="${p.replace(/"/g, '\\"')}"]`)
      const segs = p.split('/')
      for (let i = 0; i < segs.length - 1 && !(await row.count()); i++) {
        const folder = page.locator('.mb-drawer--left .t2s-folder-row', { has: page.locator('.t2s-group-label', { hasText: new RegExp(`^${segs[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
        if (await folder.count()) { await tap(folder); await page.waitForTimeout(500) }
      }
      const there = await row.first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)
      if (!there) throw new Error(`树上没有笔记行「${p}」`)
      await tap(row)
      await page.waitForTimeout(900)
    }
    const firstLine = (p) => String(seed[p].content || '').replace(/^---[\s\S]*?\n---\n/, '').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l.length >= 2 && !/^[!\[<|`>-]/.test(l)) || ''
    const needleOf = (p) => firstLine(p).slice(0, 12)

    await page.goto(preview.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(4000)
    await enterAmadeus()
    // ---- A. 不限流 ----
    const sample = (process.env.CLOUD_SEED ? pagesInSeed.filter((p) => needleOf(p)).slice(0, Number(process.env.SAMPLE || 6)) : ['根上笔记.md', 'WMOSv11/同步来的.md'])
    for (const p of sample) {
      try { await openFromTree(p) } catch (e) { fail(`A 打开 ${p}`, e.message); continue }
      const s = await waitState(needleOf(p), ['content', 'missing'])
      check(s === 'content', `A 不限流:${p} 正文装入`, s)
    }

    // ---- B. 限流中点一篇 ----
    const target = process.env.CLOUD_SEED ? pagesInSeed.filter((p) => needleOf(p) && !sample.includes(p))[0] : 'Fiary/20260719.md'
    fake.limit.file = !NEGATIVE
    try {
      await openFromTree(target)
      const s = await waitState(needleOf(target), ['missing', 'content', 'unreadable'], 4000)
      await page.screenshot({ path: path.join(SHOTS, 'b-limited.png') })
      check(s !== 'missing', `B 限流中点 ${target}:不显示「当前库里没有这篇笔记」`, `${s} · 429×${fake.hits.file429}`)
      fake.limit.file = false
      // 限流过去:自动重试或点「重试」后读出正文
      let s2 = await waitState(needleOf(target), ['content'], 8000)
      if (s2 !== 'content') {
        const retry = page.locator('.mb-main button', { hasText: /重试/ })
        if (await retry.count()) { await tap(retry); s2 = await waitState(needleOf(target), ['content'], 6000) }
      }
      check(s2 === 'content', `B 限流过去后 ${target} 正文装入`, s2)
    } catch (e) { fail(`B ${target}`, e.message) } finally { fake.limit.file = false }

    // ---- C. 断网(请求到不了服务端,服务器日志里也看不到;2026-11-09 用户实报那次就是这样)----
    // 开着一篇 → 断网冷启动 → 进笔记 Space(会回到上次那篇)→ 再从树上点它。任何时候都不许出「当前库里没有这篇笔记」;
    // 网络回来后点重试 / 重点一次能读出。
    const target2 = process.env.CLOUD_SEED ? pagesInSeed.filter((p) => needleOf(p) && !sample.includes(p) && p !== target)[0] : 'WMOSv11/MOC-Forsion.fd/Forsion-2.14.md'
    try {
      await openFromTree(target2)
      await waitState(needleOf(target2), ['content'], 6000)
      fake.limit.net = !NEGATIVE
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(4500)
      await enterAmadeus()
      const s0 = await waitState(needleOf(target2), ['missing'], 4000)
      await page.screenshot({ path: path.join(SHOTS, 'c-offline-restore.png') })
      check(s0 !== 'missing', 'C 断网冷启动进笔记:不显示「当前库里没有这篇笔记」', `${s0} · 断掉的请求×${fake.hits.netDropped || 0}`)
      const rowThere = await page.locator(`.mb-drawer--left .t2s-srow[data-sel-id="${target2}"]`).count()
      if (rowThere || await page.locator('.mb-drawer--left .t2s-folder-row').count()) {
        try {
          await openFromTree(target2)
          const s1 = await waitState(needleOf(target2), ['missing'], 4000)
          await page.screenshot({ path: path.join(SHOTS, 'c-offline-tap.png') })
          check(s1 !== 'missing', `C 断网时从树上点 ${target2}:不显示「当前库里没有这篇笔记」`, s1)
        } catch (e) { console.log(`(C 断网时树上点不到 ${target2}: ${e.message})`) }
      } else console.log('(C 断网冷启动树是空的,跳过树上点)')
      fake.limit.net = false
      let s2 = await waitState(needleOf(target2), ['content'], 4000)
      for (let i = 0; i < 2 && s2 !== 'content'; i++) {
        const retry = page.locator('.mb-main button', { hasText: /重试/ })
        if (await retry.count()) await tap(retry)
        else { await enterAmadeus().catch(() => {}); await openFromTree(target2).catch(() => {}) }
        s2 = await waitState(needleOf(target2), ['content'], 6000)
      }
      // 已知另一件事(2026-11-09 记,未修):断网冷启动时整个云端库没打开,网络回来也不会自己重开 —— 只记录,不判红。
      console.log(`INFO  C 网络回来后 ${target2}: ${s2 === 'content' ? '正文装入' : '没恢复(已知:断网冷启动库不自动重开)'}`)
    } catch (e) { fail(`C ${target2}`, e.message) } finally { fake.limit.net = false }

    check(!(fake.hits.writes || []).length, '点开笔记没有往云端写任何文件', (fake.hits.writes || []).join(', '))
    if (pageErrors.length) console.log('页面异常:', pageErrors.slice(0, 5).join(' | '))
  } catch (e) {
    fail('台架', String(e && e.message || e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    preview.kill()
    fake.close()
  }
  console.log(`截图: ${SHOTS}`)
  if (fails.length) { console.error(`❌ e2e:cloudnote${NEGATIVE ? '(负对照)' : ''} ${fails.length} 项失败`); process.exit(1) }
  console.log(`✅ e2e:cloudnote${NEGATIVE ? '(负对照)' : ''} —— 云端库点笔记:限流中不判「没有这篇」,过后能读出`)
}

main()
