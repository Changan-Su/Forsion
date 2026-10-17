/**
 * 白板打开 / 查看 / 禅模式 / 右键悬停 —— 真 Electron + 隔离库里种的三张白板(远离原点 / A4 纸张 / 空白)。
 *   F 打开时适配全图(放大 ≤ 2;视口不进文件;再次打开不改写文件)
 *   V Option+R 查看模式真能开关,画布右键菜单里有「查看模式」(受控 prop 会让这两样一起失效)
 *   Z 禅模式:工具岛连同数字角标淡出,「退出禅模式」在底部正中、不压缩放条、是胶囊(亮 / 暗)
 *   C 右键菜单悬停行的字看得见(亮 / 暗)
 *   P 纸张白板适配到第一页,随后的视口钳制是空操作(不拉扯);E 空白板仍是原点 100%
 *   H 后台(隐藏)挂载的白板露出来时才适配,不按窗口尺寸算
 * 截图(亮暗各一张)落 OUT_DIR,缺省系统临时目录,观感自己看(DESIGN §8)。
 *
 * 跑(先在本检出 `npm run build`;devlock 路径按仓根算):
 *   node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="白板视图" --eta=3 -- npm run check:boardview
 */
const fs = require('fs'); const os = require('os'); const path = require('path')
const DESK = path.resolve(__dirname, '..')
const electron = require(path.join(DESK, 'scripts/lib/launch-electron.cjs'))
const { skipOnboarding } = require(path.join(DESK, 'scripts/lib/skip-onboarding.cjs'))
const OUT = process.env.OUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'board-view-shots-')); fs.mkdirSync(OUT, { recursive: true })
const W = 1512, H = 950

let seq = 0
const base = (o) => ({ id: `e${++seq}`, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
  strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, seed: 1000 + seq, version: 1, versionNonce: seq, isDeleted: false,
  boundElements: null, updated: 1, link: null, locked: false, ...o })
const text = (x, y, w, t, size = 20) => base({ type: 'text', x, y, width: w, height: size * 1.25 * t.split('\n').length, text: t, originalText: t,
  fontSize: size, fontFamily: 5, textAlign: 'center', verticalAlign: 'top', containerId: null, lineHeight: 1.25, autoResize: true, roundness: null })
const box = (x, y, w, h, bg, label) => [base({ type: 'rectangle', x, y, width: w, height: h, backgroundColor: bg, roundness: { type: 3 } }), text(x, y + h / 2 - 12.5, w, label)]
// 内容放在离原点很远的地方:旧行为(回原点 100%)下它完全在屏幕外
const FAR = [...box(2400, 1600, 220, 90, '#a5d8ff', '收集想法'), ...box(2700, 1600, 220, 90, '#b2f2bb', '整理成笔记'), ...box(3000, 1900, 220, 90, '#ffec99', '画成白板')]
const PAGE = [...box(80, 120, 260, 100, '#a5d8ff', '第一页的内容'), ...box(420, 600, 240, 100, '#ffc9c9', '页内另一块')]
const drawing = (els, fm = []) => ['---', '', 'excalidraw-plugin: parsed', 'tags: [excalidraw]', ...fm, '', '---', '', '', '## Drawing', '```json',
  JSON.stringify({ type: 'excalidraw', version: 2, source: 'Forsion Amadeus', elements: els, appState: { viewBackgroundColor: '#ffffff' }, files: {} }), '```', '%%'].join('\n')

const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-board-verify-'))
  const userData = path.join(temp, 'userdata'), vault = path.join(temp, 'Vault')
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(vault, '欢迎.md'), '# 欢迎\n', 'utf8')
  const farFile = path.join(vault, '远处白板.excalidraw.md')
  fs.writeFileSync(farFile, drawing(FAR), 'utf8')
  fs.writeFileSync(path.join(vault, '纸张白板.excalidraw.md'), drawing(PAGE, ['forsion-paper: A4', 'forsion-page-last: 1']), 'utf8')
  fs.writeFileSync(path.join(vault, '空白板.excalidraw.md'), drawing([]), 'utf8')
  for (const d of [userData, `${userData}-dev`]) {
    fs.mkdirSync(d, { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(d, f), JSON.stringify({ lastVault: vault, localVault: vault }))
  }
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', DESK], cwd: DESK,
    env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: 'http://127.0.0.1:1', TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
  try {
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, s) => { BrowserWindow.getAllWindows()[0].setContentSize(s.W, s.H) }, { W, H })
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    if (!await skipOnboarding(win)) throw new Error('onboarding not skipped')
    await win.locator('.rb-space[aria-label="笔记"], .rb-space[aria-label="Note"]').first().click({ timeout: 15000 })
    const open = async (title) => {
      const row = win.locator('.t2s-srow', { has: win.locator('.t2s-srow-title', { hasText: new RegExp(`^${title}$`) }) }).first()
      await row.click({ timeout: 15000 })
      await win.waitForSelector('.amx-drawview .excalidraw canvas.interactive', { timeout: 30000 })
      await win.waitForTimeout(2000)
      await win.mouse.move(1300, 760)
    }
    // 引擎 App 实例(React fiber 往上找带 state.zoom 的类组件)
    const view = () => win.evaluate(() => {
      const el = [...document.querySelectorAll('.amx-drawview .excalidraw')].find((e) => e.offsetParent)
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'))
      let f = el[key]
      while (f && !(f.stateNode && f.stateNode.state && f.stateNode.state.zoom)) f = f.return
      const a = f.stateNode, st = a.state
      const r = el.getBoundingClientRect()
      const els = a.scene.getNonDeletedElements()
      const z = st.zoom.value
      const vb = els.map((e) => ({ x1: (e.x + st.scrollX) * z, y1: (e.y + st.scrollY) * z, x2: (e.x + e.width + st.scrollX) * z, y2: (e.y + e.height + st.scrollY) * z }))
      return { zoom: z, scrollX: st.scrollX, scrollY: st.scrollY, w: st.width, h: st.height, cls: el.className, viewMode: st.viewModeEnabled, zen: st.zenModeEnabled,
        host: { w: r.width, h: r.height }, n: els.length,
        inView: vb.every((b) => b.x1 >= 0 && b.y1 >= 0 && b.x2 <= st.width && b.y2 <= st.height) }
    })
    const shot = async (name) => { await win.waitForTimeout(500); await win.screenshot({ path: path.join(OUT, `${name}.png`) }) }
    const canvasFocus = async () => { await win.mouse.click(1350, 820); await win.waitForTimeout(200) }
    const press = async (k) => { await canvasFocus(); await win.keyboard.press(k); await win.waitForTimeout(700); await win.mouse.move(1300, 760) }
    const toggleDark = async (on) => {
      const cur = await win.evaluate(() => document.documentElement.dataset.mode)
      if ((cur === 'dark') !== on) { await win.locator('.rb-slot[data-id="rb-mode"] button').first().click(); await win.waitForTimeout(1200) }
    }

    // ── 2 打开时适配全图(无限画布,内容远离原点) ──
    const mt0 = fs.statSync(farFile).mtimeMs
    await open('远处白板.excalidraw')
    const v0 = await view()
    check('F1 打开远处白板:内容全部在视口内', v0.inView, JSON.stringify(v0))
    check('F2 适配放大不超过 2', v0.zoom <= 2 + 1e-6 && v0.zoom > 0.1, `zoom=${v0.zoom}`)
    await win.waitForTimeout(2500)
    const txt1 = fs.readFileSync(farFile, 'utf8'), mt1 = fs.statSync(farFile).mtimeMs
    const j = JSON.parse(txt1.split('```json')[1].split('```')[0])
    console.log('  [F3 首开] 改写了:', mt1 !== mt0, ' appState 键:', Object.keys(j.appState || {}).join(','))
    check('F3a 视口没写进文件', !('scrollX' in (j.appState || {})) && !('zoom' in (j.appState || {})))
    await open('空白板.excalidraw'); await open('远处白板.excalidraw'); await win.waitForTimeout(2500)
    check('F3b 再次打开(又适配一次)不改写文件', fs.statSync(farFile).mtimeMs === mt1, `mt1=${mt1} now=${fs.statSync(farFile).mtimeMs}`)
    await shot('fit-far-light')

    // ── 1 查看模式 ──
    await press('Alt+KeyR')
    const vm = await view()
    check('V1 Option+R 进入查看模式', vm.viewMode === true, `viewModeEnabled=${vm.viewMode}`)
    await press('Alt+KeyR')
    check('V2 再按退出', (await view()).viewMode === false)
    await win.mouse.click(1350, 820, { button: 'right' }); await win.waitForTimeout(500)
    const ctxItems = await win.evaluate(() => [...document.querySelectorAll('.context-menu-item__label')].map((e) => e.textContent))
    check('V3 画布右键菜单里有「查看模式」', ctxItems.some((t) => /查看模式|View mode/.test(t)), ctxItems.join(' / '))
    await win.keyboard.press('Escape'); await win.waitForTimeout(300)

    // ── 3 禅模式 / 4 右键悬停:亮暗各一遍 ──
    for (const mode of ['light', 'dark']) {
      await toggleDark(mode === 'dark')
      await press('Alt+KeyZ')
      await win.waitForTimeout(1200) // 引擎给退出按钮的 visibility 延迟 0.8s + 0.3s
      const zen = await win.evaluate(() => {
        const host = [...document.querySelectorAll('.amx-drawview .excalidraw')].find((e) => e.offsetParent)
        const tb = host.querySelector('.App-toolbar'), btn = host.querySelector('.disable-zen-mode'), zoom = host.querySelector('.zoom-actions')
        const cs = getComputedStyle(tb), r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
        const hr = r(host), br = r(btn), zr = r(zoom)
        return { tbCls: tb.className, tbOpacity: cs.opacity, tbVis: cs.visibility, keyVis: getComputedStyle(host.querySelector('.amx-tool-key')).visibility,
          btnVisible: getComputedStyle(btn).visibility, center: br.x + br.w / 2 - (hr.x + hr.w / 2),
          overlapZoom: !(br.x > zr.x + zr.w || br.x + br.w < zr.x || br.y > zr.y + zr.h || br.y + br.h < zr.y),
          radius: getComputedStyle(btn).borderRadius, shadow: getComputedStyle(btn).boxShadow, bg: getComputedStyle(btn).backgroundColor, btn: br }
      })
      check(`Z1[${mode}] 工具岛带 zen-mode 并淡出`, /zen-mode/.test(zen.tbCls) && zen.tbOpacity === '0' && zen.tbVis === 'hidden', `${zen.tbCls} op=${zen.tbOpacity} vis=${zen.tbVis}`)
      check(`Z2[${mode}] 数字角标跟着藏`, zen.keyVis === 'hidden', zen.keyVis)
      check(`Z3[${mode}] 退出按钮在底部正中、不压缩放条`, Math.abs(zen.center) < 2 && !zen.overlapZoom && zen.btnVisible === 'visible', JSON.stringify({ center: zen.center, overlap: zen.overlapZoom, btn: zen.btn }))
      check(`Z4[${mode}] 退出按钮是胶囊`, parseFloat(zen.radius) >= 16 && zen.shadow !== 'none', `${zen.radius} | ${zen.bg}`)
      await win.waitForTimeout(600)
      await shot(`zen-${mode}`)
      await press('Alt+KeyZ')
      await win.waitForTimeout(600)
      const back = await win.evaluate(() => { const tb = [...document.querySelectorAll('.amx-drawview .excalidraw')].find((e) => e.offsetParent).querySelector('.App-toolbar'); const cs = getComputedStyle(tb); return { op: cs.opacity, vis: cs.visibility } })
      check(`Z5[${mode}] 退出后工具岛回来`, back.op === '1' && back.vis === 'visible', JSON.stringify(back))

      // 右键空白画布,悬停到一行上(元素菜单与画布菜单是同一条 .context-menu-item:hover 规则;用空白处,这步就不依赖适配)
      await win.mouse.click(1350, 820, { button: 'right' }); await win.waitForTimeout(500)
      const row = win.locator('.context-menu-item').nth(1)
      await row.hover(); await win.waitForTimeout(300)
      const hv = await row.evaluate((b) => {
        const cs = getComputedStyle(b), lab = getComputedStyle(b.querySelector('.context-menu-item__label'))
        const menu = getComputedStyle(b.closest('.context-menu'))
        return { bg: cs.backgroundColor, fg: lab.color, menuBg: menu.backgroundColor, text: b.textContent }
      })
      const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 }
      const rgbaAlpha = (c) => { const m = c.match(/[\d.]+/g).map(Number); return m.length > 3 ? m[3] : 1 }
      // 悬停底是叠在菜单底色上的半透明中性色:有效底色 ≈ 菜单底色,和字的亮度必须拉得开
      check(`C1[${mode}] 右键菜单悬停行字看得见`, rgbaAlpha(hv.bg) < 0.3 && Math.abs(lum(hv.fg) - lum(hv.menuBg)) > 0.4, JSON.stringify(hv))
      await shot(`ctxhover-${mode}`)
      await win.keyboard.press('Escape'); await win.waitForTimeout(300)
    }
    await toggleDark(false)

    // ── 2b 纸张:适配第一页,钳制不再拽 ──
    await open('纸张白板.excalidraw')
    const p1 = await view()
    await win.waitForTimeout(1500)
    const p2 = await view()
    // A4 = 794×1123;第一页在场景 (0,0)
    const pw = 794, ph = 1123
    const page = { x1: (0 + p1.scrollX) * p1.zoom, y1: (0 + p1.scrollY) * p1.zoom, x2: (pw + p1.scrollX) * p1.zoom, y2: (ph + p1.scrollY) * p1.zoom }
    check('P1 纸张白板:第一页整页在视口内', page.x1 >= 0 && page.y1 >= 0 && page.x2 <= p1.w + 0.5 && page.y2 <= p1.h + 0.5, JSON.stringify({ page, w: p1.w, h: p1.h, zoom: p1.zoom }))
    check('P2 第一页撑满一个方向(真适配,不是原样 100%)', Math.abs((page.y2 - page.y1) - p1.h / 1.12) < 2 || Math.abs((page.x2 - page.x1) - p1.w / 1.12) < 2, `页 ${(page.x2 - page.x1).toFixed(0)}×${(page.y2 - page.y1).toFixed(0)}`)
    check('P3 钳制不再改视口(不拉扯)', p1.scrollX === p2.scrollX && p1.scrollY === p2.scrollY && p1.zoom === p2.zoom, JSON.stringify({ p1: [p1.scrollX, p1.scrollY, p1.zoom], p2: [p2.scrollX, p2.scrollY, p2.zoom] }))
    await shot('fit-paper-light')

    // ── 2c 空白板:原点 100% 不动 ──
    await open('空白板.excalidraw')
    const e1 = await view()
    check('E1 空白板仍是 100%、原点', e1.zoom === 1 && e1.scrollX === 0 && e1.scrollY === 0, JSON.stringify([e1.scrollX, e1.scrollY, e1.zoom]))

    // ── 2d 后台挂载:藏着装载完、露出来才适配(引擎的初始宽高是窗口尺寸,按它适配露出后内容被裁) ──
    await win.evaluate(() => { const s = document.createElement('style'); s.id = 'bv-hide'; s.textContent = '.amx-drawview{display:none!important}'; document.head.append(s) })
    const row = win.locator('.t2s-srow', { has: win.locator('.t2s-srow-title', { hasText: /^远处白板\.excalidraw$/ }) }).first()
    await row.click({ timeout: 15000 })
    await win.waitForSelector('.amx-drawview .excalidraw canvas.interactive', { timeout: 30000, state: 'attached' })
    await win.waitForTimeout(2500)
    await win.evaluate(() => document.getElementById('bv-hide')?.remove())
    await win.waitForTimeout(1200)
    const h1 = await view()
    check('H1 藏着挂载、露出后内容仍全部在视口内', h1.inView, JSON.stringify({ zoom: h1.zoom, w: h1.w, h: h1.h }))
  } finally { await app.close() }
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} PASS  截图:${OUT}`)
  process.exit(bad.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
