/**
 * 服务器 Unit 网页主入口 × Forsion Extend 真端到端(2026-10-20):真 web 构建 + 真 unitWeb(projection public,同 /web/)
 * + 真 Extend 包(unit/packages.ts 的 readPackage 读出来,带 locked)+ 假云端 /api + 真 Chromium。
 *
 * 钉:登录回跳后 ① 页面有 unitPublicEntry、没有 cloudFetch(Extend 的通道只在它自己的页内适配里);
 *     ② 商店只有会员 / 积分 / 物品与投稿,没有插件目录、已安装、更新;落在第一张插件页上;
 *     ③ 付款页在新标签页打开,带一次性票、不带 token;
 *     ④ 设置有「Forsion 云端」,只有 Extend 的子页,没有同步 / 连接 / 诊断;
 *     ⑤ 蓬洲云 Space 进得去,我的云盘能新建文件夹;选一个中文名文件上传,云端收到的名字和内容对得上;下载落成浏览器下载、名字内容对得上;
 *     ⑥ 云端请求都盖着访客 token(页面账号代发),没有别的身份;
 *     ⑦ 负对照:Unit 没装 Extend(同服务器的 /admin/)→ 没有商店入口、没有空的「Forsion 云端」。
 *
 * 前置:node scripts/build-unit-web.mjs(产物在 desktop/unit-web-dist);EXTEND_DIR = build 过的 Extend 检出(dist/main.js 在)。
 * 跑:EXTEND_DIR=… npx tsx scripts/unit-public-extend.e2e.ts   截图落 SHOT_DIR(缺省 /tmp)。CHROMIUM_EXE 可覆盖。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chromium, type Page } from 'playwright-core'
import { startUnitWeb } from '../electron/unitWeb'
import { resolveProduct } from '../shared/product'
import basic from '../products/basic.json'
import * as unitPackages from '../../unit/packages'
// Unit sources have no package.json; tsx may expose them through CommonJS on Node 22.
const { readPackage } = (unitPackages as unknown as { default?: typeof unitPackages }).default ?? unitPackages

const DIST = path.resolve(import.meta.dirname, '../unit-web-dist')
const SHOT_DIR = process.env.SHOT_DIR || '/tmp'
const EXTEND_DIR = process.env.EXTEND_DIR ? path.resolve(process.env.EXTEND_DIR) : ''
const TOKEN = 'tok-visitor'
const INSTANCE = 'unit-public-e2e'

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

// ── 假云端:形状照 Extend 渲染层测试的夹具(test/vitest/renderer/harness.ts、penzorData.test.ts)──
const MB = 1024 * 1024
const ME = { id: 'u1', username: 'alice', role: 'USER', email: 'alice@example.com', phone: null, avatar: null, nickname: 'Alice' }
const QUOTA = {
  dailyLimit: 100, dailyUsed: 30, dailyRemaining: 70, dailyPercent: 30, weeklyLimit: 500, weeklyUsed: 120, weeklyRemaining: 380, weeklyPercent: 24,
  weeklyResetAt: '2026-10-26', background: { sharePercent: 15, dailyLimit: 15, dailyUsed: 0, dailyRemaining: 15, dailyPercent: 0, weeklyLimit: 75, weeklyUsed: 0, weeklyRemaining: 75, weeklyPercent: 0, autoMain: false, modelId: null },
  exchangeRate: 1, resetCardPricePoints: 100, resetCards: 1,
}
const PLANS = [
  { id: 'p-plus', name: 'Plus', tier: 'plus', description: '日常轻度使用', priceMonthly: 29.9, priceQuarterly: 79.9, priceYearly: 299, currency: 'CNY', isActive: true },
  { id: 'p-pro', name: 'Pro', tier: 'pro', description: '4 倍 Plus 额度', priceMonthly: 99, priceQuarterly: 259, priceYearly: 999, currency: 'CNY', isActive: true },
]
const API: Record<string, unknown> = {
  'GET /api/announcements/pending': { announcement: null },
  'POST /api/auth/handoff': { code: 'one-time-code' },
  'GET /api/auth/me': ME,
  'GET /api/profile/me': { username: 'alice', nickname: 'Alice', bio: '', avatar: null },
  'GET /api/profile/me/works': { items: [] },
  'GET /api/membership/my': { membership: { tier: 'plus', status: 'active', expiresAt: '2026-11-20T00:00:00.000Z', plan: { name: 'Plus' } } },
  'GET /api/credits/balance': { balance: 1240 },
  'GET /api/features': { payment: true, shop: true, invite_codes: true },
  'GET /api/payment/offerings': { packages: [{ id: 'k-basic', name: 'Basic', description: '基础积分包', credits: 100, price: 9.9, currency: 'CNY', isActive: true }], membershipPlans: PLANS },
  'GET /api/shop/products': [{ id: 'reset-card', name: '额度重置卡', description: '立即恢复今日与本周 AI 额度', icon: '⚡', type: 'reset_card', pricePoints: 150, priceRmb: 0, currency: 'CNY', isActive: true }],
  'GET /api/shop/inventory': { items: [] },
  'GET /api/token-quota/my': QUOTA,
  'GET /api/invite/my-code': { code: 'ABCD1234', invitedCount: 0, totalReward: 0, claim: { eligible: false } },
  'GET /api/market/mine': { items: [] },
  'GET /api/feedback': { tickets: [] },
  'GET /api/remotesync/vaults': { vaults: [], usedBytes: 0, diagnosticsBytes: 0, maxBytes: 2048 * MB, maxFileBytes: 50 * MB },
  'GET /api/amadeus/vaults': { vaults: [{ id: 'a1', name: '云端笔记', sizeBytes: 12 * MB }] },
  'GET /api/storage/quota': { used: 30 * MB, quota: 10240 * MB },
  'GET /api/storage/files-by-app': { apps: [{ appId: 'penzor', bytes: 30 * MB, files: 2, trashBytes: 0, trashFiles: 0 }], largest: [] },
  'GET /api/exports/list?pageSize=500&sortBy=date&sortOrder=desc': { files: [], total: 0, totalBytes: 0 },
  'GET /api/trash?all=1': [],
  'GET /api/files': [
    { id: 'f1', name: '方案.pdf', fileType: 'file', fileSize: 18 * MB, updatedAt: '2026-10-19T08:00:00Z', parentId: 'ROOT', appId: 'penzor' },
    { id: 'd1', name: '照片', fileType: 'directory', fileSize: 0, updatedAt: '2026-10-18T08:00:00Z', parentId: 'ROOT', appId: 'penzor' },
  ],
}
const seen: Array<{ method: string; url: string; auth: string; source: string }> = []
const PDF_BYTES = '%PDF-1.4 fake'
/** 云端收到的上传(multipart 按 filename* 解名字,同服务端 busboy)。 */
const uploads: Array<{ name: string | null; ascii: string | null; body: string; parentId: string | null }> = []

function fakeCloud(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = req.url || '/'
  if (url.startsWith('/pay') || url.startsWith('/account')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>pay</title>'); return true }
  if (!url.startsWith('/api/')) return false
  seen.push({ method: req.method || 'GET', url, auth: String(req.headers.authorization || ''), source: String(req.headers['x-project-source'] || '') })
  const key = `${req.method} ${url}`
  const hit = key in API ? API[key] : API[`${req.method} ${url.split('?')[0]}`]
  if (String(req.headers.authorization || '') !== `Bearer ${TOKEN}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"unauthorized"}'); return true }
  if (req.method === 'POST' && url === '/api/files/upload') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const star = /filename\*=UTF-8''([^\r\n;]+)/.exec(raw)?.[1]
      const file = /Content-Type: [^\r\n]+\r\n\r\n([\s\S]*)\r\n--[^\r\n]+--\r\n$/.exec(raw)?.[1] ?? ''
      uploads.push({ name: star ? decodeURIComponent(star) : null, ascii: /filename="([^"]*)"/.exec(raw)?.[1] ?? null, body: file, parentId: /name="parentId"\r\n\r\n([^\r\n]*)/.exec(raw)?.[1] ?? null })
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'up1' }))
    })
    return true
  }
  if (req.method === 'GET' && url === '/api/files/f1/content') {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(Buffer.byteLength(PDF_BYTES)) })
    res.end(PDF_BYTES)
    return true
  }
  res.writeHead(hit === undefined ? 404 : 200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(hit ?? { detail: 'not in fake cloud' }))
  return true
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOT_DIR, `unit-public-extend-${name}.png`) })
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`缺 web 构建:先跑 node scripts/build-unit-web.mjs(${DIST})`)
  if (!EXTEND_DIR || !fs.existsSync(path.join(EXTEND_DIR, 'dist/main.js'))) throw new Error('设 EXTEND_DIR = build 过的 Forsion Extend 检出')
  const pack = await readPackage(EXTEND_DIR)
  check('Unit 把 Forsion Extend 标成首方包(locked)', pack.ui?.locked === true, JSON.stringify({ id: pack.ui?.id, locked: pack.ui?.locked }))

  // 同 unit/host.ts:market 起始 false,refreshProduct 按「装没装首方包」改写
  const startUnit = (plugins: unknown[], spaces: typeof pack.spaces) => startUnitWeb({
    account: {
      metadata: () => ({ apiBase: '/api', loginPath: '/auth' }),
      handle: async (p, req, res) => {
        if (p !== '/unit/account') return false
        const ok = req.headers.authorization === `Bearer ${TOKEN}`
        res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(ok ? { userId: 'u1', username: 'alice', role: 'USER', nickname: 'Alice' } : { error: 'Authentication required' }))
        return true
      },
    },
    routeRequest: fakeCloud,
    meta: { instanceId: INSTANCE, name: 'Forsion Genesis Web', version: '9.9.9' },
    projection: { mode: 'public', basePath: '/web/', inheritWebAccount: plugins.length > 0, product: resolveProduct(undefined, { ...basic, market: plugins.some((p) => (p as { locked?: boolean }).locked), onboarding: false, nativeFeatures: [] }), capabilities: () => ({}) },
    getEngine: () => ({ url: null, token: '' }),
    confirmPair: async () => false,
    pairedDevices: { list: () => [], add: async () => { throw new Error('Pairing is disabled') } },
    readPlugins: async () => plugins,
    readSpaces: async () => spaces,
    readConfig: async () => ({}), writeConfig: async () => { throw new Error('Host configuration is not published') },
    readProviders: async () => [],
    readHostFile: async () => null, readHostDir: async () => null, readHostStat: async () => null,
    webDistDir: () => DIST, vault: () => null, log: () => {},
  }, { port: 0, bindHost: '127.0.0.1' })
  const handle = await startUnit([pack.ui], pack.spaces)
  const bare = await startUnit([], [])
  let base = `http://unit-public.test:${handle.port}`
  let gateway = ''
  if (process.env.UNIT_GATEWAY_IMAGE) {
    gateway = `forsion-unit-gateway-${randomUUID()}`
    execFileSync('docker', ['run', '--rm', '-d', '--name', gateway, '--add-host', 'host.docker.internal:host-gateway',
      '-p', '127.0.0.1::80', '-e', `BACKEND_URL=http://host.docker.internal:${handle.port}`, process.env.UNIT_GATEWAY_IMAGE])
    const port = execFileSync('docker', ['port', gateway, '80/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)
    base = `http://unit-public.test:${port}`
    let ready = false
    for (let attempt = 0; attempt < 80; attempt++) {
      ready = await fetch(`http://127.0.0.1:${port}/?ui=desktop`, { redirect: 'manual' }).then((r) => {
        if (r.status !== 302) return false
        check('网关重定向保留查询且不降级外部 HTTPS 或丢失端口', r.headers.get('location') === '/web/?ui=desktop', String(r.headers.get('location')))
        return true
      }).catch(() => false)
      if (ready) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!ready) {
      console.error(execFileSync('docker', ['logs', gateway], { encoding: 'utf8' }))
      execFileSync('docker', ['rm', '-f', gateway], { stdio: 'ignore' })
      throw new Error('Unit gateway did not become ready')
    }
  }

  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP unit-public.test 127.0.0.1'] })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: 'zh-CN' })
    await context.addInitScript(([instance]) => {
      try {
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('forsion_tangu_onboarding_version', '9.9.9')
        localStorage.setItem('forsion_token', 'tok-visitor')
        localStorage.setItem('legacy-note-cache', 'old note stays intact')
        sessionStorage.setItem(`unit:${instance}:login-state`, 'S1') // 登录回跳的 state(unitAccount.ts)
      } catch { /* 私密模式 */ }
    }, [INSTANCE])
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const consoleLines: string[] = []
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(m.text().slice(0, 200)) })
    // 登录回跳(= /auth 登完带 token 回来),页面自己核身份、存进标签页会话
    await page.goto(gateway ? `${base}/?ui=desktop` : `${base}/web/`)
    await page.locator('.rb').first().waitFor()
    await page.waitForTimeout(1500)
    check('旧 Web 登录经 Unit 验证后继承，旧数据不清空，URL 无 token', await page.evaluate(([instance]) =>
      sessionStorage.getItem(`unit:${instance}:account`) === 'tok-visitor' &&
      localStorage.getItem('legacy-note-cache') === 'old note stays intact' && !new URL(location.href).searchParams.has('token'), [INSTANCE]))
    const bridge = await page.evaluate(() => { const t = (window as any).tangu; return { entry: t?.unitPublicEntry, unitPage: t?.unitPage, fetch: typeof t?.cloudFetch, invoke: typeof t?.cloudInvoke, market: typeof t?.marketList } })
    check('① 网页主入口标志在,cloudFetch / cloudInvoke 没挂到 window.tangu', bridge.entry === true && bridge.unitPage === true && bridge.fetch === 'undefined' && bridge.invoke === 'undefined' && bridge.market === 'function', JSON.stringify(bridge))

    // ② 商店
    const clickRibbon = async (id: string): Promise<void> => {
      const el = page.locator(`.rb [data-id="${id}"]`).first()
      if (await el.isVisible().catch(() => false)) { await el.click(); return }
      await page.locator('.rb-more').first().click()
      await page.locator(`[data-id="${id}"]`).last().click()
    }
    await clickRibbon('rb-market')
    await page.locator('.mk-page').waitFor()
    await page.locator('[data-store-view]').first().waitFor()
    await page.waitForTimeout(800)
    const nav = await page.locator('.mk-page .settings-nav-list button').allInnerTexts()
    const storeKeys = await page.locator('[data-store-view]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.storeView))
    const active = await page.locator('[data-store-view].active').getAttribute('data-store-view')
    check('② 商店只有会员 / 积分 / 物品与投稿,没有插件目录', storeKeys.join() === 'forsion-extend:membership,forsion-extend:points,forsion-extend:items'
      && nav.some((s) => s.includes('投稿')) && !nav.some((s) => /发现|已安装|更新/.test(s)), JSON.stringify(nav))
    check('② 打开就落在第一张插件页(会员)', active === 'forsion-extend:membership', String(active))
    await shot(page, 'store-membership')

    // ③ 付款页:新标签页、一次性票、不带 token
    const buy = page.locator('.mk-page button').filter({ hasText: /开通|续费|升级|购买|充值/ }).first()
    let payUrl = ''
    if (await buy.count()) {
      const [popup] = await Promise.all([context.waitForEvent('page'), buy.click()])
      await popup.waitForLoadState('domcontentloaded').catch(() => {})
      for (let i = 0; i < 30 && !/\/pay/.test(popup.url()); i++) await page.waitForTimeout(100)
      payUrl = popup.url()
      await popup.close()
    }
    const pay = payUrl ? new URL(payUrl) : null
    check('③ 付款页在新标签页打开、带一次性票、不带 token', !!pay && pay.pathname === '/pay' && pay.searchParams.get('code') === 'one-time-code' && !payUrl.includes(TOKEN), payUrl || '没有找到购买按钮')

    await page.locator('[data-store-view="forsion-extend:items"]').click()
    await page.waitForTimeout(800)
    check('② 物品页列出可兑换的东西', (await page.locator('.mk-page').innerText()).includes('额度重置卡'))
    await shot(page, 'store-items')
    await page.locator('.mk-page .settings-back').first().click()

    // ④ 设置 → Forsion 云端
    await clickRibbon('rb-settings')
    await page.locator('.settings-nav').first().waitFor()
    const cloudTab = page.locator('.settings-nav button, .settings-nav [role="button"]').filter({ hasText: 'Forsion 云端' }).first()
    await cloudTab.click()
    await page.waitForTimeout(1000)
    // 只看「Forsion 云端」这一组展开的子项(到下一个一级页「常规」为止;常规下面那个「连接」是宿主自己的,不归这页)
    const sNav = (await page.locator('.settings-nav').first().innerText()).split(/\n+/).map((s) => s.trim()).filter(Boolean)
    const from = sNav.indexOf('Forsion 云端')
    const group = sNav.slice(from + 1, sNav.indexOf('常规', from))
    check('④ 设置有「Forsion 云端」,子项只有 Extend 的页:没有同步 / 连接 / 诊断', from >= 0 && group.includes('账号') && group.includes('插件投稿')
      && !group.some((s) => /同步|连接|诊断/.test(s)), group.join(' / '))
    await shot(page, 'settings-forsion')
    await page.locator('.settings-back').first().click()
    await page.locator('.floating-panel-layer').waitFor({ state: 'detached' }).catch(() => {})
    await page.waitForTimeout(300)

    // ⑤ 蓬洲云
    const penzor = page.locator('[data-space-id="forsion-penzor"], [data-id="forsion-penzor"]').first()
    let penzorOk = false
    if (await penzor.count()) {
      await penzor.click()
      await page.getByText('我的云盘').first().click()
      const driveRoot = page.locator('[data-row-key="drive-root"]').first()
      if (await driveRoot.count() && await driveRoot.getAttribute('aria-expanded') !== 'true') await driveRoot.click()
      await page.locator('[data-row-key="app:penzor"]').first().click()
      await page.getByText('方案.pdf').first().waitFor()
      const toolbar = await page.locator('.pz-btn, .pz-ibtn').evaluateAll((els) => els.map((e) => (e.textContent || '') + '|' + (e.getAttribute('title') || '')))
      penzorOk = toolbar.some((s) => s.includes('上传')) && toolbar.some((s) => s.includes('新建文件夹'))
      check('⑤ 蓬洲云:我的云盘能看,有上传、新建文件夹', penzorOk, JSON.stringify(toolbar))
      // 上传:选文件框交 File(网页没有本机路径),中文名要原样到云端
      await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles({ name: '报告 v2.txt', mimeType: 'text/plain', buffer: Buffer.from('你好 penzor') })
      for (let i = 0; i < 100 && !uploads.length; i++) await page.waitForTimeout(50)
      const up = uploads[0]
      check('⑤ 上传:云端收到的名字(filename*)和内容对得上,落在最外层', up?.name === '报告 v2.txt' && up.ascii === '__ v2.txt' && up.body === '你好 penzor' && up.parentId === 'ROOT', JSON.stringify(up))
      await page.getByText('全部传完').first().waitFor().catch(() => {})
      await shot(page, 'penzor-uploaded')
      // 下载:右键那一行 → 下载,落成浏览器下载
      const download = page.waitForEvent('download', { timeout: 10000 }).catch(() => null)
      await page.getByText('方案.pdf').first().click({ button: 'right' })
      await page.locator('.pz-menu').getByText('下载', { exact: true }).click()
      const dl = await download
      const got = dl ? fs.readFileSync((await dl.path())!, 'utf8') : null
      check('⑤ 下载:浏览器下载落成原名、内容对得上', dl?.suggestedFilename() === '方案.pdf' && got === PDF_BYTES, `${dl?.suggestedFilename()} ${JSON.stringify(got)}`)
      await shot(page, 'penzor-drive')
    } else check('⑤ 蓬洲云 Space 在 Ribbon 上', false, `spaces=${JSON.stringify(await page.locator('[data-space-id]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.spaceId)))} console=${consoleLines.slice(-6).join(' · ')}`)

    const ribbon = await page.locator('.rb [data-id], .rb [data-space-id]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.spaceId || (e as HTMLElement).dataset.id))
    console.log(`INFO  Ribbon: ${ribbon.join(', ')}`)
    // 使用指南的视图在网页上不注册(它讲的是桌面端):Space 不该露出来
    check('使用指南 Space 不在网页的 Ribbon 上', !ribbon.includes('forsion-guide'), ribbon.join(', '))

    // ⑥ 身份
    const others = seen.filter((r) => r.auth !== `Bearer ${TOKEN}`)
    check('⑥ 云端请求都盖着访客 token', seen.length > 5 && others.length === 0, `${seen.length} 条,其它身份 ${others.length}:${JSON.stringify(others.slice(0, 3))}`)
    check('⑥ 蓬洲云的应用文件带 X-Project-Source', seen.some((r) => r.url.startsWith('/api/files') && r.source === 'penzor'))
    check('页面没有未捕获异常', errors.length === 0, errors.slice(0, 3).join(' · '))

    // ⑦ 负对照:同一份页面,Unit 没装 Extend
    const page2 = await context.newPage()
    page2.setDefaultTimeout(15000)
    await page2.goto(`http://unit-public.test:${bare.port}/web/?token=${TOKEN}&account_state=S1`)
    await page2.locator('.rb').first().waitFor()
    await page2.waitForTimeout(1500)
    const bareIds = await page2.locator('.rb [data-id]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id))
    const bareMarket = await page2.evaluate(() => typeof (window as any).tangu?.marketList)
    check('⑦ 没装 Extend:没有商店入口', !bareIds.includes('rb-market') && bareMarket === 'undefined', `${bareIds.join(', ')} marketList=${bareMarket}`)
    await page2.locator('.rb [data-id="rb-settings"]').first().click()
    await page2.locator('.settings-nav').first().waitFor()
    const bareNav = await page2.locator('.settings-nav').first().innerText()
    check('⑦ 没装 Extend:设置里没有空的「Forsion 云端」', !bareNav.includes('Forsion 云端'), bareNav.replace(/\n+/g, ' / ').slice(0, 200))
  } finally {
    await browser.close()
    await handle.close?.()
    await bare.close?.()
    if (gateway) execFileSync('docker', ['rm', '-f', gateway], { stdio: 'ignore' })
  }
  const fails = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - fails}/${results.length} passed${fails ? ` — ${fails} FAILED` : ''}  截图:${SHOT_DIR}/unit-public-extend-*.png`)
  process.exit(fails ? 1 : 0)
}

void main().catch((e) => { console.error(e); process.exit(1) })
