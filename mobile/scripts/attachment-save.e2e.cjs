/**
 * 移动端本地库「存附件」e2e —— `npm run e2e:attachsave`(mobile 目录,先 npm run build)。
 *
 * 起因(2026-09-16):本地库模式下 window.amadeus.saveAttachment 一律抛 `ReferenceError: process is not defined`
 * (attachmentPaths 把 vault 相对路径喂给 path-browserify.relative → 回落 process.cwd(),WebView 里没有 process)。
 * 它是新建白板/仪表盘/Base、编辑器粘贴图片与文件、/图片、封面上传、媒体截帧、拖入导入共用的落盘口:
 * 白板/仪表盘弹「新建…失败:process is not defined」,编辑器那几条被 catch 吞掉 = 粘贴了什么都不插。
 * 云端库(移动端缺省)走 web 的 cloudPaths、pasteImagesToPage 走 saveAsset(/vault 绝对根),都不经这里。
 * 纯函数层另有 `npm run test:attachpaths`(无 process 沙箱,不用 build)。
 *
 * 断言(本地库,中文界面):
 *  A. 桥层:saveAttachment 库根 vault / 嵌套页 same / attachments / 跨目录 vault → pageRel 正确且真落盘;
 *     saveAsset 同跑一发作对照(修前修后都该绿)。
 *  B. 左抽屉文件树空白处长按(contextmenu)→「新建白板」「新建仪表盘」→ 命名确定 → 不弹失败框、文件进库、视图打开。
 *  C. 编辑器里粘贴 PNG → 落进 attachments/ 且插入图片;粘贴 PDF → 落盘且插入 ![[…]] 嵌入。
 */
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 借 desktop 的 */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()
const { tinyPdf } = require('../../desktop/scripts/lib/tiny-pdf.cjs')

const PORT = 5299 // 避开 dev 5274 / boot 5279 / unitsentry 5281 / noteopen 5283 / editorbar 5285 / drawerdrag 5289 / spacetrap 5291 / fileback 5293 / homeback 5297
const URL = `http://localhost:${PORT}/`
const NOTE = 'e2e附件'
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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
const ping = () => new Promise((res) => {
  const req = http.get(URL, (r) => { res(r.statusCode === 200); r.resume() })
  req.on('error', () => res(false)); req.setTimeout(1500, () => { req.destroy(); res(false) })
})

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let previewErr = ''
  preview.stderr.on('data', (d) => { previewErr += String(d) })
  const killPreview = () => { try { process.kill(-preview.pid, 'SIGTERM') } catch { try { preview.kill() } catch { /* 已退出 */ } } }

  let browser = null
  const fails = []
  const ok = (name, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
    if (!cond) fails.push(`${name}${detail ? ' | ' + detail : ''}`)
  }
  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await ping() }
    if (!up) throw new Error(`vite preview 没起来\n${previewErr.slice(-500)}`)

    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    // 按中文文案点菜单 → 钉 zh(浏览器台架 `--lang` 无效,只认 newContext 的 locale)。
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'zh-CN' })
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('forsion_token', 'e2e-attachsave')
        localStorage.setItem('amadeus_vault_mode', 'local') // 本地库(Capacitor FS 的 web 实现 = IndexedDB)
      } catch { /* ignore */ }
    })
    const page = await ctx.newPage()
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    page.on('pageerror', (e) => fails.push(`未捕获异常: ${e.message}`))
    // 白板/仪表盘失败走 window.alert —— 记原话(修前就是用户看到的那句)。
    const alerts = []
    page.on('dialog', (d) => { alerts.push(d.message()); d.dismiss().catch(() => {}) })
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(4000)

    // 仪表盘(.dashboard.md)在 listPages 里,白板和二进制附件在 listFiles 里 —— 两边一起看。
    const vaultPaths = () => page.evaluate(async () => [...(await window.amadeus.listFiles()), ...(await window.amadeus.listPages())])

    // ── A. 桥层 ──
    const a = await page.evaluate(async () => {
      const b = new Uint8Array([37, 80, 68, 70]) // "%PDF"
      const run = async (fn) => { try { return { v: await fn() } } catch (e) { return { err: String((e && e.message) || e) } } }
      const P = 'e2eA/deep/page.md'
      return {
        root: await run(() => window.amadeus.saveAttachment('', 'e2e-root.pdf', b, { mode: 'vault', folder: '' })),
        same: await run(() => window.amadeus.saveAttachment(P, 'e2e-same.pdf', b, { mode: 'same', folder: '' })),
        att: await run(() => window.amadeus.saveAttachment(P, 'e2e-att.pdf', b, { mode: 'attachments', folder: 'assets' })),
        vault: await run(() => window.amadeus.saveAttachment(P, 'e2e-vault.pdf', b, { mode: 'vault', folder: 'e2eAssets' })),
        asset: await run(() => window.amadeus.saveAsset(P, 'e2e-asset.png', b)),
        files: await window.amadeus.listFiles(),
      }
    })
    const wrote = (x, pageRel, file) => !!x.v && x.v.pageRel === pageRel && a.files.includes(file)
    ok('A1 库根 vault(新建白板/仪表盘/Base 同款调用)', wrote(a.root, 'e2e-root.pdf', 'e2e-root.pdf'), JSON.stringify(a.root))
    ok('A2 嵌套页 same', wrote(a.same, 'e2e-same.pdf', 'e2eA/deep/e2e-same.pdf'), JSON.stringify(a.same))
    ok('A3 嵌套页 attachments(编辑器粘贴的缺省落位)', wrote(a.att, 'attachments/e2e-att.pdf', 'e2eA/deep/attachments/e2e-att.pdf'), JSON.stringify(a.att))
    ok('A4 嵌套页 vault 跨目录 → ../../ 相对链接', wrote(a.vault, '../../e2eAssets/e2e-vault.pdf', 'e2eAssets/e2e-vault.pdf'), JSON.stringify(a.vault))
    ok('A5 对照:saveAsset(绝对根,不经 attachmentPaths,修前也该绿)', /^\.amadeus\/e2e-asset-.+\.png$/.test((a.asset && a.asset.v) || ''), JSON.stringify(a.asset))

    // ⚠️ 种完笔记必须重开:newPage 走桥、绕过 pageStore,工作区预热早把空库读进去了(同 note-open)。
    await page.evaluate(async (n) => { await window.amadeus.newPage(`${n}.md`) }, NOTE)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(4000)

    const cdp = await ctx.newCDPSession(page)
    const tap = async (locator) => {
      const b = await locator.boundingBox()
      if (!b) throw new Error('目标不可见')
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
      await new Promise((r) => setTimeout(r, 60))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.waitForTimeout(400)
    }
    const ensureDrawer = async () => {
      if (await page.$('.mb-drawer--left.open')) return
      await tap(page.locator('.mb-topbar .mb-icon-btn').first())
      await page.waitForTimeout(600)
    }
    const view = () => page.evaluate(() => document.querySelector('.mb-main .mb-view')?.getAttribute('data-view') ?? null)

    // 进 Note Space(按 data-space 选,显示名会随语言变)。
    await ensureDrawer()
    const spaces = await page.$$eval('.mb-drawer-foot .mb-tab', (els) => els.map((e) => e.dataset.space || ''))
    const idx = spaces.indexOf('amadeus')
    if (idx < 0) throw new Error(`左抽屉底部没有 amadeus space tab(现有: ${spaces.join(',')})`)
    await tap(page.locator(`.mb-drawer-foot .mb-tab >> nth=${idx}`))
    await page.waitForTimeout(900)

    // ── B. 文件树新建 ──
    /** 文件树空白处长按 → 根菜单点 label → 命名确定。返回这一下弹出的失败框原话。 */
    const createFromTree = async (label, name) => {
      await ensureDrawer()
      const n0 = alerts.length
      const hasTree = await page.evaluate(() => {
        const el = document.querySelector('.mb-drawer--left .t2s-scroll')
        if (!el) return false
        const r = el.getBoundingClientRect()
        // 安卓 WebView 长按 = contextmenu;派发到滚动容器本身(处理器只认真空白,行上各有自己的菜单)。
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.bottom - 30 }))
        return true
      })
      if (!hasTree) throw new Error('左抽屉里没有文件树(.t2s-scroll)')
      const item = page.locator('.ctx-menu button', { hasText: label }).first()
      if (!(await item.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false))) {
        const seen = await page.$$eval('.ctx-menu button', (els) => els.map((e) => e.textContent.trim()))
        throw new Error(`根菜单里没有「${label}」(现有: ${seen.join(' / ') || '菜单没弹'})`)
      }
      await item.click()
      const input = page.locator('.dialog-input').first()
      await input.waitFor({ state: 'visible', timeout: 3000 })
      await input.fill(name)
      await page.locator('.dialog-btn[data-primary]').first().click()
      await page.waitForTimeout(2500)
      return alerts.slice(n0)
    }

    const drawAlerts = await createFromTree('新建白板', 'e2e白板')
    ok('B1 文件树 → 新建白板:不弹失败框', drawAlerts.length === 0, JSON.stringify(drawAlerts))
    ok('B2 白板文件落盘', (await vaultPaths()).includes('e2e白板.excalidraw.md'))
    ok('B3 建成即打开白板视图', (await view()) === 'amadeus-drawing', String(await view()))

    const dashAlerts = await createFromTree('新建仪表盘', 'e2e仪表盘')
    ok('B4 文件树 → 新建仪表盘:不弹失败框', dashAlerts.length === 0, JSON.stringify(dashAlerts))
    ok('B5 仪表盘文件落盘', (await vaultPaths()).includes('e2e仪表盘.dashboard.md'))
    ok('B6 建成即打开仪表盘视图', (await view()) === 'dashboard', String(await view()))

    // ── C. 编辑器粘贴 ──
    await ensureDrawer()
    const row = page.locator('.mb-drawer--left .t2s-srow', { hasText: NOTE }).first()
    if (!(await row.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false))) throw new Error(`抽屉里没有「${NOTE}」行`)
    await tap(row)
    await page.waitForTimeout(1500)
    if ((await view()) !== 'amadeus-editor') throw new Error(`点了「${NOTE}」主区却是 ${await view()}`)

    /** 往正文派发一次带文件的 paste(同 desktop block-file-ops.check 的做法);返回 null = 编辑器接住了。 */
    const paste = (file) => page.evaluate(({ name, type, b64 }) => {
      const pm = document.querySelector('.mb-main .ProseMirror')
      if (!pm) return '主区没有正文编辑器'
      pm.focus()
      const dt = new DataTransfer()
      dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type }))
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      pm.dispatchEvent(ev)
      return ev.defaultPrevented ? null : 'paste 没被编辑器接住'
    }, file)
    /** 粘贴是异步落盘:轮询到库里出现以 suffix 结尾的文件。 */
    const waitFile = async (suffix) => {
      for (let i = 0; i < 20; i++) {
        const hit = (await vaultPaths()).find((f) => f.endsWith(suffix))
        if (hit) return hit
        await page.waitForTimeout(250)
      }
      return null
    }
    const bodyHas = (s) => page.evaluate((s) => (document.querySelector('.mb-main .ProseMirror')?.innerHTML || '').includes(s), s)

    ok('C0 编辑器接住了 PNG 粘贴(否则下面的红绿不作数)', (await paste({ name: 'e2e-paste.png', type: 'image/png', b64: PNG_B64 })) === null)
    const pngAt = await waitFile('e2e-paste.png')
    ok('C1 粘贴 PNG → 落进 attachments/', pngAt === 'attachments/e2e-paste.png', String(pngAt))
    await page.waitForTimeout(500)
    ok('C2 粘贴 PNG → 正文插入图片', await page.evaluate(() => [...document.querySelectorAll('.mb-main .ProseMirror img')].some((i) => (i.getAttribute('src') || '').includes('e2e-paste.png'))))

    const pdf = Buffer.from(tinyPdf(['e2e attachsave'])).toString('base64')
    ok('C3 编辑器接住了 PDF 粘贴', (await paste({ name: 'e2e-paste.pdf', type: 'application/pdf', b64: pdf })) === null)
    const pdfAt = await waitFile('e2e-paste.pdf')
    ok('C4 粘贴 PDF → 落进 attachments/', pdfAt === 'attachments/e2e-paste.pdf', String(pdfAt))
    await page.waitForTimeout(800)
    ok('C5 粘贴 PDF → 正文插入 ![[e2e-paste.pdf]] 嵌入', await bodyHas('e2e-paste.pdf'))
  } catch (e) {
    fails.push(String((e && e.message) || e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }
  if (fails.length) { console.error('❌ e2e:attachsave\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1) }
  console.log('✅ e2e:attachsave —— 本地库存附件:桥层四种落位 + 新建白板/仪表盘 + 编辑器粘贴图片/PDF 全部落盘')
}

main()
