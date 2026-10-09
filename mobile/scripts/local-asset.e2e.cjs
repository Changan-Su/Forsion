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
 * ⚠️ 这是浏览器台架:证明得了页面这一层把地址指到了哪里、落盘写了什么;**证明不了安卓原生层**。本地库的图片地址
 *    在安卓上是 Capacitor 本地文件服务(`https://localhost/_capacitor_file_/<应用私有目录>/vault/…`);浏览器里
 *    文件系统是 IndexedDB,拿到的库根只是 `/DATA/vault` 这个路径、没人服务它 —— 台架 route 住它、用 readVaultBytes
 *    回填字节。原生那一层真能不能服务(路径、百分号解码、Range)要上模拟器 / 真机看。
 * 负对照(实跑过,修之前的产物):A 红 2 条(图没加载、策略违规),B 红 3 条(图没加载、去云端要了、落盘是云端地址),
 *    C 红 1 条(落盘是云端地址);D 在加显示侧还原之前红 3 条(图没加载、地址没重拼、去旧源要了图)。
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

  /** 一个场景 = 一个全新的浏览器上下文(存储互不串)。startSide = 冷启动时的库;
   *  stay = 留在云端库不切走(场景 C / D:假云端里本来就有这篇带图的笔记);
   *  damaged = 库里那篇笔记的图片行已经是被旧缺陷写坏的形态(场景 D)。 */
  const scenario = async (label, startSide, stay = false, damaged = false) => {
    const REL = '.amadeus/pic-cloud.png'
    // 另一端(源不同)写进去的显示地址,令牌早已过期。
    const OLD = `https://old-origin.e2e.test/api/amadeus/vaults/cloud-v1/asset?ref=${encodeURIComponent(REL)}&page=${encodeURIComponent(NOTE.path)}&at=EXPIRED`
    const cloud = { note: stay ? `# 图片笔记\n\n前文\n\n![](${damaged ? OLD : REL})\n\n后文\n` : null, puts: [], seq: 1 }
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
      if (u.pathname.endsWith('/tree')) return json(cloud.note ? { pages: [NOTE.path], files: [{ path: REL, size: 78 }], folders: [], seq: cloud.seq } : { pages: [], files: [], folders: [], seq: 1 })
      if (u.pathname.endsWith('/asset-token')) return json({ token: 'at-e2e', ttlSec: 600 })
      if (u.pathname.endsWith('/link-base')) return json({ webOrigin: 'https://cloud.e2e.test' })
      if (u.pathname.endsWith('/asset')) {
        cloudAssetHits.push(`${u.pathname}?ref=${u.searchParams.get('ref')}`)
        return cloud.note ? r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG_B64, 'base64') }) : r.fulfill({ status: 404, body: '' })
      }
      if (u.pathname.endsWith('/file') && cloud.note) {
        if (r.request().method() === 'GET') {
          return u.searchParams.get('path') === NOTE.path
            ? json({ path: NOTE.path, kind: 'page', content: cloud.note, seq: cloud.seq, hash: `h${cloud.seq}`, updatedAt: new Date().toISOString() })
            : json({}, 404)
        }
        if (r.request().method() === 'PUT') {
          const body = JSON.parse(r.request().postData() || '{}')
          if (body.path === NOTE.path) { cloud.puts.push(String(body.content)); cloud.note = String(body.content) }
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
    const saved = stay ? (cloud.puts[cloud.puts.length - 1] ?? null) : await page.evaluate((p) => window.amadeus.readTextFile(p), NOTE.path)
    const line = String(saved ?? '').split('\n').find((l) => l.includes('![')) ?? ''
    check(focused && saved != null && /后文 x/.test(String(saved)), `${label}:字敲在「后文」后面并存盘了(防空过)`, saved == null ? '没有发生保存' : `focused=${focused}`)
    check(line === `![](${seeded.rel})`, `${label}:存回去的图片链接仍是页相对路径`, `落盘那一行: ${line.slice(0, 200) || '(没有图片行)'}`)
    if (line !== `![](${seeded.rel})`) console.log(`      落盘全文:\n${String(saved ?? '').split('\n').map((l) => `          │ ${l}`).join('\n')}`)
    await page.screenshot({ path: path.join(root, 'outputs', 'localasset', `${damaged ? 'd-cloud-damaged' : stay ? 'c-cloud' : startSide === 'local' ? 'a-local' : 'b-cloud-then-local'}.png`) }).catch(() => {})
    await ctx.close()
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
