/**
 * 移动端左右抽屉「跟手拖拽」e2e —— `npm run e2e:drawerdrag`(mobile 目录,先 npm run build)。
 * 2026-08-20 的仪器:用户实报「左右面板不跟手、没有中间态」,改法是把原来三处只看
 * touchstart→touchend 净位移的 fling 判定合成一个挂在 .mb-body 上的控制器(见
 * lcl/engine/SingleColumnHost 的 useDrawerDrag)。
 *
 * 钉五件纯推演验不出来的:
 *  1. **真有中间态**:拖到一半时抽屉/主区的 transform 与遮罩 opacity 都停在开与关**之间**。
 *  2. 松手按位置吸附:过半 → 开;不过半 → 弹回关。
 *  3. 松手按速度吸附:只拖了一点点但甩得快 → 照样开。
 *  4. **没有 snap-back**:松手那一瞬面板必须还停在手指离开的位置(先 toggleSidebar 再下一帧摘
 *     data-drag 就是为了这个);同帧摘会先跳回原位再动画,肉眼是"闪一下"。
 *  5. 纵向手势一帧都不受影响:主要位移在竖直方向时压根不进入拖拽(不设 data-drag)。
 *
 * 骨架照抄 mobile-boot.e2e.cjs(同一套 vite preview + 假 token),手势走 CDP 真 touch 序列。
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

const PORT = 5289 // 避开 dev 5274 / boot 5279 / noteopen 5283 / editorbar 5285
const URL = `http://localhost:${PORT}/`

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
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    await ctx.addInitScript(() => {
      try { localStorage.setItem('forsion_token', 'e2e-drag'); localStorage.setItem('amadeus_vault_mode', 'local') } catch { /* ignore */ }
    })
    const page = await ctx.newPage()
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    page.on('pageerror', (e) => fails.push(`未捕获异常: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(4000)

    const cdp = await ctx.newCDPSession(page)
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts })
    const down = (x, y) => touch('touchStart', [{ x, y }])
    const move = (x, y) => touch('touchMove', [{ x, y }])
    const lift = () => touch('touchEnd', [])
    const wait = (ms) => page.waitForTimeout(ms)

    /** 面板/主区/遮罩的当前几何。tx = translateX(px),从 matrix 的第 5 位取。 */
    const probe = () => page.evaluate(() => {
      const tx = (el) => {
        if (!el) return null
        const m = getComputedStyle(el).transform
        if (!m || m === 'none') return 0
        const n = m.match(/matrix\(([^)]+)\)/)
        return n ? Math.round(parseFloat(n[1].split(',')[4])) : 0
      }
      const body = document.querySelector('.mb-body')
      const drawer = document.querySelector('.mb-drawer--left')
      return {
        drag: body?.getAttribute('data-drag') ?? null,
        p: body ? getComputedStyle(body).getPropertyValue('--mb-p').trim() : '',
        w: drawer ? Math.round(drawer.getBoundingClientRect().width) : 0,
        drawerTx: tx(drawer),
        mainTx: tx(document.querySelector('.mb-main')),
        dim: Number(getComputedStyle(document.querySelector('.mb-push-dim')).opacity),
        open: !!document.querySelector('.mb-drawer--left.open'),
      }
    })
    /** 拖拽结束后回到干净的关合态(每条断言之间互不污染)。 */
    const resetClosed = async () => {
      await page.evaluate(() => {
        const btn = document.querySelector('.mb-drawer--left .mb-icon-btn[aria-label=close]')
        if (btn && document.querySelector('.mb-drawer--left.open')) btn.click()
      })
      await wait(600)
    }

    const base = await probe()
    ok('0 起点:左抽屉关着且面板有宽度(hasLeft 成立,后面的比例才有意义)',
      !base.open && base.w > 100 && base.drag === null, JSON.stringify(base))
    const W = base.w
    const Y = 500 // 避开顶栏胶囊与底部安全区,落在主区中段

    // ── 1. 中间态:边缘起手往右拉到大约一半,面板/主区/遮罩都必须停在中间 ─────────────
    await down(8, Y)
    await move(30, Y)               // 先越过方向锁定阈值
    await move(Math.round(W * 0.5), Y)
    const mid = await probe()
    ok('1a 拖到一半时 data-drag 已挂上且 --mb-p 落在 (0,1) 之间',
      mid.drag === 'left' && Number(mid.p) > 0.2 && Number(mid.p) < 0.9, JSON.stringify({ drag: mid.drag, p: mid.p }))
    ok('1b ⚠️ 真有中间态:抽屉既不在关位(-W)也不在开位(0)',
      mid.drawerTx < -8 && mid.drawerTx > -(W - 8), `drawerTx=${mid.drawerTx} W=${W}`)
    ok('1c 主区跟着一起被推(push 连贯式,不是浮层)', mid.mainTx > 8 && mid.mainTx < W - 8, `mainTx=${mid.mainTx}`)
    ok('1d 遮罩透明度跟着位移一起长', mid.dim > 0.05 && mid.dim < 0.95, `dim=${mid.dim}`)

    // ── 2. 过半松手 = 开;且松手那一瞬不许跳回原位(snap-back)──────────────────────
    await move(Math.round(W * 0.85), Y)
    await lift()
    const justAfter = await probe() // 过渡刚起步的那一帧
    ok('2a ⚠️ 松手瞬间没有 snap-back:面板仍在手指离开的位置附近,不是弹回关位再动画',
      justAfter.drawerTx > -(W * 0.6), `drawerTx=${justAfter.drawerTx} W=${W}`)
    await wait(700)
    const opened = await probe()
    ok('2b 拖过半松手 → 吸附到开', opened.open && opened.drag === null && opened.drawerTx === 0, JSON.stringify(opened))

    // ── 3. 开着的时候反向拖回去 ─────────────────────────────────────────────────
    await down(Math.round(W * 0.8), Y)
    await move(Math.round(W * 0.8) - 30, Y)
    await move(20, Y)
    const closing = await probe()
    ok('3a 开着时反向拖也跟手(中间态)', closing.drag === 'left' && Number(closing.p) < 0.6 && closing.drawerTx < -8,
      JSON.stringify({ p: closing.p, tx: closing.drawerTx }))
    await lift()
    await wait(700)
    const closed = await probe()
    ok('3b 反向拖过半松手 → 吸附到关', !closed.open && closed.drag === null, JSON.stringify(closed))

    // ── 4. 不过半松手 → 弹回关 ─────────────────────────────────────────────────
    await resetClosed()
    await down(8, Y)
    await move(30, Y)
    await wait(120) // 拉开与最后一次 move 之间留时间差,免得被算成高速甩动
    await move(Math.round(W * 0.28), Y)
    await wait(120)
    await move(Math.round(W * 0.3), Y)
    await lift()
    await wait(700)
    const back = await probe()
    ok('4 拖不过半、也没甩 → 弹回关', !back.open && back.drag === null, JSON.stringify(back))

    // ── 5. 速度吸附:只拖一点点但甩得快 → 照样开 ─────────────────────────────────
    await resetClosed()
    await down(8, Y)
    await move(30, Y)
    await move(Math.round(W * 0.35), Y) // 紧挨着的一发大位移 = 高速
    await lift()
    await wait(700)
    const flung = await probe()
    ok('5 只拖了约三成但甩得快 → 按速度吸附到开', flung.open, JSON.stringify(flung))

    // ── 6. 纵向手势不受影响 ────────────────────────────────────────────────────
    await resetClosed()
    await down(120, 300)
    await move(132, 360)
    await move(140, 460)
    const vert = await probe()
    ok('6 主要位移在竖直方向 → 压根不进入拖拽(纵向滚动一帧都不被抢)',
      vert.drag === null && !vert.open, JSON.stringify({ drag: vert.drag, p: vert.p }))
    await lift()
    await wait(400)

    // ── 7~9 画布(.amx-stage)是自己的手势面:单指横拖 = 平移,不许被抽屉抢 ────────────
    //  用户实报「画布里单指拖动和左右面板划出冲突了」。画布是 pointer 事件 + touch-action:none,
    //  而本控制器听的是原生 touch —— 两者互不知情,于是一次平移同时也是一次抽屉拖拽。
    //  台架不便真开一篇画布笔记(要有 vault),但**判据全在选择器上**:往主区塞一个真的
    //  `.amx-stage` 元素,让真控制器去命中它。三条一起钉,少一条都会假绿:
    //   7 画布内非边缘起手 → 不进入拖拽;
    //   8 **文档模式的 `.amx-stage-off`(display:contents 的空壳,普通笔记里恒在)照旧能划**
    //     —— 只写 `.amx-stage` 会把所有 v4 笔记的抽屉手势一起废掉;
    //   9 屏幕边缘 24px 起手仍抢得回来(与白板/PDF 同一条退路)。
    const stage = async (cls) => {
      await page.evaluate((c) => {
        document.getElementById('e2e-stage')?.remove()
        const main = document.querySelector('.mb-main')
        const el = document.createElement('div')
        el.id = 'e2e-stage'
        el.className = c
        el.style.cssText = 'position:absolute;inset:60px 0 0 0;z-index:5;background:transparent'
        main.appendChild(el)
      }, cls)
      await wait(80)
    }
    const dragFromStage = async (x0) => {
      await resetClosed()
      await down(x0, Y)
      await move(x0 + 30, Y)
      await move(x0 + Math.round(W * 0.6), Y)
      const st = await probe()
      await lift()
      await wait(600)
      return st
    }
    await stage('amx-stage')
    const onStage = await dragFromStage(120)
    ok('7 ⚠️ 画布内(非边缘)单指横拖 → 抽屉一动不动,整段让给画布平移',
      onStage.drag === null && !onStage.open, JSON.stringify({ drag: onStage.drag, p: onStage.p }))

    await stage('amx-stage amx-stage-off')
    const onDocMode = await dragFromStage(120)
    ok('8 ⚠️ 负对照:文档模式的 .amx-stage-off 空壳不算画布,普通笔记照旧划得出抽屉',
      onDocMode.drag === 'left', JSON.stringify({ drag: onDocMode.drag, p: onDocMode.p }))

    await stage('amx-stage')
    const fromEdge = await dragFromStage(8)
    ok('9 画布里从屏幕边缘 24px 起手仍能划出抽屉(与白板/PDF 同一条退路)',
      fromEdge.drag === 'left', JSON.stringify({ drag: fromEdge.drag, p: fromEdge.p }))
    await page.evaluate(() => document.getElementById('e2e-stage')?.remove())
    await resetClosed()

    const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-drawerdrag-'))
    await resetClosed()
    await down(8, Y)
    await move(30, Y)
    await move(Math.round(W * 0.55), Y)
    await page.screenshot({ path: path.join(shotDir, 'mid-drag.png') })
    console.log('screenshot →', path.join(shotDir, 'mid-drag.png'))
    await lift()
  } catch (e) {
    fails.push(String((e && e.message) || e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }
  if (fails.length) { console.error('❌ e2e:drawerdrag\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1) }
  console.log('✅ e2e:drawerdrag —— 中间态 / 位置吸附 / 速度吸附 / 无 snap-back / 纵向不被抢 / 画布让位')
}

main()
