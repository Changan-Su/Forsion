/**
 * 笔记内嵌图片「显示 + 存盘往返」台架 —— `npm run build && npm run e2e:localasset`(mobile 目录)。
 *
 * 起因(2026-10-09):代码里三处注释说「图片(amadeus-asset://)由原生 Android 拦截读同一 vault」,但安卓原生代码里
 * 没有任何请求拦截器(android/app/src/main 下没有 shouldInterceptRequest,git 历史上也从没有过),页面的内容安全
 * 策略也不放这个协议。顺着查下去,问题不止本地库 —— 三个缺陷,同日修掉,本台架留作回归:
 *   A. 冷启动就在本地库:地址是 `amadeus-asset://v/…`,被 img-src 拦下,编辑器显示「图片无法加载」。
 *   B. 先在云端库启动,再切到本地库:资源地址的构建器是模块级的,云桥装上之后没人撤 —— 本地库的图片被指到云端库的
 *      资源端点,并且存盘时这条带令牌的云端地址被写进了本地笔记。
 *   C. 云端库(手机缺省;网页版是同一座桥):一存盘,`![](.amadeus/x.png)` 就被写成
 *      `![](https://…/asset?ref=…&page=…&at=<令牌>)` —— 令牌 24 小时过期后图片失联。根因:共享接缝
 *      desktop/shared/amadeus/assets.ts 只有去程(构建)没有回程(解析)。
 * 修法:接缝改成成对的「构建 + 解析」(云桥 / 设备网页桥各补解析);手机本地桥装自己的一对(src/amadeus/localAssets.ts),
 * 每次建桥都重装。纯函数的钉子:desktop 的 shared/amadeus/assets.test.ts、frontend/src/services/cloudAssetsRoundtrip.test.ts、
 * frontend/src/services/mobileLocalAssets.test.ts。
 *
 * 真把 mobile/dist 在手机视口的 headless Chromium 里跑,四个场景,每个都:打开一篇带图的笔记 → 看编辑器里那张
 * <img> 的地址、加载出来没有、有没有策略违规 → 在「后文」段末敲一个字、等过自动保存 → 看落盘的那一行还是不是
 * 页相对路径。A / B / C 的笔记里是 `![](.amadeus/x.png)`;
 *   D. 云端库里一篇**已经被写坏**的笔记(图片行是另一端写进去的地址:接口源不同、令牌过期)。显示时按当前的
 *      接口源与令牌重拼(toDisplayMarkdown),图当场显示得出;**只是打开不写盘**;动一个字存盘后换回页相对路径。
 *
 * 2026-10-10 加的三个场景 —— 引用指到**页目录之外**(笔记在 `子夹/`,图片在库根的 `attachments/`):
 *   E. 本地库:从库根的笔记复制一张图(图片节点的显示地址)贴进 `子夹/` 下的笔记 → 落盘那一行必须是 `../attachments/…`;
 *      冷启动重开,图还得加载得出来;再动一个字,那一行不变。
 *   F. 云端库:同 E。
 *   G. 云端库里本来就是 `../` 写法的笔记(附件放固定文件夹时产品自己写的),并且 `子夹/attachments/` 下有一张同名的
 *      另一张图(1×1):显示的必须是库根那张(2×2);动一个字,那一行不变。
 *   此前:存盘写成库内路径写法 `![](attachments/pic.png)`(共享接缝的 relFrom 不产出 `../`),重开一律按页相对拼成
 *   `子夹/attachments/pic.png` —— 本地文件服务没有兜底、云端服务端找不到;云端对带 `..` 的 ref 还一律拒收,`../` 写法本身也显示不出;
 *   地址带着 page 时服务端先按页目录再拼一遍,同路径的另一张图会顶替正主。
 *   ⚠️ 假云端的 /asset 照服务端的顺序对着文件表找(cloudResolve)。别改回「有笔记就对任何 ref 送图」:指错了文件的地址也会是绿的。
 *
 * ⚠️ 这是浏览器台架:证明得了页面这一层把地址指到了哪里、落盘写了什么;**证明不了安卓原生层**。本地库的图片地址
 *    在安卓上是 Capacitor 本地文件服务(`https://localhost/_capacitor_file_/<应用私有目录>/vault/…`);浏览器里
 *    文件系统是 IndexedDB,拿到的库根只是 `/DATA/vault` 这个路径、没人服务它 —— 台架 route 住它、用 readVaultBytes
 *    回填字节。原生那一层真能不能服务(路径、百分号解码、Range)要上模拟器 / 真机看。
 * 负对照(实跑过,修之前的产物):A 红 2 条(图没加载、策略违规),B 红 3 条(图没加载、去云端要了、落盘是云端地址),
 *    C 红 1 条(落盘是云端地址);D 在加显示侧还原之前红 3 条(图没加载、地址没重拼、去旧源要了图)。
 *    E / F / G(2026-10-10,修之前的产物实跑):E 红 3 条、F 红 3 条(落盘是库内路径写法、重开图没加载、再存一遍仍是它),G 红 1 条(图没加载)。
 */
const http = require('http')
const net = require('net')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 落到 desktop */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

const NOTE = { path: 'E2E图片笔记.md', stem: 'E2E图片笔记' }
// 2×2 的红色 PNG(naturalWidth 判加载用;1×1 也行,2×2 免得和占位图混)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4EIwDiqEF8hAN5vBf0dRNNOAAAAAElFTkSuQmCC'

// 1×1 的 PNG:「同路径的另一个文件」。显示成它 naturalWidth = 1,显示成库根那张 = 2。
const PNG1_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const ROOTNOTE = { path: 'E2E根笔记.md', stem: 'E2E根笔记' }
const SUB = { dir: '子夹', path: '子夹/E2E图片笔记.md', stem: 'E2E图片笔记' }
const ROOTPIC = 'attachments/pic.png'

/** 假云端的 GET /asset 怎么找文件 —— 镜像服务端(server 仓 microserver/amadeus/routes.ts 与 lib/paths.ts 的 normalizePath;
 *  2026-10-10 对着真路由 + PGlite 逐条核过):先「page 的目录 + ref」,再把 ref 当库内路径精确找,ref 不含 `/` 时才全库按文件名找;
 *  路径里有 `.` / `..` 段一律拒收(不是折叠)。 */
function cloudResolve(u, paths) {
  const norm = (p) => {
    const t = String(p ?? '').normalize('NFC').trim().replace(/\/+$/, '')
    if (!t || t.startsWith('/') || t.includes('\\') || t.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return null
    return t
  }
  const ref = u.searchParams.get('ref') ?? ''
  const cands = []
  const page = norm(u.searchParams.get('page'))
  if (page) {
    const dir = page.includes('/') ? page.slice(0, page.lastIndexOf('/')) : ''
    const c = norm(dir ? `${dir}/${ref}` : ref)
    if (c) cands.push(c)
  }
  const exact = norm(ref)
  if (exact && !cands.includes(exact)) cands.push(exact)
  for (const c of cands) if (paths.includes(c)) return c
  if (ref.includes('/')) return null
  return [...paths].sort().find((p) => !p.split('/').some((seg) => seg.startsWith('.')) && p.split('/').pop().toLowerCase() === ref.toLowerCase()) ?? null
}

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
// 端口由系统现分 + 盯着 preview 进程:写死端口撞上别的会话的 vite preview 时,测到的是别人那份产物。
const pickPort = () => new Promise((res, rej) => {
  const srv = net.createServer()
  srv.once('error', rej)
  srv.listen(0, () => { const { port } = srv.address(); srv.close(() => res(port)) })
})

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }
  const port = await pickPort()
  const appUrl = `http://localhost:${port}/`
  const ping = () => new Promise((res) => {
    const req = http.get(appUrl, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false)); req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
  const preview = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let previewErr = ''
  let previewExit = null
  preview.stderr.on('data', (d) => { previewErr += String(d) })
  preview.on('exit', (code) => { previewExit = code })
  const killPreview = () => { try { process.kill(-preview.pid, 'SIGTERM') } catch { try { preview.kill() } catch { /* 已退出 */ } } }

  let browser = null
  const fails = []
  const check = (ok, name, extra) => {
    if (!ok) fails.push(name)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  | ${extra}` : ''}`)
  }

  /** 一个全新的浏览器上下文(存储互不串)+ 假云端 + 手势。cloud = { files: { 库内路径: 正文字符串 | 图片 Buffer }, puts: [{ path, content }], seq }。 */
  const openCtx = async (startSide, cloud) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'zh-CN' })
    await ctx.addInitScript((side) => {
      try {
        localStorage.setItem('forsion_tangu_onboarding_done', '1')
        localStorage.setItem('forsion_token', 'e2e-localasset')
        if (!localStorage.getItem('amadeus_vault_mode')) localStorage.setItem('amadeus_vault_mode', side)
      } catch { /* ignore */ }
      // 尽早挂上:策略违规事件只派发一次,不回放。
      window.__csp = []
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ d: e.effectiveDirective, uri: String(e.blockedURI || '').slice(0, 120) }))
    }, startSide)
    const page = await ctx.newPage()
    page.on('dialog', (d) => { void d.accept() })
    const cloudAssetHits = []
    const localAssetHits = []
    const oldOriginHits = []
    // 本地库的图片地址(浏览器平台上是 `/DATA/vault/<库内路径>`,见头注):没人服务,这里用库里的真字节回填。
    await page.route('**/DATA/vault/**', async (r) => {
      const rel = decodeURIComponent(new URL(r.request().url()).pathname.split('/DATA/vault/')[1] || '')
      localAssetHits.push(rel)
      const b64 = await page.evaluate(async (p) => {
        const bytes = await window.amadeus.readVaultBytes(p).catch(() => null)
        return bytes ? btoa(String.fromCharCode(...bytes)) : null
      }, rel).catch(() => null)
      return b64 ? r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(b64, 'base64') }) : r.fulfill({ status: 404, body: '' })
    })
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    // 假云端(场景 B 用;⚠️ 后注册先匹配,必须写在 abort 之后):一个空的云端库,资源端点记下谁来要过什么。
    await page.route('**/api/amadeus/**', (r) => {
      const u = new URL(r.request().url())
      const json = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (u.pathname.endsWith('/amadeus/vaults')) return json({ vaults: [{ id: 'cloud-v1' }] })
      const paths = Object.keys(cloud.files)
      if (u.pathname.endsWith('/tree')) {
        const folders = [...new Set(paths.flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))]
        return json({ pages: paths.filter((p) => p.endsWith('.md')), files: paths.filter((p) => !p.endsWith('.md')).map((p) => ({ path: p, size: cloud.files[p].length })), folders, seq: cloud.seq })
      }
      if (u.pathname.endsWith('/asset-token')) return json({ token: 'at-e2e', ttlSec: 600 })
      if (u.pathname.endsWith('/link-base')) return json({ webOrigin: 'https://cloud.e2e.test' })
      if (u.pathname.endsWith('/asset')) {
        const hit = cloudResolve(u, paths.filter((p) => Buffer.isBuffer(cloud.files[p])))
        cloudAssetHits.push(`${u.pathname}?ref=${u.searchParams.get('ref')}${u.searchParams.has('page') ? '' : '(不带 page)'} → ${hit ?? '404'}`)
        return hit ? r.fulfill({ status: 200, contentType: 'image/png', body: cloud.files[hit] }) : r.fulfill({ status: 404, body: '' })
      }
      if (u.pathname.endsWith('/file') && paths.length) {
        if (r.request().method() === 'GET') {
          const p = u.searchParams.get('path')
          return typeof cloud.files[p] === 'string'
            ? json({ path: p, kind: 'page', content: cloud.files[p], seq: cloud.seq, hash: `h${cloud.seq}`, updatedAt: new Date().toISOString() })
            : json({}, 404)
        }
        if (r.request().method() === 'PUT') {
          const body = JSON.parse(r.request().postData() || '{}')
          if (typeof cloud.files[body.path] === 'string') { cloud.puts.push({ path: body.path, content: String(body.content) }); cloud.files[body.path] = String(body.content) }
          cloud.seq += 1
          return json({ seq: cloud.seq, hash: `h${cloud.seq}` })
        }
      }
      return json({}, 404)
    })
    // 坏地址指向的旧源:令牌过期,一律 401(也免得台架真去解析这个域名)。
    // ⚠️ 必须注册在假云端之后(后注册先匹配):它的路径也是 /api/amadeus/…,排在前面会被假云端当成好请求把图送出去。
    await page.route('**://old-origin.e2e.test/**', (r) => { oldOriginHits.push(r.request().url().slice(0, 90)); return r.fulfill({ status: 401, body: '' }) })

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
      await page.waitForTimeout(3500) // 工作区预热(启动后 ~1.2s 读库)
    }
    /** 从左抽屉的树上点开一篇笔记(子文件夹里的先把文件夹点开);树上没有 = false。 */
    const openNote = async (note) => {
      const drawer = async () => { if (!(await page.locator('.mb-drawer--left.open').count())) await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '左抽屉') }
      await drawer()
      const amx = page.locator('.mb-drawer--left [data-space="amadeus"]')
      if (await amx.count()) { await tap(amx, 'Amadeus space'); await page.waitForTimeout(900) }
      await drawer()
      const row = page.locator('.mb-drawer--left .t2s-srow', { hasText: note.stem }).first()
      if (note.dir && !(await row.isVisible().catch(() => false))) {
        await tap(page.locator('.mb-drawer--left .t2s-folder-row', { hasText: note.dir }).first(), `${note.dir} 文件夹`)
      }
      if (!(await row.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false))) return false
      await tap(row, `${note.stem} 行`)
      await page.waitForTimeout(3000)
      return true
    }
    /** 编辑器里的图(占位的内联 svg 不算)。src 给全,粘贴要用。 */
    const editorImgs = () => page.evaluate(() => [...document.querySelectorAll('.ProseMirror img, .amx-doc img')]
      .map((i) => ({ src: i.getAttribute('src') || '', complete: i.complete, w: i.naturalWidth }))
      .filter((i) => i.src && !i.src.startsWith('data:image/svg')))
    /** 点「后文」那一段、按 End、敲 text、等过自动保存。返回焦点在不在编辑器里。 */
    const typeAfter = async (text) => {
      await page.locator('.ProseMirror[contenteditable="true"] p', { hasText: '后文' }).last().tap({ timeout: 4000 }).catch(() => {})
      await page.keyboard.press('End').catch(() => {})
      await page.keyboard.type(text).catch(() => {})
      await page.waitForTimeout(600)
      const focused = await page.evaluate(() => !!document.activeElement?.classList.contains('ProseMirror'))
      await page.waitForTimeout(3500)
      return focused
    }
    return { ctx, page, tap, boot, openNote, editorImgs, typeAfter, cloudAssetHits, localAssetHits, oldOriginHits }
  }

  /** 场景 A–D。startSide = 冷启动时的库;
   *  stay = 留在云端库不切走(场景 C / D:假云端里本来就有这篇带图的笔记);
   *  damaged = 库里那篇笔记的图片行已经是被旧缺陷写坏的形态(场景 D)。 */
  const scenario = async (label, startSide, stay = false, damaged = false) => {
    const REL = '.amadeus/pic-cloud.png'
    // 另一端(源不同)写进去的显示地址,令牌早已过期。
    const OLD = `https://old-origin.e2e.test/api/amadeus/vaults/cloud-v1/asset?ref=${encodeURIComponent(REL)}&page=${encodeURIComponent(NOTE.path)}&at=EXPIRED`
    const cloud = { files: stay ? { [NOTE.path]: `# 图片笔记\n\n前文\n\n![](${damaged ? OLD : REL})\n\n后文\n`, [REL]: Buffer.from(PNG_B64, 'base64') } : {}, puts: [], seq: 1 }
    const { ctx, page, tap, boot, cloudAssetHits, localAssetHits, oldOriginHits } = await openCtx(startSide, cloud)

    await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await boot()
    const side0 = await page.evaluate(() => window.amadeusVaultMode?.side)
    check(side0 === startSide, `${label}:冷启动在${startSide === 'local' ? '本地' : '云端'}库(防空过)`, `side = ${side0}`)
    if (startSide === 'cloud' && !stay) {
      await page.evaluate(() => window.amadeusVaultMode.switch('local'))
      await page.waitForTimeout(1500)
      check((await page.evaluate(() => window.amadeusVaultMode.side)) === 'local', `${label}:已切到本地库(防空过)`)
    }

    // 存图 + 写笔记:saveAsset 就是编辑器粘贴 / 插入图片走的那条路,返回写进笔记的相对链接。
    const seeded = stay ? { rel: REL, onDisk: 1, want: 1 } : await page.evaluate(async ([note, b64]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const rel = await window.amadeus.saveAsset(note, 'pic.png', bytes)
      await window.amadeus.writeTextFile(note, `# 图片笔记\n\n前文\n\n![](${rel})\n\n后文\n`)
      const back = await window.amadeus.readVaultBytes(rel)
      return { rel, onDisk: back ? back.length : 0, want: bytes.length }
    }, [NOTE.path, PNG_B64])
    if (!stay) check(seeded.onDisk === seeded.want, `${label}:图片字节确实在本地库里(防空过)`, `${seeded.rel},${seeded.onDisk} 字节`)

    // 种完重开(工作区预热早把空库读进 store 了)。场景 B 的重开会直接冷启动在本地库 —— 那就不是 B 了,所以 B 不重开,
    // 改成让树重列一遍。
    if (stay) { /* 云端库:笔记本来就在,不用种 */ }
    else if (startSide === 'local') { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }); await boot() }
    else { await page.evaluate(() => window.amadeusVaultMode.switch('cloud')); await page.waitForTimeout(1200); await page.evaluate(() => window.amadeusVaultMode.switch('local')); await page.waitForTimeout(1800) }

    if (!(await page.locator('.mb-drawer--left.open').count())) await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '左抽屉')
    const amx = page.locator('.mb-drawer--left [data-space="amadeus"]')
    if (await amx.count()) { await tap(amx, 'Amadeus space'); await page.waitForTimeout(900) }
    if (!(await page.locator('.mb-drawer--left.open').count())) await tap(page.locator('.mb-topbar [aria-label="left panel"]'), '左抽屉')
    const row = page.locator('.mb-drawer--left .t2s-srow', { hasText: NOTE.stem }).first()
    const there = await row.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false)
    if (!there) {
      const rows = await page.locator('.mb-drawer--left .t2s-srow').allInnerTexts().catch(() => [])
      check(false, `${label}:树上有这篇笔记`, `现有行: ${rows.map((r) => r.trim()).join(' / ').slice(0, 200)}`)
      await ctx.close()
      return
    }
    await page.evaluate(() => { window.__csp.length = 0 })
    await tap(row, `${NOTE.stem} 行`)
    await page.waitForTimeout(3000)

    const seen = await page.evaluate(() => {
      const body = document.querySelector('.ProseMirror[contenteditable="true"]')
      const imgs = [...document.querySelectorAll('.ProseMirror img, .amx-doc img')].map((i) => ({
        src: (i.getAttribute('src') || '').slice(0, 160), complete: i.complete, w: i.naturalWidth,
      }))
      return { editor: !!body, text: (body?.textContent || '').replace(/\s+/g, ' ').slice(0, 60), imgs, csp: window.__csp.slice(0, 6) }
    })
    check(seen.editor && /前文/.test(seen.text), `${label}:笔记在编辑器里打开了(防空过)`, `正文「${seen.text}」`)
    console.log(`      编辑器里的 <img>: ${JSON.stringify(seen.imgs)}`)
    console.log(`      内容安全策略违规: ${JSON.stringify(seen.csp)}`)
    if (cloudAssetHits.length) console.log(`      打到云端资源端点的请求: ${cloudAssetHits.slice(0, 4).join(' , ')}`)
    const img = seen.imgs.find((i) => i.src && !i.src.startsWith('data:image/svg'))
    check(!!img, `${label}:编辑器里有那张图的 <img>`, img ? `src = ${img.src}` : '一张都没有')
    check(!!img && img.complete && img.w === 2, `${label}:图片加载出来了(naturalWidth = 2)`, img ? `complete=${img.complete} naturalWidth=${img.w}` : '')
    check(seen.csp.length === 0, `${label}:打开笔记没有触发内容安全策略违规`, seen.csp.map((v) => `${v.d} ← ${v.uri}`).join(' ; '))
    if (!stay) check(cloudAssetHits.length === 0, `${label}:本地库的图片没有去云端要`, cloudAssetHits.slice(0, 3).join(' , '))
    if (!stay) check(localAssetHits.includes(seeded.rel), `${label}:图片是按本地库的地址取的(防空过)`, `取过: ${localAssetHits.slice(0, 3).join(' , ') || '(无)'}`)
    if (damaged) {
      check(!!img && img.src.startsWith(appUrl), `${label}:坏地址显示时按当前的接口源与令牌重拼了`, img ? `src = ${img.src.slice(0, 80)}` : '')
      check(oldOriginHits.length === 0, `${label}:没有再去坏地址指的旧源要图`, oldOriginHits.slice(0, 2).join(' , '))
      // 只是打开、一个字没动:盘上不许变(显示侧的还原不能变成「打开即改写」)。打开后已等 3s,再等过一个自动保存窗。
      await page.waitForTimeout(3500)
      check(cloud.puts.length === 0, `${label}:只是打开不写盘`, cloud.puts.length ? `发生了 ${cloud.puts.length} 次保存` : '')
    }

    // 存盘往返:显示时图片地址被换成了能加载的形态,存回去必须还原成页相对路径。敲一个字、等过自动保存、看落盘的那一行。
    // (还原不了 = 设备上的绝对地址 / 带令牌的云端地址被写进笔记:换台设备、令牌一过期,图就永久失联。)
    // ⚠️ 落点必须确定:点「后文」那一段再按 End。点正文中心会点中图片节点(加载失败时是一整块占位),
    //    接着打字 = 把选中的图片节点替换掉 —— 那是台架自己删的图,不是产品把图存丢了(第一版台架踩过)。
    await page.locator('.ProseMirror[contenteditable="true"] p', { hasText: '后文' }).last().tap({ timeout: 4000 }).catch(() => {})
    await page.keyboard.press('End').catch(() => {})
    await page.keyboard.type(' x').catch(() => {})
    await page.waitForTimeout(600)
    const focused = await page.evaluate(() => !!document.activeElement?.classList.contains('ProseMirror'))
    await page.waitForTimeout(3500)
    const saved = stay ? (cloud.puts[cloud.puts.length - 1]?.content ?? null) : await page.evaluate((p) => window.amadeus.readTextFile(p), NOTE.path)
    const line = String(saved ?? '').split('\n').find((l) => l.includes('![')) ?? ''
    check(focused && saved != null && /后文 x/.test(String(saved)), `${label}:字敲在「后文」后面并存盘了(防空过)`, saved == null ? '没有发生保存' : `focused=${focused}`)
    check(line === `![](${seeded.rel})`, `${label}:存回去的图片链接仍是页相对路径`, `落盘那一行: ${line.slice(0, 200) || '(没有图片行)'}`)
    if (line !== `![](${seeded.rel})`) console.log(`      落盘全文:\n${String(saved ?? '').split('\n').map((l) => `          │ ${l}`).join('\n')}`)
    await page.screenshot({ path: path.join(root, 'outputs', 'localasset', `${damaged ? 'd-cloud-damaged' : stay ? 'c-cloud' : startSide === 'local' ? 'a-local' : 'b-cloud-then-local'}.png`) }).catch(() => {})
    await ctx.close()
  }

  const lineOf = (text) => String(text ?? '').split('\n').find((l) => l.includes('![')) ?? ''
  /** 重开(冷启动)子文件夹那篇笔记:图加载出来的必须是库根那张(2×2);动一个字,图片那一行还是 want。 */
  const reopenCheck = async (label, h, side, cloud, want) => {
    const { page } = h
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    await h.boot()
    h.cloudAssetHits.length = 0
    h.localAssetHits.length = 0
    const opened = await h.openNote(SUB)
    check(opened, `${label}:重开后树上有子文件夹里那篇笔记(防空过)`)
    if (!opened) return
    const img = (await h.editorImgs())[0]
    console.log(`      重开后的 <img>: ${JSON.stringify(img ? { ...img, src: img.src.slice(0, 200) } : null)}`)
    console.log(`      资源请求: ${[...h.cloudAssetHits, ...h.localAssetHits.map((p) => `本地 ${p}`)].slice(0, 4).join(' , ') || '(无)'}`)
    check(!!img && img.complete && img.w === 2, `${label}:重开后图片加载出来了,是库根那张(naturalWidth = 2)`, img ? `complete=${img.complete} naturalWidth=${img.w}` : '编辑器里没有图')
    const before = cloud.puts.length
    const focused = await h.typeAfter(' y')
    const saved = side === 'cloud' ? (cloud.puts.length > before ? cloud.puts[cloud.puts.length - 1].content : null) : await page.evaluate((p) => window.amadeus.readTextFile(p), SUB.path)
    check(focused && /后文.* y/.test(String(saved)), `${label}:重开后又敲了一个字并存盘了(防空过)`, saved == null ? '没有发生保存' : `focused=${focused}`)
    check(lineOf(saved) === want, `${label}:再存一遍,图片那一行不变`, `落盘那一行: ${lineOf(saved).slice(0, 200) || '(没有图片行)'}`)
  }

  /** E / F:从库根的笔记复制一张图,贴进 `子夹/` 下的笔记。被复制的是图片节点的显示地址(剪贴板 text/html 里的 <img src>):
   *  先打开库根那篇读出它的 src,再对着子文件夹那篇的编辑器派发一次带这段 html 的粘贴。 */
  const crossFolder = async (label, side) => {
    const WANT = `![](../${ROOTPIC})`
    const cloud = { files: side === 'cloud' ? { [ROOTNOTE.path]: `# 根笔记\n\n![](${ROOTPIC})\n`, [SUB.path]: '# 图片笔记\n\n前文\n\n后文\n', [ROOTPIC]: Buffer.from(PNG_B64, 'base64') } : {}, puts: [], seq: 1 }
    const h = await openCtx(side, cloud)
    const { ctx, page } = h
    try {
      await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await h.boot()
      const side0 = await page.evaluate(() => window.amadeusVaultMode?.side)
      check(side0 === side, `${label}:冷启动在${side === 'local' ? '本地' : '云端'}库(防空过)`, `side = ${side0}`)
      if (side === 'local') {
        // 图存进库根的 attachments/(「附件放固定文件夹」那条真路径),两篇笔记直接写盘;种完重开让工作区读到。
        const seeded = await page.evaluate(async ([rootNote, subNote, b64]) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          const { pageRel } = await window.amadeus.saveAttachment(rootNote, 'pic.png', bytes, { mode: 'vault', folder: 'attachments' })
          await window.amadeus.writeTextFile(rootNote, `# 根笔记\n\n![](${pageRel})\n`)
          await window.amadeus.writeTextFile(subNote, '# 图片笔记\n\n前文\n\n后文\n')
          const back = await window.amadeus.readVaultBytes(pageRel)
          return { pageRel, onDisk: back ? back.length : 0, sub: await window.amadeus.readTextFile(subNote) }
        }, [ROOTNOTE.path, SUB.path, PNG_B64])
        check(seeded.pageRel === ROOTPIC && seeded.onDisk > 0 && /后文/.test(String(seeded.sub)), `${label}:图在库根的 ${ROOTPIC}、两篇笔记都在盘上(防空过)`, JSON.stringify({ ...seeded, sub: undefined }))
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
        await h.boot()
      }
      check(await h.openNote(ROOTNOTE), `${label}:打开了库根那篇笔记(防空过)`)
      const rootImg = (await h.editorImgs())[0]
      check(!!rootImg && rootImg.complete && rootImg.w === 2, `${label}:库根那篇里的图加载得出(防空过:要复制的就是它)`, rootImg ? `src = ${rootImg.src.slice(0, 160)}` : '编辑器里没有图')
      if (!rootImg) return
      check(await h.openNote(SUB), `${label}:打开了子文件夹里那篇笔记(防空过)`)
      // 光标落到「后文」段末、另起一段,再粘贴 —— 贴在段中间会和文字同段,落盘那一行就不止图片了。
      await page.locator('.ProseMirror[contenteditable="true"] p', { hasText: '后文' }).last().tap({ timeout: 4000 }).catch(() => {})
      await page.keyboard.press('End').catch(() => {})
      await page.keyboard.press('Enter').catch(() => {})
      await page.waitForTimeout(300)
      const handled = await page.evaluate((src) => {
        const el = document.querySelector('.ProseMirror[contenteditable="true"]')
        const img = document.createElement('img')
        img.setAttribute('src', src)
        const dt = new DataTransfer()
        dt.setData('text/html', img.outerHTML)
        return !el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      }, rootImg.src)
      await page.waitForTimeout(4000) // 过自动保存
      const pasted = (await h.editorImgs())[0]
      check(handled && !!pasted && pasted.complete && pasted.w === 2, `${label}:图贴进了子文件夹的笔记,当场显示得出(防空过)`, `编辑器接了粘贴=${handled} ${pasted ? `naturalWidth=${pasted.w}` : '编辑器里没有图'}`)
      const saved = side === 'cloud' ? (cloud.puts[cloud.puts.length - 1]?.content ?? null) : await page.evaluate((p) => window.amadeus.readTextFile(p), SUB.path)
      check(lineOf(saved) === WANT, `${label}:落盘的图片链接是指回库根的 ../ 写法`, `落盘那一行: ${lineOf(saved).slice(0, 200) || (saved == null ? '(没有发生保存)' : '(没有图片行)')}`)
      await reopenCheck(label, h, side, cloud, WANT)
      await page.screenshot({ path: path.join(root, 'outputs', 'localasset', `${side === 'local' ? 'e-local' : 'f-cloud'}-cross-folder.png`) }).catch(() => {})
    } finally {
      await ctx.close()
    }
  }

  /** G:云端库里本来就是 `../` 写法的笔记,且页目录下有一张同路径的另一张图(1×1)。 */
  const dotdotCloud = async (label) => {
    const WANT = `![](../${ROOTPIC})`
    const cloud = { files: { [SUB.path]: `# 图片笔记\n\n前文\n\n${WANT}\n\n后文\n`, [ROOTPIC]: Buffer.from(PNG_B64, 'base64'), [`${SUB.dir}/${ROOTPIC}`]: Buffer.from(PNG1_B64, 'base64') }, puts: [], seq: 1 }
    const h = await openCtx('cloud', cloud)
    try {
      await h.page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await h.boot()
      await reopenCheck(label, h, 'cloud', cloud, WANT)
      await h.page.screenshot({ path: path.join(root, 'outputs', 'localasset', 'g-cloud-dotdot.png') }).catch(() => {})
    } finally {
      await h.ctx.close()
    }
  }

  try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      if (previewExit !== null) throw new Error(`vite preview 退出了(code=${previewExit})\n${previewErr.slice(-800) || '(无 stderr)'}`)
      up = await ping()
    }
    if (!up) throw new Error(`vite preview 没起来\n${previewErr.slice(-800) || '(无 stderr)'}`)
    fs.mkdirSync(path.join(root, 'outputs', 'localasset'), { recursive: true })
    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    console.log('── A. 冷启动就在本地库 ──')
    await scenario('A', 'local')
    console.log('\n── B. 先在云端库启动,再切到本地库 ──')
    await scenario('B', 'cloud')
    console.log('\n── C. 云端库(手机缺省就是它;网页版同一座桥) ──')
    await scenario('C', 'cloud', true)
    console.log('\n── D. 云端库里一篇已经被写坏的笔记(图片行是另一端写进去的带过期令牌的地址) ──')
    await scenario('D', 'cloud', true, true)
    console.log('\n── E. 本地库:从库根的笔记复制一张图,贴进子文件夹里的笔记 ──')
    await crossFolder('E', 'local')
    console.log('\n── F. 云端库:同上 ──')
    await crossFolder('F', 'cloud')
    console.log('\n── G. 云端库里本来就是 ../ 写法的笔记,页目录下还有一张同路径的另一张图 ──')
    await dotdotCloud('G')
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
