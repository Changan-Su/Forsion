/**
 * 设备页真端到端(方案 §11):真 web 构建 + 真 unitWeb + 假引擎 + 真 Chromium。
 *
 * 链路:GET /(注入 unit 标记的 index)→ unitShim 探针 401 → 页内配对流(6 位码)→
 *       B 侧确认(本仪器自动允许)→ 令牌落 localStorage → 挂载真渲染层(.rb 出现)→
 *       插件面从 /unit/plugins 拉取 → 引擎调用被反代且盖引擎 token → 刷新后免配对直进。
 *
 * 前置:node scripts/build-unit-web.mjs(产物在 desktop/unit-web-dist)。
 * 跑:npx tsx scripts/unit-page.e2e.ts   (CHROMIUM_EXE 可覆盖)
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { chromium } from 'playwright-core'
import { startUnitWeb, type PairedDevice } from '../electron/unitWeb'

const DIST = path.resolve(import.meta.dirname, '../unit-web-dist')
const SHOT_DIR = process.env.UNITSW_SHOT_DIR || '/tmp'

function findChromium(): string {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  try {
    const p = chromium.executablePath()
    if (p && fs.existsSync(p)) return p
  } catch { /* fallthrough */ }
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const results: Array<{ name: string; ok: boolean }> = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

function fakeEngine(): Promise<{ url: string; seen: Array<{ path: string; auth: string }>; close(): void }> {
  const seen: Array<{ path: string; auth: string }> = []
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url || '', auth: String(req.headers.authorization || '') })
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, sandbox: 'none', version: 'e2e' }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ detail: 'e2e fake engine' }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, seen, close: () => server.close() })
    })
  })
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`缺 web 构建:先跑 node scripts/build-unit-web.mjs(期望 ${DIST})`)
  }
  const engine = await fakeEngine()
  const paired: PairedDevice[] = []
  let pluginsServed = 0
  let pairCode = ''
  const handle = await startUnitWeb({
    getEngine: () => ({ url: engine.url, token: 'ENGINE_TOKEN' }),
    confirmPair: async (info) => { pairCode = info.code; return true }, // B 侧自动点「允许」
    pairedDevices: { list: () => paired, add: async (d) => { paired.push(d) } },
    readPlugins: async () => {
      pluginsServed++
      return [{ id: 'demo-remote', name: '远程演示插件', version: '1.0.0', apiVersion: 1, code: 'ctx.registerCommand({ id: "demo-remote-cmd", title: "远程演示", run() {} })' }]
    },
    meta: { instanceId: 'e2e-inst', name: 'E2E 测试机', version: '9.9.9' },
    webDistDir: () => DIST,
    log: (m) => console.log(m),
  }, { port: 0, bindHost: '127.0.0.1' })
  const base = `http://127.0.0.1:${handle.port}`

  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    // 1 注入标记
    const home = await (await fetch(`${base}/`)).text()
    check('index 注入 unit 标记', home.includes('__FORSION_UNIT_PAGE__') && home.includes('e2e-inst'))

    // 2 配对流:卡片 + 6 位码上屏
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.body.textContent?.includes('确认'), null, { timeout: 20000 })
    const codeShown = await page.evaluate(() => /\d{6}/.exec(document.body.textContent || '')?.[0] ?? '')
    check('配对卡展示 6 位码', /^\d{6}$/.test(codeShown))

    // 3 自动允许后真渲染层挂载(Ribbon 出现)
    await page.waitForSelector('.rb', { timeout: 45000 })
    check('配对码两侧一致(B 侧弹窗收到同码)', pairCode === codeShown, `A=${codeShown} B=${pairCode}`)
    check('配对通过后真渲染层挂载(.rb)', true)
    check('B 侧留下配对记录(hash 存储)', paired.length === 1 && !!paired[0].tokenHash)

    // 4 插件面从设备拉取
    await page.waitForFunction(() => true, null, { timeout: 1 }).catch(() => {})
    for (let i = 0; i < 20 && pluginsServed === 0; i++) await new Promise((r) => setTimeout(r, 500))
    check('插件清单经 /unit/plugins 分发', pluginsServed > 0, `served=${pluginsServed}`)

    // 5 引擎调用被反代且盖引擎 token(剥外来身份)
    for (let i = 0; i < 20 && engine.seen.length === 0; i++) await new Promise((r) => setTimeout(r, 500))
    const stamped = engine.seen.every((s) => s.auth === 'Bearer ENGINE_TOKEN')
    check('引擎调用到达且全部盖引擎 token', engine.seen.length > 0 && stamped, `hits=${engine.seen.length}`)

    await page.waitForTimeout(1200)
    await page.screenshot({ path: path.join(SHOT_DIR, 'unit-page-booted.png') })

    // 6 刷新免配对直进(令牌按 instanceId 落 localStorage)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.rb', { timeout: 45000 })
    const askedAgain = await page.evaluate(() => document.body.textContent?.includes('配对码') ?? false)
    check('刷新后免配对直进', !askedAgain)

    if (pageErrors.length) console.log(`[pageerror ×${pageErrors.length}] 首条: ${pageErrors[0]}`)
  } finally {
    await browser.close()
    await handle.close()
    engine.close()
  }
  const fails = results.filter((r) => !r.ok).length
  console.log(fails ? `\n❌ ${fails} 条未过` : '\n✅ 全部通过')
  process.exit(fails ? 1 : 0)
}

void main().catch((e) => { console.error(e); process.exit(1) })
