/**
 * 「没有左栏配方的 Space 会不会把用户关死」e2e —— `npm run e2e:spacetrap`(mobile 目录,先 npm run build)。
 *
 * 2026-08-25 用户实报(2.8.1 正式包):「left panel 不见了,上面的按钮也没了」。根因不在顶栏也不在抽屉动画,
 * 而在**判活口径**:移动端左抽屉底部常驻着 Space 切换条 + 账号 + 设置(「⋯」菜单刻意滤掉后两项),
 * 可 `hasLeft` 只看 leftLeaves / sidebarDefaults.left —— 一进内置「发布」Space(PUBLIC_SIDE_VIEWS 左右全空,
 * 用户自建 Space 的 layout.left 为空同理),两者双双归零:
 *   左胶囊塌成幽灵占位(`.mb-cap:has(> .mb-icon-btn--ghost:only-child)` 抹掉底与描边 = 屏幕上什么都没有)
 *   → 抽屉拿不到 `.open`,边缘横滑也被 hasLeft 挡掉
 *   → 唯一的切 Space / 账号 / 设置入口一起消失,saveCurrent 又把空布局存回去 = **重启也出不来**。
 *
 * 所以这台仪器钉的是「退路恒在」,不是「面板长什么样」:冷启动直接落在发布 Space,断言按钮看得见、
 * 点得开、开出来能切回别的 Space。第 5 条是负对照 —— 手动把幽灵类打回去,确认胶囊真会消失
 * (否则第 1 条断言测的是个恒真命题,属于假绿)。
 *
 * 骨架照抄 drawer-drag.e2e.cjs(同一套 vite preview + 假 token + /api abort)。
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

const PORT = 5291 // 避开 dev 5274 / boot 5279 / noteopen 5283 / editorbar 5285 / drawerdrag 5289
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
    // 冷启动直接落在「发布」Space —— 用户就是这么进去的(左抽屉里点一下 Space 条),
    // 而 activeSpace 会被存下来,所以此后每次开机都落在这儿。
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('forsion_token', 'e2e-spacetrap')
        localStorage.setItem('forsion_tangu_active_space', 'public')
      } catch { /* ignore */ }
    })
    const page = await ctx.newPage()
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    page.on('pageerror', (e) => fails.push(`未捕获异常: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(4000)

    const shell = () => page.evaluate(() => {
      const cap = document.querySelector('.mb-topbar .mb-cap')
      const btn = document.querySelector('.mb-topbar .mb-icon-btn')
      const cs = cap ? getComputedStyle(cap) : null
      const dr = document.querySelector('.mb-drawer--left')
      const b = dr ? dr.getBoundingClientRect() : null
      return {
        space: localStorage.getItem('forsion_tangu_active_space'),
        ghost: !btn || btn.classList.contains('mb-icon-btn--ghost'),
        aria: btn ? btn.getAttribute('aria-label') : null,
        // 胶囊「看不见」的判据 = 底与描边都被抹平(见 singleColumn.css 的 :has 规则)。
        capInvisible: !cs || (cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.boxShadow === 'none'),
        drawerOpen: !!dr && dr.classList.contains('open'),
        drawerX: b ? Math.round(b.x) : null,
        drawerW: b ? Math.round(b.width) : null,
        spaceTabs: [...document.querySelectorAll('.mb-spacebar .mb-tab')].map((t) => t.textContent.trim()),
        foot: !!document.querySelector('.mb-drawer-foot'),
      }
    })

    const boot = await shell()
    ok('1 冷启动落在「发布」Space(左右侧栏配方皆空)', boot.space === 'public', JSON.stringify({ space: boot.space }))
    ok('2 ⚠️ 左抽屉钮仍是真按钮、胶囊看得见(退路的入口不许塌成幽灵)',
      !boot.ghost && boot.aria === 'left panel' && !boot.capInvisible,
      JSON.stringify({ ghost: boot.ghost, aria: boot.aria, capInvisible: boot.capInvisible }))

    await page.locator('.mb-topbar .mb-icon-btn').first().click({ force: true })
    await page.waitForTimeout(900)
    const open = await shell()
    ok('3 点得开:抽屉真进屏(没有左栏视图也要开,它兼着退路)',
      open.drawerOpen && open.drawerX === 0 && open.drawerW > 200,
      JSON.stringify({ open: open.drawerOpen, x: open.drawerX, w: open.drawerW }))
    ok('4 ⚠️ 开出来有退路:Space 切换条 + 账号/设置底栏都在(移动端唯一入口)',
      open.foot && open.spaceTabs.length > 1 && open.spaceTabs.some((t) => !/发布|Publish/i.test(t)),
      JSON.stringify({ foot: open.foot, tabs: open.spaceTabs }))

    // 负对照:把旧行为(幽灵占位)手动打回去,确认第 2 条的判据真的会红 —— 否则它测的是恒真命题。
    const ghosted = await page.evaluate(() => {
      const btn = document.querySelector('.mb-topbar .mb-icon-btn')
      const cap = btn && btn.parentElement
      if (!btn || !cap) return null
      const clone = document.createElement('span')
      clone.className = 'mb-icon-btn mb-icon-btn--ghost'
      cap.replaceChildren(clone)
      const cs = getComputedStyle(cap)
      return { bg: cs.backgroundColor, shadow: cs.boxShadow }
    })
    ok('5 负对照:退回幽灵占位后胶囊确实整块消失(证明第 2 条不是假绿)',
      !!ghosted && ghosted.bg === 'rgba(0, 0, 0, 0)' && ghosted.shadow === 'none',
      JSON.stringify(ghosted))

    const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-spacetrap-'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(4000)
    await page.locator('.mb-topbar .mb-icon-btn').first().click({ force: true })
    await page.waitForTimeout(900)
    await page.screenshot({ path: path.join(shotDir, 'public-space-drawer.png') })
    console.log('screenshot →', path.join(shotDir, 'public-space-drawer.png'))
  } catch (e) {
    fails.push(String((e && e.message) || e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    killPreview()
  }
  if (fails.length) { console.error('❌ e2e:spacetrap\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1) }
  console.log('✅ e2e:spacetrap —— 无左栏配方的 Space 里,左抽屉钮仍在、点得开、开出来切得回去')
}

main()
