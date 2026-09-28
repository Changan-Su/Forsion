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
import { IPC } from '../shared/amadeus/ipc'
import { createRequire } from 'node:module'
import { startUnitWeb, type PairedDevice } from '../electron/unitWeb'
import type { VaultFace } from '../electron/amadeus/ipc'

// 可编剧假引擎(聊天面 e2e 共用):第 10 步的审批卡要一条真 run 的事件流(approval_request + 挂住)。
const { startStubEngine } = createRequire(import.meta.url)('./lib/stub-engine.cjs') as {
  startStubEngine: (data?: Record<string, unknown>) => Promise<{
    url: string; seen: { approvals: Array<Record<string, unknown>>; runs: unknown[] }; script: (events: unknown[]) => void; close: () => void
  }>
}

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

function fakeEngine(): Promise<{ url: string; seen: Array<{ path: string; auth: string; remote: string; mark: string }>; close(): void }> {
  const seen: Array<{ path: string; auth: string; remote: string; mark: string }> = []
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url || '', auth: String(req.headers.authorization || ''), remote: String(req.headers['x-forsion-remote'] || ''), mark: String(req.headers['x-forsion-remote-mark'] || '') })
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
  // 假 vault 面:内存页表(loadPage/savePage 真往返走「真桥→RPC→白名单→派发」全链,只有落盘是假的)。
  const pages = new Map<string, { manifest: unknown; contents: Record<string, string> }>()
  pages.set('E2E笔记.md', { manifest: { blocks: [] }, contents: { main: '# 来自 B 的笔记\n\n中文字节数一致性 ✓' } })
  const vaultSubs = new Set<(ch: string, payload: unknown, origin: string | null) => void>()
  const vaultFace: VaultFace = {
    call: async (ch, args) => {
      if (ch === IPC.restoreVault) return { root: '/e2e-vault', pages: [...pages.keys()], folders: [], lastPage: 'E2E笔记.md' }
      if (ch === IPC.listPages) return [...pages.keys()]
      if (ch === IPC.listFiles) return []
      if (ch === IPC.listFolders) return []
      if (ch === IPC.pageIcons) return {}
      if (ch === IPC.loadPage || ch === IPC.readPage) {
        const p = pages.get(String(args[0]))
        if (!p) throw new Error(`note not found: ${args[0]}`)
        return { ...p }
      }
      if (ch === IPC.savePage) {
        pages.set(String(args[0]), { manifest: args[1], contents: args[2] as Record<string, string> })
        return undefined
      }
      return null
    },
    onEvent: (cb) => { vaultSubs.add(cb); return () => { vaultSubs.delete(cb) } },
    assetAbs: async () => null,
    absPath: (rel) => `/e2e-vault/${rel}`,
    root: () => '/e2e-vault',
  }
  // 镜像真 vaultFace 的写→回灌:savePage 后按写入者 origin 发 externalChange(桥应丢自己的回声)。
  const rawCall = vaultFace.call
  vaultFace.call = async (ch, args, origin) => {
    const r = await rawCall(ch, args, origin)
    if (ch === IPC.savePage) for (const s of vaultSubs) s(IPC.externalChange, args[0], origin ?? null)
    return r
  }
  const handle = await startUnitWeb({
    getEngine: () => ({ url: engine.url, token: 'ENGINE_TOKEN', remoteMark: 'E2E_REMOTE_MARK' }),
    confirmPair: async (info) => { pairCode = info.code; return true }, // B 侧自动点「允许」
    pairedDevices: { list: () => paired, add: async (d) => { paired.push(d) } },
    readPlugins: async () => {
      pluginsServed++
      return [{ id: 'demo-remote', name: '远程演示插件', version: '1.0.0', apiVersion: 1, code: 'ctx.registerCommand({ id: "demo-remote-cmd", title: "远程演示", run() {} })' }]
    },
    readConfig: async () => ({ agentDeskEnabled: true, homeDir: '/tmp/e2e-home', defaultWorkspaceDir: '/tmp/e2e-home/Tangu' }),
    writeConfig: async (patch: Record<string, unknown>) => ({ agentDeskEnabled: true, ...patch }),
    readProviders: async () => [{ providerId: 'e2e-direct', modelIds: ['e2e/m1'] }],
    readHostFile: async () => null, // e2e 不铺主机文件面;桥侧对 404 兜底即可
    readHostDir: async () => null,
    readHostStat: async () => null,
    readSpaces: async () => [{
      slug: 'demo-space',
      json: JSON.stringify({ id: 'demo-space', name: '远程演示空间', icon: 'boxes', layout: { main: [{ type: 'launcher' }], left: [], right: [] } }),
      plugin: 'demo-remote',
    }],
    meta: { instanceId: 'e2e-inst', name: 'E2E 测试机', version: '9.9.9' },
    webDistDir: () => DIST,
    vault: () => vaultFace,
    log: (m) => console.log(m),
  }, { port: 0, bindHost: '127.0.0.1' })
  const base = `http://127.0.0.1:${handle.port}`
  // ⚠️ 页面一律经映射域名打开而非 127.0.0.1:T1 真实语境是明文 http://<LAN IP> = **非安全上下文**,
  // 而 loopback 是安全上下文 —— 用它跑等于永远测不到 T1(crypto.randomUUID 之类只存在于安全上下文的
  // API 在这里现形;那颗雷曾让 LAN 页整页白屏,兜底代码在 loopback 下恒为死代码)。
  const pageBase = `http://unit-e2e.test:${handle.port}`

  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    args: ['--host-resolver-rules=MAP unit-e2e.test 127.0.0.1'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    // 首启引导(OnboardingWizard)开着时外壳整片 visibility:hidden,`.rb` 永远不可见。设备页两条都会触发:
    // 从没跳过过(ONBOARDING_DISMISS_KEY),以及 unitShim 给了 appVersion(= meta.version)而已看版本不同(ONBOARDING_VERSION_KEY)。
    // 本仪器测的是配对 / 反代 / vault 桥,不是引导:两个键都预置(键名同 OnboardingWizard.tsx,版本同上面的 meta.version)。
    // browser.newPage 每次是新 context(新 localStorage)→ 第 9 步的手机页同样要预置。
    const skipOnboarding = (p: typeof page) => p.addInitScript(() => {
      try {
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('forsion_tangu_onboarding_version', '9.9.9')
      } catch { /* 私密模式 */ }
    })
    await skipOnboarding(page)
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    // 1 注入标记
    const home = await (await fetch(`${base}/`)).text()
    check('index 注入 unit 标记', home.includes('__FORSION_UNIT_PAGE__') && home.includes('e2e-inst'))

    // 2 配对流:卡片 + 6 位码上屏(非安全上下文 —— T1 的真实语境)
    await page.goto(pageBase, { waitUntil: 'domcontentloaded' })
    const secureCtx = await page.evaluate(() => window.isSecureContext)
    check('页面运行于非安全上下文(T1 真实语境)', secureCtx === false)
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
    // 页面侧痕迹断言(勿只数服务端下发数):插件 Space 经 /unit/spaces → loadUserSpaces → Ribbon 真出图标。
    let spaceOnRibbon = false
    for (let i = 0; i < 20 && !spaceOnRibbon; i++) {
      await new Promise((r) => setTimeout(r, 500))
      spaceOnRibbon = await page.evaluate(() => {
        const rb = document.querySelector('.rb')
        return !!rb && [...rb.querySelectorAll('[title],[aria-label]')].some((el) =>
          ((el.getAttribute('title') || el.getAttribute('aria-label')) ?? '').includes('远程演示空间'))
      })
    }
    check('插件 Space 经 /unit/spaces 上 Ribbon(页面侧痕迹)', spaceOnRibbon)

    // 5 引擎调用被反代且盖引擎 token(剥外来身份)
    for (let i = 0; i < 20 && engine.seen.length === 0; i++) await new Promise((r) => setTimeout(r, 500))
    const stamped = engine.seen.every((s) => s.auth === 'Bearer ENGINE_TOKEN')
    check('引擎调用到达且全部盖引擎 token', engine.seen.length > 0 && stamped, `hits=${engine.seen.length}`)
    // 5b 远端来源标记(契约 C1):局域网配对来路 = lan,且带本机标记密钥(引擎据此认「远端」)
    check('引擎调用全部盖远端来源标记 x-forsion-remote: lan + 标记密钥', engine.seen.every((s) => s.remote === 'lan' && s.mark === 'E2E_REMOTE_MARK'),
      JSON.stringify([...new Set(engine.seen.map((s) => `${s.remote}|${s.mark}`))]))
    // 5c default-deny 允许清单:页面里直接打「只许本机」的引擎路由 → 403 LOCAL_ONLY,一个字节都进不了引擎
    const hitsBefore = engine.seen.length
    const denied = await page.evaluate(async () => {
      const token = (window as any).__FORSION_UNIT_TOKEN__ || '' // unitShim 挂出的本页配对令牌
      const r = await fetch(new URL('engine/agent/plugins/install', document.baseURI), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })
      return { status: r.status, code: ((await r.json().catch(() => ({}))) as { code?: string }).code }
    })
    check('设备页打「只许本机」引擎路由(装插件)→ 403 LOCAL_ONLY 且到不了引擎',
      denied.status === 403 && denied.code === 'LOCAL_ONLY' && !engine.seen.slice(hitsBefore).some((s) => s.path.includes('plugins/install')), JSON.stringify(denied))

    // 6 本地 vault 面:真页面里经真桥(window.amadeus → RPC → 白名单 → 派发)读写 B 的笔记
    const vaultRt = await page.evaluate(async () => {
      const am = (window as any).amadeus
      const listed: string[] = await am.listPages()
      const loaded = await am.loadPage('E2E笔记.md')
      await am.savePage('E2E笔记.md', { blocks: [] }, { main: '# A 改写的\n\n远程保存 ✓' })
      const after = await am.loadPage('E2E笔记.md')
      return { listed, firstMain: loaded?.contents?.main ?? '', afterMain: after?.contents?.main ?? '' }
    })
    check('vault 面:listPages 看到 B 的笔记', vaultRt.listed.includes('E2E笔记.md'))
    check('vault 面:loadPage 中文内容无损', vaultRt.firstMain.includes('中文字节数一致性 ✓'))
    check('vault 面:savePage→loadPage 真往返', vaultRt.afterMain.includes('远程保存 ✓'))

    // 7 B 侧改动经 SSE 回灌到页面;自己的写(带本桥 origin 的回声)必须被丢
    await page.evaluate(() => {
      ;(window as any).__evGot = []
      ;(window as any).amadeus.onExternalChange((p: string) => { (window as any).__evGot.push(p) })
    })
    await page.evaluate(async () => { await (window as any).amadeus.savePage('E2E笔记.md', { blocks: [] }, { main: '再存一次' }) })
    for (let i = 0; i < 30; i++) {
      // SSE 在资源令牌到手后才建连,连上前的 emit 会丢:重复发直到页面收到(origin=null 模拟 B 侧改动)
      for (const s of vaultSubs) s(IPC.externalChange, 'B侧改动.md', null)
      const got = await page.evaluate(() => ((window as any).__evGot as string[]).includes('B侧改动.md'))
      if (got) break
      await page.waitForTimeout(500)
    }
    const ev = await page.evaluate(() => (window as any).__evGot as string[])
    check('vault 面:B 侧改动经 SSE 到达页面', ev.includes('B侧改动.md'))
    check('vault 面:自己的 savePage 回声按 origin 丢弃', !ev.includes('E2E笔记.md'), JSON.stringify(ev))

    await page.waitForTimeout(1200)
    await page.screenshot({ path: path.join(SHOT_DIR, 'unit-page-booted.png') })

    // 8 刷新免配对直进(令牌按 instanceId 落 localStorage)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.rb', { timeout: 45000 })
    const askedAgain = await page.evaluate(() => document.body.textContent?.includes('配对码') ?? false)
    check('刷新后免配对直进', !askedAgain)

    // 9 手机形态装 Mobile 壳(2026-08-25 用户拍板移动端对齐):index 内联脚本按
    //   `(pointer: coarse) and (max-width: 820px)` 自动写 lcl.uiMode → unit 分支装
    //   @mobile/mobileEntry(.mb-shell,无桌面 Ribbon)。⚠️ 光 setViewportSize 不带触点、
    //   媒体查询不命中(实翻)—— 必须 hasTouch 的新 context(顺带重走一遍配对流,fake 恒允许)。
    //   触屏放宽不翻回桌面是设计(真机横屏仍是手机),故不设反向断言;桌面页不受影响由 1-8 步覆盖。
    const mpage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 })
    await skipOnboarding(mpage)
    await mpage.goto(pageBase, { waitUntil: 'domcontentloaded' })
    await mpage.waitForSelector('.mb-shell', { timeout: 60000 })
    const mobileState = await mpage.evaluate(() => ({
      rb: !!document.querySelector('.rb'),
      // 互联入口的数据桥在设备页必须缺席(设备页里不套设备页;入口按 unitsList 存在性上架)
      unitsBridge: !!(window as unknown as { tangu?: { unitsList?: unknown } }).tangu?.unitsList,
    }))
    check('手机形态(coarse+窄):设备页装 Mobile 壳(.mb-shell)', true)
    check('手机形态:无桌面 Ribbon(.rb)', !mobileState.rb)
    check('设备页无 unitsList 桥(互联入口不套娃)', !mobileState.unitsBridge)
    // 9b 手机形态下对方插件同样装载并出图:插件 Space 落在移动壳的左抽屉脚部空间条
    //    (桌面是 Ribbon)。⚠️必须查页面侧痕迹,数服务端下发数是假绿(本仪器栽过)。
    await mpage.click('[aria-label="left panel"]')
    let spaceOnMobile = false
    for (let i = 0; i < 20 && !spaceOnMobile; i++) {
      await mpage.waitForTimeout(500)
      spaceOnMobile = await mpage.evaluate(() =>
        [...document.querySelectorAll('.mb-spacebar .mb-tab-label')].some((el) => (el.textContent || '').includes('远程演示空间')))
    }
    check('手机形态:对方插件 Space 上移动壳空间条(页面侧痕迹)', spaceOnMobile)
    await mpage.waitForTimeout(600)
    await mpage.screenshot({ path: path.join(SHOT_DIR, 'unit-page-mobile-spaces.png') })
    await mpage.keyboard.press('Escape').catch(() => {})
    await mpage.waitForTimeout(400)
    await mpage.screenshot({ path: path.join(SHOT_DIR, 'unit-page-mobile.png') })
    await mpage.close()

    // 10 设备页审批卡(Codex 终审 F#2):引擎对远端拒收改参数(400 REMOTE_ARGS_OVERRIDE_FORBIDDEN)、「总允许」降成单次。
    //    卡上命令只读、不给「总允许」、说明原因;批准不带 argsOverride;引擎拒了要上屏(不再静默吞掉)。
    //    另起一个 unitWeb 接可编剧假引擎(1-9 步的假引擎只回 404,起不了 run);页面钉 zh-CN(浏览器台架的语言只认 newPage locale)。
    let refuse = true
    const stub = await startStubEngine({
      sessions: [{ id: 's1', title: '远程审批会话', summary: '', model_id: 'm1', archived: false, emoji: null, agent_config: null,
        project_path: '/tmp/e2e-home/Tangu/demo', project_name: 'demo', created_at: '2026-09-27 09:00:00', updated_at: '2026-09-27 09:00:00' }],
      override: ({ path: p, method }: { path: string; method: string }) => (refuse && method === 'POST' && /^\/agent\/runs\/[^/]+\/approvals\/[^/]+$/.test(p)
        ? { __code: 400, body: { code: 'REMOTE_ARGS_OVERRIDE_FORBIDDEN', detail: 'Editing the arguments of an approval is only available on the host computer.' } }
        : undefined),
    })
    const paired2: PairedDevice[] = []
    const handle2 = await startUnitWeb({
      getEngine: () => ({ url: stub.url, token: 'ENGINE_TOKEN', remoteMark: 'E2E_REMOTE_MARK' }),
      confirmPair: async () => true,
      pairedDevices: { list: () => paired2, add: async (d) => { paired2.push(d) } },
      readPlugins: async () => [], readSpaces: async () => [],
      readConfig: async () => ({ homeDir: '/tmp/e2e-home', defaultWorkspaceDir: '/tmp/e2e-home/Tangu' }),
      writeConfig: async (patch: Record<string, unknown>) => patch,
      readProviders: async () => [], readHostFile: async () => null, readHostDir: async () => null, readHostStat: async () => null,
      meta: { instanceId: 'e2e-inst-approval', name: 'E2E 审批机', version: '9.9.9' },
      webDistDir: () => DIST, vault: () => vaultFace, log: () => {},
    }, { port: 0, bindHost: '127.0.0.1' })
    try {
      const apage = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
      await skipOnboarding(apage)
      await apage.goto(`http://unit-e2e.test:${handle2.port}`, { waitUntil: 'domcontentloaded' })
      await apage.waitForSelector('.rb', { timeout: 45000 })
      check('设备页注入 remoteCaller(远端身份)', await apage.evaluate(() => (window as any).tangu?.remoteCaller === true))
      // 进 Tangu Space → 打开那条会话 → 发一句,假引擎回放 run_bash 审批请求并挂住(= 真引擎在等审批)
      await apage.locator('.rb [title="Tangu"], .rb [aria-label="Tangu"]').first().click()
      await apage.waitForTimeout(1200)
      if (!(await apage.locator('.t2s-srow').count())) { await apage.click('.dv-edge-left').catch(() => {}); await apage.waitForTimeout(700) }
      await apage.locator('.t2s-srow', { hasText: '远程审批会话' }).first().click()
      const ta = apage.locator('.t2c-ta').first()
      for (let i = 0; i < 40 && !(await ta.isEnabled().catch(() => false)); i++) await apage.waitForTimeout(500)
      stub.script([
        // P1-K1:远程污点 run 的审批事件带 remote(调用方经 hub → 本机 unitWeb 验过),卡上多一行来源
        { type: 'approval_request', payload: { approvalId: 'ra1', name: 'run_bash', arguments: JSON.stringify({ command: 'make build' }), preview: '$ make build', reason: { kind: 'mode', mode: 'auto-edit' },
          remote: { via: 'tunnel', callerUnit: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f', callerKind: 'phone', callerName: 'E2E 手机' } } },
        { type: '__hold' },
      ])
      await ta.click()
      await ta.fill('跑一下构建')
      await apage.keyboard.press('Enter')
      await apage.waitForSelector('.approval-card', { timeout: 20000 })
      const card = await apage.evaluate(() => {
        const c = document.querySelector('.approval-card')!
        return {
          editable: !!c.querySelector('textarea.approval-edit'),
          preview: (c.querySelector('.approval-preview')?.textContent || '').trim(),
          buttons: [...c.querySelectorAll('.approval-actions button')].map((b) => (b.textContent || '').trim()),
          hint: (c.querySelector('[data-remote-readonly]')?.textContent || '').trim(),
          source: (c.querySelector('[data-approval-remote]')?.textContent || '').trim(),
        }
      })
      check('设备页审批卡:run_bash 命令只读(无编辑框),原样展示', !card.editable && card.preview === '$ make build', JSON.stringify(card))
      check('设备页审批卡:不给「本会话总是允许」,只剩批准 / 拒绝', card.buttons.length === 2 && !card.buttons.some((b) => b.includes('总是允许')), JSON.stringify(card.buttons))
      check('设备页审批卡:写明只能原样批 / 拒', card.hint.includes('只能原样批准或拒绝'), card.hint)
      check('审批卡来源行(P1-K1):来自远程会话 · 调用方设备名', card.source === '来自远程会话 · E2E 手机', card.source)
      // 引擎拒了(假引擎扮 400 REMOTE_ARGS_OVERRIDE_FORBIDDEN)→ 本地化原因上屏,卡片仍待批
      await apage.locator('.approval-card .approval-actions .btn.primary').click()
      let toast = ''
      for (let i = 0; i < 20 && !toast.includes('远程连接下不能修改审批的参数'); i++) {
        await apage.waitForTimeout(250)
        toast = await apage.evaluate(() => [...document.querySelectorAll('.ntf')].map((n) => n.textContent || '').join(' | '))
      }
      check('审批被引擎拒绝 → 本地化原因上屏(不再静默吞掉)', toast.includes('远程连接下不能修改审批的参数'), toast.slice(0, 200))
      await apage.screenshot({ path: path.join(SHOT_DIR, 'unit-page-approval.png') })
      // 放行后再点:发出去的是原样批准,不带 argsOverride
      refuse = false
      await apage.locator('.approval-card .approval-actions .btn.primary').click()
      for (let i = 0; i < 20 && !stub.seen.approvals.length; i++) await apage.waitForTimeout(250)
      const sent = stub.seen.approvals[0] || {}
      check('批准原样发出:action=approve、不带 argsOverride', sent.action === 'approve' && sent.argsOverride === undefined, JSON.stringify(sent))
      await apage.close()
    } finally {
      await handle2.close()
      stub.close()
    }

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
