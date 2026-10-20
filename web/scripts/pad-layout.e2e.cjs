/** Pad(平板横屏 / 横屏手机)版式回归闸 —— `cd web && npm run e2e:pad`(先 npm run build 一次,备好白板 / 字体资源)。
 *
 * 真 web 源码的 vite dev 服务 + 夹具 API(不连账号、不连引擎),触屏视口 + ?ui=mobile = 手机壳。
 * 安卓壳的底栏是原生画的、在 WebView 外:这里在页面里装同一个引擎接缝(installNativeChromeHost spaces:true),
 * 点底栏的一格 = dispatchNativeChromeSpace(NativeChromePlugin 的 action 回调走的同一个入口)。
 * 用 dev 服务而不是 build 产物:只有它能让台架 import 到与应用同一份 @lcl/engine 模块实例。
 *  ① 1180×820:从主页经底栏换到笔记 Space,并排左栏(.mb-sidecol)还在;停在笔记里重载(冷启动还原),左栏还在。
 *  ② 1180×820:主页(.hp-phone 版式)那一列左右留白相等。
 *  ③ 390×844:主页那一列左右留白相等、数值同改前(列宽 = 内容区,居中前后一个样)。
 * 截图与结果在 $OUT(缺省系统临时目录下的 forsion-pad-layout/)。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { chromium } = require('../../desktop/node_modules/playwright-core')
const { findChromium } = require('../../desktop/scripts/lib/find-chromium.cjs')
const { startStubEngine } = require('../../desktop/scripts/lib/stub-engine.cjs')

const ROOT = path.resolve(__dirname, '..')
const ENGINE = '/@fs' + path.resolve(ROOT, '../lcl/engine/index.ts')
const OUT = path.resolve(process.env.OUT || path.join(os.tmpdir(), 'forsion-pad-layout'))
fs.mkdirSync(OUT, { recursive: true })
const results = []

const freePort = () => new Promise((res, rej) => {
  const srv = net.createServer()
  srv.once('error', rej)
  srv.listen(0, () => { const { port } = srv.address(); srv.close(() => res(port)) })
})

/** vite dev(端口走 loadEnv 读的 PORT;只认自己这个进程报出的端口,不接同机别的检出的服务)。 */
async function startDev() {
  const port = await freePort()
  const child = spawn('npx', ['vite'], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let out = ''
  child.stdout.on('data', (d) => { out += String(d) })
  child.stderr.on('data', (d) => { out += String(d) })
  const kill = () => { try { process.kill(-child.pid, 'SIGTERM') } catch { /* 已退出 */ } }
  for (let i = 0; i < 60 && !out.replace(/\x1b\[[0-9;]*m/g, '').includes(`:${port}/`); i++) {
    if (child.exitCode !== null) throw new Error('vite dev 起不来:\n' + out)
    await new Promise((r) => setTimeout(r, 500))
  }
  return { url: `http://localhost:${port}/`, kill }
}

const json = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
async function fixtureApi(ctx, stub) {
  await ctx.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (p === '/auth/me') return json(route, { id: 'fixture-user', username: 'Fixture' })
    if (p === '/auth/region') return json(route, { country: 'CN' })
    if (p === '/amadeus/vaults') return json(route, { vaults: [{ id: 'default', name: 'Fixture vault', lastChangeSeq: 1, sizeBytes: 0, createdAt: new Date().toISOString() }] })
    if (p.endsWith('/tree')) return json(route, { pages: ['Fixture note.md'], folders: [], files: [], seq: 1 })
    if (p.endsWith('/file')) return json(route, { path: 'Fixture note.md', kind: 'page', content: '# Fixture note\n\nFixture body.\n', seq: 1, hash: 'fixture', updatedAt: new Date().toISOString() })
    if (/\/events$|\/stream$/.test(p)) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
    const u = new URL(route.request().url())
    return route.fulfill({ response: await route.fetch({ url: stub.url + p + u.search }) })
  })
}

async function openShell(browser, url, viewport, stub) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true, locale: 'zh-CN' })
  await ctx.addInitScript(() => {
    localStorage.setItem('forsion_token', 'fixture-only')
    localStorage.setItem('forsion_tangu_onboarding_done', '1')
    localStorage.setItem('tangu_locale', 'zh')
  })
  await fixtureApi(ctx, stub)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const boot = async () => {
    await page.goto(url + '?ui=mobile', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.mb-shell', { timeout: 120_000 })
    // 底栏宿主:同一份模块实例(店里已有主区 leaf 才是;另起一份的店是空的)
    const same = await page.evaluate(async (src) => {
      const eng = await import(src)
      window.__padEngine = eng
      eng.installNativeChromeHost({ spaces: true, render: () => {} })
      return eng.useWorkspace.getState().mainLeaves.length > 0
    }, ENGINE)
    assert(same, '台架 import 到的 @lcl/engine 不是应用那一份')
  }
  const tapSpace = async (id) => {
    assert(await page.evaluate((x) => window.__padEngine.dispatchNativeChromeSpace(x), id), `底栏点 ${id} 没人接`)
    await page.waitForSelector(`.mb-shell[data-space="${id}"]`)
    await page.waitForTimeout(600)
  }
  return { ctx, page, errors, boot, tapSpace }
}

/** 主页那一列相对内容区(.hp-root 去掉左右 padding)的左右留白。 */
const stackGaps = (page) => page.evaluate(() => {
  const root = document.querySelector('.hp-root.hp-phone')
  const stack = root?.querySelector('.hp-stack')
  if (!stack) return null
  const r = root.getBoundingClientRect(); const s = stack.getBoundingClientRect(); const c = getComputedStyle(root)
  return { left: s.left - r.left - parseFloat(c.paddingLeft), right: r.right - parseFloat(c.paddingRight) - s.right, width: s.width }
})
const sidecol = (page) => page.evaluate(() => {
  const el = document.querySelector('.mb-sidecol')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { width: r.width, visible: getComputedStyle(el).display !== 'none' && r.width > 0 }
})

async function main() {
  const dev = await startDev()
  console.log('vite dev →', dev.url)
  const stub = await startStubEngine({ models: [{ id: 'fixture-model', name: 'Fixture model', provider: 'Fixture', source: 'forsion', modelType: 'llm' }] })
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const check = async (page, name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail }); console.log('PASS', name, detail ?? '') }
    catch (e) { results.push({ name, ok: false, error: String(e.message || e) }); console.log('FAIL', name, String(e.message || e)); await page.screenshot({ path: path.join(OUT, `fail-${results.length}.png`) }) }
  }
  try {
    const pad = await openShell(browser, dev.url, { width: 1180, height: 820 }, stub)
    await pad.boot()
    await pad.tapSpace('home')
    await pad.page.screenshot({ path: path.join(OUT, 'home-1180.png') })
    await check(pad.page, '1180 主页那一列左右留白相等', async () => {
      const g = await stackGaps(pad.page)
      assert(g, '没有 .hp-phone 主页')
      assert(Math.abs(g.left - g.right) < 2, JSON.stringify(g))
      return g
    })
    await pad.tapSpace('amadeus')
    await pad.page.screenshot({ path: path.join(OUT, 'amadeus-1180.png') })
    await check(pad.page, '1180 底栏从主页换到笔记:并排左栏还在', async () => {
      const s = await sidecol(pad.page)
      assert(s?.visible, JSON.stringify(s))
      return s
    })
    await pad.boot() // 停在笔记里重载 = 冷启动还原
    await pad.page.waitForSelector('.mb-shell[data-space="amadeus"]')
    await pad.page.waitForTimeout(600)
    await check(pad.page, '1180 停在笔记里冷启动:并排左栏还在', async () => {
      const s = await sidecol(pad.page)
      assert(s?.visible, JSON.stringify(s))
      return s
    })
    if (pad.errors.length) console.log('pageerror(1180):', pad.errors)
    await pad.ctx.close()

    const phone = await openShell(browser, dev.url, { width: 390, height: 844 }, stub)
    await phone.boot()
    await phone.tapSpace('home')
    await phone.page.screenshot({ path: path.join(OUT, 'home-390.png') })
    await check(phone.page, '390 主页那一列左右留白相等(改前:2.35 / 2.35,宽 354)', async () => {
      const g = await stackGaps(phone.page)
      assert(g, '没有 .hp-phone 主页')
      assert(Math.abs(g.left - g.right) < 1, JSON.stringify(g))
      return g
    })
    await check(phone.page, '390 主页没有并排左栏', async () => {
      assert.equal(await sidecol(phone.page), null)
    })
    if (phone.errors.length) console.log('pageerror(390):', phone.errors)
    await phone.ctx.close()
  } finally {
    await browser.close()
    await stub.close()
    dev.kill()
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
    console.log('截图 / 结果 →', OUT)
  }
  const failed = results.filter((r) => !r.ok)
  console.log(failed.length ? `✗ ${failed.length}/${results.length} 红` : `✓ ${results.length} 条全绿`)
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
