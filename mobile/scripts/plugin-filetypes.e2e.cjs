/**
 * 插件复合文件(`.deck.md` / `.mindmap.md` 这类磁盘上是 .md、内容归插件管的文件)在手机本地库上的毁档防线
 * —— `npm run build && npm run e2e:pluginfiles`(mobile 目录)。
 *
 * 起因(2026-10-09 盘点):手机的库这一层只排白板,插件文件被列成普通笔记;唯一的防线是渲染层按「已加载的插件」
 * 改道。对应插件没装 / 被停用 / 被版本闸拦下 / 卸载之后,文件进笔记编辑器,一保存插件的格式就坏了。
 *
 * 真把 mobile/dist 在手机视口的 headless Chromium 里跑(本地库 = @capacitor/filesystem 的 web 实现,IndexedDB;
 * 插件经假市场真装进应用私有目录)。每种状态问三件事:
 *   ① 库这一层:listPages() 里没有它、listFiles() 里有它(索引 / 搜索 / 反链 / 改名重写全从 listPages 取);
 *   ② 点文件树里那一行:进的不是笔记编辑器(启用中 = 插件自己的视图;其余 = 一页说明,不挂编辑器);
 *   ③ 就算编辑器开了也敲一个字、等过自动保存:文件一个字节不变。
 *
 *   S1 启用中   : 点开 = 插件自己的视图
 *   S2 被停用   : 设置里关掉(amadeus.plugins.disabled)
 *   S2 被门禁拦 : manifest apiVersion 对不上
 *   S3 已卸载   : 后缀豁免要留下来(墓碑)
 *   S0 没装过   : **已知缺口,只报告不判红** —— 这台手机上从没装过对应插件(文件是云同步 / 别的设备带来的),宿主
 *                 无从知道这个后缀归插件管,文件照旧当笔记打开。怎么补(首方后缀名单 / 由商店带下来)等产品决定;
 *                 定了以后把这一段从 gap 改成 check。
 *
 * 云端库那一半(同一批后缀从 tree.pages 挪到 files)在 desktop 的 vitest:frontend/src/services/cloudBridgePluginFiles.test.ts。
 * 锚点一律 data-* / 类名,不按界面文案找元素(行名是文件名,不随语言变);语言钉 zh-CN。
 * 截图(说明页长什么样)写进 mobile/outputs/pluginfiles/。
 *
 * 负对照(2026-10-09 实跑):
 *   · 整套修复之前的 main:S1 的两条「列表」与 S2 / S3 的全部断言都红,落盘内容被改写的原文打在失败行下面;
 *   · 只关掉编辑器面板那道闸(amadeusViews 的 pluginOwned 恒 false)、库这一层照修:列表几条全绿,
 *     S2 / S3 的「点开」「一个字节没变」照红(6 条)—— 光把文件挪出页面列表不够,树上点一下照样进编辑器。
 */
const http = require('http')
const net = require('net')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const JSZip = require('jszip')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 落到 desktop */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

// ⚠️ 端口由系统现分,不写死:这台机器上常有几个会话同时跑手机台架,写死的端口撞上别人的 vite preview 时,
// 自己这份 --strictPort 起不来,而探活却打得通 —— 整轮测的是**别人那份产物**(2026-10-09 负对照时撞过:
// 结果和没修之前一模一样)。下面还会盯着 preview 进程,它一退出就报错,不等探活。
let PORT = 0
let APP_URL = ''
const pickPort = () => new Promise((res, rej) => {
  const srv = net.createServer()
  srv.once('error', rej)
  srv.listen(0, () => { const { port } = srv.address(); srv.close(() => res(port)) })
})
const CDN = 'https://market-cdn.e2e.test'
const SHOTS = path.resolve(__dirname, '../outputs/pluginfiles') // 已 gitignore
const DECK_ID = 'e2e-deck'
const GATED_ID = 'e2e-gated'

// 卡组格式照 forsion-plugin-flashcards 的 serializeDeck 写:frontmatter 里一行 JSON、HTML 注释当卡片标记、
// Q:/A: 逐行 —— 笔记编辑器回写时最容易动到的三样都在。
const PAYLOAD = (name) => `---\ndeck: ${name}\nfsrs: {"c1":{"d":5.1,"s":3.2,"due":"2026-10-12T00:00:00.000Z"}}\n---\n\n<!-- card:c1 -->\nQ: 什么是 *FSRS*?\nA: 一种间隔重复算法\n<!-- card:c2 -->\nQ: 1 + 1 = ?\nA: 2\n`
/** 状态 → 文件(行名取文件名里那段中文,台架按它找树上的行)。 */
const FILES = {
  enabled: { path: 'E2E启用.e2edeck.md', stem: 'E2E启用' },
  gated: { path: 'E2E门禁.e2egated.md', stem: 'E2E门禁' },
  never: { path: 'E2E没装过.deck.md', stem: 'E2E没装过' },
}
const NOTE = { path: 'E2E普通笔记.md', stem: 'E2E普通笔记' }

const DECK_MAIN = `
ctx.registerFileType({
  id: 'deck', extensions: ['.e2edeck.md'], title: 'E2E deck',
  mount(el, f) {
    const box = document.createElement('div')
    box.setAttribute('data-e2e-deck-view', f.filePath)
    box.textContent = 'E2E deck view'
    el.appendChild(box)
    return () => box.remove()
  },
})
`
const card = (id) => ({ id, type: 'amadeus-plugin', source: 'zip', name: id, summary: id, author: 'e2e', installSlug: id, downloads: 1, latestVersion: '1.0.0', tags: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' })

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) { const exe = path.join(root, d, rel); if (fs.existsSync(exe)) return exe }
    }
  }
  for (const exe of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(exe)) return exe
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}
const ping = () => new Promise((res) => {
  const req = http.get(APP_URL, (r) => { res(r.statusCode === 200); r.resume() })
  req.on('error', () => res(false)); req.setTimeout(1500, () => { req.destroy(); res(false) })
})
async function zipOf(entries) {
  const z = new JSZip()
  for (const [n, c] of Object.entries(entries)) z.file(n, c)
  return Buffer.from(await z.generateAsync({ type: 'uint8array' }))
}

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }
  const zips = {
    [DECK_ID]: await zipOf({
      'manifest.json': JSON.stringify({ id: DECK_ID, name: 'E2E Deck', version: '1.0.0', apiVersion: 1, fileExtensions: ['.e2edeck.md'] }),
      'main.js': DECK_MAIN,
    }),
    // apiVersion 对不上 = 门禁拦下(listPlugins 列出为 blocked,代码不读不发)。它声明的后缀照样要认。
    [GATED_ID]: await zipOf({
      'manifest.json': JSON.stringify({ id: GATED_ID, name: 'E2E Gated', version: '1.0.0', apiVersion: 99, fileExtensions: ['.e2egated.md'] }),
      'main.js': 'ctx.registerFileType({ id: "g", extensions: [".e2egated.md"], title: "g", mount() {} })',
    }),
  }

  PORT = await pickPort()
  APP_URL = `http://localhost:${PORT}/`
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let previewErr = ''
  let previewExit = null
  preview.stderr.on('data', (d) => { previewErr += String(d) })
  preview.on('exit', (code) => { previewExit = code })
  const killPreview = () => { try { process.kill(-preview.pid, 'SIGTERM') } catch { try { preview.kill() } catch { /* 已退出 */ } } }

  let browser = null
  const fails = []
  let gapMode = false // S0(已知缺口)期间:照常观测、照常打印,但不计入失败
  const check = (ok, name, extra) => {
    if (!ok && !gapMode) fails.push(name)
    console.log(`${ok ? 'PASS' : gapMode ? 'GAP ' : 'FAIL'}  ${name}${extra ? `  | ${extra}` : ''}`)
  }
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (previewExit !== null) throw new Error(`vite preview 退出了(code=${previewExit})\n${previewErr.slice(-800) || '(无 stderr)'}`)
      up = await ping()
    }
    if (!up) throw new Error(`vite preview 没起来\n${previewErr.slice(-800) || '(无 stderr)'}`)

    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    // ⚠️ 语言钉 zh-CN 必须走 context 的 locale(chromium --lang 对浏览器台架无效)
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'zh-CN' })
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('forsion_token', 'e2e-pluginfiles')
        localStorage.setItem('amadeus_vault_mode', 'local')
      } catch { /* ignore */ }
    })
    const page = await ctx.newPage()
    page.on('dialog', (d) => { void d.accept() })
    // 分诊用:页面里的异常与告警(网络类的不算 —— 台架把 /api 全掐了)。「库这一层」红的时候连同宿主清点到的后缀一起打出来。
    const pageLog = []
    page.on('pageerror', (e) => pageLog.push(`pageerror: ${e.message.slice(0, 200)}`))
    page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource|net::ERR/.test(m.text())) pageLog.push(`${m.type()}: ${m.text().slice(0, 200)}`) })
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    // ⚠️ 后注册先匹配:假市场必须写在 abort 之后。
    await page.route('**/api/market/**', (r) => {
      const u = new URL(r.request().url())
      const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      let m
      if (u.pathname === '/api/market/items') return json({ items: [card(DECK_ID), card(GATED_ID)] })
      if ((m = /^\/api\/market\/items\/([^/]+)\/install$/.exec(u.pathname))) return json({ type: 'amadeus-plugin', installSlug: m[1], downloadUrl: `${CDN}/${m[1]}.zip`, source: 'zip' })
      if ((m = /^\/api\/market\/items\/([^/]+)$/.exec(u.pathname))) return json({ ...card(m[1]), readme: '' })
      return json({}, 404)
    })
    await page.route(`${CDN}/**`, (r) => {
      const body = zips[path.basename(new URL(r.request().url()).pathname, '.zip')]
      return body
        ? r.fulfill({ status: 200, body, headers: { 'content-type': 'application/zip', 'access-control-allow-origin': '*', 'content-length': String(body.length) } })
        : r.fulfill({ status: 404, body: 'no' })
    })

    const cdp = await ctx.newCDPSession(page)
    const tap = async (locator, what) => {
      await locator.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
      await locator.first().scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {})
      await page.waitForTimeout(150)
      const b = await locator.first().boundingBox({ timeout: 4000 }).catch(() => null)
      if (!b) throw new Error(`目标不可见: ${what}`)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
      await new Promise((r) => setTimeout(r, 60))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(500)
    }
    const boot = async () => {
      await page.waitForSelector('.mb-topbar [aria-label="more"]', { timeout: 30_000 })
      await page.waitForTimeout(3500) // 工作区预热(启动后 ~1.2s 读库)+ 插件装载
    }
    const reload = async () => { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }); await boot() }
    const lists = () => page.evaluate(async () => ({ pages: await window.amadeus.listPages(), files: await window.amadeus.listFiles() }))
    const read = (p) => page.evaluate((x) => window.amadeus.readTextFile(x), p)
    /** ① 库这一层。 */
    const checkListed = async (label, f) => {
      const l = await lists()
      check(!l.pages.includes(f.path), `${label}:不在页面列表里`, l.pages.includes(f.path) ? `listPages 含 ${f.path}` : '')
      check(l.files.includes(f.path), `${label}:在文件列表里(树上还看得见)`, l.files.includes(f.path) ? '' : `listFiles = ${JSON.stringify(l.files)}`)
      if (l.pages.includes(f.path) && !gapMode) {
        const declared = await page.evaluate(async () => (await window.amadeus.listPlugins()).map((p) => `${p.id}=${(p.fileExtensions || []).join('|')}`))
        console.log(`      各插件 manifest 声明的后缀: ${declared.join(', ') || '(没有插件)'}`)
        if (pageLog.length) console.log(`      页面日志(末 6 条):\n        ${pageLog.slice(-6).join('\n        ')}`)
      }
    }
    /** 主区是不是装着这份文件的笔记编辑器(标题控件的值 = 文件名去掉 .md)。 */
    const editorTitle = () => page.evaluate(() => {
      const t = document.querySelector('.amx-doc input, .amx-doc textarea, .amx-doc [contenteditable]')
      return ((t && ('value' in t ? t.value : t.textContent)) || '').trim()
    })
    const enterAmadeus = async () => {
      if (!(await page.locator('.mb-drawer--left.open').count())) await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '左抽屉')
      await tap(page.locator('.mb-drawer--left [data-space="amadeus"]'), 'Amadeus space')
      await page.waitForTimeout(900)
    }
    /** ② + ③:点树上那一行 → 进没进笔记编辑器;进了就敲一个字、等过自动保存 → 文件变没变。 */
    const tapAndProbe = async (label, f, expectView) => {
      const before = await read(f.path)
      if (!(await page.locator('.mb-drawer--left.open').count())) await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '左抽屉')
      const row = page.locator('.mb-drawer--left .t2s-srow', { hasText: f.stem }).first()
      const there = await row.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false)
      if (!there) {
        const rows = await page.locator('.mb-drawer--left .t2s-srow').allInnerTexts().catch(() => [])
        check(false, `${label}:树上有这一行`, `现有行: ${rows.map((r) => r.trim()).join(' / ').slice(0, 200)}`)
        return
      }
      await tap(row, `${f.stem} 行`)
      await page.waitForTimeout(1500)
      const title = await editorTitle()
      const inEditor = title.includes(f.stem)
      if (expectView) {
        const mounted = await page.locator(`[data-e2e-deck-view="${f.path}"]`).count()
        check(mounted > 0 && !inEditor, `${label}:点开 = 插件自己的视图`, `插件视图 ${mounted} 个,编辑器标题「${title}」`)
      } else {
        // 不止「没进编辑器」:得真有那页说明(否则「什么都没发生」也算过)。正文编辑区一个都不该挂着。
        const note = await page.locator(`[data-plugin-owned-file="${f.path}"]`).count()
        const editors = await page.locator('.ProseMirror[contenteditable="true"]').count()
        check(!inEditor && note > 0 && editors === 0, `${label}:点开 = 一页说明,没有挂笔记编辑器`, `说明页 ${note} 个,编辑区 ${editors} 个${inEditor ? `,编辑器标题「${title}」` : ''}`)
      }
      if (inEditor) {
        // 已经进了编辑器:照用户会做的,点进正文敲一个字,等过自动保存。
        // ⚠️ 正文的 ProseMirror 不在 .amx-doc 里面(那里只有标题和属性区),按 contenteditable 找。
        const body = page.locator('.ProseMirror[contenteditable="true"]').last()
        await body.tap({ timeout: 4000 }).catch(() => {})
        await page.keyboard.type(' x').catch(() => {})
        await page.waitForTimeout(600)
        const focused = await page.evaluate(() => !!document.activeElement?.classList.contains('ProseMirror'))
        if (!focused) check(false, `${label}:(台架)字没敲进编辑器,下面那条「没变」不作数`)
        await page.waitForTimeout(3000)
      }
      const after = await read(f.path)
      check(after === before, `${label}:文件一个字节没变`, after === before ? '' : `落盘内容被改写成:\n${String(after).split('\n').map((l) => `          │ ${l}`).join('\n')}`)
      if (after !== before) await page.evaluate(([p, t]) => window.amadeus.writeTextFile(p, t), [f.path, before]) // 复原,后面的状态各测各的
    }

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await boot()

    // ── S0 什么插件都没装:种文件 ─────────────────────────────────────────────────────────
    await page.evaluate(async ([files, note, payloads]) => {
      for (let i = 0; i < files.length; i++) await window.amadeus.writeTextFile(files[i], payloads[i])
      await window.amadeus.writeTextFile(note, '# 普通笔记\n\n正文\n')
    }, [Object.values(FILES).map((f) => f.path), NOTE.path, Object.values(FILES).map((f) => PAYLOAD(f.stem))])
    await reload() // 种完重开:工作区预热早把空库读进 store 了(note-open.e2e 同一个坑)
    const l0 = await lists()
    check(l0.pages.includes(NOTE.path), '防空过:普通笔记在页面列表里', JSON.stringify(l0.pages))
    gapMode = true
    await checkListed('S0 没装过', FILES.never)
    await enterAmadeus()
    await tapAndProbe('S0 没装过', FILES.never, false)
    gapMode = false

    // ── S1 装上两个插件(一个能跑、一个被门禁拦下) ───────────────────────────────────────────
    const installed = await page.evaluate(async (ids) => {
      const out = []
      for (const id of ids) out.push(await window.tangu.marketInstall(id).then((r) => r.ok, (e) => String(e && e.message)))
      return out
    }, [DECK_ID, GATED_ID])
    check(installed.every((x) => x === true), '两个插件装进应用私有目录', JSON.stringify(installed))
    await reload()
    const plugins = await page.evaluate(async () => (await window.amadeus.listPlugins()).map((p) => `${p.id}:${p.blocked || 'ok'}`))
    check(plugins.includes(`${DECK_ID}:ok`) && plugins.includes(`${GATED_ID}:api`), '防空过:一个能跑、一个被门禁拦下', plugins.join(','))
    await checkListed('S1 启用中', FILES.enabled)
    await enterAmadeus()
    await tapAndProbe('S1 启用中', FILES.enabled, true)

    // ── S2 关掉能跑的那个;被门禁拦下的那个本来就没在跑 ──────────────────────────────────────
    await page.evaluate((id) => localStorage.setItem('amadeus.plugins.disabled', JSON.stringify([id])), DECK_ID)
    await reload()
    const viewGone = await page.locator('[data-e2e-deck-view]').count()
    check(viewGone === 0, '防空过:关掉后插件视图不在了', `剩 ${viewGone}`)
    await checkListed('S2 被停用', FILES.enabled)
    await checkListed('S2 被门禁拦下', FILES.gated)
    await enterAmadeus()
    await tapAndProbe('S2 被停用', FILES.enabled, false)
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, 'plugin-owned-placeholder.png') })
    await tapAndProbe('S2 被门禁拦下', FILES.gated, false)

    // ── S3 卸载:后缀豁免留下来 ───────────────────────────────────────────────────────────
    await page.evaluate((id) => window.amadeus.uninstallPlugin(id), DECK_ID)
    await reload()
    const left = await page.evaluate(async () => (await window.amadeus.listPlugins()).map((p) => p.id))
    check(!left.includes(DECK_ID), '防空过:插件已卸载', left.join(','))
    await checkListed('S3 已卸载', FILES.enabled)
    await enterAmadeus()
    await tapAndProbe('S3 已卸载', FILES.enabled, false)

    // 普通笔记照常进编辑器、照常能改(防线没有误伤)。
    if (!(await page.locator('.mb-drawer--left.open').count())) await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '左抽屉')
    await tap(page.locator('.mb-drawer--left .t2s-srow', { hasText: NOTE.stem }), '普通笔记行')
    await page.waitForTimeout(1500)
    check((await editorTitle()).includes(NOTE.stem), '普通笔记照常进笔记编辑器', await editorTitle())
  } catch (e) {
    check(false, '台架异常', String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }
  console.log(`\n${fails.length ? `✗ ${fails.length} 项失败` : '✓ 全部通过'}`)
  process.exit(fails.length ? 1 : 0)
}

main()
